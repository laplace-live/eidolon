// `node apps/desktop/scripts/system-ca.ts`, on a CI runner after `bun run package:desktop`: proves
// that the packaged binary in node mode reaches an https host whose CA only the OS trust store holds
// with --use-system-ca, and not without it, in the backend and in a job the backend runs. Node mode
// drops NODE_EXTRA_CA_CERTS, so that store is how a corporate CA reaches the desktop's backend.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  FactFile,
  FactsResponse,
  JobSnapshot,
  ModelsResponse,
  PersonasResponse,
} from "../../bot/src/local/api.ts";
import type { ListeningMessage } from "../../bot/src/local/supervisor.ts";
import { BACKEND_RUNTIME_ARGS } from "../src/main/controller.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const DESKTOP = join(ROOT, "apps", "desktop");
const WITHOUT = BACKEND_RUNTIME_ARGS.filter((flag) => flag !== "--use-system-ca");
const MODELS = "GET /api/v1/models";
const EMBEDDINGS = "POST /api/v1/embeddings";
/** The one model the host lists. */
const MODEL = "eidolon-ci/system-ca";
const FACTS = "The system CA check wrote this first fact.\nIt wrote this second fact too.\n";
const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

export interface PackagedApp {
  /** The fused binary main runs the backend and its jobs on, in node mode. */
  readonly binary: string;
  /** The backend: EIDOLON_APP_ROOT, holding dist/server.js and dist/cli.js. */
  readonly payload: string;
}

/** The app electron-builder leaves unpacked in apps/desktop/.out for this machine. */
function packagedApp(): PackagedApp {
  const target = `${process.platform}-${process.arch}`;
  if (target === "darwin-arm64") {
    const contents = join(DESKTOP, ".out", "mac-arm64", "Eidolon.app", "Contents");
    return {
      binary: join(contents, "MacOS", "Eidolon"),
      payload: join(contents, "Resources", "eidolon"),
    };
  }
  if (target === "win32-x64") {
    const app = join(DESKTOP, ".out", "win-unpacked");
    return { binary: join(app, "Eidolon.exe"), payload: join(app, "resources", "eidolon") };
  }
  throw new Error(`The desktop app ships for darwin-arm64 and win32-x64, not ${target}`);
}

export interface Certs {
  /** The CA, as macOS's `security` takes it. */
  readonly caPem: string;
  /** The same in DER, as Windows' `certutil` takes it. */
  readonly caDer: string;
  /** Its SHA-1, by which either store removes it. */
  readonly thumbprint: string;
  /** The host's key and certificate, for 127.0.0.1. */
  readonly key: string;
  readonly cert: string;
}

const OPENSSL_CONFIG = `[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[host]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`;

function openssl(args: readonly string[], cwd: string): void {
  const run = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`openssl ${args.join(" ")} failed:\n${run.stderr}`);
}

/** In `dir`: a throwaway CA, valid for two days under a name of its own, and a cert for 127.0.0.1. */
export function makeCerts(dir: string): Certs {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "openssl.cnf"), OPENSSL_CONFIG);
  const key = ["-config", "openssl.cnf", "-newkey", "rsa:2048", "-nodes", "-sha256"];
  const name = `/CN=Eidolon CI ${randomBytes(6).toString("hex")}`;
  openssl(
    [
      "req",
      "-x509",
      ...key,
      "-extensions",
      "ca",
      "-days",
      "2",
      "-subj",
      name,
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    ],
    dir,
  );
  openssl(
    ["req", "-new", ...key, "-subj", "/CN=127.0.0.1", "-keyout", "host.key", "-out", "host.csr"],
    dir,
  );
  openssl(
    [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "2",
      "-in",
      "host.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-set_serial",
      `0x${randomBytes(8).toString("hex")}`,
      "-extfile",
      "openssl.cnf",
      "-extensions",
      "host",
      "-out",
      "host.pem",
    ],
    dir,
  );
  const ca = new X509Certificate(readFileSync(join(dir, "ca.pem")));
  writeFileSync(join(dir, "ca.cer"), ca.raw);
  return {
    caPem: join(dir, "ca.pem"),
    caDer: join(dir, "ca.cer"),
    thumbprint: ca.fingerprint.replaceAll(":", ""),
    key: readFileSync(join(dir, "host.key"), "utf8"),
    cert: readFileSync(join(dir, "host.pem"), "utf8"),
  };
}

