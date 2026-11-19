// laplace-discover's library against a fake Bilibili and a fake yt-dlp: channels from arguments
// and batches, the three tiers, what her lists and transcripts already cover, and the batch.
import "../../config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, logger, setLogLevel } from "@eidolon/config";
import { discover, download } from "../src/index.ts";
import { fakeBilibili, type Route } from "./discover_helpers.ts";

let work = "";
let lists = "";
let streams = "";
let vods = "";
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ingest-discover-"));
  lists = join(work, "lists");
  streams = join(work, "streams");
  vods = join(work, "vods");
  mkdirSync(join(lists, "batches"), { recursive: true });
  mkdirSync(streams);
  mkdirSync(vods);
  logger.setSink(() => {});
});
afterEach(() => {
  logger.setSink(consoleSink);
  setLogLevel("DEBUG");
  rmSync(work, { recursive: true, force: true });
});

const PERSONA = { id: "test", name: "明前奶绿", shortName: "奶绿" };
const SPACE = "100";
const SERIES = "https://space.bilibili.com/100/lists/7?type=series";
/** Unix seconds of a UTC time. */
const at = (iso: string): number => Date.parse(iso) / 1000;

function archive(bvid: string, title: string, minutes: number, pubdate: string) {
  return { bvid, title, duration: minutes * 60, pubdate: at(pubdate), upMid: 100 };
}

function result(
  bvid: string,
  mid: number,
  author: string,
  title: string,
  duration: string,
  pubdate: string,
) {
  return { bvid, mid, author, title, duration, pubdate: at(pubdate), type: "video" };
}

const OFFICIAL = [
  archive("BV1aaaaaaaa1", "【直播回放】新的 2026年11月19日19点场", 120, "2026-11-19T15:00:00Z"),
  archive("BV1aaaaaaaa2", "【直播回放】旧的 2026年11月17日20点场", 60, "2026-11-17T15:00:00Z"),
  archive("BV1aaaaaaaa3", "【直播回放】短的 2026年11月16日20点场", 20, "2026-11-16T13:00:00Z"),
];

const LONG = [
  result(
    "BV1bbbbbbbb1",
    200,
    "恩仙仙",
    '【<em class="keyword">明前奶绿</em>】录播 2026年11月18日22点场',
    "290:59",
    "2026-11-18T18:00:00Z",
  ),
  result(
    "BV1bbbbbbbb2",
    201,
    "fall丶秋",
    "[明前奶绿/直播回放] 2026年11月18日 2201开播（弹幕版）",
    "583:45",
    "2026-11-18T20:00:00Z",
  ),
  result(
    "BV1bbbbbbbb3",
    200,
    "恩仙仙",
    "【明前奶绿】 2026年11月19日19点场",
    "120:0",
    "2026-11-19T16:00:00Z",
  ),
  // Dated by its upload alone, the night after the official 11-19 stream: that stream's copy.
  result("BV1bbbbbbbb4", 202, "路人", "奶绿的一天 &amp; 夜", "100:0", "2026-11-19T17:00:00Z"),
  result(
    "BV1bbbbbbbb5",
    100,
    "明前奶绿",
    "【明前奶绿】特别直播 2026年11月15日",
    "180:0",
    "2026-11-15T14:00:00Z",
  ),
  result("BV1bbbbbbbb6", 203, "别人", "无关视频", "90:0", "2026-11-15T14:00:00Z"),
  result(
    "BV1bbbbbbbb7",
    200,
    "恩仙仙",
    "【明前奶绿】 2026年11月10日20点场",
    "150:0",
    "2026-11-10T15:00:00Z",
  ),
  result(
    "BV1bbbbbbbb8",
    200,
    "恩仙仙",
    "【明前奶绿】 2026年11月09日20点场",
    "150:0",
    "2026-11-09T15:00:00Z",
  ),
  result(
    "BV1bbbbbbbb9",
    200,
    "恩仙仙",
    "【明前奶绿】 2026年11月08日20点场",
    "150:0",
    "2026-11-08T15:00:00Z",
  ),
  result(
    "BV1bbbbbbbc1",
    201,
    "fall丶秋",
    "【明前奶绿】 2026年11月08日 2000开播",
    "200:0",
    "2026-11-08T16:00:00Z",
  ),
];

const ALL = [
  result("BV1cccccccc1", 204, "剪辑", "奶绿名场面", "3:21", "2026-11-19T10:00:00Z"),
  result("BV1cccccccc2", 100, "明前奶绿", "明前奶绿 新衣回 预告", "1:0", "2026-11-18T10:00:00Z"),
  LONG[0],
  result("BV1cccccccc3", 204, "剪辑", "奶绿 旧切片", "5:0", "2026-11-17T10:00:00Z"),
];

function routes(overrides: Readonly<Record<string, Route>> = {}): Record<string, Route> {
  return {
    "/x/polymer/web-space/seasons_series_list": () => ({
      items_lists: { series_list: [{ meta: { name: "直播回放", total: 3, series_id: 7 } }] },
    }),
    "/x/series/archives": () => ({ archives: OFFICIAL, page: { num: 1, size: 100, total: 3 } }),
    "/x/web-interface/view": () => ({ owner: { mid: 100, name: "明前奶绿" } }),
    "/x/web-interface/search/type": (url) =>
      url.searchParams.get("search_type") === "bili_user"
        ? { result: [] }
        : { numPages: 1, result: url.searchParams.get("duration") === "4" ? LONG : ALL },
    ...overrides,
  };
}

