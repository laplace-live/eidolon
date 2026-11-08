// batches.ts against the download golden's prepare cases (download_helpers.ts). The golden's data/
// is the persona's lists/ here and data/auto-embed/ its lists/batches/.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { download } from "../src/index.ts";
import { downloadGolden as golden, type PrepareGolden } from "./download_helpers.ts";

const ARCHIVE_URL = "https://space.bilibili.com/2132180406/lists/2484684?type=series";
// The golden's clock: 2026-09-08 10:02:09 in Los Angeles.
const NOW = new Date("2026-09-08T17:02:09Z");

let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

let work = "";
let lists = "";
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "ingest-batches-")));
  lists = join(work, "lists");
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A golden fixture's path, where this layout keeps it. */
function moved(path: string): string {
  if (path.startsWith("data/auto-embed/")) return join(lists, "batches", path.slice(16));
  if (path.startsWith("data/")) return join(lists, path.slice(5));
  return join(work, path);
}

function placeFixtures(c: PrepareGolden): void {
  const files: Record<string, string | { b64: string }> = { ...golden.prepare_files, ...c.extra };
  for (const name of c.drop ?? []) delete files[name];
  for (const [name, content] of Object.entries(files)) {
    const path = moved(name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : Buffer.from(content.b64, "base64"));
  }
}

/** The golden's text with its paths moved into this layout. */
function relocate(text: string): string {
  return text
    .replaceAll("<WORK>/data/auto-embed/", `${lists}/batches/`)
    .replaceAll("<WORK>/data/", `${lists}/`)
    .replaceAll("<WORK>/", `${work}/`);
}

describe("prepareBatch against prepare_batch.py", () => {
  for (const c of golden.prepare) {
    test(c.name, () => {
      placeFixtures(c);
      let result: unknown = null;
      let error: string | null = null;
      try {
        result = download.prepareBatch(lists, join(work, c.capture), c.expected, {
          dryRun: c.dry_run,
          source: ARCHIVE_URL,
          now: NOW,
        });
      } catch (caught) {
        error = (caught as Error).message;
      }
      const expectedError =
        c.name === "no-baselines"
          ? // Not the golden's message: the lists are the persona's, which --persona picks.
            `No prepared URL lists found in ${lists}; check --persona`
          : c.error === null
            ? null
            : relocate(c.error);
      expect(error).toBe(expectedError);
      expect(result).toEqual(
        c.result === null ? null : JSON.parse(relocate(JSON.stringify(c.result))),
      );
      const created = (result as download.PrepareBatchResult | null)?.created_batch;
      expect(created ? readFileSync(created, "utf8") : null).toBe(c.created_text);
    });
  }
});

