// The spike harness's helpers: a run folder (data home, profile, logs and run.json, which main.cjs
// requires), launching the shell packaged or not, the loopback fakes, CDP through playwright-core,
// and each platform's process tools. Every process it starts is recorded in <runs>/pids.jsonl.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const IS_WINDOWS = process.platform === "win32";
export const TARGET = `${process.platform}-${process.arch}`;
/** Run folders: never inside the data home a real app uses. */
export const RUNS = resolve(
  process.env.EIDOLON_SPIKE_RUNS ??
    (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "eidolon-spike-runs") : join(SPIKE, ".runs")),
);
export const EVIDENCE = resolve(process.env.EIDOLON_SPIKE_EVIDENCE ?? join(SPIKE, ".evidence"));
export const PAYLOAD = join(SPIKE, ".stage", TARGET, "eidolon");
export const UNPACKAGED = IS_WINDOWS
  ? join(SPIKE, "node_modules/electron/dist/electron.exe")
  : join(SPIKE, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
export const PACKAGED_APP = join(SPIKE, ".out/mac-arm64/Eidolon.app");
export const PACKAGED = IS_WINDOWS ? join(SPIKE, ".out/win-unpacked/Eidolon.exe") : join(PACKAGED_APP, "Contents/MacOS/Eidolon");
/** The credential, setting and provider names a backend must never inherit (drop-names.ts). */
export const DROPPED = new Set(JSON.parse(readFileSync(join(SPIKE, "app/drop-names.json"), "utf8")));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function recordPid(pid, what) {
  mkdirSync(RUNS, { recursive: true });
  appendFileSync(join(RUNS, "pids.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), pid, what })}\n`);
}

// ---- the fakes ---------------------------------------------------------------------------------
const FAKES = join(RUNS, "fakes");

/** Starts scripts/fakes.ts under Bun in `dir`; resolves once it listens. */
export async function startFakes(dir = FAKES) {
  mkdirSync(dir, { recursive: true });
  const info = join(dir, "fakes.json");
  if (existsSync(info)) writeFileSync(info, "");
  const child = spawn("bun", [join(SPIKE, "scripts/fakes.ts"), dir], { stdio: ["ignore", "pipe", "pipe"] });
  recordPid(child.pid, `fakes in ${dir}`);
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(readFileSync(info, "utf8"));
      if (parsed.base) return { child, dir, ...parsed };
    } catch {}
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill();
  throw new Error(`the fakes did not start: ${output.trim().slice(0, 500)}`);
}

export function fakes(dir = FAKES) {
  return JSON.parse(readFileSync(join(dir, "fakes.json"), "utf8"));
}

/** The fakes' log entries after `fromSeq`. */
export function fakeLog(fromSeq = 0, dir = FAKES) {
  const path = join(dir, "fakes.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.seq > fromSeq);
}
export function lastFakeSeq(dir = FAKES) {
  return fakeLog(0, dir).at(-1)?.seq ?? 0;
}

/** The variables that point every provider role at the fakes, with fake keys. */
export function fakeEnv({ base, key } = fakes()) {
  return {
    OPENROUTER_API_KEY: key,
    OPENROUTER_API_BASE: base,
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: base,
    STT_PROVIDER: "openai",
    TTS_PROVIDER: "openai",
    TTS_VOICE_ID: "marin",
    RETRIEVAL_GATE_ENABLED: "false",
    RERANK_ENABLED: "false",
  };
}

// ---- runs and launches -----------------------------------------------------------------------
/** Writes <runs>/<name>/run.json, with the data home, profile and logs beside it. */
export function makeRun(name, options = {}) {
  const dir = join(RUNS, name);
  const run = {
    name,
    home: options.home ?? join(dir, "home"),
    logDir: join(dir, "logs"),
    userData: join(dir, "userdata"),
    preferredPort: options.preferredPort ?? 7860,
    cdpPort: options.cdpPort ?? null,
    fakeMicWav: options.fakeMicWav ?? null,
    onTop: options.onTop ?? false,
    audioServiceUnsandboxed: options.audioServiceUnsandboxed ?? false,
    payload: options.payload ?? null,
    env: { ...fakeEnv(options.fakes), ...(options.env ?? {}) },
  };
  mkdirSync(run.logDir, { recursive: true });
  mkdirSync(run.home, { recursive: true, mode: 0o700 });
  const file = join(dir, "run.json");
  writeFileSync(file, JSON.stringify(run, null, 1));
  return { ...run, dir, file };
}

/**
 * The environment a launch gets: on macOS a Finder launch's (launchd's), on Windows an Explorer
 * launch's stand-in, the harness's own minus every credential and provider name; plus the run file.
 */
export function appEnv(runFile, extra = {}) {
  if (IS_WINDOWS) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      const name = k.toUpperCase();
      if (DROPPED.has(name) || /^(EIDOLON_|ELECTRON_|ACTIONS_)/.test(name)) continue;
      env[k] = v;
    }
    return { ...env, ...extra, EIDOLON_SPIKE_RUN: runFile };
  }
  return {
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.USER,
    SHELL: process.env.SHELL ?? "/bin/zsh",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    __CFBundleIdentifier: "com.apple.finder",
    ...extra,
    EIDOLON_SPIKE_RUN: runFile,
  };
}
export const finderEnv = (runFile) => appEnv(runFile);

/** Launches the shell for `run`: `binary` (else the packaged or unpackaged build) with `args`. */
export function launchApp(run, { packaged = true, binary, args = [] } = {}) {
  const exe = binary ?? (packaged ? PACKAGED : UNPACKAGED);
  const argv = binary === undefined && !packaged ? [SPIKE, ...args] : args;
  const spawnedAt = Date.now();
  const child = spawn(exe, argv, { env: appEnv(run.file), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  recordPid(child.pid, `app ${exe} ${argv.join(" ")} for ${run.name}`);
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  return { child, spawnedAt, exited, output: () => output, binary: exe, argv };
}

/** The shell's events so far. */
export function shellEvents(run) {
  const path = join(run.logDir, "shell.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

export async function waitForEvent(run, predicate, timeoutMs = 30_000, after = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = shellEvents(run).filter((e) => e.at >= after).find(predicate);
    if (found) return found;
    await sleep(100);
  }
  return null;
}

export async function connect(port) {
  const { chromium } = await import("playwright-core");
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError;
}

/** The window's page: the one on eidolon-app://. */
export async function appPage(browser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith("eidolon-app://")) return page;
      }
    }
    await sleep(100);
  }
  throw new Error("no eidolon-app:// page");
}

