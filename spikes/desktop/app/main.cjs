// Phase 0 spike of the Eidolon desktop shell, on macOS arm64 and Windows x64. Not product code:
// Phase 1's apps/desktop replaces it.
// D1: the backend is this binary run as Node (ELECTRON_RUN_AS_NODE=1) on the staged npm build's
// dist/server.js, with an IPC channel. D2: the window loads eidolon-app://app/ and main forwards every
// path to the backend with the local token as a Bearer; the page holds no credential. D5: closing
// hides. D6: hidden title bar.
//
// Spike safety: nothing starts without EIDOLON_SPIKE_RUN naming a run file whose data home, profile
// and logs sit inside the run file's own folder, so no launch of this build can reach the owner's
// ~/.laplace/eidolon or an installed app's profile.
"use strict";

const { app, BrowserWindow, protocol, session, systemPreferences } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SCHEME = "eidolon-app";
const APP_ORIGIN = `${SCHEME}://app`;
const APP_USER_MODEL_ID = "live.laplace.eidolon";
const DEFAULT_PORT = 7860;
const IS_MAC = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";
const LAUNCHED_AT = Date.now() - Math.round(process.uptime() * 1000);
// A second launch with --quit quits the first instance; the smokes stop the app this way.
const QUIT_REQUESTED = process.argv.includes("--quit");

// ---- spike run file (safety gate) ----------------------------------------------------------
const runFile = process.env.EIDOLON_SPIKE_RUN;
if (!runFile) {
  console.error("eidolon spike: EIDOLON_SPIKE_RUN is not set; refusing to start");
  process.exit(1);
}
const runDir = path.dirname(path.resolve(runFile));
const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
const insideRun = (value) => {
  if (typeof value !== "string") return false;
  const relative = path.relative(runDir, path.resolve(value));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};
if (!insideRun(run.home) || !insideRun(run.userData) || !insideRun(run.logDir)) {
  console.error("eidolon spike: the run's data home, profile and logs must sit inside its folder; refusing to start");
  process.exit(1);
}
const HOME = path.resolve(run.home);
const USER_DATA = path.resolve(run.userData);
const LOG_DIR = path.resolve(run.logDir);
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });

// Synchronous appends: the last events before an exit must reach the file.
const SHELL_LOG = path.join(LOG_DIR, "shell.jsonl");
const BACKEND_LOG = path.join(LOG_DIR, "backend.log");
function mark(event, fields = {}) {
  try {
    fs.appendFileSync(SHELL_LOG, `${JSON.stringify({ at: Date.now(), sinceLaunch: Date.now() - LAUNCHED_AT, event, ...fields })}\n`);
  } catch {}
}
mark("main-start", {
  launchedAt: LAUNCHED_AT,
  packaged: app.isPackaged,
  execPath: process.execPath,
  electron: process.versions.electron,
  node: process.versions.node,
  mainPid: process.pid,
  quit: QUIT_REQUESTED,
});

// ---- before ready: scheme, switches, profile, single instance -------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);
if (!QUIT_REQUESTED) {
  // Spike-only hooks, from the run file: CDP for the harness, and Chromium's fake microphone.
  if (run.cdpPort) app.commandLine.appendSwitch("remote-debugging-port", String(run.cdpPort));
  if (run.fakeMicWav) {
    app.commandLine.appendSwitch("use-fake-device-for-media-stream");
    app.commandLine.appendSwitch("use-file-for-fake-audio-capture", run.fakeMicWav);
    // The sandboxed audio service can't read the WAV and captures silence.
    if (run.audioServiceUnsandboxed) app.commandLine.appendSwitch("disable-features", "AudioServiceSandbox");
  }
}
// The run's own profile, so the single-instance lock and the origin's storage are shared across
// its launches as the product's would be, and nothing lands in the default profile or its logs.
app.setPath("userData", USER_DATA);
app.setAppLogsPath(path.join(USER_DATA, "logs"));
if (!app.requestSingleInstanceLock({ command: QUIT_REQUESTED ? "quit" : "show" })) {
  mark("second-instance-exit", { quit: QUIT_REQUESTED });
  app.exit(0);
  return;
}
if (QUIT_REQUESTED) {
  mark("quit-nothing-running");
  app.exit(0);
  return;
}
// Before any window: Electron's default electron.app.Eidolon wouldn't match the NSIS shortcut's.
if (IS_WINDOWS) app.setAppUserModelId(APP_USER_MODEL_ID);