interface Stream {
  readonly id: string;
  readonly title: string;
  readonly duration?: number;
  readonly live_status: string;
}

const STREAMS: readonly Stream[] = [
  { id: "AAAAAAAAAA1", title: "past", duration: 7200, live_status: "was_live" },
  { id: "AAAAAAAAAA2", title: "soon", live_status: "is_upcoming" },
  { id: "AAAAAAAAAA3", title: "listed", duration: 3600, live_status: "was_live" },
];

/** yt-dlp options whose yt-dlp lists `streams` as a channel's /streams tab, as --flat-playlist prints it. */
function youtube(streams: readonly Stream[] = STREAMS): discover.DiscoverOptions["expand"] {
  const dir = mkdtempSync(join(work, "yt-dlp-"));
  const listing = join(dir, "streams.jsonl");
  writeFileSync(
    listing,
    streams
      .map(({ id, ...rest }) =>
        JSON.stringify({ webpage_url: `https://www.youtube.com/watch?v=${id}`, id, ...rest }),
      )
      .join("\n"),
  );
  const path = join(dir, "yt-dlp");
  writeFileSync(
    path,
    `#!/bin/sh
for arg in "$@"; do url=$arg; done
case $url in
  */streams) cat '${listing}' ;;
  *) echo "ERROR: unexpected $url" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return { ytDlp: { path, source: "setting" }, cookiesFromBrowser: null, cookiesFile: null };
}

function writeLists(): void {
  writeFileSync(
    join(lists, "video-full.txt"),
    ["BV1aaaaaaaa2", "BV1bbbbbbbb9", "BV1cccccccc3", "https://youtu.be/AAAAAAAAAA3", ""].join("\n"),
  );
  writeFileSync(
    join(lists, "batches", "videos-2026-11-01-000000.txt"),
    `# Source: ${SERIES}\n# Source: Eidolon's web app\nhttps://www.bilibili.com/video/BV1zzzzzzzz1\n`,
  );
  // A full stream's transcript covers its day; a clip's doesn't.
  writeFileSync(
    join(streams, "2026-11-10-BV1x.md"),
    "---\nstream_date: 2026-11-10\nduration_min: 150\n---\n",
  );
  writeFileSync(
    join(streams, "2026-11-09-BV1y.md"),
    "---\nstream_date: 2026-11-09\nduration_min: 1\n---\n",
  );
}

function options(
  fetch: typeof globalThis.fetch,
  extra: Partial<discover.DiscoverOptions> = {},
): discover.DiscoverOptions {
  return {
    persona: PERSONA,
    listsDir: lists,
    streamsDir: streams,
    vodsDir: vods,
    timeZone: "Asia/Shanghai",
    bilibili: { fetch, pauseMs: 0 },
    expand: youtube(),
    ...extra,
  };
}

/** routes() with a search whose long videos are `long`, and no other video or user. */
function searching(long: readonly unknown[]): Record<string, Route> {
  return routes({
    "/x/web-interface/search/type": (url) =>
      url.searchParams.get("search_type") === "bili_user"
        ? { result: [] }
        : { numPages: 1, result: url.searchParams.get("duration") === "4" ? long : [] },
  });
}

const video = (
  url: string,
  title: string,
  date: string | null,
  minutes: number,
  uploader: string,
) => ({
  url,
  title,
  date,
  minutes,
  uploader,
});

