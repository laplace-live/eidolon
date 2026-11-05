// The download library against the Python goldens in fixtures/download (see download_helpers.ts),
// with fake-yt-dlp.sh as yt-dlp. Where the port differs on purpose, the test says so and applies
// the difference to Python's output.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consoleSink,
  type LogRecord,
  logger,
  pyPath,
  setLogLevel,
  sortedPy,
} from "@eidolon/config";
import { binDir, download, type ProgressEvent } from "../src/index.ts";
import {
  DOWNLOAD_FIXTURES,
  downloadGolden as golden,
  installFakeYtDlp,
  type RunGolden,
  readArgvLog,
  withPortArgs,
} from "./download_helpers.ts";

let work = "";
let fake = "";
let records: [string, string][] = [];
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ingest-download-"));
  fake = installFakeYtDlp(work);
  setEnv("FAKE_YTDLP_LOG", join(work, "argv.log"));
  records = [];
  logger.setSink((record: LogRecord) => {
    records.push([record.level, record.message]);
  });
});

afterEach(() => {
  logger.setSink(consoleSink);
  setLogLevel("DEBUG");
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  rmSync(work, { recursive: true, force: true });
  rmSync(binDir(), { recursive: true, force: true });
});

const FAKE_YTDLP = (): download.YtDlp => ({ path: fake, source: "setting" });
const sub = (text: string, dir: string): string => text.replaceAll("<WORK>", dir);

describe("shlexSplit", () => {
  test("splits as Python's shlex.split, errors included", () => {
    for (const c of golden.shlex) {
      if (c.error !== undefined) {
        expect(() => download.shlexSplit(c.text)).toThrow(
          expect.objectContaining({ name: "ValueError", message: c.error }),
        );
      } else {
        expect([c.text, download.shlexSplit(c.text)]).toEqual([c.text, c.tokens as string[]]);
      }
    }
  });
});

describe("readUrlList", () => {
  test("keeps what read_url_list keeps: stripped lines, a BOM, repeats; no comments or blanks", () => {
    const path = join(work, "urls.txt");
    writeFileSync(path, golden.url_list.text, "utf8");
    expect(download.readUrlList(path)).toEqual(golden.url_list.urls);
  });

  test("a missing list is FileNotFoundError naming it", () => {
    expect(() => download.readUrlList(join(work, "missing.txt"))).toThrow(
      expect.objectContaining({
        name: "FileNotFoundError",
        message: sub(golden.url_list.missing, work),
      }),
    );
  });
});

describe("ytDlpArgs", () => {
  test("is _build_yt_dlp_cmd's argv plus --ignore-config and -- before the URL [AD]", () => {
    for (const c of golden.argv) {
      const args = download.ytDlpArgs(c.url, {
        vodsDir: c.vods_dir,
        format: c.format,
        cookiesFromBrowser: c.browser || null,
        cookiesFile: c.cookies === null ? null : pyPath(c.cookies),
        extraArgs: download.shlexSplit(c.extra),
      });
      expect(args).toEqual(withPortArgs(c.argv.slice(1)));
    }
  });

  test("--json mode asks for one parseable progress line per update, before the --", () => {
    const args = download.ytDlpArgs("u", {
      vodsDir: "v",
      format: "f",
      cookiesFromBrowser: null,
      cookiesFile: null,
      extraArgs: ["--rate-limit", "2M"],
      progressLines: true,
    });
    expect(args.slice(-9)).toEqual([
      "--rate-limit",
      "2M",
      "--newline",
      "--progress-template",
      "download:[eidolon] [%(info.id|null)j,%(progress.downloaded_bytes|null)j," +
        "%(progress.total_bytes|null)j,%(progress.total_bytes_estimate|null)j]",
      "--progress-delta",
      "0.5",
      "--",
      "u",
    ]);
  });

  test("progress lines parse into bytes done and the size, exact or estimated", () => {
    expect(download.parseProgressLine('[eidolon] ["BV1_p1",1024,4096,null]')).toEqual({
      video: "BV1_p1",
      done: 1024,
      total: 4096,
    });
    expect(download.parseProgressLine('[eidolon] ["x",5,null,99.6]')).toEqual({
      video: "x",
      done: 5,
      total: 100,
    });
    expect(download.parseProgressLine("[eidolon] [null,null,null,null]")).toEqual({ done: 0 });
    expect(download.parseProgressLine("[eidolon] not json")).toBeNull();
    expect(download.parseProgressLine("[download] 10% of 1MiB")).toBeNull();
  });
});

