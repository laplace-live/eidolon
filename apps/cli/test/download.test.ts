// laplace-download, replayed from the goldens in packages/ingest/test/fixtures/download with
// fake-yt-dlp.sh as yt-dlp.
import "../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceFolder } from "@eidolon/config";
import { acquireLock, sourcesLockKey } from "@eidolon/ingest";
import {
  downloadGolden as golden,
  installFakeYtDlp,
  type MainGolden,
  readArgvLog,
  withPortArgs,
} from "../../../packages/ingest/test/download_helpers.ts";
import { downloadMain, runCli } from "../src/index.ts";
import { blockNetwork, captureIo, captureLogs, setEnv } from "./helpers.ts";

blockNetwork();

let work = "";
let fake = "";
let logs!: ReturnType<typeof captureLogs>;
let restore: () => void = () => {};
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "cli-download-"));
  fake = installFakeYtDlp(work);
  restore = setEnv({
    YT_DLP_PATH: fake,
    FAKE_YTDLP_LOG: join(work, "argv.log"),
    YT_DLP_COOKIES_FROM_BROWSER: undefined,
    YT_DLP_COOKIES: undefined,
  });
  logs = captureLogs();
});
afterEach(() => {
  logs.stop();
  restore();
  rmSync(work, { recursive: true, force: true });
  rmSync(sourceFolder("milky-green", "vods"), { recursive: true, force: true });
});

const normalize = (text: string) => text.replace(/Duration: +\d+\.\ds/, "Duration:       <D>s");

describe("main() goldens", () => {
  for (const c of golden.main.filter((m) => m.raises === null)) {
    test(c.name, async () => {
      const dir = join(work, c.name);
      mkdirSync(dir);
      const list = join(dir, "urls.txt");
      if (c.list !== null) writeFileSync(list, c.list);
      const sub = (text: string) => text.replaceAll("<WORK>", dir).replaceAll("<LIST>", list);
      setEnv({ FAKE_YTDLP_LOG: join(dir, "argv.log") });
      const io = captureIo();
      const code = await downloadMain(c.argv.map(sub), io.io);
      expect(code).toBe(c.code as number);
      expect(normalize(io.stdout())).toBe(sub(c.stdout));
      expect(readArgvLog(join(dir, "argv.log"))).toEqual(
        c.argv_calls.map((call) => withPortArgs(call.map(sub))),
      );
      const expected = c.logs.map(([level, message]): [string, string] => [level, sub(message)]);
      if (c.name === "both-cookies") {
        // The golden's warning was wrong: yt-dlp loads both and writes the merged jar back.
        expected[0] = [
          "WARNING",
          `Cookies come from chrome and from ${dir}/c.txt: yt-dlp loads both, and writes the ` +
            `merged cookies back into ${dir}/c.txt.`,
        ];
      }
      expect(logs.records as [string, string][]).toEqual(expected);
    });
  }

  test("an unbalanced quote in --yt-dlp-args is an uncaught ValueError, before the list is read", async () => {
    const c = golden.main.find((m) => m.name === "shlex") as MainGolden;
    expect(c.raises).toBe("ValueError: No closing quotation");
    const argv = c.argv.map((a) =>
      a.replaceAll("<WORK>", work).replaceAll("<LIST>", join(work, "nope.txt")),
    );
    await expect(downloadMain(argv, captureIo().io)).rejects.toThrow(
      expect.objectContaining({ name: "ValueError", message: "No closing quotation" }),
    );
    const io = captureIo();
    expect(await runCli(["download", ...argv], io.io)).toBe(1);
    expect(io.stderr()).toStartWith("ValueError: No closing quotation\n");
    expect(logs.records).toEqual([]);
  });
});