describe("discoverVideos", () => {
  test("her official streams first, others' recordings of the days they miss, then clips", async () => {
    writeLists();
    const bilibili = fakeBilibili(routes());
    const found = await discover.discoverVideos(
      options(bilibili.fetch, { channels: ["https://www.youtube.com/@milky/videos"] }),
    );
    expect(found).toEqual({
      persona: { id: "test", name: "明前奶绿" },
      channels: [
        {
          url: "https://www.youtube.com/@milky",
          site: "youtube",
          from: "argument",
          name: "@milky",
          videos: 2,
        },
        {
          url: SERIES,
          site: "bilibili",
          from: "batch",
          name: "明前奶绿",
          list: "直播回放",
          videos: 3,
        },
      ],
      candidates: [],
      official: {
        count: 4,
        hours: 7.3,
        videos: [
          video(
            "https://www.bilibili.com/video/BV1aaaaaaaa1",
            "【直播回放】新的 2026年11月19日19点场",
            "2026-11-19",
            120,
            "明前奶绿",
          ),
          video(
            "https://www.bilibili.com/video/BV1aaaaaaaa3",
            "【直播回放】短的 2026年11月16日20点场",
            "2026-11-16",
            20,
            "明前奶绿",
          ),
          video(
            "https://www.bilibili.com/video/BV1bbbbbbbb5",
            "【明前奶绿】特别直播 2026年11月15日",
            "2026-11-15",
            180,
            "明前奶绿",
          ),
          video("https://www.youtube.com/watch?v=AAAAAAAAAA1", "past", null, 120, "@milky"),
        ],
      },
      recordings: {
        count: 2,
        hours: 7.3,
        videos: [
          video(
            "https://www.bilibili.com/video/BV1bbbbbbbb1",
            "【明前奶绿】录播 2026年11月18日22点场",
            "2026-11-18",
            291,
            "恩仙仙",
          ),
          video(
            "https://www.bilibili.com/video/BV1bbbbbbbb8",
            "【明前奶绿】 2026年11月09日20点场",
            "2026-11-09",
            150,
            "恩仙仙",
          ),
        ],
      },
      clips: { count: 2, hours: 0.1, videos: [] },
      known: 5,
      batch: null,
      warnings: [],
    });
    const paths = bilibili.sent.map(({ url }) => url.pathname);
    expect(paths.filter((path) => path === "/")).toHaveLength(1);
    for (const { url, cookie } of bilibili.sent.slice(1)) {
      expect([url.pathname, cookie]).toEqual([
        url.pathname,
        "buvid3=ABC-123infoc; b_nut=1795000000",
      ]);
    }
    const series = bilibili.sent.find(({ url }) => url.pathname === "/x/series/archives");
    expect(series?.referer).toBe("https://space.bilibili.com/100");
    expect(Object.fromEntries(series?.url.searchParams ?? [])).toEqual({
      mid: "100",
      series_id: "7",
      pn: "1",
      ps: "100",
      sort: "desc",
    });
    const searches = bilibili.sent.filter(
      ({ url }) => url.pathname === "/x/web-interface/search/type",
    );
    expect(searches.map(({ url }) => url.searchParams.get("duration"))).toEqual(["4", null]);
    expect(searches.every(({ referer }) => referer === "https://search.bilibili.com/all")).toBe(
      true,
    );
  });

  test("--save writes one batch, official first, naming the channels that listed", async () => {
    writeLists();
    const now = new Date("2026-11-19T21:00:00Z");
    const found = await discover.discoverVideos(
      options(fakeBilibili(routes()).fetch, {
        channels: ["https://www.youtube.com/@milky"],
        clips: true,
        save: true,
        now: () => now,
      }),
    );
    expect(found.clips.videos.map((each) => each.url)).toEqual([
      "https://www.bilibili.com/video/BV1cccccccc1",
      "https://www.bilibili.com/video/BV1cccccccc2",
    ]);
    const batch = found.batch as string;
    expect(batch).toBe(join(lists, "batches", download.batchName(now)));
    const lines = readFileSync(batch, "utf8").split("\n");
    expect(lines.slice(0, 6)).toEqual([
      "# Source: https://www.youtube.com/@milky",
      `# Source: ${SERIES}`,
      `# Captured: ${download.localIsoSeconds(now)}`,
      "# Official: 4; recordings: 2; clips: 2",
      "# Covers: 2026-11-18 https://www.bilibili.com/video/BV1bbbbbbbb1",
      "# Covers: 2026-11-09 https://www.bilibili.com/video/BV1bbbbbbbb8",
    ]);
    const saved = [
      "https://www.bilibili.com/video/BV1aaaaaaaa1",
      "https://www.bilibili.com/video/BV1aaaaaaaa3",
      "https://www.bilibili.com/video/BV1bbbbbbbb5",
      "https://www.youtube.com/watch?v=AAAAAAAAAA1",
      "https://www.bilibili.com/video/BV1bbbbbbbb1",
      "https://www.bilibili.com/video/BV1bbbbbbbb8",
      "https://www.bilibili.com/video/BV1cccccccc1",
      "https://www.bilibili.com/video/BV1cccccccc2",
    ];
    expect(lines.slice(6, -1)).toEqual(saved);
    // What reads a list's videos reads past the header.
    const keys = saved.map((url) => download.listKey(url) as string);
    expect(download.readIds(batch)).toEqual(keys);
    expect([...download.knownIds(lists)]).toEqual(expect.arrayContaining(keys));
    const capture = join(work, "capture.txt");
    writeFileSync(capture, "BV1aaaaaaaa1\nBV1zzzzzzzz9\n");
    expect(download.prepareBatch(lists, capture, 2, { dryRun: true }).new_ids).toEqual([
      "BV1zzzzzzzz9",
    ]);

    // Run again: the batch is a list like the others, and remembers the YouTube channel.
    const again = await discover.discoverVideos(
      options(fakeBilibili(routes()).fetch, { save: true, now: () => now }),
    );
    expect(again.channels.map(({ url, from }) => [url, from])).toEqual([
      [SERIES, "batch"],
      ["https://www.youtube.com/@milky", "batch"],
    ]);
    expect([again.official.count, again.recordings.count, again.clips.count, again.batch]).toEqual([
      0,
      0,
      0,
      null,
    ]);
  });

  test("a video skipped is in no tier and no batch, and another recording takes its day", async () => {
    writeLists();
    const now = new Date("2026-11-19T21:00:00Z");
    const found = await discover.discoverVideos(
      options(fakeBilibili(routes()).fetch, {
        channels: ["https://www.youtube.com/@milky"],
        skip: [
          "https://www.bilibili.com/video/BV1aaaaaaaa1/?spm_id_from=333",
          "BV1bbbbbbbb1",
          "https://youtu.be/AAAAAAAAAA1",
        ],
        save: true,
        now: () => now,
      }),
    );
    expect(found.official.videos.map((each) => each.url)).toEqual([
      "https://www.bilibili.com/video/BV1aaaaaaaa3",
      "https://www.bilibili.com/video/BV1bbbbbbbb5",
    ]);
    expect(found.recordings.videos.map(({ url, date }) => [url, date])).toEqual([
      ["https://www.bilibili.com/video/BV1bbbbbbbb2", "2026-11-18"],
      ["https://www.bilibili.com/video/BV1bbbbbbbb8", "2026-11-09"],
    ]);
    expect(download.readIds(found.batch as string)).toEqual([
      "BV1aaaaaaaa3",
      "BV1bbbbbbbb5",
      "BV1bbbbbbbb2",
      "BV1bbbbbbbb8",
    ]);
  });

  test("a YouTube replay is dated by its title, and covers that day", async () => {
    const found = await discover.discoverVideos(
      options(
        fakeBilibili(
          searching([
            result(
              "BV1hhhhhhh01",
              205,
              "搬运",
              "【明前奶绿】 2026年11月13日20点场",
              "150:0",
              "2026-11-13T15:00:00Z",
            ),
            result(
              "BV1hhhhhhh02",
              205,
              "搬运",
              "【明前奶绿】 2026年11月12日20点场",
              "150:0",
              "2026-11-12T15:00:00Z",
            ),
          ]),
        ).fetch,
        {
          channels: ["https://www.youtube.com/@milky"],
          expand: youtube([
            {
              id: "AAAAAAAAAA4",
              title: "【歌回】2026年11月13日",
              duration: 5400,
              live_status: "was_live",
            },
            { id: "AAAAAAAAAA5", title: "雑談", duration: 3600, live_status: "was_live" },
          ]),
        },
      ),
    );
    expect(found.official.videos.map(({ url, date }) => [url, date])).toEqual([
      ["https://www.youtube.com/watch?v=AAAAAAAAAA4", "2026-11-13"],
      ["https://www.youtube.com/watch?v=AAAAAAAAAA5", null],
    ]);
    expect(found.recordings.videos.map(({ url }) => url)).toEqual([
      "https://www.bilibili.com/video/BV1hhhhhhh02",
    ]);
  });

  test("a saved recording's # Covers: line keeps its days covered once the search misses it", async () => {
    const now = new Date("2026-11-19T21:00:00Z");
    const saved = await discover.discoverVideos(
      options(
        fakeBilibili(
          searching([
            result(
              "BV1kkkkkkk01",
              205,
              "搬运",
              "【明前奶绿】 2026年11月13日20点场",
              "150:0",
              "2026-11-13T15:00:00Z",
            ),
            // Uploaded at 01:00 on the 12th: maybe the 11th's stream.
            result("BV1kkkkkkk02", 206, "路人", "奶绿的直播", "200:0", "2026-11-11T17:00:00Z"),
          ]),
        ).fetch,
        { save: true, now: () => now },
      ),
    );
    expect(
      readFileSync(saved.batch as string, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("# Covers:")),
    ).toEqual([
      "# Covers: 2026-11-13 https://www.bilibili.com/video/BV1kkkkkkk01",
      "# Covers: 2026-11-12 2026-11-11 https://www.bilibili.com/video/BV1kkkkkkk02",
    ]);

    // Others' uploads of those days, the saved ones no longer among the results.
    const later = await discover.discoverVideos(
      options(
        fakeBilibili(
          searching([
            result(
              "BV1kkkkkkk03",
              207,
              "别人",
              "【明前奶绿】 2026年11月13日 2000开播",
              "160:0",
              "2026-11-13T16:00:00Z",
            ),
            result(
              "BV1kkkkkkk04",
              207,
              "别人",
              "【明前奶绿】 2026年11月11日 2000开播",
              "160:0",
              "2026-11-11T16:00:00Z",
            ),
            result(
              "BV1kkkkkkk05",
              207,
              "别人",
              "【明前奶绿】 2026年11月10日 2000开播",
              "160:0",
              "2026-11-10T16:00:00Z",
            ),
          ]),
        ).fetch,
      ),
    );
    expect(later.recordings.videos.map(({ url }) => url)).toEqual([
      "https://www.bilibili.com/video/BV1kkkkkkk05",
    ]);
  });

  test("of two recordings dated by their uploads a day apart, which may hold one stream, one is picked", async () => {
    const found = await discover.discoverVideos(
      options(
        fakeBilibili(
          searching([
            // 01:00 and 00:30 on the 13th, then 22:00 on the 12th: maybe all of the 12th's stream.
            result("BV1mmmmmmm01", 206, "路人", "奶绿的直播", "100:0", "2026-11-12T17:00:00Z"),
            result("BV1mmmmmmm02", 207, "路人乙", "奶绿 直播录像", "150:0", "2026-11-12T16:30:00Z"),
            result("BV1mmmmmmm03", 208, "路人丙", "奶绿 录屏", "200:0", "2026-11-12T14:00:00Z"),
            result("BV1mmmmmmm04", 208, "路人丙", "奶绿 录屏", "90:0", "2026-11-10T14:00:00Z"),
          ]),
        ).fetch,
      ),
    );
    // Of the same day, the longer.
    expect(found.recordings.videos.map(({ url, date }) => [url, date])).toEqual([
      ["https://www.bilibili.com/video/BV1mmmmmmm02", "2026-11-13"],
      ["https://www.bilibili.com/video/BV1mmmmmmm04", "2026-11-10"],
    ]);
  });

  test("a recording her lists hold, dated by its upload, covers the day before too", async () => {
    writeFileSync(join(lists, "video-full.txt"), "BV1nnnnnnn01\n");
    const found = await discover.discoverVideos(
      options(
        fakeBilibili(
          searching([
            // Uploaded at 01:00 on the 14th: maybe the 13th's stream.
            result("BV1nnnnnnn01", 206, "路人", "奶绿的直播", "200:0", "2026-11-13T17:00:00Z"),
            result(
              "BV1nnnnnnn02",
              205,
              "搬运",
              "【明前奶绿】 2026年11月13日20点场",
              "150:0",
              "2026-11-13T15:00:00Z",
            ),
            result(
              "BV1nnnnnnn03",
              205,
              "搬运",
              "【明前奶绿】 2026年11月12日20点场",
              "150:0",
              "2026-11-12T15:00:00Z",
            ),
          ]),
        ).fetch,
      ),
    );
    expect(found.recordings.videos.map(({ url }) => url)).toEqual([
      "https://www.bilibili.com/video/BV1nnnnnnn03",
    ]);
  });

  test("a transcript covers its stream's day: an official video's as listed, another's by its info.json title", async () => {
    writeLists();
    // Named a day after their streams, by their uploads in UTC: a part of the official replay of
    // the 17th, and a recording of the 8th.
    writeFileSync(join(streams, "2026-11-18-BV1aaaaaaaa2_p1.md"), "---\nduration_min: 60\n---\n");
    writeFileSync(join(streams, "2026-11-09-BV1fffffff01.md"), "---\nduration_min: 150\n---\n");
    writeFileSync(
      join(vods, "BV1fffffff01.info.json"),
      JSON.stringify({ upload_date: "20261109", title: "【明前奶绿】 2026年11月08日20点场" }),
    );
    const found = await discover.discoverVideos(options(fakeBilibili(routes()).fetch));
    // The 18th's and the 9th's, as without those transcripts.
    expect(found.recordings.videos.map(({ url }) => url)).toEqual([
      "https://www.bilibili.com/video/BV1bbbbbbbb1",
      "https://www.bilibili.com/video/BV1bbbbbbbb8",
    ]);
  });

  test("videoKey reads a BV id, a Bilibili video's URL or a YouTube video's", () => {
    expect(
      [
        "BV1aaaaaaaa1",
        " https://www.bilibili.com/video/BV1aaaaaaaa1/?p=2 ",
        "https://www.youtube.com/live/AAAAAAAAAA1",
        "https://space.bilibili.com/100",
        "https://example.com/video/BV1aaaaaaaa1",
      ].map(discover.videoKey),
    ).toEqual([
      "BV1aaaaaaaa1",
      "BV1aaaaaaaa1",
      "https://www.youtube.com/watch?v=AAAAAAAAAA1",
      null,
      null,
    ]);
  });

  test("a channel that can't be listed and a failed search are warnings", async () => {
    writeLists();
    const bilibili = fakeBilibili(
      routes({
        "/x/series/archives": () => Response.json({ code: -352, message: "-352" }),
        "/x/web-interface/search/type": () => new Response("<html>412</html>", { status: 412 }),
      }),
    );
    const found = await discover.discoverVideos(options(bilibili.fetch));
    expect(found.channels).toEqual([
      {
        url: SERIES,
        site: "bilibili",
        from: "batch",
        list: "直播回放",
        error: "/x/series/archives answered code -352",
      },
    ]);
    expect(found.warnings).toEqual([
      `Couldn't list ${SERIES}: /x/series/archives answered code -352`,
      "Bilibili's search for videos over an hour failed at page 1: HTTP 412 from /x/web-interface/search/type",
      "Bilibili's search for videos failed at page 1: HTTP 412 from /x/web-interface/search/type",
    ]);
    expect([found.official.count, found.recordings.count, found.clips.count]).toEqual([0, 0, 0]);
  });

  test("a list given whose space's lists or uploader can't be read is listed, with warnings", async () => {
    const bilibili = fakeBilibili(
      routes({
        "/x/polymer/web-space/seasons_series_list": () =>
          Response.json({ code: -352, message: "-352" }),
        "/x/web-interface/view": () => Response.json({ code: -404, message: "啥都木有" }),
      }),
    );
    const found = await discover.discoverVideos(
      options(bilibili.fetch, { channels: [SERIES], pages: 1 }),
    );
    // Her name from her own upload the search found.
    expect(found.channels).toEqual([
      { url: SERIES, site: "bilibili", from: "argument", name: "明前奶绿", videos: 3 },
    ]);
    expect(found.warnings).toEqual([
      "Couldn't read the lists of https://space.bilibili.com/100, so whether " +
        `${SERIES} is a 直播回放 list is unknown: ` +
        "/x/polymer/web-space/seasons_series_list answered code -352",
      "Couldn't read who uploaded https://www.bilibili.com/video/BV1aaaaaaaa1: " +
        "/x/web-interface/view answered code -404 (啥都木有)",
    ]);
  });

  test("with no official channel known, the users named like her are candidates, those with a 直播回放 list first", async () => {
    const bilibili = fakeBilibili(
      routes({
        "/x/web-interface/search/type": (url) =>
          url.searchParams.get("search_type") === "bili_user"
            ? {
                result: [
                  {
                    mid: 5,
                    uname: "奶绿粉丝",
                    fans: 3,
                    videos: 0,
                    official_verify: { type: 127, desc: "" },
                    room_id: 0,
                  },
                  {
                    mid: 1298779265,
                    uname: '<em class="keyword">明前奶绿</em>',
                    fans: 99392,
                    videos: 12,
                    official_verify: { type: 0, desc: "bilibili独家高能主播" },
                    room_id: 1713546334,
                  },
                  { mid: 6, uname: "奶绿的歌", fans: 40, videos: 9, room_id: 0 },
                ],
              }
            : { numPages: 0, result: [] },
        "/x/polymer/web-space/seasons_series_list": (url) => {
          const mid = url.searchParams.get("mid");
          if (mid === "6") return Response.json({ code: -352, message: "-352" });
          return mid === "1298779265"
            ? {
                items_lists: {
                  series_list: [{ meta: { name: "直播回放", total: 226, series_id: 5070891 } }],
                  seasons_list: [{ meta: { name: "合集·翻唱", total: 6, season_id: 9 } }],
                },
              }
            : { items_lists: {} };
        },
      }),
    );
    const found = await discover.discoverVideos(options(bilibili.fetch));
    expect(found.channels).toEqual([]);
    expect(found.candidates).toEqual([
      {
        url: "https://space.bilibili.com/1298779265",
        name: "明前奶绿",
        fans: 99392,
        videos: 12,
        verified: "bilibili独家高能主播",
        liveRoom: 1713546334,
        replayLists: [
          {
            url: "https://space.bilibili.com/1298779265/lists/5070891?type=series",
            name: "直播回放",
            videos: 226,
          },
        ],
      },
      { url: "https://space.bilibili.com/5", name: "奶绿粉丝", fans: 3, videos: 0 },
      { url: "https://space.bilibili.com/6", name: "奶绿的歌", fans: 40, videos: 9 },
    ]);
    expect(found.warnings).toEqual([
      "Couldn't read the lists of https://space.bilibili.com/6: /x/polymer/web-space/seasons_series_list answered code -352",
    ]);
  });

  test("a space given whole is printed and remembered by its 直播回放 list's URL", async () => {
    const now = new Date("2026-11-19T21:00:00Z");
    const found = await discover.discoverVideos(
      options(fakeBilibili(routes()).fetch, {
        channels: ["https://space.bilibili.com/100/video"],
        pages: 1,
        save: true,
        now: () => now,
      }),
    );
    expect(found.channels).toEqual([
      {
        url: SERIES,
        site: "bilibili",
        from: "argument",
        name: "明前奶绿",
        list: "直播回放",
        videos: 3,
      },
    ]);
    expect(readFileSync(found.batch as string, "utf8").split("\n")[0]).toBe(`# Source: ${SERIES}`);
  });

  test("a list given that isn't a 直播回放 or 录播 list is listed, with a warning", async () => {
    const covers = "https://space.bilibili.com/100/lists/9?type=season";
    const bilibili = fakeBilibili(
      routes({
        "/x/polymer/web-space/seasons_series_list": () => ({
          items_lists: { seasons_list: [{ meta: { name: "合集·翻唱", total: 1, season_id: 9 } }] },
        }),
        "/x/polymer/web-space/seasons_archives_list": () => ({
          archives: [archive("BV1eeeeeeee1", "翻唱", 4, "2026-11-01T12:00:00Z")],
          page: { total: 1 },
        }),
      }),
    );
    const found = await discover.discoverVideos(
      options(bilibili.fetch, { channels: [covers], pages: 1 }),
    );
    expect(found.channels.map(({ url, list, videos }) => [url, list, videos])).toEqual([
      [covers, "合集·翻唱", 1],
    ]);
    expect(found.warnings).toEqual([
      `${covers} is 合集·翻唱, no 直播回放 or 录播 list, yet all its videos count as hers`,
    ]);
  });

  test("a space lists its replay lists only, and a list read twice is read once", async () => {
    const bilibili = fakeBilibili(
      routes({
        "/x/polymer/web-space/seasons_series_list": () => ({
          items_lists: {
            series_list: [{ meta: { name: "直播回放", total: 3, series_id: 7 } }],
            seasons_list: [
              { meta: { name: "合集·翻唱", total: 6, season_id: 9 } },
              { meta: { name: "合集·录播精选", total: 1, season_id: 8 } },
            ],
          },
        }),
        "/x/polymer/web-space/seasons_archives_list": () => ({
          archives: [
            archive(
              "BV1dddddddd1",
              "【明前奶绿】录播精选 2026年11月01日",
              90,
              "2026-11-01T12:00:00Z",
            ),
          ],
          page: { page_num: 1, page_size: 100, total: 1 },
        }),
      }),
    );
    const found = await discover.discoverVideos(
      options(bilibili.fetch, {
        channels: ["https://space.bilibili.com/100/dynamic", SERIES],
        pages: 1,
      }),
    );
    // The space stands for its two replay lists, each by its own URL; the series given after it
    // is the first of them, read once.
    expect(found.channels.map(({ url, from, list, videos }) => [url, from, list, videos])).toEqual([
      [SERIES, "argument", "直播回放", 3],
      ["https://space.bilibili.com/100/lists/8?type=season", "argument", "合集·录播精选", 1],
    ]);
    // Her own long upload, which the search found, besides the four listed.
    expect(found.official.count).toBe(5);
    const lists_ = bilibili.sent.filter(({ url }) => url.pathname.includes("archives"));
    expect(lists_.map(({ url }) => url.pathname)).toEqual([
      "/x/series/archives",
      "/x/polymer/web-space/seasons_archives_list",
    ]);
    expect(lists_[1]?.url.searchParams.get("season_id")).toBe("8");
    const spaces = bilibili.sent.filter(({ url }) => url.pathname.endsWith("seasons_series_list"));
    expect(spaces).toHaveLength(1);
  });

  test("a space with no replay list leaves her uploads to the search", async () => {
    const bilibili = fakeBilibili(
      routes({
        "/x/polymer/web-space/seasons_series_list": () => ({ items_lists: {} }),
      }),
    );
    const found = await discover.discoverVideos(
      options(bilibili.fetch, { channels: ["https://space.bilibili.com/100"], pages: 1 }),
    );
    expect(found.warnings).toEqual([
      "https://space.bilibili.com/100 has no 直播回放 or 录播 list; only the search finds its uploads",
    ]);
    // Her own long upload is official; the search named her.
    expect(found.channels).toEqual([
      {
        url: "https://space.bilibili.com/100",
        site: "bilibili",
        from: "argument",
        name: "明前奶绿",
        videos: 0,
      },
    ]);
    expect(found.official.videos.map((each) => each.url)).toEqual([
      "https://www.bilibili.com/video/BV1bbbbbbbb5",
    ]);
  });

  test("a list runs to as many pages as its total takes", async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        archive(
          `BV1p${String(n)}${String(i).padStart(7, "0")}`,
          `【直播回放】 2026年10月01日${i % 24}点场`,
          60,
          "2026-10-01T12:00:00Z",
        ),
      );
    const client = new discover.BilibiliClient({
      fetch: fakeBilibili({
        "/x/series/archives": (url) => {
          const n = Number(url.searchParams.get("pn"));
          return { archives: n === 1 ? page(1, 100) : page(2, 1), page: { total: 101 } };
        },
      }).fetch,
      pauseMs: 0,
    });
    expect(await client.listVideos(SPACE, { type: "series", id: "7" })).toHaveLength(101);
  });

  test("a space's lists run to as many pages as their total takes, 10 at most", async () => {
    const read = async (answer: (page: number) => unknown) => {
      const bilibili = fakeBilibili({
        "/x/polymer/web-space/seasons_series_list": (url) =>
          answer(Number(url.searchParams.get("page_num"))),
      });
      const client = new discover.BilibiliClient({ fetch: bilibili.fetch, pauseMs: 0 });
      const found = await client.spaceLists(SPACE);
      const asked = bilibili.sent.filter(({ url }) => url.pathname.endsWith("seasons_series_list"));
      return {
        found,
        pages: asked.map(({ url }) => [
          url.searchParams.get("page_num"),
          url.searchParams.get("page_size"),
        ]),
      };
    };
    const paged = await read(laterReplayList);
    expect(paged.pages).toEqual([
      ["1", "20"],
      ["2", "20"],
    ]);
    expect(paged.found).toHaveLength(21);
    expect(paged.found[0]).toEqual({ type: "series", id: "7", name: "直播回放", total: 3 });
    const short = await read(() => ({
      items_lists: { page: { total: 100 }, seasons_list: seasons(1, 5) },
    }));
    expect(short.pages).toHaveLength(1);
    const long = await read((page) => ({
      items_lists: { page: { total: 1000 }, seasons_list: seasons(page, 20) },
    }));
    expect(long.pages).toHaveLength(10);
  });

  test("a 直播回放 list on a later page of a space's lists is found, for the space given and its candidate", async () => {
    const given = await discover.discoverVideos(
      options(
        fakeBilibili(
          routes({
            "/x/polymer/web-space/seasons_series_list": (url) =>
              laterReplayList(Number(url.searchParams.get("page_num"))),
          }),
        ).fetch,
        { channels: ["https://space.bilibili.com/100"], pages: 1 },
      ),
    );
    expect(given.channels.map(({ url, list }) => [url, list])).toEqual([[SERIES, "直播回放"]]);
    const searched = await discover.discoverVideos(
      options(
        fakeBilibili(
          routes({
            "/x/polymer/web-space/seasons_series_list": (url) =>
              laterReplayList(Number(url.searchParams.get("page_num"))),
            "/x/web-interface/search/type": (url) =>
              url.searchParams.get("search_type") === "bili_user"
                ? { result: [{ mid: 100, uname: "明前奶绿", fans: 1, videos: 1, room_id: 0 }] }
                : { numPages: 0, result: [] },
          }),
        ).fetch,
        { pages: 1 },
      ),
    );
    expect(searched.candidates.map(({ replayLists }) => replayLists)).toEqual([
      [{ url: SERIES, name: "直播回放", videos: 3 }],
    ]);
  });
});