describe("cookie settings", () => {
  test("YT_DLP_COOKIES_FROM_BROWSER defaults to chrome, blank means unset, none means no browser", () => {
    for (const [value, expected] of [
      [undefined, "chrome"],
      ["", "chrome"],
      ["none", null],
      ["firefox:Profile 1", "firefox:Profile 1"],
    ] as const) {
      setEnv("YT_DLP_COOKIES_FROM_BROWSER", value);
      expect([value, download.defaultCookiesFromBrowser()]).toEqual([value, expected]);
    }
  });

  test("YT_DLP_COOKIES is the cookies file, as a Path prints it", () => {
    setEnv("YT_DLP_COOKIES", undefined);
    expect(download.defaultCookiesFile()).toBeNull();
    setEnv("YT_DLP_COOKIES", "./c//cookies.txt");
    expect(download.defaultCookiesFile()).toBe("c/cookies.txt");
  });
});

test("downloadSummaryText is print_summary's text", () => {
  for (const c of golden.summary) {
    const report: download.DownloadReport = {
      requestedUrls: c.requested,
      succeededUrls: c.succeeded,
      failedUrls: c.failed.map(([url, error]) => ({ url, error })),
      newFiles: Array.from({ length: c.new }, (_, i) => `n${i}.m4a`),
      durationSec: c.duration,
      cancelled: false,
    };
    expect(download.downloadSummaryText(report, pyPath(c.vods_dir))).toBe(c.text);
  }
});

test("bareWithParts finds a bare id that also has _p<N> parts", () => {
  expect(
    download.bareWithParts([
      "BV1a.m4a",
      "BV1a_p1.m4a",
      "BV1b.m4a",
      "BV1b.info.json",
      "BV1c_p1.m4a",
      "BV1d.m4a",
      "BV1d_p2.info.json",
      "BV1e.opus",
      "BV1e_p10.webm",
      "BV1f.txt",
      "BV1f_p1.m4a",
    ]),
  ).toEqual(["BV1a", "BV1e"]);
});

async function replay(run: RunGolden, opts: Partial<download.DownloadOptions> = {}) {
  const dir = join(work, run.name);
  const vods = join(dir, "vods");
  if (run.initial.length > 0) mkdirSync(vods, { recursive: true });
  for (const name of run.initial) writeFileSync(join(vods, name), "x");
  const log = join(dir, "argv.log");
  mkdirSync(dir, { recursive: true });
  setEnv("FAKE_YTDLP_LOG", log);
  const report = await download.downloadUrls(run.urls, {
    vodsDir: vods,
    cookiesFromBrowser: run.browser,
    cookiesFile: run.cookies,
    extraArgs: download.shlexSplit(run.extra),
    ytDlp: FAKE_YTDLP(),
    ...opts,
  });
  return { dir, vods, report, argv: readArgvLog(log) };
}

