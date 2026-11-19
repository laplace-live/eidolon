// laplace-discover: its flags, its JSON, and the batch it writes into the persona's lists.
import "../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFolder } from "@eidolon/config";
import { download } from "@eidolon/ingest";
import { fakeBilibili } from "../../../packages/ingest/test/discover_helpers.ts";
import { discoverMain } from "../src/index.ts";
import { blockNetwork, captureIo, captureLogs } from "./helpers.ts";

blockNetwork();

const SERIES = "https://space.bilibili.com/2132180406/lists/2484684?type=series";
const NOW = new Date("2026-11-19T21:00:00Z");
let logs!: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.stop();
  for (const folder of ["lists", "streams", "vods"] as const) {
    rmSync(sourceFolder("milky-green", folder), { recursive: true, force: true });
  }
});

/** Bilibili with her 直播回放 list, and a search whose long videos are `long`. */
function bilibili(long: readonly unknown[] = []) {
  return fakeBilibili({
    "/x/polymer/web-space/seasons_series_list": () => ({
      items_lists: {
        page: { page_num: 1, page_size: 20, total: 1 },
        series_list: [{ meta: { name: "直播回放", total: 2, series_id: 2484684 } }],
      },
    }),
    "/x/series/archives": () => ({
      archives: [
        {
          bvid: "BV1aaaaaaaa1",
          title: "【直播回放】新的 2026年11月19日19点场",
          duration: 7200,
          pubdate: Date.parse("2026-11-19T15:00:00Z") / 1000,
        },
        {
          bvid: "BV1aaaaaaaa2",
          title: "【直播回放】旧的 2026年11月17日20点场",
          duration: 3600,
          pubdate: Date.parse("2026-11-17T15:00:00Z") / 1000,
        },
      ],
      page: { total: 2 },
    }),
    "/x/web-interface/view": () => ({ owner: { mid: 2132180406, name: "明前奶绿" } }),
    "/x/web-interface/search/type": (url) =>
      url.searchParams.get("duration") === "4"
        ? { numPages: 1, result: long }
        : { numPages: 0, result: [] },
  });
}

/** Her lists: one batch, which names her 直播回放 list. */
function writeLists(): string {
  const lists = sourceFolder("milky-green", "lists");
  mkdirSync(join(lists, "batches"), { recursive: true });
  writeFileSync(join(lists, "video-full.txt"), "BV1aaaaaaaa2\n");
  writeFileSync(
    join(lists, "batches", "videos-2026-09-18-021237.txt"),
    `# Source: ${SERIES}\nhttps://www.bilibili.com/video/BV1zzzzzzzz1\n`,
  );
  return lists;
}

test("-h prints the help", async () => {
  const io = captureIo();
  expect(await discoverMain(["-h"], io.io)).toBe(0);
  expect(io.stdout()).toStartWith(
    "usage: laplace-discover [-h] [--channel URL] [--clips] [--min-minutes N]\n",
  );
  expect(io.stdout()).toContain("--save             Write the new videos into a new batch\n");
});

test("a channel, a page count or a length it can't use is a usage error", async () => {
  for (const [argv, error] of [
    [
      ["--channel", "https://example.com/x"],
      "argument --channel: not a Bilibili space or list, nor a YouTube channel: 'https://example.com/x'",
    ],
    [
      ["--channel", "https://space.bilibili.com/1/lists/x?type=series"],
      "argument --channel: not a Bilibili space or list, nor a YouTube channel: 'https://space.bilibili.com/1/lists/x?type=series'",
    ],
    [["--pages", "0"], "argument --pages: must be from 1 to 50"],
    [["--pages", "51"], "argument --pages: must be from 1 to 50"],
    [["--min-minutes", "0"], "argument --min-minutes: must be at least 1"],
    [["--pages", "x"], "argument --pages: invalid int value: 'x'"],
    [
      ["--skip", "https://space.bilibili.com/100"],
      "argument --skip: not a Bilibili or YouTube video: 'https://space.bilibili.com/100'",
    ],
  ] as const) {
    const io = captureIo();
    expect([argv, await discoverMain(argv, io.io)]).toEqual([argv, 2]);
    expect(io.stderr()).toStartWith("usage: laplace-discover [-h]");
    expect(io.stderr().trimEnd().split("\n").at(-1)).toBe(`laplace-discover: error: ${error}`);
  }
});