// ---- login-shell environment (macOS; a compact port of deepseek-harness's login-shell-environment.ts) ----
const DELIMITER = "_EIDOLON_SHELL_ENV_DELIMITER_";
const MARKER = Buffer.from(`\0${DELIMITER}\0`);
const DUMP = `printf '\\0%s\\0' '${DELIMITER}'; command env -0 || exit; printf '\\0%s\\0' '${DELIMITER}'; exit`;
const PROBE_ENV = { DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true", ZSH_TMUX_AUTOSTART: "false" };
const SESSION_KEYS = new Set(["PWD", "OLDPWD", "SHLVL", "_", ...Object.keys(PROBE_ENV)]);
const LAUNCHER_PREFIXES = ["EIDOLON_", "ELECTRON_"];

function parseDump(stdout) {
  const parts = stdout.split("\0");
  const first = parts.indexOf(DELIMITER);
  const last = parts.lastIndexOf(DELIMITER);
  if (first === -1 || first === last) return undefined;
  const vars = {};
  for (const entry of parts.slice(first + 1, last)) {
    const at = entry.indexOf("=");
    if (at > 0) vars[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return vars;
}

function readShell(shell, base, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shell, ["-ilc", DUMP], {
        cwd: os.homedir(),
        env: { ...base, ...PROBE_ENV },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch (error) {
      resolve(String(error));
      return;
    }
    const chunks = [];
    let tail = Buffer.alloc(0);
    let markers = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners("data");
      child.stdout.resume();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish("timeout");
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      const window = Buffer.concat([tail, chunk]);
      for (let i = window.indexOf(MARKER); i !== -1; i = window.indexOf(MARKER, i + MARKER.length)) markers++;
      tail = window.subarray(Math.max(0, window.length - MARKER.length + 1));
      if (markers >= 2) finish(parseDump(Buffer.concat(chunks).toString("utf8")) ?? "unparsed");
    });
    child.on("error", (error) => finish(error.message));
    child.on("close", (code, signal) => {
      if (code !== 0) finish(signal ?? `exit ${code}`);
      else finish(parseDump(Buffer.concat(chunks).toString("utf8")) ?? "unparsed");
    });
  });
}

async function loginShellEnvironment(base) {
  let account = null;
  try {
    account = os.userInfo().shell;
  } catch {}
  const shells = [...new Set([...(account ? [account] : []), "/bin/zsh", "/bin/bash", "/bin/sh"])];
  const failures = [];
  const started = Date.now();
  for (const shell of shells) {
    const result = await readShell(shell, base, 10_000);
    if (typeof result !== "string") {
      const merged = { ...base };
      for (const [k, v] of Object.entries(result)) {
        if (SESSION_KEYS.has(k) || LAUNCHER_PREFIXES.some((p) => k.startsWith(p))) continue;
        merged[k] = v;
      }
      mark("login-shell", {
        shell,
        ms: Date.now() - started,
        vars: Object.keys(result).length,
        pathDirs: (result.PATH ?? "").split(":").length,
        basePathDirs: (base.PATH ?? "").split(":").length,
        failures,
      });
      return merged;
    }
    failures.push({ shell, reason: result });
  }
  mark("login-shell", { shell: null, ms: Date.now() - started, failures });
  return { ...base };
}

/** macOS reads the login shell; Windows takes the launch environment as it is. */
function launchEnvironment() {
  if (IS_MAC && process.env.EIDOLON_DESKTOP_LOGIN_SHELL !== "0") return loginShellEnvironment(process.env);
  mark("login-shell", { skipped: IS_MAC ? "EIDOLON_DESKTOP_LOGIN_SHELL=0" : process.platform });
  return Promise.resolve({ ...process.env });
}

// ---- backend --------------------------------------------------------------------------------
const PAYLOAD = app.isPackaged
  ? path.join(process.resourcesPath, "eidolon")
  : path.resolve(run.payload ?? path.join(__dirname, "..", ".stage", `${process.platform}-${process.arch}`, "eidolon"));