describe("downloadUrls against download_urls", () => {
  test("runs each URL in turn and reports as Python does; a cookie failure adds a hint [AD]", async () => {
    const run = golden.runs.find((r) => r.name === "mixed") as RunGolden;
    const { dir, vods, report, argv } = await replay(run);
    expect(argv).toEqual(run.argv.map((call) => withPortArgs(call.map((a) => sub(a, dir)))));
    const isCookies = (url: string) => url.endsWith("/cookies");
    expect({
      requested: report.requestedUrls,
      succeeded: report.succeededUrls,
      failed: report.failedUrls.map((f) => [f.url, f.error]),
      new_files: report.newFiles,
      files: sortedPy(readdirSync(vods)),
    }).toEqual({
      requested: run.requested,
      succeeded: run.succeeded,
      failed: run.failed.map(([url, error]) => [
        url,
        isCookies(url) ? `${error}\n    ${download.COOKIE_HINT}` : error,
      ]),
      new_files: run.new_files.map((name) => join(vods, name)),
      files: run.files,
    });
    const cookieError = run.logs.findIndex(([, message]) => message.includes("cookies database"));
    const logs = run.logs.map(([level, message]): [string, string] => [level, sub(message, dir)]);
    logs.splice(cookieError + 1, 0, ["WARNING", `    ${download.COOKIE_HINT}`]);
    expect(records).toEqual(logs);
    // Python's summary keeps the first line of each error, so the hint doesn't reach it.
    expect(download.downloadSummaryText({ ...report, durationSec: 0 }, vods)).toBe(
      sub(run.summary, dir),
    );
  });

  test("a bare id downloaded next to its parts is removed and fails the URL [AD]", async () => {
    const run = golden.runs.find((r) => r.name === "fallback") as RunGolden;
    // Python kept BV1cccccccc1.m4a, a second copy of part 1, and counted the URL a success.
    expect(run.new_files).toEqual(["BV1cccccccc1.m4a", "BV1dddddddd1.m4a"]);
    const { dir, vods, report, argv } = await replay(run);
    expect(argv).toEqual(run.argv.map((call) => withPortArgs(call.map((a) => sub(a, dir)))));
    expect(report.succeededUrls).toBe(1);
    expect(report.failedUrls).toEqual([
      { url: run.urls[0] as string, error: download.PARTS_UNLISTED },
    ]);
    expect(report.newFiles).toEqual([join(vods, "BV1dddddddd1.m4a")]);
    expect(sortedPy(readdirSync(vods))).toEqual(
      run.files.filter((name) => !name.startsWith("BV1cccccccc1.")),
    );
    expect(records).toEqual([
      ["INFO", `[1/2] ${run.urls[0]}`],
      ["ERROR", `  ✗ ${download.PARTS_UNLISTED}; removed BV1cccccccc1.info.json, BV1cccccccc1.m4a`],
      ["INFO", `[2/2] ${run.urls[1]}`],
    ]);
  });

  test("a part check never touches a bare file that was there before the run", async () => {
    const vods = join(work, "vods");
    mkdirSync(vods);
    for (const name of ["BV1cccccccc1.m4a", "BV1cccccccc1_p1.m4a"]) {
      writeFileSync(join(vods, name), "x");
    }
    const report = await download.downloadUrls(["https://example.invalid/exists/BV1cccccccc1"], {
      vodsDir: vods,
      ytDlp: FAKE_YTDLP(),
    });
    expect(report.succeededUrls).toBe(1);
    expect(sortedPy(readdirSync(vods))).toEqual(["BV1cccccccc1.m4a", "BV1cccccccc1_p1.m4a"]);
  });

  test("a yt-dlp that won't start fails its URL and the run goes on", async () => {
    const vods = join(work, "vods");
    const report = await download.downloadUrls(["https://example.invalid/ok/BV1aaaaaaaa1"], {
      vodsDir: vods,
      ytDlp: { path: join(work, "missing-yt-dlp"), source: "setting" },
    });
    const message = `ENOENT: no such file or directory, posix_spawn '${join(work, "missing-yt-dlp")}'`;
    expect(report.failedUrls).toEqual([
      { url: "https://example.invalid/ok/BV1aaaaaaaa1", error: message },
    ]);
    expect(records.at(-1)).toEqual(["ERROR", `  ✗ subprocess error: ${message}`]);
  });

  test("no yt-dlp to run throws before anything is created, and says so in events", async () => {
    setEnv("YT_DLP_PATH", join(work, "missing-yt-dlp"));
    const events: ProgressEvent[] = [];
    const vods = join(work, "vods");
    await expect(
      download.downloadUrls(["u"], { vodsDir: vods, onProgress: (e) => events.push(e) }),
    ).rejects.toThrow(
      expect.objectContaining({
        name: "YtDlpUnavailableError",
        message: `yt-dlp not found at ${join(work, "missing-yt-dlp")} (YT_DLP_PATH)`,
      }),
    );
    expect(existsSync(vods)).toBe(false);
    expect(events).toEqual([
      { type: "stage", stage: "download", status: "start", total: 1 },
      {
        type: "stage",
        stage: "download",
        status: "failed",
        code: "ytdlp-unavailable",
        message: `yt-dlp not found at ${join(work, "missing-yt-dlp")} (YT_DLP_PATH)`,
      },
      {
        type: "summary",
        stage: "download",
        ok: false,
        counts: { requested: 1, succeeded: 0, failed: 0, newFiles: 0 },
        durationSec: 0,
      },
    ]);
  });
});

