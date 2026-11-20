// Installs a packed @laplace.live/eidolon with npm, install scripts and all, as npx would, then runs
// it on a new HOME and data home: its link, a sign-in with the link's code, the status with the
// cookie and the proof, a CLI command's help, the eidolon command tasks run, the built-in skills,
// and a clean exit on SIGTERM. CI runs it on linux-x64.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Subprocess, spawnProcess } from "@eidolon/config";
import { Output, READY_LINE } from "../../bot/scripts/output.ts";
import {
  type ErrorBody,
  PROOF_HEADER,
  type SessionGrant,
  type SkillsResponse,
  type Status,
} from "../../bot/src/local/api.ts";

const USAGE = `usage: node apps/eidolon/scripts/ci-install-check.ts <tarball>

Installs the tarball with npm into a temporary folder, runs its eidolon on a temporary HOME and
data home, and deletes them. Exits 0 when every check passes, else 1.`;

const BOOT_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;
const TAIL_LINES = 40;

class CheckFailed extends Error {}

/** Prints the check, and throws when it failed. */
function check(name: string, pass: boolean, detail: string): asserts pass {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!pass) throw new CheckFailed(name);
}

function versionOf(tool: string): string {
  return spawnSync(tool, ["--version"], { encoding: "utf8" }).stdout.trim();
}

/** `npm install --prefix`, which runs the dependencies' install scripts; returns the bin it links. */
function install(tarball: string, prefix: string): string {
  mkdirSync(prefix, { recursive: true });
  const npm = spawnSync(
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
  return join(prefix, "node_modules", ".bin", "eidolon");
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

/** Stops what still runs: SIGTERM to the launcher's process group, then SIGKILL. */
async function stopAll(child: Subprocess): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is gone.
    }
    await exitWithin(child, STOP_TIMEOUT_MS);
  }
}

/** Starts `eidolon --no-open --port 0` and waits for the link it prints. */
async function boot(bin: string, env: Record<string, string>, cwd: string): Promise<App> {
  const child = spawnProcess([bin, "--no-open", "--port", "0"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
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

/** Every check on the package at `tarball`, installed and run inside `temp`. */
async function checkPackage(tarball: string, temp: string): Promise<void> {
  const prefix = join(temp, "prefix");
  const bin = install(tarball, prefix);
  const manifest = join(prefix, "node_modules", "@laplace.live", "eidolon", "package.json");
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  const home = join(temp, "home");
  mkdirSync(home, { recursive: true });
  // A first run's environment: this PATH, and nothing of this computer's Eidolon.
  const env = { PATH: process.env.PATH ?? "", HOME: home, EIDOLON_HOME: join(temp, "data") };
  const app = await boot(bin, env, temp);
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
    const help = await run([bin, "search", "--help"], env, temp);
    check(
      "search --help",
      help.code === 0 && help.stdout.startsWith("usage: "),
      `exit ${help.code}${help.code === 0 ? "" : `: ${help.stderr.trim()}`}`,
    );
    // As a task's command runs it: a shell finding it first on a PATH of the system's folders
    // otherwise, with no EIDOLON_HOME.
    const commands = join(env.EIDOLON_HOME, "bin");
    const tasks = await run(
      ["/bin/sh", "-c", "eidolon discover --help"],
      { PATH: `${commands}:/usr/bin:/bin`, HOME: home },
      temp,
    );
    check(
      "tasks' eidolon",
      tasks.code === 0 && tasks.stdout.startsWith("usage: "),
      `eidolon discover --help with ${commands} first on PATH: exit ${tasks.code}` +
        `${tasks.code === 0 ? "" : `: ${tasks.stderr.trim()}`}`,
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
    app.process.kill("SIGTERM");
    const code = await exitWithin(app.process, STOP_TIMEOUT_MS);
    const answers = await fetch(`${app.origin}/`).then(
      () => true,
      () => false,
    );
    check(
      "SIGTERM",
      code === 0 && !answers,
      `the launcher exited ${code ?? `not within ${STOP_TIMEOUT_MS / 1000} s`}; the port ` +
        `${answers ? "still answers" : "is closed"}`,
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
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main();