const SERVER_JS = path.join(PAYLOAD, "dist", "server.js");
const DROPPED = new Set(require("./drop-names.json"));
const LINK_CODE = /#\d{1,12}\.[A-Za-z0-9_-]{43}/;
// Before the script, as jsRuntime().args will put them (contract C12).
const NODE_ARGS = ["--disable-sigusr1", "--use-system-ca"];

let backendEnv = null;
let child = null;
let backendPort = null;
let token = null;
let quitting = false;
let stopping = false;
let backendStopped = false;
let readyWaiters = [];
let backendFailure = null;
let restarts = 0;

function backendReady() {
  if (backendPort !== null && child !== null) return Promise.resolve(backendPort);
  if (backendFailure !== null) return Promise.reject(backendFailure);
  return new Promise((resolve, reject) => readyWaiters.push({ resolve, reject }));
}
function settleWaiters(error) {
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve(backendPort);
}

function buildBackendEnv(shellEnv) {
  const env = {};
  const dropped = [];
  for (const [k, v] of Object.entries(shellEnv)) {
    if (v === undefined) continue;
    // Windows names are case-insensitive.
    const name = IS_WINDOWS ? k.toUpperCase() : k;
    if (DROPPED.has(name) || name.startsWith("EIDOLON_") || name.startsWith("ELECTRON_")) {
      dropped.push(k);
      continue;
    }
    env[k] = v;
  }
  Object.assign(env, run.env ?? {}, {
    EIDOLON_APP_ROOT: PAYLOAD,
    EIDOLON_NO_DOTENV: "1",
    ELECTRON_RUN_AS_NODE: "1",
    EIDOLON_HOME: HOME,
    EIDOLON_SHARED_SKILLS: path.join(path.dirname(HOME), `${path.basename(HOME)}-shared-skills`),
  });
  mark("backend-env", { dropped: dropped.sort(), added: Object.keys(run.env ?? {}).sort(), names: Object.keys(env).length });
  return env;
}

function pipeLines(stream, label, onLine) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    rest += chunk;
    let at;
    while ((at = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, at).replace(/\r$/, "");
      rest = rest.slice(at + 1);
      onLine(line);
      // Both lines that hold a sign-in link: a first start's, and a second start's.
      const linkLine = line.includes("Eidolon is ready:") || line.includes("Eidolon is already running:") || LINK_CODE.test(line);
      try {
        fs.appendFileSync(BACKEND_LOG, `${new Date().toISOString()} ${label} ${linkLine ? "[link line dropped]" : line}\n`);
      } catch {}
    }
  });
}

/** null when 127.0.0.1:`port` can be bound, else the error's code. */
function bindError(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve(error.code ?? String(error)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(null)));
  });
}

