// CI's update test without Electron or an install: the feed's files, manifests, ranges and routes,
// checked against electron-updater's own reading of a manifest and over real loopback requests;
// main.log's steps, against the lines the real updater logs; and what it reads of an install.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findFile,
  Provider,
  parseUpdateInfo,
  resolveFiles,
} from "electron-updater/out/providers/Provider.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProcessRow } from "../scripts/smoke/processes.ts";
import {
  byteRange,
  type Feed,
  feedFiles,
  manifestName,
  readManifest,
  requestedName,
  type Served,
  servedSummary,
  servedUpdate,
  startFeed,
  updateFile,
  wantedNames,
} from "../scripts/update-test/feed.ts";
import {
  appProcesses,
  atVersion,
  defaultLogs,
  exeVersionScript,
  mains,
  plutilVersion,
  sameVersion,
  versionsText,
  windowsVersions,
} from "../scripts/update-test/installs.ts";
import { follow, startedVersion, tail, updateSteps } from "../scripts/update-test/steps.ts";
import { type NativeUi, nativeUi } from "../src/main/background.ts";
import { QuitConfirmation } from "../src/main/quit-check.ts";
import { QuitFlow } from "../src/main/quit-flow.ts";
import { STRINGS } from "../src/main/strings.ts";
import { LAUNCH_CHECK_DELAY_MS, UpdateFlow, updaterMode } from "../src/main/update-flow.ts";

const SHA512 = `${"q".repeat(86)}==`;
/** latest-mac.yml as electron-builder writes it: the zip alone, since the DMG writes no update info. */
const MAC_MANIFEST = [
  "version: 0.0.2",
  "files:",
  "  - url: Eidolon-0.0.2-arm64-mac.zip",
  `    sha512: ${SHA512}`,
  "    size: 251658240",
  "path: Eidolon-0.0.2-arm64-mac.zip",
  `sha512: ${SHA512}`,
  "releaseDate: '2026-11-22T10:00:00.000Z'",
  "",
].join("\n");
/** latest.yml: a generic feed keeps the setup's own name, spaces and all. */
const WIN_MANIFEST = [
  "version: 0.0.2",
  "files:",
  "  - url: Eidolon Setup 0.0.2.exe",
  `    sha512: ${SHA512}`,
  "    size: 262144000",
  "path: Eidolon Setup 0.0.2.exe",
  `sha512: ${SHA512}`,
  "releaseDate: '2026-11-22T10:00:00.000Z'",
  "",
].join("\n");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eidolon-update-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A folder of empty files, and folders for names ending in `/`. */
function folder(name: string, entries: readonly string[]): string {
  const path = join(dir, name);
  mkdirSync(path);
  for (const entry of entries) {
    if (entry.endsWith("/")) mkdirSync(join(path, entry));
    else writeFileSync(join(path, entry), "");
  }
  return path;
}

