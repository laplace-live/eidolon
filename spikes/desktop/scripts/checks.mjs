// The spike's packaged smoke on macOS and Windows: one launch of the app on a temporary data home,
// driven over CDP (main.cjs opens it from the run file), with every provider faked on loopback. Each
// step records its evidence; a suite maps steps to the contract's checks. Exits 1 when a check fails.
// usage: node scripts/checks.mjs --suite <windows-installed|windows-signed|mac-signed|local>
//          --name <run> [--app <binary>] [--port <preferred port>]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  alive,
  appEnv,
  appPage,
  connect,
  EVIDENCE,
  fakeLog,
  IS_WINDOWS,
  lastFakeSeq,
  launchApp,
  makeRun,
  PAYLOAD,
  powershellJson,
  processes,
  RUNS,
  recordPid,
  SPIKE,
  shellEvents,
  sleep,
  startFakes,
  UNPACKAGED,
  waitForEvent,
  watchProcesses,
  writeEvidence,
} from "./lib.mjs";
import { readPe } from "./pe.mjs";
import { fakeMicWav } from "./wav.mjs";

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
const SUITE = option("suite", "local");
const NAME = option("name", SUITE);
const SUITES = {
  "windows-installed": {
    steps: ["backend", "home", "chat", "upload", "job", "ort", "modules", "restart", "call", "modules-after-call", "quit"],
    ids: { W2: ["backend"], W3: ["job", "ort", "upload", "modules"], W4: ["home", "chat"], W5: ["restart"], W6: ["quit"] },
    optional: ["call", "modules-after-call"],
  },
  "windows-signed": {
    steps: ["backend", "home", "chat", "ort", "modules", "quit"],
    ids: { S2: ["backend", "home", "chat", "ort", "modules"] },
    optional: [],
  },
  "mac-signed": {
    steps: ["backend", "home", "chat", "upload", "job", "ort", "modules", "call", "restart", "quit"],
    ids: { M6: ["home", "chat", "upload", "call", "job", "quit"] },
    optional: [],
  },
  local: {
    steps: ["backend", "home", "chat", "upload", "job", "ort", "modules", "call", "restart", "quit"],
    ids: {},
    optional: [],
  },
};
const suite = SUITES[SUITE];
if (!suite) throw new Error(`unknown suite ${SUITE}`);

const unpackaged = option("app", null) === null && SUITE === "local";
const BINARY = resolve(
  option("app", null) ??
    (SUITE === "windows-installed" || SUITE === "windows-signed"
      ? join(process.env.LOCALAPPDATA ?? "", "Programs", "eidolon", "Eidolon.exe")
      : UNPACKAGED),
);
const APP_ARGS = unpackaged ? [SPIKE] : [];
const APP_PAYLOAD = unpackaged
  ? PAYLOAD
  : IS_WINDOWS
    ? join(dirname(BINARY), "resources", "eidolon")
    : join(dirname(dirname(BINARY)), "Resources", "eidolon");
const CDP_PORT = 9333;
const same = (a, b) => (IS_WINDOWS ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const underPayload = (file) => (IS_WINDOWS ? resolve(file).toLowerCase().startsWith(APP_PAYLOAD.toLowerCase() + sep) : resolve(file).startsWith(APP_PAYLOAD + sep));
const short = (file) => String(file).replace(APP_PAYLOAD, "<payload>").replace(dirname(BINARY), "<app>");

const GREETING = "晚上好呀，今天也来陪我聊天啦？";
const CHAT_MESSAGE = "今天过得怎么样？";
const FILES_MESSAGE = "看看这张照片";
const FILES_REPLY_FAKE = "看到图片啦，是一张红色的小照片。";
const HEARD_REPLY = "听得到呀，声音很清楚。";
// A 4x2 red JPEG with EXIF orientation 6 (made once with sharp): it must reach the mind upright, 2x4,
// with its EXIF stripped.
const PHOTO =
  "/9j/4QDORXhpZgAASUkqAAgAAAAHAA8BAgAGAAAAcgAAABIBAwABAAAABgAAABoBBQABAAAAYgAAABsBBQABAAAAagAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAeAAAAAAAAAA4YwAA6AMAADhjAADoAwAAc3Bpa2UABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAAQAAAADoAQAAQAAAAIAAAAAAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8AAEQgAAgAEAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABUBAQEAAAAAAAAAAAAAAAAAAAUH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AigACtv/Z";

/** A JPEG's size and whether it carries EXIF, from its markers. */
function jpegInfo(bytes) {
  const out = { width: null, height: null, exif: false };
  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff; ) {
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    if (marker === 0xe1 && bytes.toString("latin1", at + 4, at + 10) === "Exif\0\0") out.exif = true;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      out.height = bytes.readUInt16BE(at + 5);
      out.width = bytes.readUInt16BE(at + 7);
    }
    if (marker === 0xda) break;
    at += 2 + length;
  }
  return out;
}

