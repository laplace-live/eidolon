// Installs a packed @laplace.live/eidolon with npm, install scripts and all, as npx would, then runs
// it on a new HOME and data home: its link, a sign-in with the link's code, the status with the
// cookie and the proof, a character model checked by its PSD2Live runtime, a CLI command's help,
// the eidolon command tasks run, the built-in skills, sharp, LanceDB and onnxruntime-node as the
// bundles load them, and a clean exit on SIGTERM. CI runs it on linux-x64 and win32-x64, where
// tasks' commands run in Git Bash and nothing sends SIGTERM: there it also checks npm's .cmd for
// the command, and that the app ends with its launcher.
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { killTree, type Subprocess, spawnProcess, which } from "@eidolon/config";
import { Output, READY_LINE } from "../../bot/scripts/output.ts";
import {
  type CharacterModel,
  type ErrorBody,
  PROOF_HEADER,
  type SessionGrant,
  type SkillsResponse,
  type Status,
} from "../../bot/src/local/api.ts";
import { PLATFORMS } from "../src/launcher.ts";

const WINDOWS = process.platform === "win32";
/** The checkout's CC0 test rig, which the package's server loads in its own copy of the runtime. */
const RIG = resolve(import.meta.dirname, "../../bot/test/local/fixtures/psd2live/tml.p2lrt");

const USAGE = `usage: node apps/eidolon/scripts/ci-install-check.ts <tarball>

Installs the tarball with npm into a temporary folder, runs its eidolon on a temporary HOME and
data home, and deletes them. Exits 0 when every check passes, else 1.`;

const BOOT_TIMEOUT_MS = 120_000;
/** An image made and read back by sharp, imported as the bundles import it with a viewer's first. */
const SHARP_CHECK = `
const { default: sharp } = await import("sharp");
const made = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#e33" } })
  .jpeg()
  .toBuffer();
const { format, width, height } = await sharp(made).metadata();
console.log(\`\${format} \${width}×\${height}\`);
`;
/**
 * LanceDB's binary for this platform, which the bundles require by name, opening a database, and
 * onnxruntime-node running Silero VAD from the package's models: on Windows each needs the Visual
 * C++ runtime.
 */
const NATIVE_CHECK = `
const { createRequire } = await import("node:module");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Connection } = createRequire(join(process.cwd(), "package.json"))(process.argv[1]);
const dir = mkdtempSync(join(tmpdir(), "eidolon-lancedb-"));
const tables = await (await Connection.new(dir, {})).tableNames();
rmSync(dir, { recursive: true, force: true });
const ort = await import("onnxruntime-node");
const vad = await ort.InferenceSession.create(join(process.cwd(), "data", "models", "silero_vad.onnx"));
console.log(\`lancedb \${JSON.stringify(tables)}, silero inputs \${vad.inputNames.join(",")}\`);
`;
const STOP_TIMEOUT_MS = 15_000;
const TAIL_LINES = 40;

class CheckFailed extends Error {}

/** Prints the check, and throws when it failed. */
function check(name: string, pass: boolean, detail: string): asserts pass {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!pass) throw new CheckFailed(name);
}

/**
 * Runs `command` to its end. On Windows npm, and the .cmd npm links for a package's command, start
 * only through cmd.exe: there the line is the command's own, each argument quoted, the command by
 * its full path, since a batch file cmd.exe finds on PATH by a quoted name reads its own folder
 * (`%~dp0`) as the working one.
 */
function runSync(command: string, args: readonly string[], options: SpawnSyncOptions) {
  return WINDOWS
    ? spawnSync([`"${which(command) ?? command}"`, ...args.map((arg) => `"${arg}"`)].join(" "), {
        ...options,
        shell: true,
      })
    : spawnSync(command, args, options);
}

function versionOf(tool: string): string {
  return String(runSync(tool, ["--version"], { encoding: "utf8" }).stdout).trim();
}

