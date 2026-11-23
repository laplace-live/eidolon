// `bun run smoke:desktop`, the packaged smoke: the fused app electron-builder left in
// apps/desktop/.out, on a temporary data home and profile with every provider faked on loopback,
// driven through its backend's API with the Bearer, since Playwright and CDP can't drive a fused
// build. On Windows it installs the NSIS setup silently, smokes the installed app and uninstalls it.
// It never builds or packages. Each check prints a line, and results.json in the run's folder keeps
// them all, a passing run's folder included.
import type { SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { killTree } from "@eidolon/config";
import type { JobRecord, Status } from "../../bot/src/local/api.ts";
import { PLATFORMS } from "../../eidolon/src/launcher.ts";
import { dataHome, isAlive, probe, readToken } from "../src/main/attach.ts";
import { BACKEND_RUNTIME_ARGS, backendEnv, RESTART_EXIT_CODE } from "../src/main/controller.ts";
import { checkNatives, type NativesReport } from "./natives.ts";
import { POSIX_LAUNCHERS } from "./node-shim.ts";
import {
  DESKTOP,
  errorLines,
  installedBinary,
  installer,
  LINES,
  type LogName,
  localToken,
  packagedApp,
  packagedBinary,
  type Smoke,
  startSmoke,
  until,
  within,
} from "./smoke/kit.ts";
import { namesUninstaller, silentUninstall, UNINSTALLER, uninstallEntries } from "./smoke/nsis.ts";
import {
  type AppLayout,
  appLayout,
  cause,
  changedFiles,
  closedPort,
  fileHashes,
  icoImages,
  inside,
  jpegFacts,
  leaks,
  lineTime,
  type Marker,
  mappedNatives,
  nodesIn,
  placeMarker,
  processesNaming,
  ROTATED_PHOTO,
  runAsNodeProbe,
  runsOnBinary,
  scriptRun,
  strayErrorLines,
  systemFolders,
  withVariables,
} from "./smoke/packaged.ts";
import { processTable } from "./smoke/processes.ts";

const LABEL = "smoke-desktop";
const TARGET = `${process.platform}-${process.arch}`;
const MAKE = "bun run build:web && bun run build:desktop && bun run package:desktop";
const PERSONA = "milky-green";
/** What the ingest job writes and the search reads back. */
const FACTS = ["明前奶绿说她的猫叫坚果。", "明前奶绿开了一家花店。"] as const;
const QUERY = "她的猫叫什么名字";
/** What checkNatives must find mapped from the payload, by file name. */
const EVERY_NATIVE = ["lancedb", "onnxruntime_binding", "sharp-", "vips"];
const JSON_TYPE = { "content-type": "application/json" };
// Each step's limit. Together they end a hung run in failed checks, its uninstall and results.json
// included, well inside desktop.yml's 15 minutes; a run takes about 12 s on macOS, and the NSIS
// setup alone took 58 s on windows-latest.
const INSTALL_MS = 180_000;
const START_MS = 90_000;
const JOB_MS = 90_000;
const SEARCH_MS = 60_000;
const RESTART_MS = 60_000;
const QUIT_MS = 60_000;
const UNINSTALL_MS = 120_000;
const TERMINAL_MS = 60_000;
/** The shim's runs, on the stand-in and then for real, pnpm dlx's first install among them. */
const SHIM_MS = 180_000;
/** The node shim's npx, run without the binary the backend names. */
const NO_NODE = "npx: EIDOLON_NODE isn't set: Eidolon sets it for the MCP servers it starts";
/** Timings the results keep, in ms unless named otherwise. */
type Numbers = Record<string, number>;

/** The ms left of a step's `ms`, for each of its waits in turn: at least 1, a last look. */
function budget(ms: number): () => number {
  const end = Date.now() + ms;
  return () => Math.max(end - Date.now(), 1);
}

/** The first line after `from` that holds `pattern`; at the timeout, an error naming the log's last. */
async function line(
  smoke: Smoke,
  name: LogName,
  pattern: string | RegExp,
  timeoutMs: number,
  from = 0,
): Promise<string> {
  try {
    return await smoke.waitForLine(name, pattern, { timeoutMs, from });
  } catch (error) {
    const last = smoke.log(name).trimEnd().split(/\r?\n/).at(-1) ?? "";
    const waited = (timeoutMs / 1000).toFixed(1);
    throw new Error(`${(error as Error).message} within ${waited} s; its last: ${last}`);
  }
}

/** main.log's line for backend `pid`'s exit, its code or signal captured. */
function exitOf(pid: number): RegExp {
  return new RegExp(`Eidolon: the backend \\(pid ${pid}\\) exited \\((\\w+)\\)`);
}

interface Output {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `command`, tracked, and collects what it prints; at the timeout it and its tree are killed. */
async function collect(
  smoke: Smoke,
  what: string,
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  timeoutMs: number,
): Promise<Output> {
  const { child } = smoke.processes.spawn(what, command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (data: string) => {
    stdout += data;
  });
  child.stderr?.setEncoding("utf8").on("data", (data: string) => {
    stderr += data;
  });
  const timer = setTimeout(() => {
    if (child.pid !== undefined) killTree(child.pid);
  }, timeoutMs);
  const code = await new Promise<number | null>((done) => child.once("close", done));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Runs the app's binary in node mode, tracked, and collects what it prints. */
function onBinary(
  smoke: Smoke,
  what: string,
  layout: AppLayout,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Output> {
  return collect(
    smoke,
    what,
    layout.binary,
    [...BACKEND_RUNTIME_ARGS, ...args],
    { env },
    timeoutMs,
  );
}

/** Runs a launcher of the app's as a terminal would, tracked, and collects what it prints. */
function onLauncher(
  smoke: Smoke,
  what: string,
  script: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly cwd?: string },
  timeoutMs: number,
): Promise<Output> {
  const run = scriptRun(script, args, process.platform, process.env.ComSpec);
  return collect(
    smoke,
    what,
    run.command,
    run.args,
    { ...options, windowsVerbatimArguments: run.windowsVerbatimArguments },
    timeoutMs,
  );
}

/** Output's last line, for a detail. */
function lastLine(text: string): string {
  return text.trimEnd().split(/\r?\n/).at(-1) ?? "";
}

/**
 * A package with a command, which npx gets as a file: spec: it prints what it was given and the
 * Electron it runs on, as JSON on one line.
 */
function shimFixture(folder: string): string {
  mkdirSync(join(folder, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({ name: "eidolon-smoke-shim", version: "1.0.0", bin: "bin/hello.js" }),
  );
  writeFileSync(
    join(folder, "bin", "hello.js"),
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), electron: process.versions.electron ?? null }));\n",
    { mode: 0o755 },
  );
  return folder;
}