test("prints what is new as JSON, and --save writes it into the persona's lists", async () => {
  const lists = writeLists();
  const io = captureIo();
  const options = { bilibili: { fetch: bilibili().fetch, pauseMs: 0 }, now: () => NOW };
  expect(await discoverMain(["--save"], { ...io.io, options })).toBe(0);
  const batch = join(lists, "batches", download.batchName(NOW));
  expect(JSON.parse(io.stdout())).toEqual({
    persona: { id: "milky-green", name: "明前奶绿" },
    channels: [
      {
        url: SERIES,
        site: "bilibili",
        from: "batch",
        name: "明前奶绿",
        list: "直播回放",
        videos: 2,
      },
    ],
    candidates: [],
    official: {
      count: 1,
      hours: 2,
      videos: [
        {
          url: "https://www.bilibili.com/video/BV1aaaaaaaa1",
          title: "【直播回放】新的 2026年11月19日19点场",
          date: "2026-11-19",
          minutes: 120,
          uploader: "明前奶绿",
        },
      ],
    },
    recordings: { count: 0, hours: 0, videos: [] },
    clips: { count: 0, hours: 0, videos: [] },
    known: 2,
    batch,
    warnings: [],
  });
  // A video to a line, so a long list stays within what a task's command shows.
  expect(io.stdout()).toContain(
    '\n    "videos": [\n      {"url":"https://www.bilibili.com/video/BV1aaaaaaaa1",' +
      '"title":"【直播回放】新的 2026年11月19日19点场","date":"2026-11-19","minutes":120,' +
      '"uploader":"明前奶绿"}\n    ]\n',
  );
  expect(io.stdout()).toEndWith('\n  "warnings": []\n}\n');
  expect(readFileSync(batch, "utf8")).toBe(
    [
      `# Source: ${SERIES}`,
      `# Captured: ${download.localIsoSeconds(NOW)}`,
      "# Official: 1; recordings: 0; clips: 0",
      "https://www.bilibili.com/video/BV1aaaaaaaa1",
      "",
    ].join("\n"),
  );
});

test("a transcript is dated by its info.json in the persona's vods", async () => {
  writeLists();
  // Uploaded on the 13th, of the 12th's stream.
  const streams = sourceFolder("milky-green", "streams");
  const vods = sourceFolder("milky-green", "vods");
  mkdirSync(streams, { recursive: true });
  mkdirSync(vods, { recursive: true });
  writeFileSync(join(streams, "2026-11-13-BV1qqqqqqq01.md"), "---\nduration_min: 120\n---\n");
  writeFileSync(
    join(vods, "BV1qqqqqqq01.info.json"),
    JSON.stringify({ title: "【明前奶绿】 2026年11月12日20点场" }),
  );
  const recording = (bvid: string, day: number) => ({
    bvid,
    mid: 9,
    author: "搬运",
    title: `【明前奶绿】 2026年11月${day}日20点场`,
    duration: "150:0",
    pubdate: Date.parse(`2026-11-${day}T15:00:00Z`) / 1000,
  });
  const io = captureIo();
  const options = {
    bilibili: {
      fetch: bilibili([recording("BV1rrrrrrr13", 13), recording("BV1rrrrrrr12", 12)]).fetch,
      pauseMs: 0,
    },
  };
  expect(await discoverMain([], { ...io.io, options })).toBe(0);
  const found = JSON.parse(io.stdout()) as { recordings: { videos: { url: string }[] } };
  expect(found.recordings.videos.map(({ url }) => url)).toEqual([
    "https://www.bilibili.com/video/BV1rrrrrrr13",
  ]);
});

test("a list it can't read prints why and exits 1", async () => {
  const lists = sourceFolder("milky-green", "lists");
  mkdirSync(lists, { recursive: true });
  writeFileSync(join(lists, "video-full.txt"), "https://space.bilibili.com/1\n");
  const io = captureIo();
  const options = { bilibili: { fetch: bilibili().fetch, pauseMs: 0 } };
  expect(await discoverMain([], { ...io.io, options })).toBe(1);
  expect(io.stderr()).toBe(
    `${join(lists, "video-full.txt")}:1: expected a BV ID or Bilibili video URL\n`,
  );
  expect(io.stdout()).toBe("");
});