describe("lists", () => {
  test("another site's URL is a key as written; Bilibili's other hosts stay errors [AD]", () => {
    expect(download.listKey("https://www.youtube.com/watch?v=abc")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
    for (const value of [
      "HTTP://Example.COM/x",
      "http://localhost:8080/a.m4a",
      "https://[::1]/x",
    ]) {
      expect(download.listKey(value)).toBe(value);
    }
    expect(download.listKey("//www.bilibili.com/video/BV1aaaaaaaa1/")).toBe("BV1aaaaaaaa1");
    for (const value of [
      "https://m.bilibili.com/video/BV1aaaaaaaa1",
      "https://space.bilibili.com/2132180406",
      "https://b23.tv/AbCdEf1",
      "https://www.bilibili.com/list/BV1aaaaaaaa1",
      "ftp://example.com/x",
      "https:///x",
      "example.com/x",
    ]) {
      expect([value, download.listKey(value)]).toEqual([value, null]);
    }
  });

  test("every *.txt in lists/ counts, dotfiles don't, and a batch line keeps its URL", () => {
    mkdirSync(join(lists, "batches"), { recursive: true });
    writeFileSync(join(lists, "youtube.txt"), "https://www.youtube.com/watch?v=abc\n");
    writeFileSync(join(lists, "._youtube.txt"), Buffer.from([0x00, 0x05, 0xff]));
    writeFileSync(join(lists, "notes.md"), "BV1zzzzzzzz9\n");
    writeFileSync(join(lists, "batches", "videos-2026-01-01-000000.txt"), "BV1aaaaaaaa1\n");
    writeFileSync(join(lists, "batches", "extra.txt"), "BV1zzzzzzzz8\n");
    expect(download.baselineLists(lists)).toEqual([join(lists, "youtube.txt")]);
    expect(download.knownIds(lists)).toEqual(
      new Set(["https://www.youtube.com/watch?v=abc", "BV1aaaaaaaa1"]),
    );
    const path = download.writeBatch(
      lists,
      ["BV1bbbbbbbb1", "https://www.youtube.com/watch?v=new"],
      ["Captured: now"],
      NOW,
    );
    expect(path).toBe(join(lists, "batches", "videos-2026-09-08-100209.txt"));
    expect(readFileSync(path, "utf8")).toBe(
      "# Captured: now\nhttps://www.bilibili.com/video/BV1bbbbbbbb1\n" +
        "https://www.youtube.com/watch?v=new\n",
    );
    expect(download.readIds(path)).toEqual(["BV1bbbbbbbb1", "https://www.youtube.com/watch?v=new"]);
  });

  test("without --source a batch has no Source line [AD]", () => {
    writeFileSync(join(work, "capture.txt"), "BV1cccccccc1\n");
    mkdirSync(lists);
    writeFileSync(join(lists, "video-full.txt"), "BV1aaaaaaaa1\n");
    const result = download.prepareBatch(lists, join(work, "capture.txt"), 1, { now: NOW });
    expect(readFileSync(result.created_batch as string, "utf8")).toBe(
      "# Captured: 2026-09-08T10:02:09-07:00\n# Archive total: 1; new BV IDs: 1\n" +
        "https://www.bilibili.com/video/BV1cccccccc1\n",
    );
  });

  test("a batch stays pending until its .done.json is written", () => {
    mkdirSync(lists);
    const batch = download.writeBatch(lists, ["BV1aaaaaaaa1"], [], NOW);
    expect(download.pendingBatches(lists)).toEqual([batch]);
    download.writeBatchDone(batch, {
      finishedAt: "2026-09-08T18:00:00.000Z",
      ids: ["BV1aaaaaaaa1"],
      parts: ["BV1aaaaaaaa1_p1", "BV1aaaaaaaa1_p2"],
      exitCode: 0,
    });
    expect(download.pendingBatches(lists)).toEqual([]);
    expect(download.batchDonePath(batch)).toBe(batch.replace(/\.txt$/, ".done.json"));
    expect(JSON.parse(readFileSync(download.batchDonePath(batch), "utf8"))).toEqual({
      finishedAt: "2026-09-08T18:00:00.000Z",
      ids: ["BV1aaaaaaaa1"],
      parts: ["BV1aaaaaaaa1_p1", "BV1aaaaaaaa1_p2"],
      exitCode: 0,
    });
    expect(readdirSync(join(lists, "batches")).sort()).toEqual([
      "videos-2026-09-08-100209.done.json",
      "videos-2026-09-08-100209.txt",
    ]);
  });

  test("local time with its offset, as datetime.astimezone() prints it", () => {
    expect(download.localIsoSeconds(NOW)).toBe("2026-09-08T10:02:09-07:00");
    expect(download.batchName(NOW)).toBe("videos-2026-09-08-100209.txt");
    const saved = process.env.TZ;
    try {
      process.env.TZ = "Asia/Kolkata";
      expect(download.localIsoSeconds(NOW)).toBe("2026-09-08T22:32:09+05:30");
      process.env.TZ = "UTC";
      expect(download.localIsoSeconds(NOW)).toBe("2026-09-08T17:02:09+00:00");
    } finally {
      process.env.TZ = saved;
    }
    expect(existsSync(lists)).toBe(false);
  });
});
