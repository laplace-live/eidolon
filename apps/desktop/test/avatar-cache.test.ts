// Notification avatar disk cache: fetches 256x256 PNGs from the ready backend, deduplicates by
// SHA-256 on disk, evicts old entries without deleting files shared by another key, and fails open.
import { hash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type AvatarBackendFetch, NotificationAvatarCache } from "../src/main/avatar-cache.ts";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "eidolon-avatar-cache-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function pngBytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(`\x89PNG\r\n\x1a\n${tag}`));
}

describe("NotificationAvatarCache", () => {
  test("fetches single and group avatars, caches by content SHA-256, and skips rewrite on same bytes", async () => {
    const requests: string[] = [];
    const lines: string[] = [];
    const responses = new Map<string, Uint8Array>([
      ["/api/local/personas/milky-green/notification-avatar", pngBytes("milky")],
      ["/api/local/personas/milky-green/notification-avatar?group=rin,kuro", pngBytes("group")],
    ]);
    const fetch: AvatarBackendFetch = async (path) => {
      requests.push(path);
      const body = responses.get(path);
      if (body === undefined) return new Response(null, { status: 404 });
      return new Response(Buffer.from(body), { status: 200 });
    };
    const cache = new NotificationAvatarCache({
      folder,
      fetch,
      log: {
        info: (m) => lines.push(`info ${m}`),
        warn: (m) => lines.push(`warn ${m}`),
      },
    });

    const single = await cache.resolve("milky-green");
    expect(single).toBe(join(folder, `${hash("sha256", pngBytes("milky"), "hex")}.png`));
    expect(readFileSync(single as string)).toEqual(Buffer.from(pngBytes("milky")));

    // Deduplicates, strips self, slices to 2 peers, and rejects invalid ids.
    const group = await cache.resolve("milky-green", ["milky-green", "rin", "rin", "kuro", "z"]);
    expect(group).toBe(join(folder, `${hash("sha256", pngBytes("group"), "hex")}.png`));
    expect(await cache.resolve("InvalidId")).toBeNull();
    expect(await cache.resolve("milky-green", ["../bad"])).toBeNull();
    expect(requests).toEqual([
      "/api/local/personas/milky-green/notification-avatar",
      "/api/local/personas/milky-green/notification-avatar?group=rin,kuro",
    ]);

    // Updated avatar bytes produce a new file path by new SHA-256 and unlink the superseded file.
    responses.set("/api/local/personas/milky-green/notification-avatar", pngBytes("milky-v2"));
    const updated = await cache.resolve("milky-green");
    expect(updated).not.toBe(single);
    expect(existsSync(single as string)).toBe(false);
    expect(existsSync(updated as string)).toBe(true);
    expect(lines).toEqual([]);
  });

  test("fails open, logs once per streak, and falls back to last known file when fetch fails", async () => {
    let fail = false;
    const lines: string[] = [];
    const fetch: AvatarBackendFetch = async () => {
      if (fail) return new Response(null, { status: 503 });
      return new Response(Buffer.from(pngBytes("ok")), { status: 200 });
    };
    const cache = new NotificationAvatarCache({
      folder,
      fetch,
      log: {
        info: (m) => lines.push(`info ${m}`),
        warn: (m) => lines.push(`warn ${m}`),
      },
    });

    fail = true;
    expect(await cache.resolve("unseen")).toBeNull();
    expect(await cache.resolve("unseen")).toBeNull();
    expect(lines).toEqual([
      "warn Eidolon: notifications couldn't read an avatar: GET /api/local/personas/unseen/notification-avatar answered 503",
    ]);

    fail = false;
    const okPath = await cache.resolve("milky-green");
    expect(okPath).not.toBeNull();
    expect(lines.at(-1)).toBe("info Eidolon: notifications read avatars again");

    // Once cached, a temporary failure returns the existing cached path.
    fail = true;
    expect(await cache.resolve("milky-green")).toBe(okPath);
  });

  test("evicts oldest cache entries past maxEntries while preserving files shared by another key", async () => {
    const shared = pngBytes("silhouette");
    const uniqueA = pngBytes("a");
    const uniqueB = pngBytes("b");
    const bodies = new Map([
      ["/api/local/personas/a/notification-avatar", uniqueA],
      ["/api/local/personas/b/notification-avatar", uniqueB],
      ["/api/local/personas/c/notification-avatar", shared],
      ["/api/local/personas/d/notification-avatar", shared],
    ]);
    const cache = new NotificationAvatarCache({
      folder,
      maxEntries: 2,
      fetch: async (path) => new Response(Buffer.from(bodies.get(path) ?? shared), { status: 200 }),
      log: { info: () => {}, warn: () => {} },
    });

    const pathC = (await cache.resolve("c")) as string;
    const pathD = (await cache.resolve("d")) as string;
    expect(pathC).toBe(pathD);

    // Resolving "a" evicts "c", but "d" still uses `pathC`, so `pathC` stays on disk.
    const pathA = (await cache.resolve("a")) as string;
    expect(existsSync(pathC)).toBe(true);
    expect(existsSync(pathA)).toBe(true);

    // Resolving "b" evicts "d" (last user of `pathC`), removing `pathC` from disk.
    const pathB = (await cache.resolve("b")) as string;
    expect(existsSync(pathC)).toBe(false);
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
    expect(readdirSync(folder).sort()).toHaveLength(2);
  });

  test("prunes leftover temp files and excess PNGs from prior launches oldest-first", async () => {
    const { mkdirSync, utimesSync, writeFileSync } = await import("node:fs");
    mkdirSync(folder, { recursive: true });
    const oldPng = join(folder, "111.png");
    const midPng = join(folder, "222.png");
    const newPng = join(folder, "333.png");
    const temp = join(folder, "999.tmp");
    writeFileSync(oldPng, pngBytes("1"));
    writeFileSync(midPng, pngBytes("2"));
    writeFileSync(newPng, pngBytes("3"));
    writeFileSync(temp, "partial");
    utimesSync(oldPng, 1_000, 1_000);
    utimesSync(midPng, 2_000, 2_000);
    utimesSync(newPng, 3_000, 3_000);

    const cache = new NotificationAvatarCache({
      folder,
      maxEntries: 2,
      fetch: async () => new Response(Buffer.from(pngBytes("fresh")), { status: 200 }),
      log: { info: () => {}, warn: () => {} },
    });
    const fresh = await cache.resolve("fresh");
    expect(existsSync(fresh as string)).toBe(true);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(oldPng)).toBe(false);
    expect(existsSync(midPng)).toBe(false);
    expect(existsSync(newPng)).toBe(true);
    expect(readdirSync(folder)).toHaveLength(2);
  });

  test("coordinates concurrent same-hash fetches and evictions without deleting returned files", async () => {
    const shared = pngBytes("shared");
    const bodies = new Map([
      ["/api/local/personas/a/notification-avatar", shared],
      ["/api/local/personas/b/notification-avatar", pngBytes("b")],
      ["/api/local/personas/c/notification-avatar", pngBytes("c")],
      ["/api/local/personas/d/notification-avatar", shared],
    ]);
    const cache = new NotificationAvatarCache({
      folder,
      maxEntries: 2,
      fetch: async (path) => new Response(Buffer.from(bodies.get(path) ?? shared), { status: 200 }),
      log: { info: () => {}, warn: () => {} },
    });

    await cache.resolve("a");
    await cache.resolve("b");
    const [pathC, pathD] = await Promise.all([cache.resolve("c"), cache.resolve("d")]);
    expect(existsSync(pathC as string)).toBe(true);
    expect(existsSync(pathD as string)).toBe(true);
    expect(readdirSync(folder)).toHaveLength(2);
  });
});