// ---- processes -------------------------------------------------------------------------------
/** Runs a PowerShell script, passed encoded so no quoting reaches the command line. */
export function powershell(script, options = {}) {
  // No progress records: redirected, PowerShell writes them to stderr as CLIXML.
  const encoded = Buffer.from(`$ProgressPreference = "SilentlyContinue"\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, "utf16le").toString("base64");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}
export function powershellJson(script, options) {
  const out = powershell(`${script} | ConvertTo-Json -Compress -Depth 6`, options).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Processes whose command line mentions `needle`, as {pid, ppid, command, exe}. */
export function processes(needle) {
  if (IS_WINDOWS) {
    return powershellJson(
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine",
    )
      .filter((p) => (p.CommandLine ?? "").includes(needle) || (p.ExecutablePath ?? "").includes(needle))
      .map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, command: p.CommandLine ?? "", exe: p.ExecutablePath ?? null }));
  }
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes(needle) && !l.includes("ps -axo"))
    .map((l) => {
      const [pid, ppid, ...rest] = l.split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), command: rest.join(" "), exe: null };
    });
}

/** Starts a background poll that appends every process named `name` to `file` as JSON lines. */
export function watchProcesses(file, name) {
  if (IS_WINDOWS) {
    const script = `$ProgressPreference = "SilentlyContinue"; while ($true) { Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress | Add-Content -LiteralPath '${file.replace(/'/g, "''")}' -Encoding UTF8; Start-Sleep -Milliseconds 50 }`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: "ignore" });
    recordPid(child.pid, `process watch for ${name}`);
    return {
      stop() {
        child.kill();
      },
      seen() {
        if (!existsSync(file)) return [];
        const out = new Map();
        for (const line of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean)) {
          let parsed;
          try {
            parsed = JSON.parse(line.replace(/^\uFEFF/, ""));
          } catch {
            continue;
          }
          for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
            out.set(p.ProcessId, { pid: p.ProcessId, ppid: p.ParentProcessId, exe: p.ExecutablePath, command: p.CommandLine ?? "" });
          }
        }
        return [...out.values()];
      },
    };
  }
  const seen = new Map();
  const timer = setInterval(() => {
    for (const p of processes(name)) if (!seen.has(p.pid)) seen.set(p.pid, p);
  }, 30);
  return {
    stop() {
      clearInterval(timer);
    },
    seen() {
      return [...seen.values()];
    },
  };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listeningPorts(pid) {
  try {
    const out = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    return out.split("\n").slice(1).filter(Boolean).map((l) => l.split(/\s+/).at(-2));
  } catch {
    return [];
  }
}

export function writeEvidence(name, value) {
  mkdirSync(EVIDENCE, { recursive: true });
  const path = join(EVIDENCE, name);
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 1)}\n`);
  return path;
}
