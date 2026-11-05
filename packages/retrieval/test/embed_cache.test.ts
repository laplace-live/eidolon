// Keys, blobs and the file's schema are what Python's EmbedCache produced (write_golden.ts). The
// real cache, which Python filled, is read in write_real.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbedCache, embedCacheKey } from "../src/index.ts";
import { WRITE_GOLDEN } from "./write_golden.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rawBlob(path: string, key: string): string {
  const db = new Database(path);
  try {
    const [row] = db.query("SELECT vector FROM embed_cache WHERE key = ?").values(key);
    return Buffer.from(row?.[0] as Uint8Array).toString("hex");
  } finally {
    db.close();
  }
}

test("keys are Python's sha1 of the model, the dimension and the text", () => {
  for (const [model, dim, text, key] of WRITE_GOLDEN.keys) {
    expect(embedCacheKey(model, dim, text)).toBe(key);
  }
});

test("vectors are stored as the float32 bytes numpy wrote, rounded the same way", () => {
  const path = join(dir, "embed_cache.db");
  const cache = new EmbedCache(path);
  WRITE_GOLDEN.blobs.forEach(([vector], i) => {
    cache.putMany("m", 4, [[`text ${i}`, vector]]);
  });
  cache.close();
  WRITE_GOLDEN.blobs.forEach(([, hex], i) => {
    expect(rawBlob(path, embedCacheKey("m", 4, `text ${i}`))).toBe(hex);
  });
});

test("a new file gets Python's table and WAL mode, in a folder created for it", () => {
  const path = join(dir, "nested", "cache", "embed_cache.db");
  new EmbedCache(path).close();
  const db = new Database(path);
  try {
    const sql = db.query("SELECT sql FROM sqlite_master WHERE name = 'embed_cache'").values();
    expect(sql).toEqual([[WRITE_GOLDEN.cache_file.sql]]);
    expect(db.query("PRAGMA journal_mode").values()).toEqual([
      [WRITE_GOLDEN.cache_file.journal_mode],
    ]);
  } finally {
    db.close();
  }
});

test("getMany finds hits by index across 500-key lookups, never another model's or size's", () => {
  const cache = new EmbedCache(join(dir, "embed_cache.db"));
  const texts = Array.from({ length: 1203 }, (_, i) => `text ${i}`);
  const stored = texts.flatMap((text, i) => (i % 3 === 0 ? [[text, [i, -i]] as const] : []));
  cache.putMany("m", 2, stored);
  const found = cache.getMany("m", 2, [...texts, "text 0", "absent"]);
  const expected = [...texts.keys()].filter((i) => i % 3 === 0).concat([1203]);
  expect([...found.keys()]).toEqual(expected);
  expect(found.get(1200)).toEqual(new Float32Array([1200, -1200]));
  expect(found.get(1203)).toEqual(new Float32Array([0, -0]));
  expect(cache.getMany("m", 3, ["text 0"]).size).toBe(0);
  expect(cache.getMany("other", 2, ["text 0"]).size).toBe(0);
  expect(cache.getMany("m", 2, []).size).toBe(0);
  cache.close();
});

test("putMany replaces an entry; count spans every model and dimension", () => {
  const cache = new EmbedCache(join(dir, "embed_cache.db"));
  cache.putMany("m", 2, [
    ["a", [1, 2]],
    ["b", [3, 4]],
  ]);
  cache.putMany("m", 2, [["a", new Float32Array([5, 6])]]);
  cache.putMany("n", 2, [["a", [7, 8]]]);
  cache.putMany("m", 2, []);
  expect(cache.count()).toBe(3);
  expect(cache.getMany("m", 2, ["a"]).get(0)).toEqual(new Float32Array([5, 6]));
  cache.close();
});

test("a batch that fails part way stores none of it", () => {
  const cache = new EmbedCache(join(dir, "embed_cache.db"));
  const broken = [
    ["a", [1, 2]],
    ["b", null as unknown as number[]],
  ] as const;
  expect(() => cache.putMany("m", 2, broken)).toThrow();
  expect(cache.count()).toBe(0);
  cache.close();
});

test("a write waits for another process's lock, as Python's 5 s timeout did", async () => {
  const path = join(dir, "embed_cache.db");
  const cache = new EmbedCache(path);
  const holder = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { Database } from "bun:sqlite";
       const db = new Database(${JSON.stringify(path)});
       db.exec("BEGIN IMMEDIATE");
       db.run("INSERT INTO embed_cache VALUES ('held', x'00000000')");
       console.log("locked");
       Bun.sleepSync(300);
       db.exec("COMMIT");`,
    ],
    { stdout: "pipe" },
  );
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
  const start = performance.now();
  cache.putMany("m", 1, [["a", [1]]]);
  expect(performance.now() - start).toBeGreaterThan(100);
  expect(await holder.exited).toBe(0);
  expect(cache.count()).toBe(2);
  cache.close();
});

test("clear deletes every vector, keeps the file another ingest may hold, and shrinks it", () => {
  const path = join(dir, "embed_cache.db");
  const cache = new EmbedCache(path);
  const other = new EmbedCache(path);
  const big = Array.from(
    { length: 200 },
    (_, i) => [`t${i}`, new Float32Array(3072).fill(i)] as const,
  );
  cache.putMany("m", 3072, big);
  other.putMany("n", 4, [["x", [1, 2, 3, 4]]]);
  expect(cache.clear()).toBe(201);
  expect(other.count()).toBe(0);
  other.putMany("n", 4, [["y", [1, 2, 3, 4]]]);
  expect(cache.count()).toBe(1);
  other.close();
  cache.close();
  expect(existsSync(path)).toBe(true);
  // 200 vectors of 12 KB each; what remains is a few pages.
  expect(statSync(path).size).toBeLessThan(100_000);
});