describe("events", () => {
  test("a failed URL's code says what its stderr points to", () => {
    const cases: [string, string | undefined][] = [
      ['ERROR: could not find chrome cookies database in "/x"', "cookies-unavailable"],
      [
        "ERROR: Failed to decrypt with DPAPI. See  https://example.invalid  for more info",
        "cookies-unavailable",
      ],
      ["ERROR: could not find local state file", "cookies-unavailable"],
      [
        "ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser or " +
          "--cookies for the authentication.",
        "cookies-unavailable",
      ],
      ["ERROR: unable to write data: [Errno 28] No space left on device", "disk-full"],
      [
        "ERROR: [BiliBili] x: Unable to download JSON metadata: HTTP Error 412: Precondition Failed",
        "http-412",
      ],
      [
        "ERROR: [youtube] x: Unable to download webpage: HTTP Error 429: Too Many Requests",
        "rate-limited",
      ],
      [
        "ERROR: [BiliBili] x: Unable to download webpage: <urlopen error [Errno 8] nodename nor " +
          "servname provided, or not known>",
        "network",
      ],
      ["ERROR: [generic] x: Unable to download webpage: The read operation timed out", "network"],
      ["ERROR: [generic] 'x' is not a valid URL", undefined],
      ["WARNING: Connection refused on a retry that worked", undefined],
    ];
    for (const [stderr, code] of cases) {
      expect([stderr, download.ytDlpFailureCode(stderr)]).toEqual([stderr, code]);
    }
  });

  test("--json mode turns yt-dlp's progress into events and passes the rest on", async () => {
    const vods = join(work, "vods");
    const events: ProgressEvent[] = [];
    const output: string[] = [];
    const urls = [
      "https://example.invalid/progress/BV1aaaaaaaa1",
      "https://example.invalid/parts/BV1bbbbbbbb1/2",
      "https://example.invalid/412",
    ];
    const report = await download.downloadUrls(urls, {
      vodsDir: vods,
      ytDlp: FAKE_YTDLP(),
      output: "events",
      onOutput: (line) => output.push(line),
      onProgress: (event) => events.push(event),
    });
    expect(output).toEqual([
      `[download] Destination: ${join(vods, "BV1aaaaaaaa1.m4a")}`,
      "[eidolon] not json",
    ]);
    const item = (index: number) =>
      ({ type: "item", stage: "download", item: urls[index - 1], index, total: 3 }) as const;
    expect(events.slice(0, -1)).toEqual([
      { type: "stage", stage: "download", status: "start", total: 3 },
      { ...item(1), status: "start" },
      {
        type: "progress",
        stage: "download",
        item: urls[0],
        video: "BV1aaaaaaaa1",
        done: 1024,
        total: 4096,
        unit: "bytes",
      },
      {
        type: "progress",
        stage: "download",
        item: urls[0],
        video: "BV1aaaaaaaa1",
        done: 4096,
        total: 8193,
        unit: "bytes",
      },
      { ...item(1), status: "done", outputs: ["BV1aaaaaaaa1"] },
      { ...item(2), status: "start" },
      { ...item(2), status: "done", outputs: ["BV1bbbbbbbb1_p1", "BV1bbbbbbbb1_p2"] },
      { ...item(3), status: "start" },
      {
        ...item(3),
        status: "failed",
        message: report.failedUrls[0]?.error,
        outputs: [],
        code: "http-412",
      },
      // Its one failure's code is the stage's.
      { type: "stage", stage: "download", status: "failed", code: "http-412" },
    ]);
    expect(events.at(-1)).toEqual({
      type: "summary",
      stage: "download",
      ok: false,
      counts: { requested: 3, succeeded: 2, failed: 1, newFiles: 3 },
      durationSec: report.durationSec,
      failures: [{ item: urls[2], error: report.failedUrls[0]?.error }],
    });
  });

  test("cancelling stops the running yt-dlp, starts no other URL and says so", async () => {
    const vods = join(work, "vods");
    const controller = new AbortController();
    const events: ProgressEvent[] = [];
    const log = join(work, "argv.log");
    const running = download.downloadUrls(
      ["https://example.invalid/hang", "https://example.invalid/ok/BV1aaaaaaaa1"],
      {
        vodsDir: vods,
        ytDlp: FAKE_YTDLP(),
        signal: controller.signal,
        onProgress: (e) => events.push(e),
      },
    );
    while (!existsSync(log)) await Bun.sleep(10);
    controller.abort();
    const started = performance.now();
    const report = await running;
    expect(performance.now() - started).toBeLessThan(4000);
    expect(report.cancelled).toBe(true);
    expect(report.succeededUrls).toBe(0);
    expect(report.failedUrls).toEqual([]);
    expect(readArgvLog(log)).toHaveLength(1);
    expect(events.slice(-3)).toEqual([
      {
        type: "item",
        stage: "download",
        item: "https://example.invalid/hang",
        index: 1,
        total: 2,
        status: "cancelled",
        outputs: [],
      },
      { type: "stage", stage: "download", status: "cancelled" },
      {
        type: "summary",
        stage: "download",
        ok: false,
        cancelled: true,
        counts: { requested: 2, succeeded: 0, failed: 0, newFiles: 0 },
        durationSec: report.durationSec,
      },
    ]);
  });
});