/** `count` of a space's seasons as page `page` of its lists has them. */
function seasons(page: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    meta: { name: `合集${page}-${i}`, total: 1, season_id: page * 100 + i },
  }));
}

/** Page `page` of a space's 21 lists: 20 seasons, then its 直播回放 series. */
function laterReplayList(page: number) {
  return {
    items_lists: {
      page: { page_num: page, page_size: 20, total: 21 },
      ...(page === 1
        ? { seasons_list: seasons(1, 20) }
        : { series_list: [{ meta: { name: "直播回放", total: 3, series_id: 7 } }] }),
    },
  };
}

describe("channels", () => {
  test("parseChannel normalizes a space, its lists and a YouTube channel", () => {
    const cases: [string, string | null][] = [
      ["https://space.bilibili.com/2132180406", "https://space.bilibili.com/2132180406"],
      [
        "https://space.bilibili.com/2132180406/video?tid=0",
        "https://space.bilibili.com/2132180406",
      ],
      ["space.bilibili.com/1", null],
      [
        "https://space.bilibili.com/2132180406/lists/2484684?type=series",
        "https://space.bilibili.com/2132180406/lists/2484684?type=series",
      ],
      [
        "https://space.bilibili.com/2132180406/lists/3781243?type=season",
        "https://space.bilibili.com/2132180406/lists/3781243?type=season",
      ],
      [
        "https://space.bilibili.com/1/channel/seriesdetail?sid=7&ctype=0",
        "https://space.bilibili.com/1/lists/7?type=series",
      ],
      [
        "https://space.bilibili.com/1/channel/collectiondetail?sid=9",
        "https://space.bilibili.com/1/lists/9?type=season",
      ],
      // The lists tab is the space's; a list's URL with a malformed id is no channel.
      ["https://space.bilibili.com/1/lists", "https://space.bilibili.com/1"],
      ["https://space.bilibili.com/1/lists/7x?type=series", null],
      ["https://space.bilibili.com/1/channel/seriesdetail?sid=x", null],
      ["https://space.bilibili.com/1/channel/collectiondetail", null],
      ["https://space.bilibili.com/x", null],
      ["https://www.bilibili.com/video/BV1aaaaaaaa1", null],
      ["https://www.youtube.com/@hololive/streams", "https://www.youtube.com/@hololive"],
      ["https://m.youtube.com/channel/UC1234/videos", "https://www.youtube.com/channel/UC1234"],
      ["https://youtube.com/c/Name", "https://www.youtube.com/c/Name"],
      ["https://www.youtube.com/user/name", "https://www.youtube.com/user/name"],
      ["https://www.youtube.com/watch?v=AAAAAAAAAA1", null],
      ["ftp://space.bilibili.com/1", null],
      ["Eidolon's web app", null],
    ];
    for (const [text, url] of cases)
      expect([text, discover.parseChannel(text)?.url ?? null]).toEqual([text, url]);
    expect(discover.parseChannel("https://www.youtube.com/@%E5%A5%B6%E7%BB%BF")).toEqual({
      site: "youtube",
      url: "https://www.youtube.com/@%E5%A5%B6%E7%BB%BF",
      name: "@奶绿",
    });
  });

  test("youtubeVideoId reads each kind of video link", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=AAAAAAAAAA1&t=10",
      "https://youtu.be/AAAAAAAAAA1",
      "https://www.youtube.com/live/AAAAAAAAAA1",
      "https://m.youtube.com/shorts/AAAAAAAAAA1",
    ]) {
      expect([url, discover.youtubeVideoId(url)]).toEqual([url, "AAAAAAAAAA1"]);
    }
    expect(discover.youtubeVideoId("https://www.youtube.com/@milky")).toBeNull();
    expect(discover.youtubeVideoId("BV1aaaaaaaa1")).toBeNull();
  });

  test("batchSources reads every batch's # Source: lines, oldest batch first", () => {
    writeFileSync(
      join(lists, "batches", "videos-2026-01-02-000000.txt"),
      "# Source: b\nBV1aaaaaaaa1\n",
    );
    writeFileSync(
      join(lists, "batches", "videos-2026-01-01-000000.txt"),
      "#Source:  a \n# Captured: x\n",
    );
    writeFileSync(join(lists, "video-full.txt"), "# Source: not a batch\n");
    expect(discover.batchSources(lists)).toEqual(["a", "b"]);
  });
});