describe("the feed's files", () => {
  test("latest*.yml as electron-builder writes it: the version and each file url: and path: name", () => {
    expect(manifestName("darwin")).toBe("latest-mac.yml");
    expect(manifestName("win32")).toBe("latest.yml");
    expect(readManifest(MAC_MANIFEST)).toEqual({
      version: "0.0.2",
      files: ["Eidolon-0.0.2-arm64-mac.zip"],
    });
    expect(readManifest(WIN_MANIFEST.replaceAll("\n", "\r\n"))).toEqual({
      version: "0.0.2",
      files: ["Eidolon Setup 0.0.2.exe"],
    });
    // YAML quotes a value that needs it, a single quote doubled inside single quotes.
    expect(
      readManifest(
        "version: '1.2.3'\nfiles:\n  - url: \"a b.zip\"\n    size: 1\n  - url: 'it''s.zip'\npath: \"a b.zip\"\n",
      ),
    ).toEqual({ version: "1.2.3", files: ["a b.zip", "it's.zip"] });
    expect(readManifest("files: []\n")).toEqual({ version: null, files: [] });
  });

  test("the update is the file electron-updater downloads: the zip on macOS, the setup on Windows", () => {
    expect(updateFile(readManifest(MAC_MANIFEST), "darwin")).toBe("Eidolon-0.0.2-arm64-mac.zip");
    expect(updateFile(readManifest(WIN_MANIFEST), "win32")).toBe("Eidolon Setup 0.0.2.exe");
    expect(
      updateFile({ version: "0.0.2", files: ["Eidolon-0.0.2-arm64.dmg", "x.zip"] }, "darwin"),
    ).toBe("x.zip");
    expect(updateFile(readManifest(MAC_MANIFEST), "win32")).toBeNull();
  });

  test.each([
    ["darwin", MAC_MANIFEST, "latest-mac.yml"],
    ["win32", WIN_MANIFEST, "latest.yml"],
  ] as const)(
    "on %s, names each URL electron-updater derives from the manifest: the update, its blockmap and the old version's",
    async (platform, text, channel) => {
      const base = new URL("http://127.0.0.1:8765/");
      const info = parseUpdateInfo(text, channel, new URL(channel, base));
      const resolved = resolveFiles(info, base);
      const update =
        platform === "darwin"
          ? findFile(resolved, "zip", ["pkg", "dmg"])
          : findFile(resolved, "exe");
      if (update == null) throw new Error("electron-updater found no update file");
      const urls = [
        update.url,
        ...(await Provider.prototype.getBlockMapFiles(update.url, "0.0.1", "0.0.2")),
      ];
      const asked = urls.map((url) => requestedName(`${url.pathname}${url.search}`));
      const manifest = readManifest(text);
      const file = updateFile(manifest, platform);
      expect(file).toBe(asked[0]);
      expect(new Set(wantedNames(manifest, file as string, "0.0.1"))).toEqual(new Set(asked));
    },
  );

  test("wanted: each file the manifest names, the update's blockmap and the old version's", () => {
    const mac = readManifest(MAC_MANIFEST);
    expect(wantedNames(mac, "Eidolon-0.0.2-arm64-mac.zip", "0.0.1")).toEqual([
      "Eidolon-0.0.2-arm64-mac.zip",
      "Eidolon-0.0.2-arm64-mac.zip.blockmap",
      "Eidolon-0.0.1-arm64-mac.zip.blockmap",
    ]);
    const windows = readManifest(WIN_MANIFEST);
    expect(wantedNames(windows, "Eidolon Setup 0.0.2.exe", "0.0.1")).toEqual([
      "Eidolon Setup 0.0.2.exe",
      "Eidolon Setup 0.0.2.exe.blockmap",
      "Eidolon Setup 0.0.1.exe.blockmap",
    ]);
  });

  test("serves the new outputs' manifest, installers and blockmaps and the old outputs' blockmaps alone", () => {
    const older = folder("old", [
      "latest-mac.yml",
      "Eidolon-0.0.1-arm64.dmg",
      "Eidolon-0.0.1-arm64-mac.zip",
      "Eidolon-0.0.1-arm64-mac.zip.blockmap",
      "builder-debug.yml",
      "mac-arm64/",
    ]);
    const newer = folder("new", [
      "latest-mac.yml",
      "Eidolon-0.0.2-arm64.dmg",
      "Eidolon-0.0.2-arm64-mac.zip",
      "Eidolon-0.0.2-arm64-mac.zip.blockmap",
      "builder-debug.yml",
      "builder-effective-config.yaml",
      "mac-arm64/",
      "Eidolon.zip/",
    ]);
    expect(Object.fromEntries(feedFiles(older, newer))).toEqual({
      "latest-mac.yml": join(newer, "latest-mac.yml"),
      "Eidolon-0.0.2-arm64.dmg": join(newer, "Eidolon-0.0.2-arm64.dmg"),
      "Eidolon-0.0.2-arm64-mac.zip": join(newer, "Eidolon-0.0.2-arm64-mac.zip"),
      "Eidolon-0.0.2-arm64-mac.zip.blockmap": join(newer, "Eidolon-0.0.2-arm64-mac.zip.blockmap"),
      "Eidolon-0.0.1-arm64-mac.zip.blockmap": join(older, "Eidolon-0.0.1-arm64-mac.zip.blockmap"),
    });
  });

  test("refuses two builds of one version, whose blockmaps share a name", () => {
    const older = folder("old", ["latest.yml", "Eidolon Setup 0.0.2.exe.blockmap"]);
    const newer = folder("new", ["latest.yml", "Eidolon Setup 0.0.2.exe.blockmap"]);
    expect(() => feedFiles(older, newer)).toThrow(
      "Eidolon Setup 0.0.2.exe.blockmap is in both builds' outputs",
    );
  });
});