function launch(port) {
  return new Promise((resolve, reject) => {
    const args = [...NODE_ARGS, SERVER_JS, "--host", "127.0.0.1", "--port", String(port), "--no-open"];
    const started = Date.now();
    // Not detached: on macOS a crash of main closes the IPC channel, which stops the server; on
    // Windows the backend shares main's job.
    const c = spawn(process.execPath, args, {
      cwd: os.homedir(),
      env: backendEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    mark("backend-spawn", { pid: c.pid, port, args: args.map((a) => (a === SERVER_JS ? "<payload>/dist/server.js" : a)) });
    let stdoutTail = "";
    let stderrTail = "";
    let listening = false;
    pipeLines(c.stdout, "out", (line) => (stdoutTail = `${stdoutTail}${line}\n`.slice(-8192)));
    pipeLines(c.stderr, "err", (line) => (stderrTail = `${stderrTail}${line}\n`.slice(-8192)));
    c.on("message", (message) => {
      if (message && message.kind === "listening" && Number.isInteger(message.port) && !listening) {
        listening = true;
        mark("backend-listening", { pid: c.pid, port: message.port, ms: Date.now() - started });
        resolve({ child: c, port: message.port });
      } else {
        mark("backend-message-ignored", { kind: message?.kind });
      }
    });
    c.on("error", (error) => {
      mark("backend-spawn-error", { message: error.message });
      if (!listening) reject(error);
    });
    c.on("exit", (code, signal) => {
      mark("backend-exit", { pid: c.pid, code, signal, listening, ms: Date.now() - started });
      if (!listening) {
        const error = new Error(`the backend exited ${code ?? signal} before listening`);
        error.portTaken = code === 1 && /is taken by another program|listen EACCES/.test(stderrTail);
        error.alreadyRunning = code === 0 && /Eidolon is already running/.test(stdoutTail);
        error.stderrTail = stderrTail.split("\n").slice(-6).join("\n");
        reject(error);
        return;
      }
      onBackendExit(c, code, signal);
    });
  });
}

async function startBackend(port) {
  try {
    let launched;
    try {
      launched = await launch(port);
    } catch (error) {
      if (!error.portTaken || port === 0) throw error;
      mark("port-taken", { port, retry: 0 });
      launched = await launch(0);
    }
    child = launched.child;
    backendPort = launched.port;
    backendFailure = null;
    // A first start writes the token, and deleting the file rotates it: read it after every spawn.
    token = fs.readFileSync(path.join(HOME, "local-token"), "utf8").trim();
    mark("token-read", { file: "<home>/local-token", length: token.length });
    settleWaiters(null);
    return backendPort;
  } catch (error) {
    backendFailure = error;
    mark("backend-failed", { message: error.message, portTaken: !!error.portTaken, alreadyRunning: !!error.alreadyRunning, stderrTail: error.stderrTail });
    settleWaiters(error);
    showFailure(error);
    throw error;
  }
}

function onBackendExit(c, code, signal) {
  if (c !== child) return;
  child = null;
  const port = backendPort;
  backendPort = null;
  if (quitting) return;
  if (code === 75) {
    restarts += 1;
    mark("backend-restart", { port, restarts });
    startBackend(port).then(
      (bound) => mark("backend-restarted", { port: bound, samePort: bound === port }),
      () => {},
    );
    return;
  }
  const error = new Error(`the backend stopped (${code ?? signal})`);
  backendFailure = error;
  mark("backend-died", { code, signal });
  showFailure(error);
}

function exitWithin(exited, ms) {
  return Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function stopBackend() {
  const c = child;
  if (c === null) return;
  const started = Date.now();
  const exited = new Promise((resolve) => c.once("exit", (code, signal) => resolve({ code, signal })));
  mark("backend-stop", { pid: c.pid, connected: c.connected });
  // The server's stop trigger on every platform: it stops when its IPC channel closes.
  if (c.connected) c.disconnect();
  let result = await exitWithin(exited, 10_000);
  if (result === null) {
    mark("backend-kill", { pid: c.pid });
    c.kill();
    result = await exitWithin(exited, 5_000);
  }
  if (result === null && !IS_WINDOWS) {
    mark("backend-sigkill", { pid: c.pid });
    c.kill("SIGKILL");
    result = await exitWithin(exited, 5_000);
  }
  mark("backend-stopped", { pid: c.pid, ...(result ?? { code: "unknown" }), ms: Date.now() - started });
}

// ---- the forwarder ------------------------------------------------------------------------------
const WITHHELD_RESPONSE_HEADERS = [
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
];
let headerSamples = 0;

async function forward(request, source) {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== APP_ORIGIN) {
    mark("forward-refused", { origin, path: source.pathname });
    return new Response(null, { status: 403 });
  }
  let port;
  try {
    port = await Promise.race([
      backendReady(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30_000)),
    ]);
  } catch (error) {
    mark("forward-unavailable", { path: source.pathname, message: error.message });
    return new Response("Eidolon is not running", { status: 503 });
  }
  if (headerSamples < 4 || source.pathname.startsWith("/api/")) {
    headerSamples += 1;
    mark("forward-headers", {
      method: request.method,
      path: source.pathname,
      names: [...request.headers.keys()].sort(),
      origin,
      secFetchSite: request.headers.get("sec-fetch-site"),
      secFetchMode: request.headers.get("sec-fetch-mode"),
      cookie: request.headers.has("cookie"),
      authorization: request.headers.has("authorization"),
    });
  }
  const target = new URL(`http://127.0.0.1:${port}`);
  target.pathname = source.pathname;
  target.search = source.search;
  const headers = new Headers(request.headers);
  for (const name of ["host", "origin", "cookie", "sec-fetch-site", "x-eidolon-proof"]) headers.delete(name);
  headers.set("authorization", `Bearer ${token}`);
  const init = { method: request.method, headers, redirect: "manual", signal: request.signal };
  if (request.body !== null && request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  const started = Date.now();
  request.signal?.addEventListener("abort", () => mark("forward-aborted", { path: source.pathname, ms: Date.now() - started }));
  let response;
  try {
    response = await fetch(target, init);
  } catch (error) {
    mark("forward-error", { method: request.method, path: source.pathname, message: String(error?.cause?.code ?? error?.message ?? error) });
    return new Response("Eidolon did not answer", { status: 502 });
  }
  const outgoing = new Headers(response.headers);
  const withheld = WITHHELD_RESPONSE_HEADERS.filter((name) => outgoing.has(name));
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name);
  mark("forward", {
    method: request.method,
    path: source.pathname,
    status: response.status,
    type: (response.headers.get("content-type") ?? "").split(";")[0],
    ms: Date.now() - started,
    withheld,
  });
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
let failureText = null;
function shellPage(url) {
  const failed = url.pathname === "/failed";
  const body = failed
    ? `<h1>Eidolon could not start</h1><pre>${escapeHtml(failureText ?? "")}</pre>`
    : "<p>Starting Eidolon…</p>";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Eidolon</title><style>
html,body{height:100%;margin:0}body{display:grid;place-items:center;font:13px -apple-system,system-ui;color:#777;-webkit-app-region:drag}
@media (prefers-color-scheme:dark){body{background:#212121;color:#aaa}}pre{white-space:pre-wrap;max-width:70ch}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

// ---- window -----------------------------------------------------------------------------------
let win = null;

function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === `${SCHEME}:` && url.hostname === "app";
  } catch {
    return false;
  }
}

function showFailure(error) {
  failureText = `${error.message}${error.stderrTail ? `\n\n${error.stderrTail}` : ""}`;
  if (win && !win.isDestroyed()) {
    win.loadURL(`${SCHEME}://shell/failed`).catch(() => {});
    win.show();
  }
}

// Resolves once the sidebar is in the DOM and painted (two frames later) and FCP is recorded.
const PROBE = `new Promise((resolve) => {
  const started = Date.now();
  let sidebarAt = null;
  let paintedAt = null;
  const fcp = () => performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint");
  const tick = () => {
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    const locked = /Open Eidolon from Your Terminal/.test(document.body?.innerText ?? "");
    if (sidebar && sidebarAt === null) {
      sidebarAt = Date.now();
      requestAnimationFrame(() => requestAnimationFrame(() => { paintedAt = Date.now(); }));
    }
    const done = (paintedAt !== null && fcp()) || locked || Date.now() - started > 20000;
    if (done) {
      const header = document.querySelector('[data-slot="sidebar"] a, [data-slot="sidebar"] svg');
      const rect = header ? header.getBoundingClientRect() : null;
      resolve(JSON.stringify({
        sidebarHeaderRect: rect && { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), text: header.textContent.trim().slice(0, 40) },
        timeOrigin: performance.timeOrigin,
        paints: performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]),
        sidebarAt,
        sidebarPaintedAt: paintedAt,
        locked,
        path: location.pathname,
        origin: location.origin,
        secure: window.isSecureContext,
      }));
    } else setTimeout(tick, 16);
  };
  tick();
})`;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 600,
    show: false,
    ...(IS_MAC
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } }
      : { titleBarStyle: "hidden", titleBarOverlay: { color: "#00000000", symbolColor: "#777777", height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mark("window-created");
  win.once("ready-to-show", () => {
    mark("window-ready-to-show");
    // Timing runs only: keep the window above others until Home is probed, so occlusion doesn't
    // stop its frames (Electron reports an occluded window as hidden and Chromium stops painting).
    if (run.onTop) {
      win.setAlwaysOnTop(true, "floating");
      app.focus({ steal: true });
    }
    win.show();
  });
  win.on("show", () => mark("window-show"));
  win.on("hide", () => mark("window-hide"));
  win.on("closed", () => mark("window-closed"));
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    mark("window-close-hid");
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    mark("window-open-denied", { url });
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    const target = typeof url === "string" ? url : event.url;
    if (isAppUrl(target) || String(target).startsWith(`${SCHEME}://shell/`)) return;
    event.preventDefault();
    mark("navigation-denied", { url: target });
  });
  contents.on("console-message", (details) => {
    mark("console", {
      level: details.level,
      message: String(details.message).slice(0, 500),
      source: details.sourceId,
      line: details.lineNumber,
    });
  });
  contents.on("render-process-gone", (_event, details) => mark("render-process-gone", details));
  contents.on("destroyed", () => mark("webcontents-destroyed"));
  contents.on("did-fail-load", (_event, code, description, url) => mark("did-fail-load", { code, description, url }));
  contents.on("did-finish-load", () => {
    const url = contents.getURL();
    mark("did-finish-load", { url });
    if (isAppUrl(url)) {
      contents.executeJavaScript(PROBE).then(
        (json) => {
          const probe = JSON.parse(json);
          const fcp = probe.paints.find(([name]) => name === "first-contentful-paint");
          mark("home-probe", {
            ...probe,
            fcpAt: fcp ? Math.round(probe.timeOrigin + fcp[1]) : null,
            windowButtons: typeof win.getWindowButtonPosition === "function" ? win.getWindowButtonPosition() : null,
            contentBounds: win.getContentBounds(),
          });
          if (run.onTop && win && !win.isDestroyed()) win.setAlwaysOnTop(false);
        },
        (error) => mark("home-probe-error", { message: error.message }),
      );
    }
  });
  win.loadURL(`${SCHEME}://shell/`);
}

function installPermissions(ses) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = details?.mediaTypes ?? [];
    const allowed =
      permission === "media" &&
      win !== null &&
      contents === win.webContents &&
      isAppUrl(details?.requestingUrl ?? "") &&
      mediaTypes.length > 0 &&
      mediaTypes.every((type) => type === "audio");
    mark("permission-request", {
      permission,
      requestingUrl: details?.requestingUrl,
      mediaTypes,
      isMainFrame: details?.isMainFrame,
      granted: allowed,
      micStatus: IS_MAC || IS_WINDOWS ? systemPreferences.getMediaAccessStatus("microphone") : null,
    });
    // A real build asks macOS here (systemPreferences.askForMediaAccess). With Chromium's fake
    // device no microphone opens, and a TCC prompt nobody can answer would stall the spike.
    callback(allowed);
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const allowed =
      permission === "media" && isAppUrl(requestingOrigin) && (details?.mediaType === "audio" || details?.mediaType === undefined);
    mark("permission-check", { permission, requestingOrigin, mediaType: details?.mediaType, allowed });
    return allowed;
  });
}