/** `npm install --prefix`, which runs the dependencies' install scripts; returns the bin it links. */
function install(tarball: string, prefix: string): string {
  mkdirSync(prefix, { recursive: true });
  const npm = runSync(
    "npm",
    ["install", "--prefix", prefix, "--no-audit", "--no-fund", resolve(tarball)],
    { cwd: prefix, stdio: ["ignore", "inherit", "inherit"] },
  );
  check(
    "install",
    npm.status === 0,
    `npm ${versionOf("npm")} on Node ${versionOf("node")}, ${process.platform}-${process.arch}: ` +
      `exit ${npm.status}`,
  );
  return join(prefix, "node_modules", ".bin", WINDOWS ? "eidolon.cmd" : "eidolon");
}

interface App {
  /** The launcher, which leads its own process group. */
  readonly process: Subprocess;
  readonly stdout: Output;
  readonly stderr: Output;
  readonly origin: string;
  /** The link's fragment, which POST session trades for the cookie and the proof. */
  readonly code: string;
}

/** The launcher's exit code, or null when it hasn't exited within `ms`. */
export async function exitWithin(child: Subprocess, ms: number): Promise<number | null> {
  // Cleared on exit: a pending timer would hold this script open for the rest of `ms`.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([child.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a command to its end, keeping this process's event loop, and so the app's pipes, going. */
async function run(
  argv: readonly [string, ...string[]],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawnProcess(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Stops what still runs: SIGTERM to the launcher's process group, then SIGKILL; its tree on Windows. */
async function stopAll(child: Subprocess): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (WINDOWS) killTree(child.pid);
    else {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is gone.
      }
    }
    await exitWithin(child, STOP_TIMEOUT_MS);
  }
}

/** Starts `eidolon --no-open --port 0` and waits for the link it prints. */
async function boot(
  eidolon: readonly [string, ...string[]],
  env: Record<string, string>,
  cwd: string,
): Promise<App> {
  const child = spawnProcess([...eidolon, "--no-open", "--port", "0"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    // On Windows it stays in this process's job instead, which ends it with this process.
    detached: !WINDOWS,
  });
  const stdout = new Output(child.stdout as ReadableStream<Uint8Array>);
  const stderr = new Output(child.stderr as ReadableStream<Uint8Array>);
  let link: string;
  try {
    link = await stdout.waitFor(READY_LINE, child.exited, BOOT_TIMEOUT_MS);
  } catch {
    const exit = child.exitCode ?? child.signalCode;
    await stopAll(child);
    check(
      "link",
      false,
      `${exit === null ? "timed out" : `exited ${exit}`} without one:\n` +
        `${stdout.tail(TAIL_LINES)}\n${stderr.tail(TAIL_LINES)}`,
    );
  }
  const url = new URL(link);
  check("link", true, url.origin);
  return { process: child, stdout, stderr, origin: url.origin, code: url.hash.slice(1) };
}

/** The headers the app's pages send: the cookie and the proof POST session traded the code for. */
async function signIn(origin: string, code: string): Promise<Record<string, string>> {
  const response = await fetch(`${origin}/api/local/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ code }),
  });
  const grant = (await response.json().catch(() => ({}))) as Partial<SessionGrant>;
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  const proof = typeof grant.proof === "string" ? grant.proof : undefined;
  check(
    "sign-in",
    response.status === 200 && cookie !== undefined && proof !== undefined,
    `POST /api/local/session with the link's code: ${response.status}, ` +
      `${cookie === undefined ? "no" : "a"} cookie and ${proof === undefined ? "no" : "a"} proof`,
  );
  return { Cookie: cookie, [PROOF_HEADER]: proof, Origin: origin };
}

/** What Windows programs need of this environment, with the user's own folders under `home`. */
function windowsEnv(home: string): Record<string, string> {
  const kept = ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "TEMP", "TMP"].flatMap(
    (name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value] as const];
    },
  );
  return {
    ...Object.fromEntries(kept),
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
  };
}

/** Whether the app at `origin` stops answering within `ms`. */
async function closes(origin: string, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  for (;;) {
    const answers = await fetch(`${origin}/`).then(
      () => true,
      () => false,
    );
    if (!answers) return true;
    if (performance.now() > deadline) return false;
    await delay(250);
  }
}

