// The managed yt-dlp against a fake GitHub: never a real download.
import "../../config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, type LogRecord, logger, setLogLevel } from "@eidolon/config";
import {
  acquireLock,
  binDir,
  download,
  type ProgressEvent,
  YT_DLP_LOCK_KEY,
} from "../src/index.ts";

const LINUX = { platform: "linux", arch: "x64", musl: false } as const;
const DAY = download.UPDATE_INTERVAL_MS;
const T0 = Date.parse("2026-11-05T12:00:00Z");

let work = "";
let records: [string, string][] = [];
const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ingest-ytdlp-"));
  setEnv("YT_DLP_PATH", undefined);
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

interface Release {
  tag: string;
  body: Uint8Array<ArrayBuffer>;
  /** Overrides what SHA2-256SUMS lists for the asset. */
  sum?: string;
}

/** GitHub's releases pages as yt-dlp publishes them, for `release`, with every request logged. */
function fakeGitHub(
  release: () => Release | Error,
  asset = "yt-dlp_linux",
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const current = release();
    if (current instanceof Error) throw current;
    if (url === "https://github.com/yt-dlp/yt-dlp/releases/latest") {
      expect(init?.redirect).toBe("manual");
      return new Response("<html>", {
        status: 302,
        headers: { location: `https://github.com/yt-dlp/yt-dlp/releases/tag/${current.tag}` },
      });
    }
    const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${current.tag}/`;
    if (!url.startsWith(base)) return new Response("not found", { status: 404 });
    const name = url.slice(base.length);
    if (name === "SHA2-256SUMS") {
      const sum = current.sum ?? new Bun.CryptoHasher("sha256").update(current.body).digest("hex");
      return new Response(
        `${"1".repeat(64)}  yt-dlp\n${sum}  ${asset}\n${"2".repeat(64)}  yt-dlp_zzz\n`,
      );
    }
    return new Response(current.body, {
      headers: { "content-length": String(current.body.length) },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const managed = () => join(binDir(), "yt-dlp");

describe("ytDlpAsset", () => {
  test("picks the release asset yt-dlp builds for each platform, or none", () => {
    const cases: [string, string, boolean, string | null][] = [
      ["darwin", "arm64", false, "yt-dlp_macos"],
      ["darwin", "x64", false, "yt-dlp_macos"],
      ["linux", "x64", false, "yt-dlp_linux"],
      ["linux", "arm64", false, "yt-dlp_linux_aarch64"],
      ["linux", "x64", true, "yt-dlp_musllinux"],
      ["linux", "arm64", true, "yt-dlp_musllinux_aarch64"],
      ["linux", "arm", false, null],
      ["win32", "x64", false, "yt-dlp.exe"],
      ["win32", "arm64", false, "yt-dlp_arm64.exe"],
      ["win32", "ia32", false, null],
      ["freebsd", "x64", false, null],
    ];
    for (const [platform, arch, musl, asset] of cases) {
      expect([platform, arch, musl, download.ytDlpAsset(platform, arch, musl)]).toEqual([
        platform,
        arch,
        musl,
        asset,
      ]);
    }
  });
});

describe("resolveYtDlp", () => {
  test("YT_DLP_PATH wins and is never updated; a missing one names the setting", async () => {
    const own = join(work, "my-yt-dlp");
    writeFileSync(own, "#!/bin/sh\n");
    chmodSync(own, 0o755);
    setEnv("YT_DLP_PATH", own);
    const github = fakeGitHub(() => new Error("no network"));
    expect(await download.resolveYtDlp({ ...LINUX, fetch: github.fetch })).toEqual({
      path: own,
      source: "setting",
    });
    expect(github.calls).toEqual([]);
    setEnv("YT_DLP_PATH", join(work, "missing"));
    await expect(download.resolveYtDlp(LINUX)).rejects.toThrow(
      expect.objectContaining({
        name: "YtDlpUnavailableError",
        code: "ytdlp-unavailable",
        message: `yt-dlp not found at ${join(work, "missing")} (YT_DLP_PATH)`,
      }),
    );
  });

  test("where yt-dlp builds nothing, one on PATH runs with a warning, else none does", async () => {
    const bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "yt-dlp"), "#!/bin/sh\n");
    chmodSync(join(bin, "yt-dlp"), 0o755);
    setEnv("PATH", `${bin}:/usr/bin:/bin`);
    const found = await download.resolveYtDlp({ platform: "linux", arch: "arm" });
    expect(found).toEqual({ path: join(bin, "yt-dlp"), source: "path" });
    expect(records).toEqual([
      [
        "WARNING",
        `yt-dlp publishes no build for linux arm; using ${join(bin, "yt-dlp")}, which is never updated`,
      ],
    ]);
    setEnv("PATH", "/usr/bin:/bin");
    await expect(download.resolveYtDlp({ platform: "freebsd", arch: "x64" })).rejects.toThrow(
      "yt-dlp publishes no build for freebsd x64; install yt-dlp and set YT_DLP_PATH to it",
    );
  });

  test("installs the latest release, checked against SHA2-256SUMS, and reports it as setup", async () => {
    const body = bytes("#!/bin/sh\necho 2026.10.26\n");
    const github = fakeGitHub(() => ({ tag: "2026.10.26", body }));
    const events: ProgressEvent[] = [];
    const found = await download.resolveYtDlp({
      ...LINUX,
      fetch: github.fetch,
      now: () => T0,
      onProgress: (event) => events.push(event),
    });
    expect(found).toEqual({ path: managed(), source: "managed", tag: "2026.10.26" });
    expect(readFileSync(managed())).toEqual(Buffer.from(body));
    expect(statSync(managed()).mode & 0o777).toBe(0o755);
    expect(github.calls).toEqual([
      "https://github.com/yt-dlp/yt-dlp/releases/latest",
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS",
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux",
    ]);
    expect(events).toEqual([
      { type: "stage", stage: "setup", status: "start", message: "yt-dlp 2026.10.26" },
      {
        type: "progress",
        stage: "setup",
        item: "yt-dlp_linux",
        done: body.length,
        total: body.length,
        unit: "bytes",
      },
      { type: "stage", stage: "setup", status: "done", message: "yt-dlp 2026.10.26" },
    ]);
    expect(JSON.parse(readFileSync(join(binDir(), "yt-dlp.stamp.json"), "utf8"))).toEqual({
      tag: "2026.10.26",
      asset: "yt-dlp_linux",
      sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
      checkedAt: new Date(T0).toISOString(),
    });
    expect(readdirSync(binDir()).sort()).toEqual(["yt-dlp", "yt-dlp.stamp.json"]);
  });

  test("asks GitHub at most once a day, and updates only to a new tag", async () => {
    let release: Release = { tag: "2026.10.26", body: bytes("old") };
    const github = fakeGitHub(() => release);
    let now = T0;
    const opts = { ...LINUX, fetch: github.fetch, now: () => now };
    await download.resolveYtDlp(opts);
    github.calls.length = 0;

    now = T0 + DAY - 1;
    release = { tag: "2026.11.01", body: bytes("new") };
    expect(await download.resolveYtDlp(opts)).toMatchObject({ tag: "2026.10.26" });
    expect(github.calls).toEqual([]);

    now = T0 + DAY;
    expect(await download.resolveYtDlp(opts)).toMatchObject({ tag: "2026.11.01" });
    expect(readFileSync(managed(), "utf8")).toBe("new");
    expect(github.calls).toHaveLength(3);

    github.calls.length = 0;
    now = T0 + 2 * DAY;
    expect(await download.resolveYtDlp(opts)).toMatchObject({ tag: "2026.11.01" });
    expect(github.calls).toEqual(["https://github.com/yt-dlp/yt-dlp/releases/latest"]);
    const stamp = JSON.parse(readFileSync(join(binDir(), "yt-dlp.stamp.json"), "utf8"));
    expect(stamp.checkedAt).toBe(new Date(T0 + 2 * DAY).toISOString());
  });

  test("force asks even within the day", async () => {
    const github = fakeGitHub(() => ({ tag: "2026.10.26", body: bytes("x") }));
    let now = T0;
    await download.resolveYtDlp({ ...LINUX, fetch: github.fetch, now: () => now });
    github.calls.length = 0;
    now = T0 + 60_000;
    await download.resolveYtDlp({ ...LINUX, fetch: github.fetch, now: () => now, force: true });
    expect(github.calls).toEqual(["https://github.com/yt-dlp/yt-dlp/releases/latest"]);
  });

  test("a binary that fails its checksum is never installed", async () => {
    const good = fakeGitHub(() => ({ tag: "2026.10.26", body: bytes("good") }));
    let now = T0;
    await download.resolveYtDlp({ ...LINUX, fetch: good.fetch, now: () => now });
    const events: ProgressEvent[] = [];
    const bad = fakeGitHub(() => ({ tag: "2026.11.01", body: bytes("evil"), sum: "f".repeat(64) }));
    now = T0 + DAY;
    const kept = await download.resolveYtDlp({
      ...LINUX,
      fetch: bad.fetch,
      now: () => now,
      onProgress: (event) => events.push(event),
    });
    expect(kept).toMatchObject({ tag: "2026.10.26" });
    expect(readFileSync(managed(), "utf8")).toBe("good");
    expect(readdirSync(binDir()).sort()).toEqual(["yt-dlp", "yt-dlp.stamp.json"]);
    expect(events.at(-1)).toMatchObject({ type: "stage", stage: "setup", status: "failed" });
    expect(events.at(-1)).not.toHaveProperty("code");
    expect(records.at(-1)?.[0]).toBe("WARNING");
    expect(records.at(-1)?.[1]).toStartWith("Could not update yt-dlp (yt-dlp_linux of 2026.11.01");

    rmSync(binDir(), { recursive: true, force: true });
    // No yt-dlp on PATH to fall back to.
    setEnv("PATH", join(work, "empty"));
    await expect(
      download.resolveYtDlp({ ...LINUX, fetch: bad.fetch, now: () => now }),
    ).rejects.toThrow(expect.objectContaining({ name: "YtDlpUnavailableError" }));
    expect(existsSync(managed())).toBe(false);
    expect(readdirSync(binDir())).toEqual([]);
  });

  test("when installing fails, a yt-dlp on PATH runs instead, with a warning", async () => {
    const onPath = join(work, "path-bin");
    mkdirSync(onPath);
    writeFileSync(join(onPath, "yt-dlp"), "#!/bin/sh\n");
    chmodSync(join(onPath, "yt-dlp"), 0o755);
    setEnv("PATH", onPath);
    const fallback = { path: join(onPath, "yt-dlp"), source: "path" } as const;

    // GitHub unreachable: no release to install.
    const offline = fakeGitHub(() => new Error("getaddrinfo ENOTFOUND"));
    expect(await download.resolveYtDlp({ ...LINUX, fetch: offline.fetch, now: () => T0 })).toEqual(
      fallback,
    );
    expect(records.at(-1)).toEqual([
      "WARNING",
      `Could not install yt-dlp (getaddrinfo ENOTFOUND); using ${fallback.path}, which is never updated`,
    ]);

    // A download that fails its checksum: the setup stage fails, but yt-dlp is there to run.
    const events: ProgressEvent[] = [];
    const bad = fakeGitHub(() => ({ tag: "2026.11.01", body: bytes("evil"), sum: "f".repeat(64) }));
    const found = await download.resolveYtDlp({
      ...LINUX,
      fetch: bad.fetch,
      now: () => T0,
      onProgress: (event) => events.push(event),
    });
    expect(found).toEqual(fallback);
    expect(existsSync(managed())).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "stage", stage: "setup", status: "failed" });
    expect(events.at(-1)).not.toHaveProperty("code");

    // And with none on PATH, the stage fails with code ytdlp-unavailable.
    setEnv("PATH", join(work, "empty"));
    events.length = 0;
    await expect(
      download.resolveYtDlp({
        ...LINUX,
        fetch: bad.fetch,
        now: () => T0,
        onProgress: (event) => events.push(event),
      }),
    ).rejects.toThrow(expect.objectContaining({ name: "YtDlpUnavailableError" }));
    expect(events.at(-1)).toMatchObject({ status: "failed", code: "ytdlp-unavailable" });
  });

  test("a failed check keeps the installed copy and waits a day to ask again", async () => {
    let fail = false;
    const github = fakeGitHub(() =>
      fail ? new Error("getaddrinfo ENOTFOUND") : { tag: "2026.10.26", body: bytes("x") },
    );
    let now = T0;
    const opts = { ...LINUX, fetch: github.fetch, now: () => now };
    await download.resolveYtDlp(opts);
    fail = true;
    now = T0 + DAY;
    expect(await download.resolveYtDlp(opts)).toEqual({
      path: managed(),
      source: "managed",
      tag: "2026.10.26",
    });
    expect(records.at(-1)).toEqual([
      "WARNING",
      "Could not update yt-dlp (getaddrinfo ENOTFOUND); keeping the installed one",
    ]);
    github.calls.length = 0;
    now = T0 + DAY + 1;
    await download.resolveYtDlp(opts);
    expect(github.calls).toEqual([]);

    rmSync(binDir(), { recursive: true, force: true });
    setEnv("PATH", join(work, "empty"));
    await expect(download.resolveYtDlp(opts)).rejects.toThrow(
      "Could not install yt-dlp: getaddrinfo ENOTFOUND. Set YT_DLP_PATH to run another yt-dlp.",
    );
  });

  test("while another process holds the update lock, an installed copy runs as it is", async () => {
    const github = fakeGitHub(() => ({ tag: "2026.10.26", body: bytes("x") }));
    let now = T0;
    await download.resolveYtDlp({ ...LINUX, fetch: github.fetch, now: () => now });
    github.calls.length = 0;
    const release = acquireLock(YT_DLP_LOCK_KEY, "laplace-pipeline");
    try {
      now = T0 + DAY;
      expect(
        await download.resolveYtDlp({ ...LINUX, fetch: github.fetch, now: () => now }),
      ).toMatchObject({ tag: "2026.10.26" });
      expect(github.calls).toEqual([]);
    } finally {
      release();
    }
  });

  test("with nothing installed, it waits for the lock, then installs", async () => {
    const github = fakeGitHub(() => ({ tag: "2026.10.26", body: bytes("x") }));
    const release = acquireLock(YT_DLP_LOCK_KEY, "laplace-pipeline");
    setTimeout(release, 150);
    const found = await download.resolveYtDlp({
      ...LINUX,
      fetch: github.fetch,
      now: () => T0,
      lockPollMs: 20,
    });
    expect(found).toMatchObject({ source: "managed", tag: "2026.10.26" });
    expect(records[0]).toEqual(["INFO", "Waiting for another process to install yt-dlp"]);
  });

  test("cancelling an install leaves no binary and no temp file, and says cancelled", async () => {
    const controller = new AbortController();
    const github = fakeGitHub(() => ({ tag: "2026.10.26", body: bytes("x") }));
    const stalled = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/yt-dlp_linux")) return github.fetch(input, init);
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(bytes("partial"));
          signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
          controller.abort(new DOMException("stop", "AbortError"));
        },
      });
      return new Response(body);
    }) as typeof fetch;
    const events: ProgressEvent[] = [];
    await expect(
      download.resolveYtDlp({
        ...LINUX,
        fetch: stalled,
        signal: controller.signal,
        onProgress: (event) => events.push(event),
      }),
    ).rejects.toThrow("stop");
    expect(events.at(-1)).toEqual({ type: "stage", stage: "setup", status: "cancelled" });
    expect(readdirSync(binDir())).toEqual([]);
  });

  test("cancelling stops the wait for the lock", async () => {
    const release = acquireLock(YT_DLP_LOCK_KEY, "laplace-pipeline");
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("stop", "AbortError")), 50);
      await expect(
        download.resolveYtDlp({ ...LINUX, signal: controller.signal, lockPollMs: 10 }),
      ).rejects.toThrow("stop");
    } finally {
      release();
    }
  });

  test("on Windows the running exe is renamed aside before the new one takes its name", async () => {
    let release: Release = { tag: "2026.10.26", body: bytes("old") };
    const github = fakeGitHub(() => release, "yt-dlp.exe");
    const win = { platform: "win32", arch: "x64", fetch: github.fetch } as const;
    let now = T0;
    await download.resolveYtDlp({ ...win, now: () => now });
    expect(readFileSync(join(binDir(), "yt-dlp.exe"), "utf8")).toBe("old");
    release = { tag: "2026.11.01", body: bytes("new") };
    now = T0 + DAY;
    expect(await download.resolveYtDlp({ ...win, now: () => now })).toEqual({
      path: join(binDir(), "yt-dlp.exe"),
      source: "managed",
      tag: "2026.11.01",
    });
    expect(readFileSync(join(binDir(), "yt-dlp.exe"), "utf8")).toBe("new");
    expect(readFileSync(join(binDir(), "yt-dlp.exe.old"), "utf8")).toBe("old");
  });
});