describe("a request's byte range", () => {
  test("none is the whole file", () => {
    expect(byteRange(undefined, 100)).toEqual({ kind: "whole" });
  });

  test("one range: first-last, first- to the end, -suffix, the last clamped to the size", () => {
    expect(byteRange("bytes=0-0", 100)).toEqual({ kind: "part", start: 0, end: 0 });
    expect(byteRange("bytes=10-19", 100)).toEqual({ kind: "part", start: 10, end: 19 });
    expect(byteRange("bytes=90-", 100)).toEqual({ kind: "part", start: 90, end: 99 });
    expect(byteRange("bytes=-5", 100)).toEqual({ kind: "part", start: 95, end: 99 });
    expect(byteRange("bytes=-500", 100)).toEqual({ kind: "part", start: 0, end: 99 });
    expect(byteRange("bytes=95-1000", 100)).toEqual({ kind: "part", start: 95, end: 99 });
  });

  test("refused: past the end, backwards, empty, several ranges, another unit, garbled", () => {
    for (const header of [
      "bytes=100-",
      "bytes=100-200",
      "bytes=20-10",
      "bytes=-0",
      "bytes=-",
      "bytes=0-1,5-6",
      "items=0-5",
      "bytes=a-b",
      "",
    ]) {
      expect([header, byteRange(header, 100)]).toEqual([header, { kind: "refused" }]);
    }
    expect(byteRange("bytes=0-", 0)).toEqual({ kind: "refused" });
  });
});

describe("a request's file", () => {
  test("its path's one segment, percent-decoded, the query dropped", () => {
    expect(requestedName("/latest-mac.yml?noCache=1jx0g2")).toBe("latest-mac.yml");
    expect(requestedName("/Eidolon%20Setup%200.0.2.exe")).toBe("Eidolon Setup 0.0.2.exe");
    expect(requestedName("/Eidolon-0.0.1-arm64-mac.zip.blockmap")).toBe(
      "Eidolon-0.0.1-arm64-mac.zip.blockmap",
    );
  });

  test("none for the root, a folder, a path out of it, or a garbled escape", () => {
    for (const path of ["/", "", "latest.yml", "/a/b", "/..%2Fsecret", "/%2e%2e", "/%E0%A4%A"]) {
      expect([path, requestedName(path)]).toEqual([path, null]);
    }
  });
});