describe("parsing", () => {
  test("titleDate reads the day a title names", () => {
    const cases: [string, string | null][] = [
      ["【直播回放】笑（ 2026年11月17日19点场", "2026-11-17"],
      ["2026年1月7日 1908开播", "2026-01-07"],
      ["录播 2026-11-05", "2026-11-05"],
      ["录播 2026.11.5 晚", "2026-11-05"],
      ["2026/11/05", "2026-11-05"],
      ["【20261105】直播", "2026-11-05"],
      ["BV12026110512", null],
      ["2026年13月40日 then 2026-11-02", "2026-11-02"],
      ["no date", null],
    ];
    for (const [title, date] of cases)
      expect([title, discover.titleDate(title)]).toEqual([title, date]);
  });

  test("a search result's duration and title", () => {
    expect(discover.searchDuration("290:59")).toBe(290 * 60 + 59);
    expect(discover.searchDuration("378:0")).toBe(378 * 60);
    expect(discover.searchDuration("1:02:03")).toBe(3723);
    expect(discover.searchDuration("")).toBe(0);
    expect(discover.searchDuration(30)).toBe(0);
    expect(
      discover.cleanTitle(
        '【<em class="keyword">灰泽满</em>Hazel】A &amp; B &#x4E00;&#20108; &bogus;',
      ),
    ).toBe("【灰泽满Hazel】A & B 一二 &bogus;");
    // A tag runs to the first `>`; a `<` with none after it is text.
    expect(discover.cleanTitle("<scr<b>ipt>x</b> &lt;i&gt;")).toBe("ipt>x <i>");
    expect(discover.cleanTitle("奶绿<3 2026年11月19日")).toBe("奶绿<3 2026年11月19日");
  });
});