describe("after an HTTP 412", () => {
  // The release GitHub serves is the fake itself, so the run goes on with the updated copy.
  const ASSET = readFileSync(join(DOWNLOAD_FIXTURES, "fake-yt-dlp.sh"));

  function fakeGitHub(calls: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/releases/latest")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.01" },
        });
      }
      if (url.endsWith("/SHA2-256SUMS")) {
        const hash = new Bun.CryptoHasher("sha256").update(ASSET).digest("hex");
        return new Response(`${hash}  yt-dlp_linux\n${"0".repeat(64)}  yt-dlp_macos\n`);
      }
      return new Response(ASSET);
    }) as typeof fetch;
  }

  test("the managed yt-dlp is checked for a newer release once per run", async () => {
    const calls: string[] = [];
    const vods = join(work, "vods");
    const events: ProgressEvent[] = [];
    const report = await download.downloadUrls(
      ["https://example.invalid/412", "https://example.invalid/412"],
      {
        vodsDir: vods,
        ytDlp: { path: fake, source: "managed", tag: "2026.06.09" },
        ytDlpOptions: { fetch: fakeGitHub(calls), platform: "linux", arch: "x64", musl: false },
        onProgress: (event) => events.push(event),
      },
    );
    expect(report.failedUrls).toHaveLength(2);
    expect(calls).toEqual([
      "https://github.com/yt-dlp/yt-dlp/releases/latest",
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.01/SHA2-256SUMS",
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.01/yt-dlp_linux",
    ]);
    expect(events.filter((e) => e.type === "stage" && e.stage === "setup")).toEqual([
      { type: "stage", stage: "setup", status: "start", message: "yt-dlp 2026.11.01" },
      { type: "stage", stage: "setup", status: "done", message: "yt-dlp 2026.11.01" },
    ]);
  });

  test("a yt-dlp the user chose is never updated", async () => {
    const calls: string[] = [];
    await download.downloadUrls(["https://example.invalid/412"], {
      vodsDir: join(work, "vods"),
      ytDlp: FAKE_YTDLP(),
      ytDlpOptions: { fetch: fakeGitHub(calls) },
    });
    expect(calls).toEqual([]);
  });
});

describe("expandPlaylist", () => {
  test("lists a playlist's videos through --flat-playlist, an entry event for each", async () => {
    const events: ProgressEvent[] = [];
    const entries = await download.expandPlaylist("https://example.invalid/playlist/3", {
      ytDlp: FAKE_YTDLP(),
      cookiesFromBrowser: null,
      cookiesFile: "c.txt",
      extraArgs: ["--sleep-requests", "1"],
      onProgress: (event) => events.push(event),
    });
    expect(entries).toEqual([
      {
        url: "https://www.bilibili.com/video/BV1eeeeeeee1",
        id: "BV1eeeeeeee1",
        title: "part 1",
        durationSec: 600.5,
      },
      { url: "https://www.bilibili.com/video/BV1eeeeeeee2", id: "BV1eeeeeeee2" },
      {
        url: "https://www.bilibili.com/video/BV1eeeeeeee3",
        id: "BV1eeeeeeee3",
        title: "part 3",
        durationSec: 1800.5,
      },
    ]);
    expect(events).toEqual(entries.map((entry) => ({ type: "entry", entry })));
    expect(readArgvLog(join(work, "argv.log"))).toEqual([
      [
        "--ignore-config",
        "--js-runtimes",
        `bun:${process.execPath}`,
        "--flat-playlist",
        "--print",
        "%(.{webpage_url,id,title,duration})j",
        "--cookies",
        "c.txt",
        "--sleep-requests",
        "1",
        "--",
        "https://example.invalid/playlist/3",
      ],
    ]);
  });

  test("a cookie store yt-dlp can't read fails with code cookies-unavailable", async () => {
    await expect(
      download.expandPlaylist("https://example.invalid/cookies", { ytDlp: FAKE_YTDLP() }),
    ).rejects.toThrow(
      expect.objectContaining({ name: "YtDlpFailedError", code: "cookies-unavailable" }),
    );
  });

  test("a yt-dlp failure throws its stderr tail", async () => {
    await expect(
      download.expandPlaylist("https://example.invalid/fail/2", { ytDlp: FAKE_YTDLP() }),
    ).rejects.toThrow(
      expect.objectContaining({
        name: "YtDlpFailedError",
        message: "yt-dlp failed (exit=1). stderr tail:\n    WARNING: line 1\n    WARNING: line 2",
      }),
    );
  });
});