const results = {
  suite: SUITE,
  run: NAME,
  platform: `${process.platform}-${process.arch}`,
  app: short(BINARY),
  startedAt: new Date().toISOString(),
  steps: {},
  checks: {},
  numbers: {},
  notes: [],
};
const save = () => writeEvidence(`${NAME}-results.json`, results);
const record = (step, status, evidence) => {
  results.steps[step] = { status, evidence };
  console.log(`[${step}] ${status}: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence).slice(0, 600)}`);
  save();
};

// ---- launch ------------------------------------------------------------------------------------
const fakesDir = join(RUNS, `${NAME}-fakes`);
const fake = await startFakes(fakesDir);
const mic = suite.steps.includes("call") ? fakeMicWav(join(RUNS, NAME, "mic.wav")) : null;
results.mic = mic;
const run = makeRun(NAME, {
  preferredPort: Number(option("port", "7860")),
  cdpPort: CDP_PORT,
  fakeMicWav: mic ? join(RUNS, NAME, "mic.wav") : null,
  audioServiceUnsandboxed: mic !== null,
  fakes: fake,
  payload: unpackaged ? PAYLOAD : null,
});
const since = (at) => shellEvents(run).filter((e) => e.at >= at);
const backendLog = () => {
  const path = join(run.logDir, "backend.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const app = launchApp(run, { binary: BINARY, args: APP_ARGS });
const mainPid = app.child.pid;
console.log(`app pid ${mainPid}: ${BINARY}${APP_ARGS.length ? ` ${APP_ARGS.join(" ")}` : ""}; run ${run.dir}`);
const ctx = { backendPid: null, port: null, page: null, browser: null, chatId: null, short: null, log: null, box: null, quit: false };

async function installHooks(page) {
  await page.evaluate(() => {
    window.__spike = { csp: [], errors: [], pcs: [] };
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__spike.csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile }),
    );
    window.addEventListener("error", (e) => window.__spike.errors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => window.__spike.errors.push(String(e.reason)));
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args);
        window.__spike.pcs.push(this);
      }
    };
  });
}