// ---- lifecycle ---------------------------------------------------------------------------------
app.on("second-instance", (_event, argv, _cwd, data) => {
  const quit = data?.command === "quit" || argv.includes("--quit");
  mark("second-instance", { quit, data: data ?? null });
  if (quit) {
    app.quit();
    return;
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
app.on("activate", () => {
  mark("activate");
  if (win && !win.isDestroyed()) win.show();
});
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  quitting = true;
  if (backendStopped || child === null) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  mark("quit-requested");
  stopBackend()
    .catch((error) => mark("stop-error", { message: error.message }))
    .finally(() => {
      backendStopped = true;
      app.quit();
    });
});
app.on("will-quit", () => mark("will-quit"));
app.on("quit", (_event, code) => mark("quit", { code }));
if (!IS_WINDOWS) {
  // Spike test hooks for a harness without Accessibility access: SIGTERM quits through app.quit()
  // and before-quit, as Cmd+Q's role:quit does; SIGUSR2 calls win.close(), as the close button does.
  process.on("SIGTERM", () => {
    mark("main-sigterm");
    app.quit();
  });
  process.on("SIGUSR2", () => {
    mark("main-sigusr2-close");
    if (win && !win.isDestroyed()) win.close();
  });
}

const environmentPromise = launchEnvironment();

app.whenReady().then(async () => {
  mark("app-ready");
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname === "shell") return shellPage(url);
    if (url.hostname !== "app") {
      mark("protocol-404", { host: url.hostname, path: url.pathname });
      return new Response("Not found", { status: 404 });
    }
    return forward(request, url);
  });
  installPermissions(session.defaultSession);
  createWindow();
  backendEnv = buildBackendEnv(await environmentPromise);
  let port = Number(run.preferredPort ?? DEFAULT_PORT);
  if (port !== 0) {
    // The server meets a taken port only after loading everything: test it first.
    const error = await bindError(port);
    mark("port-probe", { port, error });
    if (error === "EADDRINUSE" || error === "EACCES") port = 0;
  }
  try {
    await startBackend(port);
  } catch {
    return;
  }
  mark("loading-app");
  win.loadURL(`${APP_ORIGIN}/`);
});