describe("laplace-download", () => {
  test("audio goes to the persona's sources by default", async () => {
    const list = join(work, "urls.txt");
    writeFileSync(list, "https://example.invalid/ok/BV1aaaaaaaa1\n");
    const io = captureIo();
    expect(await downloadMain([list], io.io)).toBe(0);
    const vods = sourceFolder("milky-green", "vods");
    expect(existsSync(join(vods, "BV1aaaaaaaa1.m4a"))).toBe(true);
    expect(logs.records[0]).toEqual([
      "INFO",
      `Downloading 1 URL(s) to ${vods}/ (format='bestaudio[ext=m4a]', cookies_from_browser='chrome')`,
    ]);
  });

  test("the cookie settings are the flags' defaults; none reads no browser", async () => {
    const list = join(work, "urls.txt");
    writeFileSync(list, "https://example.invalid/ok/BV1aaaaaaaa1\n");
    const cookieArgs = async (argv: string[]): Promise<string[]> => {
      rmSync(join(work, "argv.log"), { force: true });
      expect(
        await downloadMain([list, "--vods-dir", join(work, "v"), ...argv], captureIo().io),
      ).toBe(0);
      const call = readArgvLog(join(work, "argv.log"))[0] as string[];
      return call.flatMap((arg, i) =>
        arg.startsWith("--cookies") ? [arg, call[i + 1] as string] : [],
      );
    };
    const file = join(work, "c.txt");
    setEnv({ YT_DLP_COOKIES_FROM_BROWSER: "firefox", YT_DLP_COOKIES: file });
    expect(await cookieArgs([])).toEqual(["--cookies-from-browser", "firefox", "--cookies", file]);
    expect(await cookieArgs(["--cookies-from-browser", ""])).toEqual(["--cookies", file]);
    expect(await cookieArgs(["--cookies-from-browser", "safari"])).toEqual([
      "--cookies-from-browser",
      "safari",
      "--cookies",
      file,
    ]);
    setEnv({ YT_DLP_COOKIES_FROM_BROWSER: "none", YT_DLP_COOKIES: "" });
    expect(await cookieArgs([])).toEqual([]);
    setEnv({ YT_DLP_COOKIES_FROM_BROWSER: "" });
    expect(await cookieArgs([])).toEqual(["--cookies-from-browser", "chrome"]);
  });

  test("--json writes only events to stdout, and the summary to stderr", async () => {
    const list = join(work, "urls.txt");
    writeFileSync(
      list,
      "https://example.invalid/progress/BV1aaaaaaaa1\nhttps://example.invalid/fail/1\n",
    );
    const io = captureIo();
    expect(await downloadMain([list, "--vods-dir", join(work, "v"), "--json"], io.io)).toBe(1);
    const events = io
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.every((e) => e.v === 1 && typeof e.t === "number")).toBe(true);
    expect(events.map((e) => [e.type, e.status ?? e.unit ?? e.ok])).toEqual([
      ["stage", "start"],
      ["item", "start"],
      ["progress", "bytes"],
      ["progress", "bytes"],
      ["item", "done"],
      ["item", "start"],
      ["item", "failed"],
      ["stage", "failed"],
      ["summary", false],
    ]);
    expect(io.stderr()).toContain("[download] Destination: ");
    expect(io.stderr()).toContain("Download Summary");
    const argv = readArgvLog(join(work, "argv.log"))[0] as string[];
    expect(argv.slice(argv.indexOf("--newline"), argv.indexOf("--newline") + 2)).toEqual([
      "--newline",
      "--progress-template",
    ]);
  });

  test("a second run for the persona exits 1 while the first holds its sources", async () => {
    const list = join(work, "urls.txt");
    writeFileSync(list, "https://example.invalid/ok/BV1aaaaaaaa1\n");
    const release = acquireLock(sourcesLockKey("milky-green"), "laplace-pipeline");
    try {
      const io = captureIo();
      expect(await downloadMain([list], io.io)).toBe(1);
      const message = `Another laplace-pipeline is running for milky-green (pid ${process.pid}).`;
      expect(logs.records).toEqual([["ERROR", message]]);
      const json = captureIo();
      expect(await downloadMain([list, "--json"], json.io)).toBe(1);
      const [stage, summary] = json
        .stdout()
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(stage).toMatchObject({
        type: "stage",
        stage: "download",
        status: "failed",
        code: "locked",
        message,
      });
      expect(summary).toMatchObject({ type: "summary", stage: "download", ok: false });
    } finally {
      release();
    }
    expect(readArgvLog(join(work, "argv.log"))).toEqual([]);
  });

  test("a missing list and an empty one end with a summary under --json", async () => {
    const missing = captureIo();
    expect(await downloadMain([join(work, "nope.txt"), "--json"], missing.io)).toBe(1);
    expect(missing.stdout()).toContain('"status":"failed"');
    expect(missing.stdout().trimEnd().split("\n").at(-1)).toContain('"type":"summary"');
    writeFileSync(join(work, "empty.txt"), "# none\n");
    const empty = captureIo();
    expect(await downloadMain([join(work, "empty.txt"), "--json"], empty.io)).toBe(0);
    const last = JSON.parse(empty.stdout().trimEnd().split("\n").at(-1) as string);
    expect(last).toMatchObject({ type: "summary", ok: true, counts: { requested: 0 } });
  });

  test("no yt-dlp to run exits 1 naming YT_DLP_PATH", async () => {
    setEnv({ YT_DLP_PATH: join(work, "missing") });
    const list = join(work, "urls.txt");
    writeFileSync(list, "https://example.invalid/ok/BV1aaaaaaaa1\n");
    expect(await downloadMain([list, "--vods-dir", join(work, "v")], captureIo().io)).toBe(1);
    expect(logs.records.at(-1)).toEqual([
      "ERROR",
      `yt-dlp not found at ${join(work, "missing")} (YT_DLP_PATH)`,
    ]);
  });

  test("--expand prints a playlist's video URLs and exits", async () => {
    const io = captureIo();
    expect(await downloadMain(["--expand", "https://example.invalid/playlist/2"], io.io)).toBe(0);
    expect(io.stdout()).toBe(
      "https://www.bilibili.com/video/BV1eeeeeeee1\nhttps://www.bilibili.com/video/BV1eeeeeeee2\n",
    );
    const failed = captureIo();
    expect(await downloadMain(["--expand", "https://example.invalid/fail/1"], failed.io)).toBe(1);
    expect(logs.records.at(-1)).toEqual([
      "ERROR",
      "yt-dlp failed (exit=1). stderr tail:\n    WARNING: line 1",
    ]);
  });

  test("--expand --json: an entry event per video, then the summary; the URL comes last, after --", async () => {
    const io = captureIo();
    const url = "https://example.invalid/playlist/3";
    expect(await downloadMain(["--expand", url, "--json"], io.io)).toBe(0);
    const events = io
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.every((event) => event.v === 1)).toBe(true);
    expect(events.map(({ v: _v, t: _t, durationSec: _d, ...event }) => event)).toEqual([
      { type: "stage", stage: "expand", status: "start" },
      {
        type: "entry",
        entry: {
          url: "https://www.bilibili.com/video/BV1eeeeeeee1",
          id: "BV1eeeeeeee1",
          title: "part 1",
          durationSec: 600.5,
        },
      },
      {
        type: "entry",
        entry: { url: "https://www.bilibili.com/video/BV1eeeeeeee2", id: "BV1eeeeeeee2" },
      },
      {
        type: "entry",
        entry: {
          url: "https://www.bilibili.com/video/BV1eeeeeeee3",
          id: "BV1eeeeeeee3",
          title: "part 3",
          durationSec: 1800.5,
        },
      },
      { type: "stage", stage: "expand", status: "done", total: 3 },
      { type: "summary", stage: "expand", ok: true, counts: { entries: 3 } },
    ]);
    expect(readArgvLog(join(work, "argv.log")).at(-1)?.slice(-2)).toEqual(["--", url]);

    const failed = captureIo();
    const cookies = "https://example.invalid/cookies";
    expect(await downloadMain(["--expand", cookies, "--json"], failed.io)).toBe(1);
    const last = failed
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .slice(-2);
    expect(last).toMatchObject([
      { type: "stage", stage: "expand", status: "failed", code: "cookies-unavailable" },
      { type: "summary", stage: "expand", ok: false, counts: { entries: 0 } },
    ]);
  });

  test("usage errors", async () => {
    const usage = "usage: laplace-download [-h]";
    for (const [argv, message] of [
      [[], "the following arguments are required: url_list"],
      [["--expand", "u", "list.txt"], "argument url_list: not allowed with argument --expand"],
      [["list.txt", "--persona", "nobody"], "argument --persona: write --persona nobody in full"],
      [
        ["list.txt", "--yt-dlp-args", "--no-playlist"],
        "argument --yt-dlp-args: expected one argument",
      ],
    ] as const) {
      const io = captureIo();
      expect(await downloadMain(argv, io.io)).toBe(2);
      expect(io.stderr()).toStartWith(usage);
      expect(io.stderr()).toEndWith(`laplace-download: error: ${message}\n`);
    }
    const help = captureIo();
    expect(await downloadMain(["-h"], help.io)).toBe(0);
    expect(help.stdout()).toContain("--expand URL          Print the video URLs");
  });
});
