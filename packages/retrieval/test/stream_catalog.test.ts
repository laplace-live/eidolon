// The loader parts of tests/test_stream_catalog.py. The fixtures were written by the Python
// build_catalog from that file's _write_part inputs; expected.json holds Python's outputs.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpLen } from "@eidolon/config";
import {
  CATALOG_FILENAME,
  clearCatalogCache,
  compactOverview,
  formatBroadcasts,
  resolveDbPath,
  StreamCatalog,
  warmStreamCatalog,
} from "../src/index.ts";
import { captureLogs } from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "catalog");
const expected = await Bun.file(join(FIXTURES, "expected.json")).json();

const records = captureLogs();
let dir: string;

function install(fixture: string, mtimeSec?: number): void {
  const target = join(dir, CATALOG_FILENAME);
  copyFileSync(join(FIXTURES, `${fixture}.json`), target);
  if (mtimeSec !== undefined) utimesSync(target, mtimeSec, mtimeSec);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-catalog-"));
  clearCatalogCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tests/test_stream_catalog.py", () => {
  test("parts grouped by date and BV load newest first", async () => {
    install("grouped");
    const catalog = new StreamCatalog(dir);
    const broadcasts = await catalog.broadcasts();
    expect(broadcasts.map((b) => b.id)).toEqual([
      "2026-09-09-BV1abc",
      "2026-09-08-BV2def",
      "2026-09-08-BV1abc",
    ]);
    const grouped = broadcasts.find((b) => b.id === "2026-09-08-BV1abc");
    expect(grouped?.streamIds).toEqual([1, 2, 10].map((i) => `2026-09-08-BV1abc_p${i}`));
    expect(grouped?.sourceChunkIds.length).toBe(3);
    expect((await catalog.recent(1))[0]?.streamDate).toBe("2026-09-09");
  });

  test("songs, anime and unrefined scenes remain in the catalog", async () => {
    install("songs");
    const [broadcast] = await new StreamCatalog(dir).broadcasts();
    if (broadcast === undefined) throw new Error("no broadcast");
    expect(broadcast.scenes.length).toBe(4);
    expect(broadcast.scenes[1]?.summary).toBe("Summary of karaoke 1");
    expect(broadcast.scenes[2]?.summary).toBe("Summary of anime_audio 2");
    expect(broadcast.scenes[2]?.timestamp).toBe("10:00");
    expect(broadcast.unrefinedCount).toBe(1);
    expect(broadcast.overview).toContain("唱歌");
    expect(broadcast.overview).toContain("动画播放");
    expect(compactOverview(broadcast.scenes, 1800)).toBe(broadcast.overview);
    const output = formatBroadcasts([broadcast]);
    expect(output).toContain("1段未精炼");
    expect(output).toContain("代表性摘录");
    expect(output).toBe(expected.songs_format);
  });

  test("select uses an exclusive end and resolves part or broadcast ids", async () => {
    install("select");
    const catalog = new StreamCatalog(dir);
    const selected = await catalog.select({ startDate: "2026-09-07", endDate: "2026-09-09" });
    expect(selected.map((b) => b.streamDate)).toEqual(["2026-09-08", "2026-09-07"]);
    const first = selected[0];
    if (first === undefined) throw new Error("nothing selected");
    expect(await catalog.select({ streamIds: [first.id] })).toEqual([first]);
    expect(await catalog.select({ streamIds: first.streamIds })).toEqual([first]);
    expect(await catalog.select({ streamIds: [] })).toEqual([]);
  });

  test("the cache refreshes after replacement and fails open", async () => {
    const catalog = new StreamCatalog(dir);
    expect(await catalog.broadcasts()).toEqual([]);
    install("one", 1_000);
    expect((await catalog.broadcasts()).length).toBe(1);
    install("two", 2_000);
    expect((await catalog.broadcasts()).length).toBe(2);
    writeFileSync(catalog.path, "{");
    utimesSync(catalog.path, 3_000, 3_000);
    expect(await catalog.broadcasts()).toEqual([]);
    expect(await catalog.broadcasts()).toEqual([]);
    install("two", 4_000);
    expect((await catalog.broadcasts()).length).toBe(2);
    unlinkSync(catalog.path);
    expect(await catalog.broadcasts()).toEqual([]);
    const warnings = records.filter((r) => r.level === "WARNING");
    expect(warnings.length).toBe(2);
    expect(warnings[0]?.message).toStartWith("Stream catalog unavailable: ");
    const missing = records.filter((r) => r.level === "DEBUG");
    expect(missing.map((r) => r.message)).toEqual([
      `Stream catalog unavailable: ${catalog.path}`,
      `Stream catalog unavailable: ${catalog.path}`,
    ]);
  });

  test("a weekly format includes every broadcast within budget", async () => {
    install("weekly");
    const broadcasts = await new StreamCatalog(dir).broadcasts();
    const output = formatBroadcasts(broadcasts, 4000);
    expect(cpLen(output)).toBeLessThanOrEqual(4000);
    for (const b of broadcasts) expect(output).toContain(b.id);
    expect(output.split("唱歌").length - 1).toBeGreaterThanOrEqual(7);
    expect(output.split("动画播放").length - 1).toBeGreaterThanOrEqual(7);
    for (const limit of [0, 1, 20, 100, 300]) {
      expect(cpLen(formatBroadcasts(broadcasts, limit))).toBeLessThanOrEqual(limit);
      expect(cpLen(formatBroadcasts([], limit))).toBeLessThanOrEqual(limit);
    }
    expect(formatBroadcasts(broadcasts, 300)).toContain("省略");
    for (const [limit, text] of Object.entries(expected.weekly_format)) {
      expect(formatBroadcasts(broadcasts, Number(limit))).toBe(text as string);
    }
    for (const [limit, text] of Object.entries(expected.empty_format)) {
      expect(formatBroadcasts([], Number(limit))).toBe(text as string);
    }
  });

  test("concurrent cold reads share one parse", async () => {
    install("one");
    const reads = spyOn(Bun, "file");
    try {
      const catalog = new StreamCatalog(dir);
      const [first, second, other] = await Promise.all([
        catalog.broadcasts(),
        catalog.broadcasts(),
        new StreamCatalog(dir).broadcasts(),
      ]);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(first.length).toBe(1);
      expect(second).toEqual(first);
      expect(other[0]).toBe(first[0] as (typeof first)[0]);
    } finally {
      reads.mockRestore();
    }
  });
});