/** Every check on the package at `tarball`, installed and run inside `temp`. */
async function checkPackage(tarball: string, temp: string): Promise<void> {
  const prefix = join(temp, "prefix");
  const bin = install(tarball, prefix);
  const pkg = join(prefix, "node_modules", "@laplace.live", "eidolon");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
    version: string;
    bin: { eidolon: string };
  };
  const { version } = manifest;
  // npm's .cmd for it starts only through cmd.exe, which would hide the launcher's process: the
  // launcher itself, as the .cmd runs it.
  const eidolon: [string, ...string[]] = WINDOWS
    ? [process.execPath, join(pkg, manifest.bin.eidolon)]
    : [bin];
  const home = join(temp, "home");
  mkdirSync(home, { recursive: true });
  // A first run's environment: this PATH, and nothing of this computer's Eidolon.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    EIDOLON_HOME: join(temp, "data"),
    ...(WINDOWS ? windowsEnv(home) : {}),
  };
  if (WINDOWS) {
    const shim = runSync(bin, ["--version"], { cwd: temp, env, encoding: "utf8" });
    check(
      "eidolon.cmd",
      shim.status === 0 && String(shim.stdout).trim() === version,
      `npm's eidolon.cmd --version: exit ${shim.status}, ${String(shim.stdout).trim() || String(shim.stderr).trim()}`,
    );
  }
  const app = await boot(eidolon, env, temp);
  try {
    const session = await signIn(app.origin, app.code);
    const status = await fetch(`${app.origin}/api/local/status`, { headers: session });
    const body = (await status.json().catch(() => ({}))) as Partial<Status>;
    check(
      "status",
      status.status === 200 && body.version === version,
      `GET /api/local/status with the cookie and the proof: ${status.status}, version ` +
        `${body.version ?? "none"}`,
    );
    const alone = await fetch(`${app.origin}/api/local/status`, {
      headers: { Cookie: session.Cookie },
    });
    const refusal = ((await alone.json().catch(() => ({}))) as Partial<ErrorBody>).error?.code;
    check(
      "proof",
      alone.status === 401 && refusal === "proof-missing",
      `the cookie alone: ${alone.status} ${refusal ?? ""}`,
    );
    const chats = await fetch(`${app.origin}/api/local/chats`, { headers: session });
    const listed = (await chats.json().catch(() => null)) as unknown;
    // A first run has no keys, so a new chat is refused before anything is written.
    const create = await fetch(`${app.origin}/api/local/chats`, {
      method: "POST",
      headers: { ...session, "Content-Type": "application/json" },
      body: JSON.stringify({ participants: ["milky-green"] }),
    });
    const refused = ((await create.json().catch(() => ({}))) as Partial<ErrorBody>).error?.code;
    check(
      "chats",
      chats.status === 200 &&
        Array.isArray(listed) &&
        listed.length === 0 &&
        create.status === 409 &&
        refused === "missing-key",
      `GET /api/local/chats: ${chats.status}, ${JSON.stringify(listed)}; a new chat without ` +
        `keys: ${create.status} ${refused ?? ""}`,
    );
    const imported = await fetch(
      `${app.origin}/api/local/personas/milky-green/models?filename=tml.p2lrt`,
      {
        method: "POST",
        headers: { ...session, "Content-Type": "application/octet-stream" },
        body: new Blob([readFileSync(RIG)]),
      },
    );
    const model = (await imported.json().catch(() => ({}))) as Partial<CharacterModel>;
    check(
      "character model",
      imported.status === 201 && model.inventory?.generator === "psd2live 3.8.4",
      `POST /api/local/personas/milky-green/models with the test rig: ${imported.status}, ` +
        `${model.inventory?.generator ?? "nothing read of it"}`,
    );
    const help = await run([...eidolon, "search", "--help"], env, temp);
    check(
      "search --help",
      help.code === 0 && help.stdout.startsWith("usage: "),
      `exit ${help.code}${help.code === 0 ? "" : `: ${help.stderr.trim()}`}`,
    );
    // As a task's command runs it: a shell, on Windows Git Bash, finding it first on a PATH of the
    // system's folders otherwise, with no EIDOLON_HOME.
    const commands = join(env.EIDOLON_HOME, "bin");
    const system = process.env.SystemRoot ?? "C:\\Windows";
    const [shell, taskEnv]: [string, Record<string, string>] = WINDOWS
      ? [
          join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
          { ...windowsEnv(home), PATH: [commands, join(system, "System32"), system].join(";") },
        ]
      : ["/bin/sh", { PATH: `${commands}:/usr/bin:/bin`, HOME: home }];
    const tasks = await run([shell, "-c", "eidolon discover --help"], taskEnv, temp);
    check(
      "tasks' eidolon",
      tasks.code === 0 && tasks.stdout.startsWith("usage: "),
      `eidolon discover --help with ${commands} first on PATH: exit ${tasks.code}` +
        `${tasks.code === 0 ? "" : `: ${tasks.stderr.trim()}`}`,
    );
    const images = await run(
      [process.execPath, "--input-type=module", "--eval", SHARP_CHECK],
      env,
      pkg,
    );
    check(
      "sharp",
      images.code === 0 && images.stdout.trim() === "jpeg 2×1",
      images.code === 0 ? images.stdout.trim() : `exit ${images.code}: ${images.stderr.trim()}`,
    );
    const lancedb = PLATFORMS[`${process.platform}-${process.arch}` as keyof typeof PLATFORMS];
    const native = await run(
      [process.execPath, "--input-type=module", "--eval", NATIVE_CHECK, lancedb],
      env,
      pkg,
    );
    check(
      "native modules",
      native.code === 0 && native.stdout.startsWith("lancedb [], silero inputs "),
      native.code === 0 ? native.stdout.trim() : `exit ${native.code}: ${native.stderr.trim()}`,
    );
    const skills = await fetch(`${app.origin}/api/local/skills`, { headers: session });
    const listing = (await skills.json().catch(() => ({}))) as Partial<SkillsResponse>;
    const builtin = (listing.skills ?? []).filter((skill) => skill.source === "builtin");
    check(
      "built-in skills",
      skills.status === 200 && builtin.some((skill) => skill.name === "persona-update"),
      `GET /api/local/skills: ${skills.status}, built in: ` +
        `${builtin.map((skill) => skill.name).join(", ") || "none"}`,
    );
    // On Windows a kill ends the launcher at once, as closing the console window does at last; its
    // job takes the supervisor along, and the supervisor's the server.
    app.process.kill("SIGTERM");
    const code = await exitWithin(app.process, STOP_TIMEOUT_MS);
    const closed = await closes(app.origin, WINDOWS ? STOP_TIMEOUT_MS : 0);
    check(
      WINDOWS ? "ends with its launcher" : "SIGTERM",
      (WINDOWS ? code !== null : code === 0) && closed,
      `the launcher exited ${code ?? `not within ${STOP_TIMEOUT_MS / 1000} s`}; the port ` +
        `${closed ? "is closed" : "still answers"}`,
    );
  } catch (error) {
    console.log(
      `The app's stdout:\n${app.stdout.tail(TAIL_LINES)}\n` +
        `Its stderr:\n${app.stderr.tail(TAIL_LINES)}`,
    );
    throw error;
  } finally {
    await stopAll(app.process);
  }
}

function tarballArg(argv: readonly string[]): string {
  const [tarball, ...rest] = argv;
  if (tarball !== undefined && rest.length === 0 && !tarball.startsWith("-")) return tarball;
  console.error(USAGE);
  process.exit(2);
}

async function main(): Promise<number> {
  const tarball = tarballArg(process.argv.slice(2));
  const temp = mkdtempSync(join(tmpdir(), "eidolon-install-check-"));
  try {
    await checkPackage(resolve(tarball), temp);
    console.log("Every check passed.");
    return 0;
  } catch (error) {
    if (!(error instanceof CheckFailed)) console.log(`FAIL: ${(error as Error).stack}`);
    return 1;
  } finally {
    // Windows refuses, for a moment, to delete a folder a process it is ending still holds.
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (import.meta.main) process.exitCode = await main();