export interface Host {
  /** Where OpenRouter's API is, for OPENROUTER_API_BASE: https://127.0.0.1:<port>/api/v1. */
  readonly base: string;
  /**
   * What reached it, in order: a route, such as MODELS, or `refused: <why>` for a handshake the
   * client ended.
   */
  readonly seen: string[];
  close(): Promise<void>;
}

/** OpenRouter's model list and embeddings on 127.0.0.1, over https with `certs`' host cert. */
export async function startHost(certs: Certs): Promise<Host> {
  const seen: string[] = [];
  const server = createServer({ key: certs.key, cert: certs.cert }, (request, response) => {
    const route = `${request.method} ${(request.url ?? "/").split("?")[0]}`;
    seen.push(route);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      let status = 404;
      let answer: unknown = { error: { message: `${route} isn't served here` } };
      if (route === MODELS) {
        status = 200;
        answer = { data: [{ id: MODEL }] };
      } else if (route === EMBEDDINGS) {
        const { input, dimensions } = JSON.parse(body) as { input: unknown; dimensions?: number };
        const size = dimensions ?? 8;
        status = 200;
        answer = {
          object: "list",
          data: (Array.isArray(input) ? input : [input]).map((_, index) => ({
            object: "embedding",
            index,
            embedding: Array.from({ length: size }, (_, at) => (at === index % size ? 1 : 0)),
          })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        };
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  server.on("tlsClientError", (error) => seen.push(`refused: ${error.message}`));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    base: `https://127.0.0.1:${port}/api/v1`,
    seen,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function refused(seen: readonly string[]): boolean {
  return seen.some((entry) => entry.startsWith("refused"));
}

/**
 * Runs a command to its end, or kills it after `ms`, keeping what it wrote. Never spawnSync while
 * the host serves: this process's event loop answers the command's handshakes.
 */
export function run(
  command: string,
  args: readonly string[],
  { env = process.env, ms }: { env?: NodeJS.ProcessEnv; ms: number },
): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      output += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      output += text;
    });
    const timer = setTimeout(() => child.kill(), ms);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

/** The environment main gives the backend, with OpenRouter, which lists and embeds, at `base`. */
export function backendEnv(payload: string, home: string, base: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    ...process.env,
    EIDOLON_APP_ROOT: payload,
    EIDOLON_NO_DOTENV: "1",
    ELECTRON_RUN_AS_NODE: "1",
    EIDOLON_HOME: home,
    EMBED_PROVIDER: "openrouter",
    OPENROUTER_API_BASE: base,
    OPENROUTER_API_KEY: "eidolon-ci",
  };
}

export interface Backend {
  readonly port: number;
  readonly token: string;
  /** The end of what it wrote to stderr. */
  stderr(): string;
  stop(): Promise<void>;
}

/** Whether `promise` settles within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  const settled = await Promise.race([promise.then(() => true), late]);
  clearTimeout(timer);
  return settled;
}

/** The payload's server on `binary`, as main starts it but on port 0, once it listens. */
export async function startBackend(
  { binary, payload }: PackagedApp,
  flags: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Backend> {
  const script = join(payload, "dist", "server.js");
  const child = spawn(
    binary,
    [...flags, script, "--host", "127.0.0.1", "--port", "0", "--no-open"],
    {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  // Its two ready lines carry the sign-in link's code: read, never shown.
  child.stdout?.resume();
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (text: string) => {
    stderr = (stderr + text).slice(-8000);
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // The server's stop trigger, as main's.
    if (child.connected) child.disconnect();
    if (await within(exited, 10_000)) return;
    child.kill();
    await within(exited, 5_000);
  };
  try {
    const port = await new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("it didn't listen within 60 s")), 60_000);
      child.on("message", (message: unknown) => {
        const said = message as Partial<ListeningMessage> | null;
        if (said?.kind === "listening" && typeof said.port === "number") {
          clearTimeout(timer);
          done(said.port);
        }
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        fail(new Error(`it exited (${code ?? signal}) before it listened`));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });
    const token = readFileSync(join(env.EIDOLON_HOME as string, "local-token"), "utf8").trim();
    return { port, token, stderr: () => stderr, stop };
  } catch (error) {
    await stop();
    throw new Error(`The server on ${binary} didn't start: ${(error as Error).message}\n${stderr}`);
  }
}

/** `path` of `backend`'s API, with the Bearer as main sends it, and its JSON answer. */
export async function api<T>(
  backend: Backend,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${backend.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${backend.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** OpenRouter's models as `backend` lists them, which it fetches from the host itself. */
export async function listModels(
  backend: Backend,
  host: Host,
): Promise<{ listing: ModelsResponse; seen: string[] }> {
  const from = host.seen.length;
  const { body } = await api<ModelsResponse>(
    backend,
    "GET",
    "/api/local/accounts/openrouter/models?category=llm",
  );
  return { listing: body, seen: host.seen.slice(from) };
}

/**
 * Writes two facts for `backend`'s active persona, in a file her fact patterns pick, and returns
 * her id.
 */
export async function writeFacts(backend: Backend): Promise<string> {
  const { body: personas } = await api<PersonasResponse>(backend, "GET", "/api/local/personas");
  const persona = personas.active;
  const facts = `/api/local/personas/${persona}/facts`;
  const { body: listing } = await api<FactsResponse>(backend, "GET", facts);
  const name = listing.patterns[0]?.replace("*", "system-ca") ?? "system-ca.txt";
  const put = await api<FactFile>(backend, "PUT", `${facts}/${encodeURIComponent(name)}`, {
    text: FACTS,
  });
  if (put.status !== 200 || !put.body.matched) {
    throw new Error(
      `${persona}'s facts take no ${name}: ${put.status} ${JSON.stringify(put.body)}`,
    );
  }
  return persona;
}

/** The payload's `ingest-facts` run straight on the binary, with no embedding cache. */
export async function ingestDirectly(
  { binary, payload }: PackagedApp,
  flags: readonly string[],
  env: NodeJS.ProcessEnv,
  persona: string,
  host: Host,
): Promise<{ code: number | null; output: string; seen: string[] }> {
  const from = host.seen.length;
  const cli = join(payload, "dist", "cli.js");
  const ran = await run(
    binary,
    [...flags, cli, "ingest-facts", "--persona", persona, "--no-cache"],
    { env, ms: 180_000 },
  );
  return { ...ran, seen: host.seen.slice(from) };
}

/** `ingest-facts` as a job of `backend`, which its jobs runner starts with jsRuntime()'s flags. */
export async function ingestAsJob(
  backend: Backend,
  persona: string,
  host: Host,
): Promise<{ job: JobSnapshot; seen: string[] }> {
  const from = host.seen.length;
  let { body: job } = await api<JobSnapshot>(backend, "POST", "/api/local/jobs", {
    command: "ingest-facts",
    persona,
  });
  const deadline = Date.now() + 180_000;
  while (job.status === "running" && Date.now() < deadline) {
    await sleep(500);
    ({ body: job } = await api<JobSnapshot>(backend, "GET", `/api/local/jobs/${job.id}`));
  }
  return { job, seen: host.seen.slice(from) };
}

interface Check {
  readonly passed: boolean;
  readonly name: string;
  /** Shown when it fails. */
  readonly detail: string;
}

/** The backend and a job on `app`, with and without --use-system-ca, against `host`. */
async function prove(app: PackagedApp, host: Host, work: string, checks: Check[]): Promise<void> {
  const env = backendEnv(app.payload, join(work, "home"), host.base);
  const without = await startBackend(app, WITHOUT, env);
  try {
    const { listing, seen } = await listModels(without, host);
    checks.push({
      passed: listing.status === "failed" && refused(seen) && !seen.includes(MODELS),
      name: "the backend without --use-system-ca can't list the host's models",
      detail: JSON.stringify({ listing, seen }),
    });
    const persona = await writeFacts(without);
    const direct = await ingestDirectly(app, WITHOUT, env, persona, host);
    checks.push({
      passed:
        direct.code !== 0 &&
        /Connection error/.test(direct.output) &&
        refused(direct.seen) &&
        !direct.seen.includes(EMBEDDINGS),
      name: "ingest-facts without --use-system-ca can't embed through the host",
      detail: `exit ${direct.code}, ${JSON.stringify(direct.seen)}\n${direct.output.slice(-3000)}`,
    });
    // The backend itself has no --use-system-ca here: the job's comes from jsRuntime().args.
    const { job, seen: jobSeen } = await ingestAsJob(without, persona, host);
    checks.push({
      passed: job.status === "succeeded" && jobSeen.includes(EMBEDDINGS),
      name: "ingest-facts as the backend's job embeds through the host, with jsRuntime()'s flags",
      detail: `${JSON.stringify(jobSeen)}\n${job.stderrTail || JSON.stringify(job)}`,
    });
  } finally {
    await without.stop();
  }
  const main = await startBackend(app, BACKEND_RUNTIME_ARGS, env);
  try {
    const { listing, seen } = await listModels(main, host);
    checks.push({
      passed: listing.status === "ok" && listing.models.some((model) => model.id === MODEL),
      name: `the backend with main's flags (${BACKEND_RUNTIME_ARGS.join(" ")}) lists the host's models`,
      detail: `${JSON.stringify({ listing, seen })}\n${main.stderr()}`,
    });
  } finally {
    await main.stop();
  }
}

const STORE = process.platform === "darwin" ? "the System keychain" : "LocalMachine's Root store";

/** Runs a trust store command, its output shown: undefined once it succeeded, else why not. */
function onStore([command, ...args]: readonly string[]): string | undefined {
  const ran = spawnSync(command as string, args, { stdio: "inherit", timeout: 60_000 });
  if (ran.status === 0) return undefined;
  return ran.error?.message ?? `exit ${ran.status ?? ran.signal}`;
}

/**
 * Puts the CA in the machine's trust store: the admin domain on macOS and LocalMachine's Root on
 * Windows, which a runner can write without anyone answering a prompt, as the user's can't be.
 */
function trust(certs: Certs): void {
  const failed = onStore(
    process.platform === "darwin"
      ? [
          "sudo",
          "-n",
          "security",
          "add-trusted-cert",
          "-d",
          "-r",
          "trustRoot",
          "-k",
          SYSTEM_KEYCHAIN,
          certs.caPem,
        ]
      : ["certutil", "-addstore", "-f", "Root", certs.caDer],
  );
  if (failed !== undefined) throw new Error(`Couldn't add the CA to ${STORE}: ${failed}`);
}

/**
 * Deletes the CA, which ends its trust, since the host sends only its own cert. macOS keeps the
 * admin trust entry, orphaned: removing one (`remove-trusted-cert -d`) waits on an authorization
 * dialog no hosted runner can answer (https://github.com/taucad/tau/pull/1300).
 */
function distrust(certs: Certs): void {
  const failed = onStore(
    process.platform === "darwin"
      ? ["sudo", "-n", "security", "delete-certificate", "-Z", certs.thumbprint, SYSTEM_KEYCHAIN]
      : ["certutil", "-delstore", "Root", certs.thumbprint],
  );
  const kept = process.platform === "darwin" ? "; its admin trust entry stays, orphaned" : "";
  console.log(
    failed === undefined
      ? `system-ca: deleted the CA from ${STORE}${kept}`
      : `system-ca: couldn't delete the CA from ${STORE} (${failed}); it stays there`,
  );
}

if (import.meta.main) {
  if (process.env.CI !== "true") {
    console.error(
      "system-ca.ts adds a throwaway CA to this machine's trust store, so it runs only on a CI " +
        "runner, where CI=true",
    );
    process.exit(2);
  }
  const app = packagedApp();
  if (!existsSync(app.binary) || !existsSync(join(app.payload, "dist", "server.js"))) {
    console.error(
      `system-ca: no packaged app at ${relative(ROOT, app.binary)}: run bun run build:desktop, ` +
        "then bun run package:desktop",
    );
    process.exit(2);
  }
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "eidolon-system-ca-"));
  const checks: Check[] = [];
  let certs: Certs | undefined;
  let host: Host | undefined;
  let trusted = false;
  try {
    certs = makeCerts(join(work, "certs"));
    host = await startHost(certs);
    trust(certs);
    trusted = true;
    const control = await run(
      process.execPath,
      [
        "--use-system-ca",
        "-e",
        `fetch(${JSON.stringify(`${host.base}/models`)}).then((r) => process.exit(r.ok ? 0 : 1), ` +
          "(e) => { console.error(String(e?.cause ?? e)); process.exit(1); });",
      ],
      { ms: 30_000 },
    );
    checks.push({
      passed: control.code === 0,
      name: `Node ${process.version} with --use-system-ca reaches the host: the OS store holds its CA`,
      detail: control.output,
    });
    if (control.code === 0) await prove(app, host, work, checks);
  } catch (error) {
    checks.push({
      passed: false,
      name: "the run itself",
      detail: (error as Error).stack ?? String(error),
    });
  } finally {
    if (trusted && certs !== undefined) distrust(certs);
    await host?.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(`--use-system-ca on ${relative(ROOT, app.binary)}, in node mode:`);
  for (const check of checks) {
    console.log(`  ${check.passed ? "ok  " : "FAIL"}  ${check.name}`);
    if (!check.passed) console.log(check.detail.replace(/^/gm, "          "));
  }
  process.exit(checks.every((check) => check.passed) ? 0 : 1);
}