describe("loader edges", () => {
  test("a missing key or wrong version warns", async () => {
    writeFileSync(
      join(dir, CATALOG_FILENAME),
      JSON.stringify({ schema_version: 2, broadcasts: [] }),
    );
    expect(await new StreamCatalog(dir).broadcasts()).toEqual([]);
    writeFileSync(join(dir, CATALOG_FILENAME), JSON.stringify({ schema_version: 1 }));
    utimesSync(join(dir, CATALOG_FILENAME), 5_000, 5_000);
    expect(await new StreamCatalog(dir).broadcasts()).toEqual([]);
    writeFileSync(
      join(dir, CATALOG_FILENAME),
      '{"schema_version": 1, "broadcasts": [{"id": "x"}]}',
    );
    utimesSync(join(dir, CATALOG_FILENAME), 6_000, 6_000);
    expect(await new StreamCatalog(dir).broadcasts()).toEqual([]);
    expect(records.filter((r) => r.level === "WARNING").map((r) => r.message)).toEqual([
      "Stream catalog unavailable: Unsupported stream catalog version",
      "Stream catalog unavailable: 'broadcasts'",
      "Stream catalog unavailable: 'stream_date'",
    ]);
  });

  test("optional keys default and a string stream_ids becomes characters", async () => {
    const entry = {
      id: "b",
      stream_date: "",
      stream_ids: "ab",
      overview: "o",
      source_chunk_ids: [],
    };
    writeFileSync(
      join(dir, CATALOG_FILENAME),
      JSON.stringify({ broadcasts: [entry], schema_version: 1 }),
    );
    const [b] = await new StreamCatalog(dir).broadcasts();
    expect(b).toEqual({
      id: "b",
      streamDate: "",
      streamIds: ["a", "b"],
      overview: "o",
      sourceChunkIds: [],
      scenes: [],
      sourcePaths: [],
      unrefinedCount: 0,
      overviewCompressed: false,
    });
    expect(formatBroadcasts(b ? [b] : [])).toContain("日期未知 [b] 2个录播分P/0段");
  });

  test("an undated broadcast never falls before an end date", async () => {
    const entry = { id: "b", stream_date: "", stream_ids: [], overview: "o", source_chunk_ids: [] };
    writeFileSync(
      join(dir, CATALOG_FILENAME),
      JSON.stringify({ schema_version: 1, broadcasts: [entry] }),
    );
    const catalog = new StreamCatalog(dir);
    expect(await catalog.select({ endDate: "2026-09-09" })).toEqual([]);
    expect((await catalog.select({})).length).toBe(1);
  });

  test("recent clamps a negative count, and exists() checks the file", async () => {
    const catalog = new StreamCatalog(dir);
    expect(catalog.exists()).toBe(false);
    install("select");
    expect(catalog.exists()).toBe(true);
    expect(await catalog.recent(-1)).toEqual([]);
    expect((await catalog.recent()).length).toBe(3);
  });

  test("warmStreamCatalog fills the shared cache", async () => {
    install("select");
    await warmStreamCatalog(dir);
    const reads = spyOn(Bun, "file");
    try {
      expect((await new StreamCatalog(dir).broadcasts()).length).toBe(3);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });
});

const realPath = join(resolveDbPath(), CATALOG_FILENAME);
const realBytes = existsSync(realPath) ? await Bun.file(realPath).bytes() : null;
// Python's goldens were printed for one catalog; a re-ingest changes it.
const sameAsGoldens =
  realBytes !== null &&
  createHash("sha1").update(realBytes).digest("hex") === expected.real_catalog_sha1;

describe("the committed catalog", () => {
  test.skipIf(realBytes === null)(
    "parses in slices; every stored overview recomputes",
    async () => {
      const yields = spyOn(globalThis, "setImmediate");
      let broadcasts: Awaited<ReturnType<StreamCatalog["broadcasts"]>>;
      try {
        broadcasts = await new StreamCatalog(resolveDbPath()).broadcasts();
        expect(yields).toHaveBeenCalled();
      } finally {
        yields.mockRestore();
      }
      expect(broadcasts.length).toBeGreaterThan(0);
      const differing = broadcasts.filter((b) => compactOverview(b.scenes, 1800) !== b.overview);
      expect(differing.map((b) => b.id)).toEqual([]);
    },
  );

  test.skipIf(!sameAsGoldens)("formatBroadcasts of the newest seven matches Python", async () => {
    const broadcasts = await new StreamCatalog(resolveDbPath()).broadcasts();
    expect(broadcasts.length).toBe(expected.real_count);
    const top7 = broadcasts.slice(0, 7);
    expect(top7.map((b) => b.id)).toEqual(expected.real_top7_ids);
    for (const [limit, [length, sha1]] of Object.entries(
      expected.real_top7 as Record<string, [number, string]>,
    )) {
      const text = formatBroadcasts(top7, Number(limit));
      expect([cpLen(text), createHash("sha1").update(text).digest("hex")]).toEqual([length, sha1]);
    }
  });
});