/** The backend's loaded natives and runtime DLLs, with their paths. */
function loadedNatives(pid) {
  if (IS_WINDOWS) {
    return powershellJson(
      `(Get-Process -Id ${pid}).Modules | Where-Object { $_.ModuleName -match '^(vcruntime140|msvcp140|onnxruntime|lancedb|sharp|libvips|directml|dxcompiler|dxil)' } | Select-Object ModuleName,FileName`,
    ).map((m) => ({ name: m.ModuleName, path: m.FileName }));
  }
  try {
    return execFileSync("lsof", ["-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })
      .split("\n")
      .filter((l) => /\.(node|dylib)$/.test(l) && /onnxruntime|lancedb|sharp|vips/.test(l))
      .map((l) => {
        const path = l.split(/\s+/).slice(8).join(" ");
        return { name: path.split("/").at(-1), path };
      });
  } catch {
    return [];
  }
}

// ---- steps -------------------------------------------------------------------------------------
const STEPS = {
  async backend() {
    if (IS_WINDOWS) {
      const all = powershellJson(
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine",
      );
      const backend = all.find((p) => p.ProcessId === ctx.backendPid);
      const children = all.filter((p) => p.ParentProcessId === ctx.backendPid).map((p) => `${p.Name} ${p.CommandLine ?? ""}`.slice(0, 200));
      const consoles = all.filter((p) => /^conhost\.exe$/i.test(p.Name ?? "") && [mainPid, ctx.backendPid].includes(p.ParentProcessId));
      const [windowInfo] = powershellJson(
        `Get-Process -Id ${ctx.backendPid} | Select-Object Id,@{ n = 'MainWindowHandle'; e = { [int64]$_.MainWindowHandle } },MainWindowTitle`,
      );
      const pe = readPe(BINARY);
      const command = backend?.CommandLine ?? "";
      const evidence = {
        backendPid: ctx.backendPid,
        mainPid,
        parent: backend?.ParentProcessId,
        executable: backend ? short(backend.ExecutablePath) : null,
        commandLine: short(command),
        sigusr1Disabled: command.includes("--disable-sigusr1"),
        serverFromPayload: command.toLowerCase().includes(join(APP_PAYLOAD, "dist", "server.js").toLowerCase()),
        exeSubsystem: pe?.subsystem,
        conhostChildren: consoles.length,
        mainWindowHandle: windowInfo?.MainWindowHandle ?? null,
        children,
        port: ctx.port,
      };
      const pass =
        backend !== undefined &&
        same(backend.ExecutablePath, BINARY) &&
        backend.ParentProcessId === mainPid &&
        evidence.sigusr1Disabled &&
        evidence.serverFromPayload &&
        pe?.subsystem === "windows-gui" &&
        consoles.length === 0 &&
        Number(evidence.mainWindowHandle) === 0;
      record("backend", pass ? "pass" : "fail", evidence);
      return;
    }
    const command = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(ctx.backendPid)], { encoding: "utf8" }).trim();
    const [ppid, ...rest] = command.split(/\s+/);
    const line = rest.join(" ");
    const evidence = {
      backendPid: ctx.backendPid,
      mainPid,
      parent: Number(ppid),
      commandLine: short(line),
      sigusr1Disabled: line.includes("--disable-sigusr1"),
      serverFromPayload: line.includes(join(APP_PAYLOAD, "dist", "server.js")),
      port: ctx.port,
    };
    const pass = line.startsWith(BINARY) && Number(ppid) === mainPid && evidence.sigusr1Disabled && evidence.serverFromPayload;
    record("backend", pass ? "pass" : "fail", evidence);
  },

  async home() {
    const page = ctx.page;
    await page.locator('[data-slot="sidebar"]').first().waitFor();
    await sleep(1000);
    await page.screenshot({ path: join(EVIDENCE, `${NAME}-home.png`) });
    const facts = await page.evaluate(async () => {
      const index = await fetch("/");
      const status = await fetch("/api/local/status");
      const body = status.ok ? await status.json() : null;
      return {
        href: location.href,
        origin: location.origin,
        secure: window.isSecureContext,
        shellFlag: document.documentElement.dataset.shell ?? null,
        bridge: typeof window.eidolonDesktop,
        locked: /Open Eidolon from Your Terminal/.test(document.body.innerText),
        setupPage: location.pathname.startsWith("/setup"),
        sidebarLinks: [...document.querySelectorAll('[data-slot="sidebar"] a')].map((a) => a.textContent.trim()).filter(Boolean).slice(0, 12),
        csp: index.headers.get("content-security-policy"),
        status: status.status,
        version: body?.version ?? null,
        cookie: document.cookie,
      };
    });
    const consoleLines = shellEvents(run).filter((e) => e.event === "console");
    const bad = consoleLines.filter((e) => e.level === "error" || /Content Security Policy/i.test(e.message));
    const probe = shellEvents(run).find((e) => e.event === "home-probe");
    const listening = shellEvents(run).find((e) => e.event === "backend-listening");
    results.numbers.coldStart = {
      backendListeningMs: listening ? listening.at - app.spawnedAt : null,
      homeFcpMs: probe?.fcpAt ? probe.fcpAt - app.spawnedAt : null,
    };
    const pass = !facts.locked && !facts.setupPage && facts.sidebarLinks.length > 0 && bad.length === 0 && facts.secure && facts.status === 200 && facts.cookie === "";
    record("home", pass ? "pass" : "fail", {
      url: facts.href,
      locked: facts.locked,
      setupPage: facts.setupPage,
      sidebar: facts.sidebarLinks,
      secureContext: facts.secure,
      statusRoute: `${facts.status}, server ${facts.version}`,
      pageCookie: JSON.stringify(facts.cookie),
      consoleErrors: bad.map((e) => `${e.level}: ${e.message}`).slice(0, 5),
      consoleWarnings: consoleLines.filter((e) => e.level === "warning").length,
      preloadFlag: facts.shellFlag,
      bridge: facts.bridge,
      csp: facts.csp,
      coldStart: results.numbers.coldStart,
      screenshot: `${NAME}-home.png`,
    });
  },

  async chat() {
    const page = ctx.page;
    const personas = await page.evaluate(async () => (await fetch("/api/local/personas")).json());
    const persona = personas.personas.find((p) => p.id === "milky-green");
    ctx.short = persona.shortName?.trim() || persona.name;
    await page.getByRole("link", { name: "Chats", exact: true }).first().click();
    await page.waitForURL(/\/chats$/);
    await page.getByRole("button", { name: "New Chat", exact: true }).first().click();
    await page.getByRole("menuitemcheckbox").filter({ hasText: persona.name }).click();
    const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url() === "eidolon-app://app/api/local/chats");
    await page.getByRole("menuitem", { name: "Start Chat", exact: true }).click();
    const createdStatus = (await created).status();
    await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/);
    ctx.chatId = new URL(page.url()).pathname.split("/").at(-1);
    ctx.log = page.getByRole("log", { name: "Conversation", exact: true });
    await ctx.log.getByText(GREETING, { exact: true }).waitFor({ timeout: 30_000 });
    ctx.box = page.getByRole("textbox", { name: `Message ${ctx.short}`, exact: true });
    const seq = lastFakeSeq(fakesDir);
    await ctx.box.fill(CHAT_MESSAGE);
    const sentAt = Date.now();
    await ctx.box.press("Enter");
    let firstAt = null;
    let wholeAt = null;
    while (Date.now() - sentAt < 30_000) {
      const text = await ctx.log.innerText();
      if (firstAt === null && text.includes("还不错哦") && !text.includes("刚刚在看猫猫视频")) firstAt = Date.now();
      if (text.includes("刚刚在看猫猫视频")) {
        wholeAt = Date.now();
        break;
      }
      await sleep(40);
    }
    await page.screenshot({ path: join(EVIDENCE, `${NAME}-chat.png`) });
    const forwarded = since(sentAt - 50).filter((e) => e.event === "forward" && e.path.startsWith(`/api/local/chats/${ctx.chatId}`));
    const chunks = fakeLog(seq, fakesDir).filter((e) => e.kind === "sse-chunk");
    const messages = forwarded.find((e) => e.method === "POST" && e.path.endsWith("/messages"));
    const pass = createdStatus === 201 && firstAt !== null && wholeAt !== null && wholeAt - firstAt > 1500 && messages?.status === 200 && /ndjson/.test(messages?.type ?? "");
    record("chat", pass ? "pass" : "fail", {
      createChat: createdStatus,
      greeting: "shown",
      firstChunkShownAfterMs: firstAt && firstAt - sentAt,
      restShownAfterFirstMs: firstAt && wholeAt && wholeAt - firstAt,
      fakeHoldMs: chunks.length >= 2 ? chunks[1].at - chunks[0].at : null,
      messagesRoute: messages && `${messages.method} ${messages.status} ${messages.type}`,
      screenshot: `${NAME}-chat.png`,
    });
  },

  async upload() {
    const page = ctx.page;
    const photoPath = join(RUNS, NAME, "photo.jpg");
    const photo = Buffer.from(PHOTO, "base64");
    writeFileSync(photoPath, photo);
    const at = Date.now();
    await page.locator('input[type="file"]').setInputFiles(photoPath);
    const upload = await waitForEvent(run, (e) => e.event === "forward" && e.path === `/api/local/chats/${ctx.chatId}/files`, 20_000, at);
    await sleep(800);
    const seq = lastFakeSeq(fakesDir);
    await ctx.box.fill(FILES_MESSAGE);
    await ctx.box.press("Enter");
    await ctx.log.getByText(FILES_REPLY_FAKE, { exact: true }).waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(EVIDENCE, `${NAME}-upload.png`) });
    const asked = fakeLog(seq, fakesDir).find((e) => e.kind === "chat" && e.images?.length > 0);
    const made = asked ? jpegInfo(readFileSync(asked.images[0])) : null;
    const sent = jpegInfo(photo);
    const natives = loadedNatives(ctx.backendPid).filter((m) => /sharp|vips/i.test(m.name));
    const pass =
      upload?.status === 201 && made?.width === 2 && made?.height === 4 && made.exif === false && natives.some((m) => underPayload(m.path));
    record("upload", pass ? "pass" : "fail", {
      postFiles: upload && `${upload.status} in ${upload.ms} ms`,
      sent: `${sent.width}x${sent.height} JPEG, EXIF orientation 6`,
      mindGot: made && `${asked.last.content.find((p) => p.type === "image_url")?.head}, ${made.width}x${made.height}, exif ${made.exif ? "kept" : "stripped"}`,
      sharpLoadedInBackend: natives.map((m) => short(m.path)),
      screenshot: `${NAME}-upload.png`,
    });
  },

  async job() {
    const page = ctx.page;
    const factName = "spike设定集.txt";
    const lines = "2024-05-01 明前奶绿说她最喜欢的饮料是冰美式。\n明前奶绿的猫叫坚果，是拉普拉斯花店的店长。\n";
    const put = await page.evaluate(
      async ({ factName, lines }) => {
        const r = await fetch(`/api/local/personas/milky-green/facts/${encodeURIComponent(factName)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: lines }),
        });
        return r.status;
      },
      { factName, lines },
    );
    const watch = watchProcesses(join(RUNS, NAME, "job-processes.jsonl"), IS_WINDOWS ? "Eidolon.exe" : "dist/cli.js");
    await sleep(IS_WINDOWS ? 1500 : 100);
    const started = await page.evaluate(async () => {
      const r = await fetch("/api/local/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "ingest-facts", persona: "milky-green" }),
      });
      return { status: r.status, job: await r.json() };
    });
    let job = started.job;
    const deadline = Date.now() + 120_000;
    while (job.status === "running" && Date.now() < deadline) {
      await sleep(250);
      job = await page.evaluate(async (id) => (await fetch(`/api/local/jobs/${id}`)).json(), job.id);
    }
    await sleep(300);
    watch.stop();
    const children = watch.seen().filter((p) => /dist[\\/]cli\.js/.test(p.command));
    const metaPath = join(run.home, "personas/milky-green/index/persona_facts.meta.json");
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
    const lance = join(run.home, "personas/milky-green/index/persona_facts.lance");
    const jobChild = children.find((c) => c.pid === job.pid) ?? children[0];
    const onAppBinary =
      jobChild !== undefined &&
      jobChild.ppid === ctx.backendPid &&
      (IS_WINDOWS ? jobChild.exe !== null && same(jobChild.exe, BINARY) : jobChild.command.startsWith(BINARY));
    const pass = put === 200 && job.status === "succeeded" && meta?.rows === 2 && existsSync(lance) && onAppBinary;
    record("job", pass ? "pass" : "fail", {
      putFacts: put,
      job: `${started.status} → ${job.status} (exit ${job.exitCode}, pid ${job.pid})`,
      rows: meta?.rows,
      table: existsSync(lance) ? "<home>/personas/milky-green/index/persona_facts.lance" : "missing",
      childOnAppBinary: onAppBinary,
      children: children.map((p) => ({ pid: p.pid, ppid: p.ppid, exe: p.exe ? short(p.exe) : null, command: short(p.command).slice(0, 300) })),
      backendLog: backendLog().split("\n").filter((l) => l.includes(`Job ${job.id}`)).map((l) => l.replace(/^\S+ \S+ /, "")).slice(0, 3),
    });
  },

  async ort() {
    const script = join(SPIKE, "scripts", "ort-check.cjs");
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    let out;
    try {
      out = execFileSync(BINARY, ["--disable-sigusr1", "--use-system-ca", script, APP_PAYLOAD], { env, encoding: "utf8", timeout: 60_000 });
    } catch (error) {
      record("ort", "fail", { error: String(error.stdout ?? error.message).slice(0, 2000), stderr: String(error.stderr ?? "").slice(0, 2000) });
      return;
    }
    const result = JSON.parse(out.trim().split("\n").at(-1));
    const ortDir = IS_WINDOWS ? join(APP_PAYLOAD, "node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "x64") : null;
    const loaded = (result.loaded ?? []).map((p) => short(p));
    const evidence = {
      ok: result.ok,
      probability: result.probability,
      execPath: short(result.execPath ?? ""),
      execArgv: result.execArgv,
      node: result.node,
      electron: result.electron,
      loaded,
    };
    let pass = result.ok === true && same(result.execPath, BINARY) && (result.loaded ?? []).some((p) => /onnxruntime/i.test(p) && underPayload(p));
    if (IS_WINDOWS) {
      const from = (name) => (result.loaded ?? []).filter((p) => p.toLowerCase().endsWith(`\\${name}`)).map((p) => short(p));
      evidence.vcruntime140From = from("vcruntime140.dll");
      evidence.msvcp140From = from("msvcp140.dll");
      evidence.directMlInPayload = ["DirectML.dll", "dxcompiler.dll", "dxil.dll"].filter((f) => existsSync(join(ortDir, f)));
      evidence.directMlLoaded = (result.loaded ?? []).filter((p) => /directml|dxcompiler|dxil/i.test(p)).map((p) => short(p));
      evidence.ortFolder = readdirSync(ortDir).sort();
      pass = pass && evidence.directMlInPayload.length === 0 && evidence.directMlLoaded.length === 0;
    }
    record("ort", pass ? "pass" : "fail", evidence);
  },

  async modules() {
    await STEPS.modulesOf("modules");
  },
  async "modules-after-call"() {
    await STEPS.modulesOf("modules-after-call");
  },
  async modulesOf(step) {
    const natives = loadedNatives(ctx.backendPid);
    const addons = natives.filter((m) => /lancedb|sharp|onnxruntime/i.test(m.name));
    const evidence = {
      backendPid: ctx.backendPid,
      loaded: natives.map((m) => `${m.name} ← ${short(m.path)}`),
    };
    if (IS_WINDOWS) {
      evidence.vcruntime140From = natives.filter((m) => /^vcruntime140\.dll$/i.test(m.name)).map((m) => short(m.path));
      evidence.msvcp140From = natives.filter((m) => /^msvcp140\.dll$/i.test(m.name)).map((m) => short(m.path));
    }
    const pass = addons.length > 0 && addons.every((m) => underPayload(m.path));
    record(step, pass ? "pass" : "fail", evidence);
  },

  async call() {
    const page = ctx.page;
    const seq = lastFakeSeq(fakesDir);
    const at = Date.now();
    await page.getByRole("button", { name: "Call", exact: true }).click();
    const dock = page.getByRole("region", { name: `Call with ${ctx.short}`, exact: true });
    await dock.waitFor({ timeout: 20_000 });
    const spoke = async (input, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = fakeLog(seq, fakesDir).find((e) => e.kind === "speech" && e.format === "pcm" && (input === undefined || String(e.input).includes(input)));
        if (found) return found;
        await sleep(250);
      }
      return null;
    };
    const greetingSpoken = await spoke(undefined, 40_000);
    await sleep(4000);
    const statsOf = () =>
      page.evaluate(async () => {
        const out = [];
        for (const pc of window.__spike.pcs) {
          const report = await pc.getStats();
          const entry = { connection: pc.connectionState, ice: pc.iceConnectionState };
          report.forEach((s) => {
            if (s.type === "inbound-rtp" && s.kind === "audio") entry.inbound = { bytes: s.bytesReceived, packets: s.packetsReceived, energy: s.totalAudioEnergy };
            if (s.type === "outbound-rtp" && s.kind === "audio") entry.outbound = { bytes: s.bytesSent, packets: s.packetsSent };
            if (s.type === "media-source" && s.kind === "audio") entry.mic = { energy: s.totalAudioEnergy, seconds: s.totalSamplesDuration };
            if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") entry.pair = { rtt: s.currentRoundTripTime };
          });
          out.push(entry);
        }
        return out;
      });
    await page.screenshot({ path: join(EVIDENCE, `${NAME}-call.png`) });
    const heardReply = mic?.kind === "speech" ? await spoke(HEARD_REPLY, 40_000) : null;
    const stats = await statsOf();
    const natives = loadedNatives(ctx.backendPid).filter((m) => /onnxruntime/i.test(m.name));
    const permission = since(at).filter((e) => e.event === "permission-request" || e.event === "permission-check");
    const realtime = fakeLog(seq, fakesDir).filter((e) => e.kind.startsWith("realtime"));
    await dock.getByRole("button", { name: "Hang Up", exact: true }).click();
    await dock.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
    const pc = stats.find((s) => s.connection === "connected") ?? stats[0];
    const pass =
      !!greetingSpoken &&
      pc?.connection === "connected" &&
      (pc?.inbound?.energy ?? 0) > 0 &&
      natives.some((m) => underPayload(m.path)) &&
      permission.some((p) => p.event === "permission-request" && p.granted);
    record("call", pass ? "pass" : "fail", {
      mic,
      permission: permission.filter((p) => p.event === "permission-request").map((p) => `${p.permission} ${JSON.stringify(p.mediaTypes)} → ${p.granted ? "granted" : "denied"} (mic status ${p.micStatus})`),
      webrtc: pc && `${pc.connection}/${pc.ice}, rtt ${pc.pair?.rtt}`,
      herVoiceIn: pc?.inbound && `${pc.inbound.packets} packets, totalAudioEnergy ${pc.inbound.energy?.toFixed?.(4)}`,
      micOut: pc?.outbound && `${pc.outbound.packets} packets; mic source energy ${pc.mic?.energy?.toFixed?.(4)} over ${pc.mic?.seconds?.toFixed?.(1)} s`,
      greetingTts: greetingSpoken && `${greetingSpoken.format} "${greetingSpoken.input}"`,
      sttAppends: realtime.filter((e) => e.kind === "realtime-append").at(-1)?.appended ?? 0,
      vadCommits: realtime.filter((e) => e.kind === "realtime-commit").length,
      answeredHeardLine: heardReply ? `TTS "${heardReply.input}"` : mic?.kind === "speech" ? "no" : "not asked (silent microphone)",
      onnxInBackend: natives.map((m) => short(m.path)),
      screenshot: `${NAME}-call.png`,
    });
  },

  async restart() {
    const page = ctx.page;
    await page.evaluate(() => localStorage.setItem("spike-marker", "kept-across-restart"));
    const at = Date.now();
    const timeline = page.evaluate(async () => {
      const out = [];
      const restart = await fetch("/api/local/restart", { method: "POST" });
      out.push({ t: 0, what: "restart", status: restart.status });
      const start = performance.now();
      while (performance.now() - start < 6000) {
        const t0 = performance.now();
        try {
          const r = await fetch("/api/local/status");
          out.push({ t: Math.round(t0 - start), ms: Math.round(performance.now() - t0), status: r.status });
        } catch (error) {
          out.push({ t: Math.round(t0 - start), error: String(error) });
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    });
    const restarted = await waitForEvent(run, (e) => e.event === "backend-restarted", 60_000, at);
    const polled = await timeline;
    const exit = since(at).find((e) => e.event === "backend-exit");
    const relisten = since(at).find((e) => e.event === "backend-listening");
    if (relisten) ctx.backendPid = relisten.pid;
    await page.reload();
    await page.locator('[data-slot="sidebar"]').first().waitFor({ timeout: 20_000 });
    await installHooks(page);
    const after = await page.evaluate(async () => ({
      status: (await fetch("/api/local/status")).status,
      marker: localStorage.getItem("spike-marker"),
      path: location.pathname,
    }));
    await page.screenshot({ path: join(EVIDENCE, `${NAME}-after-restart.png`) });
    const statuses = polled.filter((p) => p.status !== undefined).map((p) => p.status);
    const failures = polled.filter((p) => p.error || (p.status && p.status >= 500));
    const pass = exit?.code === 75 && restarted?.samePort === true && restarted.port === ctx.port && after.status === 200 && after.marker === "kept-across-restart";
    record("restart", pass ? "pass" : "fail", {
      exitCode: exit?.code,
      respawnedOnSamePort: restarted?.samePort,
      port: restarted?.port,
      newBackendPid: relisten?.pid,
      downMs: exit && relisten ? relisten.at - exit.at : null,
      pagePollsDuringRestart: `${statuses.length} answered (${[...new Set(statuses)].join(",")}), ${failures.length} failed${failures.length ? `: ${JSON.stringify(failures.slice(0, 3))}` : ""}`,
      afterReload: after,
      screenshot: `${NAME}-after-restart.png`,
    });
  },

  async quit() {
    const at = Date.now();
    const backendPid = ctx.backendPid;
    ctx.quit = true;
    const second = spawn(BINARY, [...APP_ARGS, "--quit"], { env: appEnv(run.file), stdio: ["ignore", "pipe", "pipe"] });
    recordPid(second.pid, `--quit launch for ${NAME}`);
    let secondOutput = "";
    second.stdout.on("data", (d) => (secondOutput += d));
    second.stderr.on("data", (d) => (secondOutput += d));
    const secondExit = await Promise.race([
      new Promise((resolve) => second.on("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - at }))),
      sleep(30_000).then(() => null),
    ]);
    const exited = await Promise.race([app.exited, sleep(40_000).then(() => null)]);
    await sleep(1500);
    const events = since(at).map((e) => e.event).filter((e) => !["forward", "forward-headers", "console", "permission-check"].includes(e));
    const stopped = since(at).find((e) => e.event === "backend-stopped");
    const leftovers = IS_WINDOWS
      ? powershellJson("Get-Process -Name Eidolon -ErrorAction SilentlyContinue | Select-Object Id,Path").map((p) => `${p.Id} ${p.Path}`)
      : [...processes(unpackaged ? join(SPIKE, "node_modules/electron/dist") : dirname(dirname(dirname(BINARY)))), ...processes(APP_PAYLOAD)]
          .filter((p) => p.pid !== process.pid)
          .map((p) => `${p.pid} ${short(p.command).slice(0, 160)}`);
    const errors = backendLog().split("\n").filter((l) => /\| (ERROR|CRITICAL) +\|/.test(l));
    const pass =
      secondExit?.code === 0 && exited?.code === 0 && stopped?.code === 0 && !alive(backendPid) && !alive(mainPid) && leftovers.length === 0;
    record("quit", pass ? "pass" : "fail", {
      quitLaunch: secondExit && `--quit launch exited ${secondExit.code ?? secondExit.signal} in ${secondExit.ms} ms`,
      appExit: exited && `main exited ${exited.code ?? exited.signal} ${exited.at - at} ms after the --quit launch`,
      backend: stopped && `exit ${stopped.code ?? stopped.signal} ${stopped.ms} ms after disconnect()`,
      events,
      leftovers,
      backendLogErrors: errors.slice(0, 10),
      secondOutput: secondOutput.trim().slice(0, 500),
    });
  },
};

// ---- the walk ----------------------------------------------------------------------------------
try {
  const probe = await waitForEvent(run, (e) => e.event === "home-probe" || e.event === "backend-failed", 180_000);
  const listening = shellEvents(run).filter((e) => e.event === "backend-listening").at(-1);
  if (!probe || probe.event !== "home-probe" || !listening) {
    throw new Error(`no Home: ${JSON.stringify(probe)}; output: ${app.output().slice(0, 1500)}`);
  }
  ctx.backendPid = listening.pid;
  ctx.port = listening.port;
  recordPid(listening.pid, `backend of ${NAME}`);
  results.numbers.backendPort = ctx.port;
  results.numbers.portProbe = shellEvents(run).find((e) => e.event === "port-probe") ?? null;
  ctx.browser = await connect(CDP_PORT);
  ctx.page = await appPage(ctx.browser);
  ctx.page.setDefaultTimeout(20_000);
  await installHooks(ctx.page);
  for (const step of suite.steps) {
    const optional = suite.optional.includes(step);
    try {
      await STEPS[step]();
    } catch (error) {
      record(step, "fail", String(error?.stack ?? error).slice(0, 2000));
    }
    if (optional && results.steps[step]?.status === "fail") results.steps[step].status = "fail (optional)";
  }
} catch (error) {
  results.fatal = String(error?.stack ?? error);
  console.error(error);
} finally {
  try {
    await ctx.browser?.close();
  } catch {}
  if (app.child.exitCode === null && app.child.signalCode === null) {
    results.notes.push("the app was still running after the walk; killed");
    if (IS_WINDOWS) {
      try {
        execFileSync("taskkill", ["/pid", String(mainPid), "/t", "/f"], { stdio: "ignore" });
      } catch {}
    } else {
      app.child.kill("SIGTERM");
      await Promise.race([app.exited, sleep(20_000)]);
      if (app.child.exitCode === null) app.child.kill("SIGKILL");
    }
  }
  fake.child.kill();
  for (const [id, steps] of Object.entries(suite.ids)) {
    const statuses = steps.map((s) => results.steps[s]?.status ?? "not run");
    results.checks[id] = {
      status: statuses.every((s) => s === "pass") ? "pass" : "fail",
      steps: Object.fromEntries(steps.map((s, i) => [s, statuses[i]])),
    };
  }
  results.finishedAt = new Date().toISOString();
  save();
  const logs = join(EVIDENCE, `${NAME}-logs`);
  mkdirSync(logs, { recursive: true });
  for (const file of ["shell.jsonl", "backend.log"]) {
    if (existsSync(join(run.logDir, file))) cpSync(join(run.logDir, file), join(logs, file));
  }
  if (existsSync(join(fakesDir, "fakes.jsonl"))) cpSync(join(fakesDir, "fakes.jsonl"), join(logs, "fakes.jsonl"));
  console.log(`\n${SUITE} ${NAME}:`);
  for (const [step, { status }] of Object.entries(results.steps)) console.log(`  ${step}: ${status}`);
  for (const [id, { status }] of Object.entries(results.checks)) console.log(`  ${id}: ${status}`);
  if (results.fatal) console.log(`  fatal: ${results.fatal.split("\n")[0]}`);
  const failed = results.fatal || Object.values(results.checks).some((c) => c.status !== "pass");
  process.exit(failed ? 1 : 0);
}