function described(facts: ReturnType<typeof jpegFacts>): string {
  return facts === null
    ? "no JPEG"
    : `a ${facts.width}×${facts.height} JPEG ${facts.exif ? "with" : "without"} EXIF`;
}

/** The checks on one packaged app, from its binary's node mode to its quit. */
async function walk(smoke: Smoke, layout: AppLayout, numbers: Numbers): Promise<void> {
  const { checks, fakes, run } = smoke;
  const payload = realpathSync(layout.payload);
  // Eidolon.app, or the folder Eidolon.exe is in.
  const root =
    process.platform === "win32" ? dirname(layout.binary) : join(layout.resources, "..", "..");
  const short = (text: string) => text.replaceAll(root, "<app>");
  // As main starts the backend, for the app's binary run as Node beside it.
  const nodeEnv = backendEnv(
    { ...smoke.env },
    { home: run.home, appRoot: layout.payload, platform: process.platform },
  );

  // Before the app starts: checkNatives blocks this process, whose fakes, focus watch and
  // connections to the backend would stall meanwhile.
  const NATIVES =
    "LanceDB, onnxruntime and sharp load from the payload and run on the app's binary";
  await checks.step(NATIVES, async () => {
    const at = Date.now();
    let report: NativesReport;
    try {
      report = checkNatives(layout.payload, PLATFORMS[TARGET as keyof typeof PLATFORMS], {
        command: layout.binary,
        args: BACKEND_RUNTIME_ARGS,
        env: nodeEnv,
      });
    } catch (error) {
      // Its message is the run's whole output: the error's own line says what failed to load.
      const output = (error as Error).message.split(/\r?\n/).map((text) => text.trim());
      const cause = output.find((text) => /^\w*Error\b|^Error:/.test(text)) ?? output[0];
      checks.add(NATIVES, false, `on the app's binary in node mode: ${short(cause ?? "")}`);
      return;
    }
    numbers.nativesMs = Date.now() - at;
    const loaded = report.loaded.filter((path) => /\.(node|dll|dylib)$/i.test(path));
    const outside = loaded.filter((path) => !inside(path, payload));
    const missing = EVERY_NATIVE.filter(
      (name) => !loaded.some((path) => basename(path).toLowerCase().includes(name)),
    );
    checks.add(
      NATIVES,
      report.rows === 2 &&
        report.speech >= 0 &&
        report.speech <= 1 &&
        report.image === "jpeg 2x1" &&
        outside.length === 0 &&
        missing.length === 0,
      `in node mode: LanceDB counted ${report.rows} rows in a table it wrote, Silero's CPU session gave ${report.speech.toFixed(3)}, sharp read back a ${report.image}; ${loaded.length} libraries mapped, ${outside.length === 0 ? "all from the payload" : `not from the payload: ${outside.join(", ")}`}${missing.length > 0 ? `; never mapped: ${missing.join(", ")}` : ""}`,
    );
  });

  const TRAY = "the tray icon's file ships in the app's resources, as apps/desktop/assets has it";
  await checks.step(TRAY, async () => {
    const shipped = readFileSync(layout.trayIcon);
    const same = shipped.equals(readFileSync(join(DESKTOP, "assets", "tray-icon.ico")));
    const images = icoImages(shipped);
    checks.add(
      TRAY,
      images > 0 && same,
      `${short(layout.trayIcon)}: ${shipped.byteLength} bytes, ${images} image(s), ${same ? "the same as" : "not"} apps/desktop/assets/tray-icon.ico`,
    );
  });

  const TERMINAL =
    "the eidolon command runs the CLI on the app's binary, on the home the terminal names";
  await checks.step(TERMINAL, async () => {
    // A home of its own, where the CLI keeps its usage ledger.
    const home = join(run.scratch, "terminal-home");
    mkdirSync(home, { mode: 0o700 });
    const at = Date.now();
    // Never with no arguments, which opens the app outside background mode.
    const ran = await onLauncher(
      smoke,
      "the eidolon command",
      layout.terminalCommand,
      ["search", "--help"],
      { env: withVariables(smoke.env, { EIDOLON_HOME: home }) },
      TERMINAL_MS,
    );
    numbers.terminalCommandMs = Date.now() - at;
    const usage = ran.stdout.startsWith("usage: laplace-search ");
    const wrote = readdirSync(home);
    checks.add(
      TERMINAL,
      ran.code === 0 && usage && wrote.length > 0,
      `${short(layout.terminalCommand)} search --help exited ${ran.code}${usage ? ", laplace-search's usage on stdout" : `; stdout: ${lastLine(ran.stdout) || "nothing"}; stderr: ${cause(ran.stderr) || "nothing"}`}; the terminal's home holds ${wrote.join(", ") || "nothing"}`,
    );
  });

  const SHIM =
    "the node shim runs node, pnpm and npx on the app's binary, on a PATH with no other node";
  await checks.step(SHIM, async () => {
    const folders = systemFolders(process.platform, smoke.env);
    const others = nodesIn(folders);
    if (others.length > 0) {
      checks.add(SHIM, false, `the OS's own folders hold a node: ${others.join(", ")}`);
      return;
    }
    const left = budget(SHIM_MS);
    // pnpm's store and caches go under the home: on Windows under LOCALAPPDATA.
    const home = join(run.scratch, "shim-home");
    const cwd = join(run.scratch, "shim-cwd");
    for (const folder of [home, cwd]) mkdirSync(folder, { mode: 0o700 });
    const homes: Record<string, string> =
      process.platform === "win32"
        ? {
            USERPROFILE: home,
            LOCALAPPDATA: join(home, "AppData", "Local"),
            APPDATA: join(home, "AppData", "Roaming"),
          }
        : {};
    const env = withVariables(smoke.env, {
      PATH: [...folders, layout.nodeShim].join(delimiter),
      HOME: home,
      ...homes,
      EIDOLON_NODE: layout.binary,
      // A file: package needs no registry; one pnpm tried anyway would fail at once, not after the
      // 70 s its retries take.
      pnpm_config_registry: `http://127.0.0.1:${await closedPort()}/`,
      pnpm_config_fetch_retries: "0",
    });
    const named = (name: string) =>
      join(layout.nodeShim, process.platform === "win32" ? `${name}.cmd` : name);
    // On the stand-in first: a launcher that leaves ELECTRON_RUN_AS_NODE unset never reaches the
    // app's binary.
    const probe = runAsNodeProbe(run.scratch);
    const unset: string[] = [];
    for (const name of POSIX_LAUNCHERS) {
      const probed = await onLauncher(
        smoke,
        `the shim's ${name} on a stand-in`,
        named(name),
        ["--version"],
        { env: { ...env, EIDOLON_NODE: probe }, cwd },
        left(),
      );
      if (probed.stdout.trim() !== "1") unset.push(name);
    }
    if (unset.length > 0) {
      checks.add(
        SHIM,
        false,
        `${unset.join(", ")} ran EIDOLON_NODE without ELECTRON_RUN_AS_NODE=1, which would start Eidolon itself, so none ran on the app's binary`,
      );
      return;
    }
    const node = await onLauncher(
      smoke,
      "the shim's node",
      named("node"),
      ["-p", "process.versions.electron"],
      { env, cwd },
      left(),
    );
    const pnpm = await onLauncher(
      smoke,
      "the shim's pnpm",
      named("pnpm"),
      ["--version"],
      { env, cwd },
      left(),
    );
    const fixture = shimFixture(join(run.scratch, "shim-fixture"));
    const at = Date.now();
    const npx = await onLauncher(
      smoke,
      "the shim's npx",
      named("npx"),
      ["-y", `file:${fixture}`, "one", "two words"],
      { env, cwd },
      left(),
    );
    numbers.npxMs = Date.now() - at;
    const { EIDOLON_NODE: _, ...unnamed } = env;
    const refused = await onLauncher(
      smoke,
      "the shim's npx without EIDOLON_NODE",
      named("npx"),
      ["-y", `file:${fixture}`],
      { env: unnamed, cwd },
      left(),
    );
    const lines = (text: string) => text.split(/\r?\n/).filter((line) => line !== "");
    const manifest = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const electron = manifest.devDependencies.electron;
    const bundled = JSON.parse(
      readFileSync(
        join(layout.payload, "node-shim", "node_modules", "pnpm", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    const printed = JSON.stringify({ args: ["one", "two words"], electron });
    const said = (output: Output) =>
      output.code === 0
        ? lines(output.stdout).join(" / ")
        : `exit ${output.code}: ${cause(output.stderr)}`;
    checks.add(
      SHIM,
      node.code === 0 &&
        JSON.stringify(lines(node.stdout)) === JSON.stringify([electron]) &&
        pnpm.code === 0 &&
        JSON.stringify(lines(pnpm.stdout)) === JSON.stringify([bundled.version]) &&
        npx.code === 0 &&
        JSON.stringify(lines(npx.stdout)) === JSON.stringify([printed]) &&
        refused.code === 1 &&
        refused.stdout === "" &&
        JSON.stringify(lines(refused.stderr).map((line) => line.trim())) ===
          JSON.stringify([NO_NODE]),
      `each set ELECTRON_RUN_AS_NODE=1 for a stand-in first; node -p process.versions.electron: ${said(node)} (pinned ${electron}); pnpm --version: ${said(pnpm)} (the payload's ${bundled.version}); npx -y file:<fixture>: ${said(npx)}; without EIDOLON_NODE, npx exited ${refused.code}${refused.stdout === "" ? "" : " with stdout"}: ${lastLine(refused.stderr).trim() || "nothing on stderr"}`,
    );
  });

  const app = packagedApp(run, layout.binary);
  const launchedAt = Date.now();
  const main = smoke.start(app);
  const START = "the app starts on the run's home and profile and shows the web app";
  const shown = await checks.step(START, async () => {
    const left = budget(START_MS);
    if (!smoke.args.headful) await line(smoke, "main", LINES.background, left());
    const home = LINES.dataHome.exec(await line(smoke, "main", LINES.dataHome, left()))?.[1];
    const listens = await line(smoke, "main", LINES.listens, left());
    const page = await line(smoke, "main", LINES.appShown, left());
    numbers.listeningMs = (lineTime(listens) ?? Date.now()) - launchedAt;
    numbers.appShownMs = (lineTime(page) ?? Date.now()) - launchedAt;
    checks.add(
      START,
      home === run.home,
      `${smoke.args.headful ? "headful" : "in background mode"}; ${home === run.home ? "the run's data home" : `the data home ${home}`}; listening after ${numbers.listeningMs} ms, the web app shown after ${numbers.appShownMs} ms`,
    );
  });
  const server = smoke.server();
  if (!shown || server === null) return;
  await smoke.processes.adopt("backend", server.pid);

  const BACKEND =
    "its backend is the app's binary in node mode on the payload's server, under main";
  await checks.step(BACKEND, async () => {
    const row = (await processTable()).find((candidate) => candidate.pid === server.pid);
    const runs =
      row !== undefined && runsOnBinary(row.command, layout.binary, serverScript(layout));
    checks.add(
      BACKEND,
      runs && row?.ppid === main.child.pid,
      `pid ${server.pid} under pid ${row?.ppid ?? "none"}, main's ${main.child.pid}, on ${server.origin}: ${row === undefined ? "gone" : short(row.command)}`,
    );
  });

  await checks.step("the canary key never reached the backend", async () => {
    await smoke.checkCanary();
  });

  const VERSION = "the version: a packaged build on the pinned Electron, and the payload's server";
  await checks.step(VERSION, async () => {
    const started = smoke
      .log("main")
      .split(/\r?\n/)
      .find((text) => text.includes(" · Electron "));
    const named = /Eidolon (\S+)( \(unpackaged\))? · Electron (\S+) · /.exec(started ?? "");
    const manifest = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const pinned = manifest.devDependencies.electron;
    const status = (await (await smoke.api("/api/local/status")).json()) as Partial<Status>;
    const staged = JSON.parse(readFileSync(join(layout.payload, "package.json"), "utf8")) as {
      version?: unknown;
    };
    checks.add(
      VERSION,
      named !== null &&
        named[2] === undefined &&
        named[3] === pinned &&
        typeof status.version === "string" &&
        status.version === staged.version,
      `main.log names Eidolon ${named?.[1] ?? "?"}${named?.[2] ?? ""} on Electron ${named?.[3] ?? "?"}, pinned ${pinned}; the server reports ${String(status.version)}, the payload's package.json ${String(staged.version)}`,
    );
  });

  const SESSION =
    "the session: the Bearer signs in, a wrong one or none gets a 401, and the server proves it holds local-token";
  await checks.step(SESSION, async () => {
    const signed = await smoke.api("/api/local/session");
    const body = (await signed.json()) as { ok?: unknown };
    const answer = async (headers: Record<string, string>) => {
      const response = await fetch(new URL("/api/local/session", server.origin), {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      return response.status;
    };
    const anonymous = await answer({});
    // Shaped as local-token's secret is: 32 random bytes in base64url.
    const wrong = await answer({
      authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
    });
    const token = readToken(run.home);
    const proved = token !== null && (await probe(server.origin, token));
    checks.add(
      SESSION,
      signed.status === 200 && body.ok === true && anonymous === 401 && wrong === 401 && proved,
      `with the Bearer ${signed.status} ${JSON.stringify(body)}; with a wrong one ${wrong}; without one ${anonymous}; main's probe ${proved ? "proved" : "didn't prove"} the token`,
    );
  });

  const STATUS = "the status answers for her persona on the fakes' accounts, and / is the web app";
  await checks.step(STATUS, async () => {
    const answer = await smoke.api("/api/local/status");
    const status = (await answer.json()) as Partial<Status>;
    const page = await smoke.api("/", { headers: { accept: "text/html" } });
    const html = await page.text();
    const type = page.headers.get("content-type") ?? "";
    const keyed = (status.keys ?? []).filter((key) => key.set).map((key) => key.account);
    checks.add(
      STATUS,
      answer.status === 200 &&
        status.persona?.id === PERSONA &&
        status.activeCalls === 0 &&
        ["openai", "openrouter"].every((id) => keyed.includes(id)) &&
        page.status === 200 &&
        type.startsWith("text/html") &&
        html.includes('id="root"'),
      `status ${answer.status}: ${status.persona?.id ?? "no persona"}, ${status.activeCalls ?? "?"} calls, keys for ${keyed.join(", ") || "none"}; / ${page.status}, ${html.length} bytes of ${type}`,
    );
  });

  const SHARP = "sharp: a photo sent to a chat comes back from the backend upright and bare";
  await checks.step(SHARP, async () => {
    const photo = Buffer.from(ROTATED_PHOTO, "base64");
    const created = await smoke.api("/api/local/chats", {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({ participants: [PERSONA] }),
    });
    const { id } = (await created.json()) as { id: string };
    const upload = await smoke.api(`/api/local/chats/${id}/files`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: photo,
    });
    const saved = (await upload.json()) as {
      name?: string;
      mime?: string;
      error?: { message?: string };
    };
    if (upload.status !== 201) {
      checks.add(
        SHARP,
        false,
        `POST files answered ${upload.status}: ${saved.error?.message ?? "no error said"}`,
      );
      return;
    }
    const back = await smoke.api(`/api/local/chats/${id}/files/${saved.name}`);
    const made = jpegFacts(new Uint8Array(await back.arrayBuffer()));
    checks.add(
      SHARP,
      back.status === 200 && made?.width === 2 && made.height === 4 && !made.exif,
      `sent ${described(jpegFacts(photo))}, orientation 6; kept as ${saved.mime}; back ${back.status}, ${described(made)}`,
    );
  });

  const MAPPED =
    "the backend maps its natives from the payload: LanceDB from its start, sharp and libvips with the first photo";
  await checks.step(MAPPED, async () => {
    const mapped = await mappedNatives(server.pid);
    const outside = mapped.filter((path) => !inside(path, payload));
    const missing = ["lancedb", "sharp-", "vips"].filter(
      (name) => !mapped.some((path) => basename(path).toLowerCase().includes(name)),
    );
    checks.add(
      MAPPED,
      outside.length === 0 && missing.length === 0,
      `${mapped.map((path) => basename(path)).join(", ") || "nothing"}${outside.length > 0 ? `; not from the payload: ${outside.join(", ")}` : ""}${missing.length > 0 ? `; never mapped: ${missing.join(", ")}` : ""}`,
    );
  });

  const JOB =
    "LanceDB: an ingest-facts job on the app's binary writes her facts through the fakes' embeddings";
  await checks.step(JOB, async () => {
    const { patterns } = (await (
      await smoke.api(`/api/local/personas/${PERSONA}/facts`)
    ).json()) as { patterns: string[] };
    const name = (patterns[0] ?? "*.txt").replaceAll("*", "smoke");
    const put = await smoke.api(
      `/api/local/personas/${PERSONA}/facts/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: JSON_TYPE,
        body: JSON.stringify({ text: `${FACTS.join("\n")}\n` }),
      },
    );
    await put.body?.cancel();
    const left = budget(JOB_MS);
    const embedded = fakes.count("POST /v1/embeddings");
    const release = fakes.holdEmbeddings();
    let job: JobRecord;
    let command: string | null = null;
    let lancedb: string | null = null;
    try {
      const started = await smoke.api("/api/local/jobs", {
        method: "POST",
        headers: JSON_TYPE,
        body: JSON.stringify({ command: "ingest-facts", persona: PERSONA }),
      });
      const answer = (await started.json()) as Partial<JobRecord> & {
        error?: { message?: string };
      };
      if (started.status !== 201 || typeof answer.id !== "string") {
        checks.add(
          JOB,
          false,
          `${name} ${put.status}; POST jobs answered ${started.status}: ${answer.error?.message ?? "no job"}`,
        );
        return;
      }
      job = answer as JobRecord;
      // Held at its embeddings, the job runs on while its process is looked at.
      await until(
        () => fakes.count("POST /v1/embeddings"),
        (count) => count > embedded,
        left(),
      );
      // Tracked from here, it fails the run if it outlives the backend.
      await smoke.processes.snapshot();
      const row = (await processTable()).find(
        (candidate) =>
          candidate.ppid === server.pid &&
          runsOnBinary(candidate.command, layout.binary, cliScript(layout)),
      );
      if (row !== undefined) {
        command = row.command;
        const mapped = await mappedNatives(row.pid);
        lancedb = mapped.find((path) => basename(path).toLowerCase().includes("lancedb")) ?? null;
      }
    } finally {
      release();
    }
    const done = await until(
      async () => (await (await smoke.api(`/api/local/jobs/${job.id}`)).json()) as JobRecord,
      (record) => record.status !== "running",
      left(),
      300,
    );
    const metaFile = join(run.home, "personas", PERSONA, "index", "persona_facts.meta.json");
    const meta = existsSync(metaFile)
      ? (JSON.parse(readFileSync(metaFile, "utf8")) as { rows?: unknown })
      : null;
    checks.add(
      JOB,
      put.status === 200 &&
        command !== null &&
        lancedb !== null &&
        inside(lancedb, payload) &&
        done.status === "succeeded" &&
        meta?.rows === FACTS.length,
      `${name} ${put.status}; the job ${command === null ? "never seen running under the backend" : `ran as ${short(command)}`}, ${lancedb === null ? "without LanceDB mapped" : `LanceDB mapped from ${short(lancedb)}`}; held at its embeddings, then ${done.status} (exit ${done.exitCode}); persona_facts holds ${String(meta?.rows ?? "no")} rows`,
    );
  });

  const SEARCH =
    "LanceDB: a search on the app's binary reads her facts back through the fakes' embeddings";
  await checks.step(SEARCH, async () => {
    const embedded = fakes.count("POST /v1/embeddings");
    const at = Date.now();
    // The fakes serve no reranker, and reranking is no native's.
    const searched = await onBinary(
      smoke,
      "search",
      layout,
      [cliScript(layout), "search", "--table", "persona_facts", "--json", "--top-k", "2", QUERY],
      { ...nodeEnv, RERANK_ENABLED: "false" },
      SEARCH_MS,
    );
    numbers.searchMs = Date.now() - at;
    const hits = searched.code === 0 ? (JSON.parse(searched.stdout) as { text?: unknown }[]) : [];
    const texts = hits.map((hit) => String(hit.text));
    const queries = fakes.count("POST /v1/embeddings") - embedded;
    checks.add(
      SEARCH,
      searched.code === 0 && FACTS.every((fact) => texts.includes(fact)) && queries > 0,
      `exit ${searched.code} after ${numbers.searchMs} ms with ${hits.length} hits: ${texts.join(" ") || "none"}; ${queries} embeddings request(s) for the query${searched.code === 0 ? "" : `; ${searched.stderr.trimEnd().split(/\r?\n/).at(-1) ?? ""}`}`,
    );
  });

  const RESTART = "a restart through Settings' route keeps the port and changes the backend's pid";
  await checks.step(RESTART, async () => {
    const before = smoke.server() ?? server;
    // What the old backend started is tracked before it exits and leaves its children unparented.
    await smoke.processes.snapshot();
    const left = budget(RESTART_MS);
    const from = smoke.log("main").length;
    const answer = await smoke.api("/api/local/restart", { method: "POST" });
    await answer.body?.cancel();
    const exited = await line(smoke, "main", exitOf(before.pid), left(), from);
    const respawned = await line(smoke, "main", LINES.started, left(), from);
    const listens = await line(smoke, "main", LINES.listens, left(), from);
    const after = await until(
      () => smoke.server(),
      (now) => now !== null && now.pid !== before.pid,
      left(),
    );
    if (after !== null && after.pid !== before.pid) {
      await smoke.processes.adopt("backend after the restart", after.pid);
    }
    const status = await smoke.api("/api/local/status");
    await status.body?.cancel();
    numbers.restartDownMs = (lineTime(listens) ?? 0) - (lineTime(exited) ?? 0);
    const code = exitOf(before.pid).exec(exited)?.[1];
    const asked = LINES.started.exec(respawned)?.[2];
    checks.add(
      RESTART,
      answer.ok &&
        code === String(RESTART_EXIT_CODE) &&
        asked === String(before.port) &&
        after?.port === before.port &&
        after.pid !== before.pid &&
        !isAlive(before.pid) &&
        status.status === 200,
      `POST restart ${answer.status}; pid ${before.pid} exited (${code}); pid ${after?.pid ?? "none"} asked for port ${asked} and listens on ${after?.origin ?? "nothing"} after ${numbers.restartDownMs} ms down; status ${status.status}`,
    );
  });

  const token = localToken(run.home);
  const QUIT = "--quit: the second launch and main exit 0, and the backend stops cleanly";
  await checks.step(QUIT, async () => {
    const backend = smoke.server();
    await smoke.processes.snapshot();
    const left = budget(QUIT_MS);
    const from = smoke.log("main").length;
    const second = await smoke.quit(app, left());
    numbers.quitLaunchMs = second.ms;
    const exit = await within(main.exited, left());
    const stopped =
      backend === null
        ? null
        : await line(smoke, "main", exitOf(backend.pid), left(), from).catch(() => null);
    const code =
      stopped === null || backend === null ? null : exitOf(backend.pid).exec(stopped)?.[1];
    const quitting = smoke.log("main").slice(from).includes(LINES.quitting);
    // Main kills a backend that outlives its stop trigger, which an exit code alone can hide.
    const forced = /Eidolon: (the backend \(pid \d+\) didn't [^;]+)/.exec(
      smoke.log("main").slice(from),
    )?.[1];
    checks.add(
      QUIT,
      second.code === 0 && exit?.code === 0 && quitting && code === "0" && forced === undefined,
      `the second launch exited ${second.code ?? second.signal} in ${second.ms} ms; main ${exit === null ? "still ran on" : `exited ${exit.code ?? exit.signal}`}${quitting ? ", having logged its quit" : " with no quit in main.log"}; the backend ${code === null || code === undefined ? "logged no exit" : `(pid ${backend?.pid}) exited (${code})`}${forced === undefined ? "" : `, after ${forced}`}`,
    );
  });

  const LEFT = "nothing the app started is left running after the quit";
  await checks.step(LEFT, async () => {
    // On macOS, also what was started between two snapshots and lost its parent since.
    for (const row of await processesNaming(run.root)) {
      const what = `${short(row.command).slice(0, 160)}, naming the run's folder`;
      await smoke.processes.adopt(what, row.pid);
    }
    const left = await smoke.processes.settle(15_000);
    checks.add(
      LEFT,
      left.length === 0,
      left.join("; ") || "main, its helpers and each backend are gone",
    );
  });

  const ERRORS = "no error lines in either log of the run's profile";
  const mainLog = smoke.log("main");
  const backendLog = smoke.log("backend");
  const errors = [
    ...errorLines(mainLog, "main"),
    ...errorLines(backendLog, "backend"),
    ...strayErrorLines(backendLog),
  ];
  checks.add(
    ERRORS,
    errors.length === 0 && backendLog.length > 0,
    errors.length > 0
      ? errors.slice(0, 3).join(" | ")
      : `main.log ${mainLog.split("\n").length} lines, backend.log ${backendLog.split("\n").length}`,
  );
  const leaked =
    token === null
      ? []
      : [
          ...leaks(mainLog, token).map((where) => `main.log's ${where}`),
          ...leaks(backendLog, token).map((where) => `backend.log's ${where}`),
        ];
  checks.add(
    "neither log holds a link code's line or the token",
    token !== null && leaked.length === 0,
    token === null ? "no token to look for" : leaked.slice(0, 3).join("; "),
  );
}

function serverScript(layout: AppLayout): string {
  return join(layout.payload, "dist", "server.js");
}

function cliScript(layout: AppLayout): string {
  return join(layout.payload, "dist", "cli.js");
}

/** Windows: the NSIS setup installs the app silently for this user, where the walk smokes it. */
async function install(
  smoke: Smoke,
  setup: string,
  binary: string,
  numbers: Numbers,
): Promise<void> {
  const folder = dirname(binary);
  const INSTALL = "the NSIS setup installs the app silently, for this user";
  await smoke.checks.step(INSTALL, async () => {
    const at = Date.now();
    const running = smoke.processes.spawn("setup", setup, ["/S"], { stdio: "ignore" });
    const exit = await within(running.exited, INSTALL_MS);
    numbers.installSeconds = Math.round((Date.now() - at) / 100) / 10;
    const entry = (await uninstallEntries()).find((candidate) =>
      namesUninstaller(candidate, folder),
    );
    smoke.checks.add(
      INSTALL,
      exit?.code === 0 && existsSync(binary) && existsSync(join(folder, UNINSTALLER)) && !!entry,
      `${basename(setup)} exited ${exit === null ? `not within ${INSTALL_MS / 1000} s` : (exit.code ?? exit.signal)} after ${numbers.installSeconds} s; ${binary} ${existsSync(binary) ? "is there" : "is missing"}; HKCU's uninstall entry: ${entry?.UninstallString ?? "none for its uninstaller"}`,
    );
  });
}

/** A few of what `folder` still holds, by path from it; or why it can't be read, as it goes. */
function leftIn(folder: string): string {
  try {
    return readdirSync(folder, { recursive: true }).slice(0, 5).join(", ") || "nothing";
  } catch (error) {
    return (error as Error).message;
  }
}

/** The default data home with the smoke's marker in it, as it was before the install. */
interface MarkedHome {
  readonly marker: Marker;
  readonly before: Readonly<Record<string, string>> | null;
}

/**
 * On a CI runner, a marker in the default data home, the one npx and `bun run app` share: the
 * uninstaller never learns the run's own home, so this is the home the install and uninstall
 * could touch. Never elsewhere, where that home may hold someone's own data.
 */
function markDefaultHome(): MarkedHome | null {
  if (process.env.CI !== "true") return null;
  const marker = placeMarker(dataHome({}), `eidolon-smoke-${randomBytes(6).toString("hex")}`);
  return { marker, before: fileHashes(marker.folder) };
}

/**
 * Windows: the uninstaller removes the app silently and leaves the data homes as they were: the
 * run's, and on a CI runner the default one, marked before the install.
 */
async function uninstall(
  smoke: Smoke,
  binary: string,
  numbers: Numbers,
  marked: MarkedHome | null,
): Promise<void> {
  const folder = dirname(binary);
  const UNINSTALL =
    "the uninstaller removes the app silently and leaves the data homes as they were, file for file";
  await smoke.checks.step(UNINSTALL, async () => {
    // After a walk that failed midway: the uninstaller would end the app with no stop of its own.
    if ((await smoke.processes.running()).length > 0) await smoke.processes.stopAll();
    const before = fileHashes(smoke.run.home);
    const listed = await uninstallEntries();
    const silent = silentUninstall(listed, folder);
    if (silent === null) {
      const seen = listed.map((entry) => entry.UninstallString ?? entry.DisplayName ?? "?");
      smoke.checks.add(
        UNINSTALL,
        false,
        `no uninstall entry of this user's names ${join(folder, UNINSTALLER)} /currentuser, so nothing ran and the app is still in ${folder}; Eidolon's entries: ${seen.join("; ") || "none"}`,
      );
      return;
    }
    const { command, args } = silent;
    const ourEntries = async () =>
      (await uninstallEntries()).filter((entry) => namesUninstaller(entry, folder));
    const left = budget(UNINSTALL_MS);
    const at = Date.now();
    const running = smoke.processes.spawn("uninstaller", command, args, { stdio: "ignore" });
    const exit = await within(running.exited, left());
    // NSIS's uninstaller returns at once and removes the app from a copy of itself in %TEMP%.
    await until(
      () => existsSync(folder),
      (there) => !there,
      left(),
      500,
    );
    const entries = await until(ourEntries, (found) => found.length === 0, left(), 1000);
    numbers.uninstallSeconds = Math.round((Date.now() - at) / 100) / 10;
    const changed = changedFiles(before, fileHashes(smoke.run.home));
    const files = Object.keys(before ?? {}).length;
    const changedDefault =
      marked === null ? null : changedFiles(marked.before, fileHashes(marked.marker.folder));
    const remaining = existsSync(folder) ? leftIn(folder) : null;
    smoke.checks.add(
      UNINSTALL,
      exit?.code === 0 &&
        remaining === null &&
        entries.length === 0 &&
        files > 0 &&
        changed.length === 0 &&
        (changedDefault?.length ?? 0) === 0,
      `${basename(command)} ${args.join(" ")} exited ${exit === null ? "not in time" : (exit.code ?? exit.signal)}; after ${numbers.uninstallSeconds} s the install folder ${remaining === null ? "is gone" : `remains, holding ${remaining}`}, ${entries.length} uninstall entr${entries.length === 1 ? "y" : "ies"} left; the run's data home's ${files} files ${changed.length === 0 ? "are unchanged" : `changed: ${changed.slice(0, 5).join(", ")}`}; the default data home ${changedDefault === null ? "is checked on a CI runner only" : changedDefault.length === 0 ? "holds the marker as it was" : `changed: ${changedDefault.slice(0, 5).join(", ")}`}`,
    );
  });
}

/** What this machine's build in apps/desktop/.out gives the smoke, or why there's nothing to smoke. */
function plan(): { readonly binary: string; readonly setup: string | null } | string {
  if (TARGET !== "darwin-arm64" && TARGET !== "win32-x64") {
    return `the packaged smoke runs on macOS arm64 and Windows x64, not ${TARGET}`;
  }
  if (process.platform !== "win32") {
    const binary = packagedBinary();
    return existsSync(binary)
      ? { binary, setup: null }
      : `apps/desktop/.out has no packaged app (${binary}). Make it with: ${MAKE}`;
  }
  let setup: string;
  try {
    setup = installer();
  } catch (error) {
    return `${(error as Error).message}, the NSIS setup to smoke. Make it with: ${MAKE}`;
  }
  const binary = installedBinary();
  if (existsSync(dirname(binary))) {
    return `Eidolon is already installed for this user in ${dirname(binary)}. The smoke installs its own build there and uninstalls it after, so it runs only where none is, such as a CI runner`;
  }
  return { binary, setup };
}

const planned = plan();
if (typeof planned === "string") {
  console.error(`${LABEL}: ${planned}`);
  process.exit(1);
}
const smoke = await startSmoke({ label: LABEL, restoresPreferences: true });
const startedAt = new Date();
const numbers: Numbers = {};
console.log(
  `${LABEL}: ${planned.setup ?? planned.binary} on ${TARGET}, ${smoke.args.headful ? "headful" : "in background mode"}; the run's folder is ${smoke.run.root}`,
);
try {
  if (planned.setup === null) await walk(smoke, appLayout(planned.binary), numbers);
  else {
    const marked = markDefaultHome();
    try {
      await install(smoke, planned.setup, planned.binary, numbers);
      if (existsSync(planned.binary)) await walk(smoke, appLayout(planned.binary), numbers);
    } finally {
      if (existsSync(dirname(planned.binary))) {
        await uninstall(smoke, planned.binary, numbers, marked);
      }
      marked?.marker.remove();
    }
  }
} catch (error) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  smoke.checks.add(`${LABEL} ran to its end`, false, text.split("\n").slice(0, 4).join(" | "));
}
const code = await smoke.finish();
// A pass removed the run's folder; its results come back into it alone.
mkdirSync(smoke.run.root, { recursive: true, mode: 0o700 });
const results = join(smoke.run.root, "results.json");
writeFileSync(
  results,
  `${JSON.stringify(
    {
      smoke: LABEL,
      target: TARGET,
      app: planned.binary,
      setup: planned.setup,
      background: !smoke.args.headful,
      startedAt: startedAt.toISOString(),
      seconds: Math.round((Date.now() - startedAt.getTime()) / 100) / 10,
      passed: code === 0,
      numbers,
      checks: smoke.checks.list,
    },
    null,
    2,
  )}\n`,
);
console.log(`${LABEL}: the results are in ${results}`);
process.exit(code);