describe("the feed over loopback", () => {
  let feed: Feed;
  let served: Served[];
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

  beforeEach(async () => {
    const files = folder("feed", []);
    writeFileSync(join(files, "latest.yml"), WIN_MANIFEST);
    writeFileSync(join(files, "Eidolon Setup 0.0.2.exe"), bytes);
    writeFileSync(join(files, "empty.blockmap"), "");
    served = [];
    feed = await startFeed(
      new Map([
        ["latest.yml", join(files, "latest.yml")],
        ["Eidolon Setup 0.0.2.exe", join(files, "Eidolon Setup 0.0.2.exe")],
        ["empty.blockmap", join(files, "empty.blockmap")],
      ]),
      { onServed: (entry) => served.push(entry) },
    );
  });

  afterEach(async () => {
    await feed.close();
  });

  const get = (path: string, init: RequestInit = {}) => fetch(new URL(path, feed.url), init);

  test("listens on 127.0.0.1, and answers a file whole with its length and Accept-Ranges", async () => {
    expect(feed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const manifest = await get("/latest.yml?noCache=abc");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("accept-ranges")).toBe("bytes");
    expect(manifest.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
    expect(await manifest.text()).toBe(WIN_MANIFEST);
    const setup = await get("/Eidolon%20Setup%200.0.2.exe");
    expect(setup.status).toBe(200);
    expect(setup.headers.get("content-type")).toBe("application/octet-stream");
    expect(setup.headers.get("content-length")).toBe("256");
    expect(Buffer.from(await setup.arrayBuffer())).toEqual(bytes);
  });

  test("answers one range with 206, its Content-Range and exactly its bytes", async () => {
    const part = await get("/Eidolon%20Setup%200.0.2.exe", { headers: { range: "bytes=16-31" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 16-31/256");
    expect(part.headers.get("content-length")).toBe("16");
    expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(16, 32));
    const suffix = await get("/Eidolon%20Setup%200.0.2.exe", { headers: { range: "bytes=-4" } });
    expect(suffix.headers.get("content-range")).toBe("bytes 252-255/256");
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(252));
  });

  test("refuses an unsatisfiable or multiple range with 416 and the size, never the whole file", async () => {
    for (const range of ["bytes=256-", "bytes=0-1,4-5"]) {
      const refused = await get("/Eidolon%20Setup%200.0.2.exe", { headers: { range } });
      expect([range, refused.status, await refused.text()]).toEqual([range, 416, ""]);
      expect(refused.headers.get("content-range")).toBe("bytes */256");
    }
  });

  test("HEAD gives the headers alone; an empty file answers empty", async () => {
    const head = await get("/Eidolon%20Setup%200.0.2.exe", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("256");
    expect(await head.text()).toBe("");
    const empty = await get("/empty.blockmap");
    expect([empty.status, empty.headers.get("content-length"), await empty.text()]).toEqual([
      200,
      "0",
      "",
    ]);
  });

  test("404 for a file it doesn't serve, 405 for anything but GET and HEAD", async () => {
    for (const path of ["/latest-mac.yml", "/Eidolon Setup 0.0.1.exe.blockmap", "/", "/a/b"]) {
      const missing = await get(path);
      expect([path, missing.status]).toEqual([path, 404]);
      await missing.body?.cancel();
    }
    const posted = await get("/latest.yml", { method: "POST", body: "x" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
    await posted.body?.cancel();
  });

  test("records each request it answered: the file, the range, the status and the bytes sent", async () => {
    await (await get("/latest.yml?noCache=1")).text();
    await (await get("/Eidolon%20Setup%200.0.2.exe", { headers: { range: "bytes=0-9" } })).text();
    await (await get("/missing.zip")).text();
    // Each is recorded when its response closes, which can trail the body on a busy runner.
    await vi.waitFor(() => expect(served).toHaveLength(3));
    expect(served).toEqual([
      {
        method: "GET",
        path: "/latest.yml?noCache=1",
        name: "latest.yml",
        range: null,
        status: 200,
        bytes: WIN_MANIFEST.length,
        complete: true,
      },
      {
        method: "GET",
        path: "/Eidolon%20Setup%200.0.2.exe",
        name: "Eidolon Setup 0.0.2.exe",
        range: "bytes=0-9",
        status: 206,
        bytes: 10,
        complete: true,
      },
      {
        method: "GET",
        path: "/missing.zip",
        name: "missing.zip",
        range: null,
        status: 404,
        bytes: 0,
        complete: true,
      },
    ]);
    expect(feed.served).toEqual(served);
  });

  test("refuses a port already taken, naming it", async () => {
    const port = Number(new URL(feed.url).port);
    await expect(startFeed(new Map(), { port })).rejects.toThrow(
      `the feed can't listen on 127.0.0.1:${port}`,
    );
  });
});

test("what the feed served of a file: whole, in ranges, or not at all", () => {
  const entry = (name: string, status: number, bytes: number): Served => ({
    method: "GET",
    path: `/${encodeURIComponent(name)}`,
    name,
    range: status === 206 ? "bytes=0-1" : null,
    status,
    bytes,
    complete: true,
  });
  const served = [
    entry("latest.yml", 200, 400),
    entry("Eidolon Setup 0.0.2.exe.blockmap", 200, 2048),
    entry("Eidolon Setup 0.0.1.exe.blockmap", 404, 0),
    entry("Eidolon Setup 0.0.2.exe", 206, 1_048_576),
    entry("Eidolon Setup 0.0.2.exe", 206, 524_288),
  ];
  expect(servedSummary(served, "latest.yml")).toBe("latest.yml whole (400 bytes)");
  expect(servedSummary(served, "Eidolon Setup 0.0.2.exe")).toBe(
    "Eidolon Setup 0.0.2.exe in 2 ranges (1.5 MB)",
  );
  expect(servedSummary(served, "Eidolon Setup 0.0.1.exe.blockmap")).toBe(
    "Eidolon Setup 0.0.1.exe.blockmap 404",
  );
  expect(servedSummary(served, "Eidolon-0.0.2-arm64-mac.zip")).toBe(
    "Eidolon-0.0.2-arm64-mac.zip never asked for",
  );
});

describe("whether the feed served the update as it should", () => {
  const get = (name: string, status: number): Served => ({
    method: "GET",
    path: `/${encodeURIComponent(name)}`,
    name,
    range: status === 206 ? "bytes=0-1" : null,
    status,
    bytes: 2,
    complete: true,
  });
  const WIN = {
    manifest: "latest.yml",
    update: "Eidolon Setup 0.0.2.exe",
    blockmaps: ["Eidolon Setup 0.0.2.exe.blockmap", "Eidolon Setup 0.0.1.exe.blockmap"],
  };
  const DIFFERENTIAL = [
    get("latest.yml", 200),
    get("Eidolon Setup 0.0.1.exe.blockmap", 200),
    get("Eidolon Setup 0.0.2.exe.blockmap", 200),
    get("Eidolon Setup 0.0.2.exe", 206),
    get("Eidolon Setup 0.0.2.exe", 206),
  ];

  test("Windows: the manifest, both blockmaps, then the setup in ranges alone", () => {
    expect(servedUpdate(DIFFERENTIAL, "win32", WIN)).toBe(true);
  });

  // electron-updater downloads the whole setup when its differential download fails.
  test("Windows: fails a whole setup, a blockmap not served, or no setup at all", () => {
    expect(servedUpdate([...DIFFERENTIAL, get(WIN.update, 200)], "win32", WIN)).toBe(false);
    expect(servedUpdate([get("latest.yml", 200), get(WIN.update, 200)], "win32", WIN)).toBe(false);
    const withoutOld = DIFFERENTIAL.filter((entry) => entry.name !== WIN.blockmaps[1]);
    expect(servedUpdate(withoutOld, "win32", WIN)).toBe(false);
    expect(servedUpdate([...withoutOld, get(WIN.blockmaps[1] as string, 404)], "win32", WIN)).toBe(
      false,
    );
    expect(servedUpdate(DIFFERENTIAL.slice(0, 3), "win32", WIN)).toBe(false);
  });

  test("macOS: the manifest, then the zip, whole on a first update", () => {
    const MAC = {
      manifest: "latest-mac.yml",
      update: "Eidolon-0.0.2-arm64-mac.zip",
      blockmaps: ["Eidolon-0.0.2-arm64-mac.zip.blockmap", "Eidolon-0.0.1-arm64-mac.zip.blockmap"],
    };
    expect(servedUpdate([get(MAC.manifest, 200), get(MAC.update, 200)], "darwin", MAC)).toBe(true);
    expect(servedUpdate([get(MAC.manifest, 200)], "darwin", MAC)).toBe(false);
    expect(servedUpdate([get(MAC.update, 200)], "darwin", MAC)).toBe(false);
  });
});

describe("main.log's steps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** electron-log's prefix on each line, as main.log has it. */
  const logged = (lines: readonly string[], eol = "\n") =>
    lines.map((line) => `[2026-11-22 12:00:00.000] [info]  ${line}`).join(eol);

  test("are the lines the real updater logs in background mode under EIDOLON_DESKTOP_UPDATE_TEST, in order", async () => {
    const lines: string[] = [];
    const log = {
      info: (line: string) => lines.push(line),
      warn: (line: string) => lines.push(line),
    };
    lines.push(
      updaterMode({
        packaged: true,
        background: true,
        platform: "darwin",
        exePath: "/t/Applications/Eidolon.app/Contents/MacOS/Eidolon",
        env: { EIDOLON_DESKTOP_UPDATE_TEST: "1" },
        checkWritable: () => {},
      }).line,
    );
    const electron = new Proxy({} as NativeUi, {
      get: () => () => {
        throw new Error("background mode reached Electron");
      },
    });
    const native = nativeUi(true, electron, log);
    const confirmation = new QuitConfirmation({
      check: async () => ({ calls: 0, tasks: 0, jobs: 0 }),
      strings: () => STRINGS.en,
      show: (box) => native.messageBox(box),
      focus: () => {},
      platform: "darwin",
    });
    const quit = new QuitFlow({
      confirm: (purpose) => confirmation.confirm(purpose),
      hideWindows: () => {},
      stopBackend: async () => {},
      quit: () => {},
      log: { info: log.info, error: log.warn },
    });
    let installs = 0;
    const flow = new UpdateFlow({
      driver: {
        check: async () => ({
          version: "0.0.2",
          files: [],
          path: "",
          sha512: "",
          releaseDate: "2026-11-22T10:00:00.000Z",
        }),
        download: async (progress) => progress(100),
        install: () => installs++,
      },
      restart: (install, installable) => quit.restart(install, installable),
      relaunch: () => {},
      show: (box) => native.messageBox(box),
      open: () => {},
      progress: () => {},
      strings: () => STRINGS.en,
      version: "0.0.1",
      platform: "darwin",
      log,
    });
    flow.backendReady();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(installs).toBe(1);
    const steps = updateSteps("0.0.2", "darwin");
    const progress = follow(logged(lines), steps);
    expect(progress.stopped).toBeNull();
    expect(progress.lines).toHaveLength(steps.length);
    expect(progress.lines.at(-1)).toContain("Eidolon: installing 0.0.2");
  });

  test("each step has a name, a line and a deadline", () => {
    const steps = updateSteps("0.0.2", "darwin");
    expect(steps.map((step) => step.line)).toEqual([
      "Eidolon: updates are on in background mode (EIDOLON_DESKTOP_UPDATE_TEST)",
      "Eidolon: checking for updates",
      "Eidolon: update available: 0.0.2",
      "Eidolon: downloading 0.0.2",
      "Eidolon: update downloaded: 0.0.2",
      "Eidolon: restarting to install 0.0.2",
      "Eidolon: quitting to install the update",
      "Eidolon: installing 0.0.2",
    ]);
    for (const step of steps) {
      expect(step.name).not.toBe("");
      expect(step.ms).toBeGreaterThanOrEqual(30_000);
    }
  });

  test("are followed in order only, whatever the line endings", () => {
    const steps = updateSteps("0.0.2", "darwin");
    // Downloading before the update was found doesn't count until it comes again after.
    const text = logged(
      [
        "Eidolon 0.0.1 · Electron 45.4.1 · Chromium 142 · Node 24 · darwin 25.0.0 arm64",
        "Eidolon: updates are on in background mode (EIDOLON_DESKTOP_UPDATE_TEST)",
        "Eidolon: downloading 0.0.2",
        "Eidolon: checking for updates",
        "Eidolon: update available: 0.0.2",
      ],
      "\r\n",
    );
    expect(follow(text, steps)).toEqual({
      lines: [
        "[2026-11-22 12:00:00.000] [info]  Eidolon: updates are on in background mode (EIDOLON_DESKTOP_UPDATE_TEST)",
        "[2026-11-22 12:00:00.000] [info]  Eidolon: checking for updates",
        "[2026-11-22 12:00:00.000] [info]  Eidolon: update available: 0.0.2",
      ],
      stopped: null,
    });
    expect(follow("", steps)).toEqual({ lines: [], stopped: null });
  });

  test("count a line only as its own message, not quoted inside another's", () => {
    const steps = updateSteps("0.0.2", "darwin");
    const text = logged([
      'Eidolon: background mode answered "OK" to a message box: Eidolon: updates are on in background mode (EIDOLON_DESKTOP_UPDATE_TEST)',
      "Error: Eidolon: up to date: 0.0.2 is the latest",
    ]);
    expect(follow(text, steps)).toEqual({ lines: [], stopped: null });
    expect(
      follow("Eidolon: updates are on in background mode (EIDOLON_DESKTOP_UPDATE_TEST)", steps)
        .lines,
    ).toHaveLength(1);
  });

  test("stop at a line after which the update can't go on without a person", () => {
    const steps = updateSteps("0.0.2", "darwin");
    const on = "Eidolon: updates are on in background mode (EIDOLON_DESKTOP_UPDATE_TEST)";
    for (const [before, stop] of [
      [[], "Eidolon: updates are off in background mode"],
      [
        [],
        "Eidolon: updates are off: this copy isn't the one installed in %LOCALAPPDATA%\\Programs\\eidolon",
      ],
      [[on, "Eidolon: checking for updates"], "Eidolon: up to date: 0.0.1 is the latest"],
      [[on, "Eidolon: checking for updates"], "Eidolon: the update check failed: net::ERR_FAILED"],
      [
        [on, "Eidolon: checking for updates", "Eidolon: update available: 0.0.2"],
        "Eidolon: an update box didn't show: no window",
      ],
      [
        [
          on,
          "Eidolon: checking for updates",
          "Eidolon: update available: 0.0.2",
          "Eidolon: downloading 0.0.2",
        ],
        "Eidolon: the download of 0.0.2 failed: New version 0.0.2 is not signed by the application owner",
      ],
      [
        [on, "Eidolon: update downloaded: 0.0.2"],
        "Eidolon: 0.0.2 can't be installed: Code signature did not pass validation",
      ],
      [[on], "Eidolon: 0.0.2 stays downloaded, to install at the next restart or quit"],
      [[on], "Eidolon: the restart failed: stopping failed"],
      [[on], "Eidolon: restarting without the update"],
    ] as const) {
      const progress = follow(logged([...before, stop, "Eidolon: installing 0.0.2"]), steps);
      expect(progress.stopped).toBe(`[2026-11-22 12:00:00.000] [info]  ${stop}`);
    }
  });

  test("on Windows include the setup's signature check, after the download starts, and stop on its refusal", () => {
    const steps = updateSteps("0.0.2", "win32");
    expect(steps.map((step) => step.line).slice(3, 6)).toEqual([
      "Eidolon: downloading 0.0.2",
      "Eidolon: the update's signature is valid",
      "Eidolon: update downloaded: 0.0.2",
    ]);
    expect(updateSteps("0.0.2", "darwin").map((step) => step.line)).not.toContain(
      "Eidolon: the update's signature is valid",
    );
    const refused =
      "Eidolon: the update's signature doesn't check out: couldn't check the update's signature: Error: spawn powershell.exe ETIMEDOUT";
    expect(follow(logged([refused]), steps).stopped).toBe(
      `[2026-11-22 12:00:00.000] [info]  ${refused}`,
    );
  });

  test("the version a log's last start line names, and its tail", () => {
    const text = logged([
      "Eidolon 0.0.1 · Electron 45.4.1 · Chromium 142.0.7444.59 · Node 24.11.0 · win32 10.0.26100 x64",
      "Eidolon: quitting",
      "Eidolon 0.0.2 · Electron 45.4.1 · Chromium 142.0.7444.59 · Node 24.11.0 · win32 10.0.26100 x64",
      "Eidolon: the backend listens on http://127.0.0.1:7860",
    ]);
    expect(startedVersion(text)).toBe("0.0.2");
    expect(startedVersion(logged(["Eidolon 0.0.3 (unpackaged) · Electron 45.4.1 · …"]))).toBe(
      "0.0.3",
    );
    expect(startedVersion("Eidolon: quitting\n")).toBeNull();
    expect(tail("a\nb\n\nc\r\nd\n", 2)).toEqual(["c", "d"]);
    expect(tail("", 2)).toEqual([]);
  });
});

describe("an install", () => {
  test("is at a version when every source says it, Windows' resource with its fourth part 0", () => {
    expect(sameVersion("0.0.2", "0.0.2")).toBe(true);
    expect(sameVersion("0.0.2.0", "0.0.2")).toBe(true);
    for (const reported of ["0.0.1", "0.0.2.1", "0.0.21", "10.0.2", "", null]) {
      expect([reported, sameVersion(reported, "0.0.2")]).toEqual([reported, false]);
    }
    const versions = { "the uninstall entry's DisplayVersion": "0.0.2", "Eidolon.exe": "0.0.2" };
    expect(atVersion(versions, "0.0.2")).toBe(true);
    expect(atVersion({ ...versions, "Eidolon.exe": null }, "0.0.2")).toBe(false);
    expect(atVersion({}, "0.0.2")).toBe(false);
    expect(versionsText({ ...versions, "Eidolon.exe": null })).toBe(
      "the uninstall entry's DisplayVersion 0.0.2, Eidolon.exe unread",
    );
  });

  test("macOS: the bundle's CFBundleShortVersionString, as plutil extracts it", () => {
    expect(plutilVersion(0, "0.0.2\n")).toBe("0.0.2");
    expect(plutilVersion(0, "")).toBeNull();
    expect(
      plutilVersion(
        1,
        "/t/Eidolon.app/Contents/Info.plist: (The file “Info.plist” couldn’t be opened because there is no such file.)",
      ),
    ).toBeNull();
  });

  test("Windows: the uninstall entry naming the folder's uninstaller, and Eidolon.exe's FileVersion", () => {
    const folder = "C:\\Users\\runneradmin\\AppData\\Local\\Programs\\eidolon";
    const ours = {
      DisplayName: "Eidolon 0.0.2",
      DisplayVersion: "0.0.2",
      UninstallString: `"${folder}\\Uninstall Eidolon.exe" /currentuser`,
    };
    const other = {
      DisplayName: "Eidolon Notes 2.1.0",
      DisplayVersion: "2.1.0",
      UninstallString: `"${folder}-notes\\Uninstall Eidolon Notes.exe" /currentuser`,
    };
    expect(
      windowsVersions([other, ours], [{ FileVersion: "0.0.2", ProductVersion: "0.0.2.0" }], folder),
    ).toEqual({
      "the uninstall entry's DisplayVersion": "0.0.2",
      "Eidolon.exe's FileVersion": "0.0.2",
    });
    expect(windowsVersions([other], [], folder)).toEqual({
      "the uninstall entry's DisplayVersion": null,
      "Eidolon.exe's FileVersion": null,
    });
    expect(exeVersionScript("C:\\it's\\Eidolon.exe")).toBe(
      "Get-Item -LiteralPath 'C:\\it''s\\Eidolon.exe' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ FileVersion = [string]$_.VersionInfo.FileVersion; ProductVersion = [string]$_.VersionInfo.ProductVersion } }",
    );
  });

  test("macOS: its processes run its own executable, not Squirrel.Mac's ShipIt from inside it", () => {
    const app = "/Users/runner/work/_temp/eidolon-update-test-a1/Applications/Eidolon.app";
    const table: ProcessRow[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 500, ppid: 1, command: `${app}/Contents/MacOS/Eidolon` },
      {
        pid: 501,
        ppid: 500,
        command: `${app}/Contents/Frameworks/Eidolon Helper (Renderer).app/Contents/MacOS/Eidolon Helper (Renderer) --type=renderer`,
      },
      {
        pid: 502,
        ppid: 500,
        command: `${app}/Contents/MacOS/Eidolon --disable-sigusr1 --use-system-ca ${app}/Contents/Resources/eidolon/dist/server.js`,
      },
      {
        pid: 600,
        ppid: 1,
        command: `${app}/Contents/Frameworks/Squirrel.framework/Resources/ShipIt live.laplace.eidolon.ShipIt /Users/runner/Library/Caches/live.laplace.eidolon.ShipIt/ShipItState.plist`,
      },
      { pid: 700, ppid: 1, command: `${app}.old/Contents/MacOS/Eidolon` },
      { pid: 701, ppid: 1, command: "/Applications/Eidolon.app/Contents/MacOS/Eidolon" },
    ];
    const rows = appProcesses(table, app, "darwin");
    expect(rows.map((row) => row.pid)).toEqual([500, 502]);
    expect(mains(rows).map((row) => row.pid)).toEqual([500]);
  });

  test("Windows: its processes run from its folder, whatever the case; the update's setup doesn't", () => {
    const folder = "C:\\Users\\runneradmin\\AppData\\Local\\Programs\\eidolon";
    const table: ProcessRow[] = [
      { pid: 4, ppid: 0, command: "System" },
      { pid: 900, ppid: 880, command: `"${folder}\\Eidolon.exe" --updated` },
      { pid: 901, ppid: 900, command: `"${folder}\\Eidolon.exe" --type=gpu-process` },
      {
        pid: 902,
        ppid: 900,
        command: `"${folder.toUpperCase()}\\EIDOLON.EXE" --disable-sigusr1 --use-system-ca "${folder}\\resources\\eidolon\\dist\\server.js"`,
      },
      {
        pid: 950,
        ppid: 1,
        command: `"C:\\Users\\runneradmin\\AppData\\Local\\eidolon-updater\\pending\\Eidolon Setup 0.0.2.exe" --updated /S --force-run`,
      },
      { pid: 960, ppid: 1, command: `"${folder}-notes\\Eidolon Notes.exe"` },
      { pid: 970, ppid: 1, command: "Eidolon.exe" },
    ];
    const rows = appProcesses(table, folder, "win32");
    expect(rows.map((row) => row.pid)).toEqual([900, 901, 902]);
    expect(mains(rows).map((row) => row.pid)).toEqual([900]);
  });

  test("the default profile's logs, where Squirrel.Mac's and NSIS's relaunch writes", () => {
    expect(defaultLogs("darwin", {}, "/Users/runner")).toBe("/Users/runner/Library/Logs/Eidolon");
    expect(
      defaultLogs(
        "win32",
        { APPDATA: "C:\\Users\\runneradmin\\AppData\\Roaming" },
        "C:\\Users\\runneradmin",
      ),
    ).toBe("C:\\Users\\runneradmin\\AppData\\Roaming\\Eidolon\\logs");
    expect(defaultLogs("win32", {}, "C:\\Users\\runneradmin")).toBe(
      "C:\\Users\\runneradmin\\AppData\\Roaming\\Eidolon\\logs",
    );
  });
});
