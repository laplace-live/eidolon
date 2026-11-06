// Installs a packed @laplace.live/eidolon with npm, install scripts and all, as npx would, then runs
// it on a new HOME and data home: its link, a sign-in with the link's code, the status with the
// cookie and the proof, a CLI command's help, and a clean exit on SIGTERM. CI runs it on linux-x64.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import {
  type ErrorBody,
  PROOF_HEADER,
  type SessionGrant,
  type Status,
} from "../../bot/src/local/api.ts";

const USAGE = `usage: bun apps/eidolon/scripts/ci-install-check.ts <tarball> [--prefix DIR]

Installs the tarball with npm into DIR, else into a temporary folder, runs its eidolon on a
temporary HOME and data home, and deletes them. Exits 0 when every check passes, else 1.`;

const BOOT_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;

export class CheckFailed extends Error {}

/** Prints the check, and throws when it failed. */
export function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!pass) throw new CheckFailed(name);
}

function versionOf(tool: string): string {
  return Bun.spawnSync([tool, "--version"]).stdout.toString().trim();
}

/** `npm install --prefix`, which runs the dependencies' install scripts; returns the bin it links. */
export function install(tarball: string, prefix: string): string {
  mkdirSync(prefix, { recursive: true });
  const npm = Bun.spawnSync(
    ["npm", "install", "--prefix", prefix, "--no-audit", "--no-fund", resolve(tarball)],
    { cwd: prefix, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  check(
    "install",
    npm.exitCode === 0,
    `npm ${versionOf("npm")} on Node ${versionOf("node")}, ${process.platform}-${process.arch}: ` +
      `exit ${npm.exitCode}`,
  );
  return join(prefix, "node_modules", ".bin", "eidolon");
}

/** A first run's environment: this PATH, and nothing of this computer's Eidolon. */
export function firstRunEnv(home: string, dataHome: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: home, EIDOLON_HOME: dataHome };
}

/** What a stream has carried so far. */
class Collected {
  text = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.text += decoder.decode(chunk, { stream: true });
    })();
  }

  tail(lines = 40): string {
    return this.text.trimEnd().split("\n").slice(-lines).join("\n");
  }
}

export interface App {
  /** The launcher, which leads its own process group. */
  readonly process: Subprocess<"ignore", "pipe", "pipe">;
  readonly stdout: Collected;
  readonly stderr: Collected;
  readonly origin: string;
  /** The link's fragment, which POST session trades for the cookie and the proof. */
  readonly code: string;
}

/** The launcher's exit code, or null when it hasn't exited within `ms`. */
export function exitWithin(child: Subprocess, ms: number): Promise<number | null> {
  return Promise.race([child.exited, Bun.sleep(ms).then(() => null)]);
}

/** Runs a command to its end, keeping this process's event loop, and so the app's pipes, going. */
export async function run(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Stops what still runs: SIGTERM to the launcher's process group, then SIGKILL. */
export async function stopAll(child: Subprocess): Promise<void> {
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
export async function boot(bin: string, env: Record<string, string>, cwd: string): Promise<App> {
  const child = Bun.spawn([bin, "--no-open", "--port", "0"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stdout = new Collected(child.stdout);
  const stderr = new Collected(child.stderr);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const link = /^Eidolon is ready: (\S+)$/m.exec(stdout.text)?.[1];
    if (link !== undefined) {
      const url = new URL(link);
      check("link", true, url.origin);
      return { process: child, stdout, stderr, origin: url.origin, code: url.hash.slice(1) };
    }
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      await stopAll(child);
      const why =
        Date.now() > deadline ? "timed out" : `exited ${child.exitCode ?? child.signalCode}`;
      check("link", false, `${why} without one:\n${stdout.tail()}\n${stderr.tail()}`);
    }
    await Bun.sleep(100);
  }
}

/** The headers the app's pages send: the cookie and the proof POST session traded the code for. */
export async function signIn(origin: string, code: string): Promise<Record<string, string>> {
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
  return { Cookie: cookie as string, [PROOF_HEADER]: proof as string, Origin: origin };
}

/** Every check on the package at `tarball`, installed into `prefix`; `temp` holds its homes. */
export async function checkPackage(tarball: string, prefix: string, temp: string): Promise<void> {
  const bin = install(tarball, prefix);
  const manifest = join(prefix, "node_modules", "@laplace.live", "eidolon", "package.json");
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  const home = join(temp, "home");
  mkdirSync(home, { recursive: true });
  const env = firstRunEnv(home, join(temp, "data"));
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
      headers: { Cookie: session.Cookie as string },
    });
    const refusal = ((await alone.json().catch(() => ({}))) as Partial<ErrorBody>).error?.code;
    check(
      "proof",
      alone.status === 401 && refusal === "proof-missing",
      `the cookie alone: ${alone.status} ${refusal ?? ""}`,
    );
    const help = await run([bin, "search", "--help"], env, temp);
    check(
      "search --help",
      help.code === 0 && help.stdout.startsWith("usage: "),
      `exit ${help.code}${help.code === 0 ? "" : `: ${help.stderr.trim()}`}`,
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
    console.log(`The app's stdout:\n${app.stdout.tail()}\nIts stderr:\n${app.stderr.tail()}`);
    throw error;
  } finally {
    await stopAll(app.process);
  }
}

function options(argv: string[]): { tarball: string; prefix: string | undefined } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { prefix: { type: "string" } },
      allowPositionals: true,
    });
    const [tarball] = positionals;
    if (tarball !== undefined && positionals.length === 1)
      return { tarball, prefix: values.prefix };
  } catch (error) {
    console.error((error as Error).message);
  }
  console.error(USAGE);
  process.exit(2);
}

if (import.meta.main) {
  const { tarball, prefix } = options(Bun.argv.slice(2));
  const temp = mkdtempSync(join(tmpdir(), "eidolon-install-check-"));
  try {
    await checkPackage(resolve(tarball), resolve(prefix ?? join(temp, "prefix")), temp);
    console.log("Every check passed.");
  } catch (error) {
    if (!(error instanceof CheckFailed)) console.log(`FAIL: ${(error as Error).stack}`);
    process.exitCode = 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
