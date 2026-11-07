// A browser walk through the local web app on a throwaway data home: sign-in, the wizard's keys step
// in English and 简体中文, saved keys, a saved prompt, and a facts index built through the studio.
// The keys are fake, so the providers refuse them for free, and the embeddings come from a fake
// server, so nothing is billed. --call instead places a real call from the call page with the
// .env's keys, which bills them.
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CREDENTIALS, dataHome, envOptional, expandUser, SETTINGS } from "@eidolon/config";
import type { Subprocess } from "bun";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright-core";
import type { JobSnapshot, Status } from "../src/local/api.ts";
import { Output, READY_LINE } from "./output.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_ENTRY = join(ROOT, "apps/bot/src/local/server.ts");
const SERVER_LOAD_ENV = "apps/bot/src/load-env.ts";
/** The server's and the job CLI's: each walks up to a .env and applies it over the environment. */
const LOAD_ENVS = [SERVER_LOAD_ENV, "apps/cli/src/load-env.ts"];
const PROBE_FLAG = "--probe-env";
const PERSONA = "milky-green";
// Named to match milky-green's knowledge.facts.files, or the ingest would leave it out.
const FACT_FILE = "local-smoke设定集.txt";
const FACT_LINES = [
  "2024-05-01 明前奶绿说她最喜欢的饮料是冰美式。",
  "明前奶绿的猫叫坚果，是拉普拉斯花店的店长。",
];
const JOB_TIMEOUT_MS = 120_000;

const QUESTION = "你还记得你的猫叫什么吗？";
const SELFIE_REQUEST = "给我发张自拍吧";
const CONNECT_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 60_000;
const SELFIE_TIMEOUT_MS = 90_000;
// Quiet time after the bot's last speaking, LLM or text event before its turn counts as over.
const SETTLE_MS = 2000;
const SAMPLE_MS = 100;
const FLOOR_DB = -120;
// As e2e-call.ts counts the bot as audible.
const AUDIBLE_DB = -50;
const MIN_SAMPLES = 3;

const USAGE = `usage: bun apps/bot/scripts/local-smoke.ts [--headful] [--offline]
       bun apps/bot/scripts/local-smoke.ts --call [--selfie]

Boots the local web app on a temporary data home, walks it in Chrome, then deletes the home. Exits
0 when every check passes, 1 when one fails.

Without --call it runs without the .env or any provider key, so nothing is billed:
  --headful   show the browser (headless Chrome is killed on some Macs)
  --offline   skip the wizard's key checks, which send fake keys to Soniox, OpenRouter and Fish

  --call      call the active persona from the call page with the real keys in the .env, which
              bills them: the greeting, a typed question and its reply, then hang up. The browser
              always shows, with a fake microphone
  --selfie    with --call, also ask for a selfie, billed per image

EIDOLON_CHROME names the browser to drive; without it, Google Chrome in /Applications on macOS,
and elsewhere the Chrome Playwright finds.`;

/** EIDOLON_CHROME, else Google Chrome where macOS installs it, else the Chrome Playwright finds. */
function chrome(): { readonly executablePath: string } | { readonly channel: "chrome" } {
  const path = envOptional("EIDOLON_CHROME");
  if (path !== undefined) return { executablePath: path };
  return process.platform === "darwin" ? { executablePath: MAC_CHROME } : { channel: "chrome" };
}

class UsageError extends Error {}

interface Options {
  readonly headful: boolean;
  readonly offline: boolean;
  readonly call: boolean;
  readonly selfie: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let headful = false;
  let offline = false;
  let call = false;
  let selfie = false;
  for (const arg of argv) {
    if (arg === "--headful") headful = true;
    else if (arg === "--offline") offline = true;
    else if (arg === "--call") call = true;
    else if (arg === "--selfie") selfie = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (selfie && !call) throw new UsageError("--selfie needs --call");
  if (offline && call) throw new UsageError("--offline and --call can't be combined");
  return { headful: headful || call, offline, call, selfie };
}

type Lang = "en" | "zh-CN";

/** The web app's strings, keyed `<feature>.<key>` as its i18n loader merges them. */
function loadStrings(lang: Lang): ReadonlyMap<string, string> {
  const dir = join(ROOT, "apps/web/src/locales", lang);
  const strings = new Map<string, string>();
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    const feature = name.slice(0, -".json".length);
    const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, string>;
    for (const [key, text] of Object.entries(file)) strings.set(`${feature}.${key}`, text);
  }
  return strings;
}

const STRINGS: Readonly<Record<Lang, ReadonlyMap<string, string>>> = {
  en: loadStrings("en"),
  "zh-CN": loadStrings("zh-CN"),
};

/** A string with its `{name}` placeholders filled, as the app's i18n fills them. */
function t(lang: Lang, key: string, vars: Readonly<Record<string, string>> = {}): string {
  const text = STRINGS[lang].get(key);
  if (text === undefined) throw new Error(`no ${lang} string ${key}`);
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** What a check of a refused key shows: the provider's own string, else the shared one. */
function refusedVerdict(lang: Lang, provider: string): string {
  const own = `settings.check.${provider}.invalid-key`;
  return STRINGS[lang].has(own) ? t(lang, own) : t(lang, "settings.check.invalid-key");
}

const REQUIRED: readonly (readonly [key: string, provider: string])[] = [
  ["SONIOX_API_KEY", "soniox"],
  ["OPENROUTER_API_KEY", "openrouter"],
  ["FISH_API_KEY", "fish"],
];

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

class Checks {
  readonly list: Check[] = [];
  /** Lines printed after the list. */
  readonly notes: string[] = [];

  add(name: string, pass: boolean, detail: string): void {
    this.list.push({ name, pass, detail });
  }

  /** Runs `body`, which adds its own checks; a throw fails `name` with the error's first line. */
  async step(name: string, body: () => Promise<void>): Promise<boolean> {
    try {
      await body();
      return true;
    } catch (error) {
      this.add(name, false, error instanceof Error ? error.message.split("\n")[0] : String(error));
      return false;
    }
  }

  get pass(): boolean {
    return this.list.every((check) => check.pass);
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function modeOf(path: string): string {
  return existsSync(path) ? `0${mode(path).toString(8)}` : "missing";
}

/** One digest over every file's path and bytes. */
function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
  for (const path of files) hash.update(`${relative(dir, path)}\0`).update(readFileSync(path));
  return hash.digest("hex");
}

/** A unit vector derived from the text, so equal texts embed equally. */
function fakeVector(text: string, dimensions: number): number[] {
  const seed = createHash("sha256").update(text).digest();
  const vector = Array.from({ length: dimensions }, (_, i) =>
    Math.sin((seed[i % 32] + 1) * (i + 1)),
  );
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

/** An OpenAI-compatible embeddings endpoint that answers the fake key only. */
function fakeEmbeddings(key: string) {
  const seen = { requests: 0, inputs: 0, refused: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/embeddings") {
        return new Response(null, { status: 404 });
      }
      if (request.headers.get("authorization") !== `Bearer ${key}`) {
        seen.refused++;
        return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
      }
      const body = (await request.json()) as { input?: unknown; dimensions?: unknown };
      const inputs = (Array.isArray(body.input) ? body.input : [body.input]).map(String);
      const dimensions = typeof body.dimensions === "number" ? body.dimensions : 3072;
      seen.requests++;
      seen.inputs += inputs.length;
      return Response.json({
        object: "list",
        model: "fake",
        data: inputs.map((text, index) => ({
          object: "embedding",
          index,
          embedding: fakeVector(text, dimensions),
        })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

type FakeEmbeddings = ReturnType<typeof fakeEmbeddings>;

/**
 * The server's environment, which its jobs inherit: this shell's, without anything a setting, a
 * credential or EIDOLON_* reads, plus the temporary data home and, unless `dotenv`, the .env
 * opt-out.
 */
function childEnv(home: string, dotenv = false): Record<string, string> {
  const dropped = new Set<string>([...CREDENTIALS, ...SETTINGS.map((row) => row.env)]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !dropped.has(name) && !name.startsWith("EIDOLON_")) {
      env[name] = value;
    }
  }
  return dotenv
    ? { ...env, EIDOLON_HOME: home }
    : { ...env, EIDOLON_NO_DOTENV: "1", EIDOLON_HOME: home };
}

/** What one load-env.ts did, as the probe reports it. */
interface EnvReport {
  readonly home: string;
  /** How many variables it set or changed. */
  readonly changed: number;
  /** MEM0_HISTORY_DB_PATH, resolved: the one file a call writes outside the data home's defaults. */
  readonly historyDb: string | null;
}

/** Run as a child: imports one load-env.ts and reports what it did. */
async function probeEnv(path: string): Promise<void> {
  const before = { ...process.env };
  await import(path);
  const names = new Set([...Object.keys(before), ...Object.keys(process.env)]);
  const changed = [...names].filter((name) => before[name] !== process.env[name]).length;
  const historyDb = envOptional("MEM0_HISTORY_DB_PATH");
  const report: EnvReport = {
    home: dataHome(),
    changed,
    historyDb: historyDb === undefined ? null : resolve(expandUser(historyDb)),
  };
  process.stdout.write(JSON.stringify(report));
}

/** What `rel` does when run with `env`; a string says why it couldn't be probed. */
async function probeLoadEnv(rel: string, env: Record<string, string>): Promise<EnvReport | string> {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", import.meta.path, PROBE_FLAG, join(ROOT, rel)],
    { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    return JSON.parse(out) as EnvReport;
  } catch {
    return `${rel} could not be probed (exit ${code}): ${err.trim().split("\n").at(-1) ?? ""}`;
  }
}

/**
 * Null when both load-env.ts files, run with `env`, apply no .env and use `home`; else why not.
 * Only a count of variables is shown: a .env holds real keys.
 */
async function isolationProblem(env: Record<string, string>, home: string): Promise<string | null> {
  for (const rel of LOAD_ENVS) {
    const report = await probeLoadEnv(rel, env);
    if (typeof report === "string") return report;
    if (report.changed !== 0) {
      return `${rel} applied a .env (${report.changed} variables) under EIDOLON_NO_DOTENV=1`;
    }
    if (resolve(report.home) !== resolve(home)) {
      return `${rel} would use ${report.home} as the data home, not the temporary one`;
    }
  }
  return null;
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Null when the server, with the .env applied, writes nothing outside `home`; else why not. It
 * names variables, never their values.
 */
async function callIsolationProblem(
  env: Record<string, string>,
  home: string,
): Promise<string | null> {
  const report = await probeLoadEnv(SERVER_LOAD_ENV, env);
  if (typeof report === "string") return report;
  if (report.changed === 0) {
    return `${SERVER_LOAD_ENV} found no .env to apply, so the call would have no keys`;
  }
  if (resolve(report.home) !== resolve(home)) {
    return "the .env sets EIDOLON_HOME, which would replace the temporary data home";
  }
  if (report.historyDb !== null && !isInside(home, report.historyDb)) {
    return "the .env puts MEM0_HISTORY_DB_PATH outside the temporary data home";
  }
  return null;
}

async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(500);
  }
}

async function shows(locator: Locator, timeout?: number): Promise<boolean> {
  return locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);
}

async function visibleText(locator: Locator): Promise<string> {
  return (await locator.allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").trim();
}

function isPut(
  url: string,
): (response: { url(): string; request(): { method(): string } }) => boolean {
  return (response) => response.request().method() === "PUT" && response.url() === url;
}

/** The server under test, signed in to with the token its data home holds. */
interface Server {
  readonly link: string;
  readonly origin: string;
  readonly secret: string;
  readonly stdout: Output;
  readonly stderr: Output;
}

/** One run's temporary folder, server and browser, released once however the run ends. */
class Run {
  readonly temp = mkdtempSync(join(tmpdir(), "eidolon-local-smoke-"));
  readonly home = join(this.temp, "home");
  browser: Browser | null = null;
  #server: Subprocess | null = null;
  readonly #cleanups: (() => void)[] = [];
  readonly #interrupt = (): void => {
    void this.stop().finally(() => {
      this.#release();
      process.exit(130);
    });
  };

  constructor() {
    process.once("SIGINT", this.#interrupt);
  }

  /** Runs `cleanup` once the run ends, Ctrl-C included. */
  defer(cleanup: () => void): void {
    this.#cleanups.push(cleanup);
  }

  /** Starts the server with `env`, adding the boot check; null when it printed no link. */
  async boot(env: Record<string, string>, checks: Checks): Promise<Server | null> {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", SERVER_ENTRY, "--port", "0", "--no-open"],
      { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    this.#server = child;
    const stdout = new Output(child.stdout);
    const stderr = new Output(child.stderr);
    let link: string;
    try {
      link = await stdout.waitFor(READY_LINE, child.exited, 60_000);
    } catch {
      checks.add("boot", false, `no link printed:\n${stderr.tail()}`);
      return null;
    }
    const token = join(this.home, "local-token");
    checks.add(
      "boot",
      modeOf(token) === "0600" && modeOf(this.home) === "0700",
      `link printed; the temporary home ${modeOf(this.home)}, its local-token ${modeOf(token)}`,
    );
    const secret = readFileSync(token, "utf8").trim();
    return { link, origin: new URL(link).origin, secret, stdout, stderr };
  }

  /** Closes the browser and stops the server: its exit code, or null if none ran or it hung. */
  async stop(): Promise<number | null> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    const child = this.#server;
    this.#server = null;
    if (child === null) return null;
    child.kill("SIGTERM");
    const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => null)]);
    if (code === null) child.kill("SIGKILL");
    return code;
  }

  /** Stops what still runs, then checks the templates and deletes the temporary folder. */
  async end(checks: Checks, templates: string): Promise<void> {
    await this.stop();
    process.off("SIGINT", this.#interrupt);
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    const unchanged = treeHash(join(ROOT, "personas")) === templates;
    checks.add("templates", unchanged, `personas/ ${unchanged ? "unchanged" : "CHANGED"}`);
    this.#release();
    checks.add(
      "cleanup",
      !existsSync(this.temp),
      `${this.temp} ${existsSync(this.temp) ? "remains" : "deleted"}`,
    );
  }

  #release(): void {
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    rmSync(this.temp, { recursive: true, force: true });
  }
}

/** Builds apps/web/dist when `always` or when it has no index.html; false after a failed build. */
async function buildWeb(checks: Checks, always: boolean): Promise<boolean> {
  if (!always && existsSync(join(ROOT, "apps/web/dist/index.html"))) return true;
  const build = Bun.spawn([process.execPath, "run", "build:web"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if ((await build.exited) === 0) return true;
  checks.add("build", false, "bun run build:web failed");
  return false;
}

/** Adds every CSP violation in `context`'s pages to `problems`. */
async function reportCsp(context: BrowserContext, problems: string[]): Promise<void> {
  await context.exposeFunction("smokeCspViolation", (text: string) => {
    problems.push(`CSP ${text}`);
  });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const page = window as unknown as { smokeCspViolation(text: string): void };
      page.smokeCspViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

interface Walk {
  readonly options: Options;
  readonly checks: Checks;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly origin: string;
  readonly link: string;
  readonly home: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly embeddings: FakeEmbeddings;
  /** A call with the Bearer token, as a CLI makes one; its answer joins the echo scan. */
  readonly api: (method: string, path: string, body?: string) => Promise<Response>;
}

/** The field a key's input sits in, with its Check button and its verdict. */
function keyField(page: Page, name: string): Locator {
  return page.locator('[data-slot="field"]').filter({ has: page.locator(`input[name="${name}"]`) });
}

async function signIn(walk: Walk): Promise<void> {
  const { page } = walk;
  await page.goto(walk.link);
  await page.getByText(t("en", "setup.keys.title"), { exact: true }).waitFor();
  const url = new URL(page.url());
  const port = new URL(walk.origin).port;
  const cookie = (await walk.context.cookies(walk.origin)).find(
    (entry) => entry.name === `eidolon_session_${port}`,
  );
  const code = new URL(walk.link).hash.slice(1);
  const secret = readFileSync(join(walk.home, "local-token"), "utf8").trim();
  const proofKey = `eidolon_proof_${port}`;
  const [stored, proof] = await page.evaluate(
    (key): [string, string | null] => [
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
      localStorage.getItem(key),
    ],
    proofKey,
  );
  const leaked = [code, secret, cookie?.value].some((value) => value && stored.includes(value));
  const monthAhead = Date.now() / 1000 + 29 * 86_400;
  walk.checks.add(
    "sign-in",
    url.hash === "" &&
      url.pathname === "/setup" &&
      cookie?.httpOnly === true &&
      cookie.sameSite === "Strict" &&
      cookie.expires > monthAhead &&
      cookie.value !== code &&
      cookie.value !== secret &&
      proof === createHmac("sha256", secret).update("proof").digest("base64url") &&
      !leaked,
    `landed on ${url.pathname}${url.hash || " without the fragment"}; cookie ` +
      (cookie ? `HttpOnly=${cookie.httpOnly} SameSite=${cookie.sameSite}` : "missing") +
      `; ${proof === null ? "no proof" : `a proof under ${proofKey}`}` +
      `; web storage ${leaked ? "holds a token" : "holds no other token"}`,
  );

  // What a service on another localhost port can replay: the cookie, with any Origin it likes.
  const status = `${walk.origin}/api/local/status`;
  const replayed: Record<string, string> = { Origin: walk.origin };
  if (cookie !== undefined) replayed.Cookie = `${cookie.name}=${cookie.value}`;
  const without = await fetch(status, { headers: replayed });
  const refusal = ((await without.json()) as { error?: { code?: string } }).error?.code;
  const both = await fetch(status, { headers: { ...replayed, "X-Eidolon-Proof": proof ?? "" } });
  walk.checks.add(
    "session proof",
    without.status === 401 && refusal === "proof-missing" && both.status === 200,
    `the cookie alone: ${without.status} ${refusal ?? ""}; with the page's proof: ${both.status}`,
  );
}

/** embeddings.baseUrl through the wizard's "use another provider" form, as a user would set it. */
async function saveEmbeddingsBase(walk: Walk): Promise<void> {
  const { page } = walk;
  await page.getByRole("button", { name: t("en", "setup.keys.otherProviders") }).click();
  await page
    .getByLabel(t("en", "settings.embeddings.baseUrl"), { exact: true })
    .fill(walk.embeddings.url);
  const saved = page.waitForResponse(isPut(`${walk.origin}/api/local/settings`));
  await page.getByRole("button", { name: t("en", "settings.form.save"), exact: true }).click();
  const status = (await saved).status();
  const yaml = readFileSync(join(walk.home, "settings.yaml"), "utf8");
  const named = yaml.includes(walk.embeddings.url);
  walk.checks.add(
    "provider base",
    status === 200 && named,
    `PUT settings ${status}; settings.yaml ${named ? "names" : "lacks"} the fake embeddings server`,
  );
}

/** The refused-key verdicts in `lang` that didn't show, with what showed instead. */
async function missingVerdicts(page: Page, lang: Lang): Promise<string[]> {
  const missing: string[] = [];
  for (const [name, provider] of REQUIRED) {
    const status = keyField(page, name).getByRole("status");
    if (!(await shows(status.filter({ hasText: refusedVerdict(lang, provider) }), 30_000))) {
      missing.push(`${provider}: ${(await visibleText(status)) || "no verdict"}`);
    }
  }
  return missing;
}

async function switchLanguage(page: Page, from: Lang, to: Lang): Promise<void> {
  await page.getByRole("button", { name: t(from, "common.language.label"), exact: true }).click();
  await page.getByText(t(to, "setup.keys.title"), { exact: true }).waitFor();
}

/** The keys step in both languages; online, the providers check the fake keys. */
async function keysStep(walk: Walk): Promise<void> {
  const { page, checks, keys } = walk;
  await saveEmbeddingsBase(walk);
  if (walk.options.offline) {
    await switchLanguage(page, "en", "zh-CN");
    const response = await walk.api("PUT", "/api/local/credentials", JSON.stringify(keys));
    checks.add(
      "keys",
      response.ok,
      `offline: the step shows in both languages; keys saved by PUT credentials (${response.status})`,
    );
  } else {
    for (const [name] of REQUIRED) await page.locator(`input[name="${name}"]`).fill(keys[name]);
    await page.locator('input[name="EMBED_API_KEY"]').fill(keys.EMBED_API_KEY);
    for (const [name] of REQUIRED) {
      await keyField(page, name)
        .getByRole("button", { name: t("en", "settings.credentials.check"), exact: true })
        .click();
    }
    const english = await missingVerdicts(page, "en");
    checks.add(
      "keys (en)",
      english.length === 0,
      english.length === 0
        ? "Soniox, OpenRouter and Fish refused the fake keys"
        : english.join("; "),
    );
    await switchLanguage(page, "en", "zh-CN");
    const chinese = await missingVerdicts(page, "zh-CN");
    const saved = page.waitForResponse(isPut(`${walk.origin}/api/local/credentials`));
    await page.getByRole("button", { name: t("zh-CN", "setup.keys.next"), exact: true }).click();
    const status = (await saved).status();
    const refused = await shows(
      page.getByText(t("zh-CN", "setup.keys.checksFailed"), { exact: true }),
      30_000,
    );
    checks.add(
      "keys (zh-CN)",
      chinese.length === 0 && status === 200 && refused,
      chinese.length > 0
        ? chinese.join("; ")
        : `the verdicts in Chinese; ${t("zh-CN", "setup.keys.next")} saved the keys (${status}) ` +
            `and ${refused ? "showed the rechecks failing" : "showed no failed recheck"}`,
    );
    const yaml = readFileSync(join(walk.home, "settings.yaml"), "utf8");
    checks.add(
      "cookie default",
      /cookiesFromBrowser: none/.test(yaml),
      "a new install's first save sets sources.cookiesFromBrowser: none",
    );
  }
  await switchLanguage(page, "zh-CN", "en");
}

async function credentialsAtRest(walk: Walk): Promise<void> {
  const path = join(walk.home, "credentials.json");
  const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const names = Object.keys(walk.keys);
  const saved = names.filter((name) => stored[name] === walk.keys[name]).length;
  walk.checks.add(
    "credentials.json",
    mode(path) === 0o600 && saved === names.length,
    `mode ${modeOf(path)}; ${saved} of ${names.length} keys as typed`,
  );
  // Error answers are where an echo would hide: a parser's message, an unknown name.
  await walk.api("GET", "/api/local/credentials");
  await walk.api(
    "PUT",
    "/api/local/credentials",
    `{"SONIOX_API_KEY": "${walk.keys.SONIOX_API_KEY}"`,
  );
  await walk.api(
    "PUT",
    "/api/local/credentials",
    JSON.stringify({ NOT_A_CREDENTIAL: walk.keys.FISH_API_KEY }),
  );
}

async function savePrompt(walk: Walk, templates: string): Promise<void> {
  const { page } = walk;
  await page.goto(`${walk.origin}/personas/${PERSONA}/prompt`);
  const editor = page.getByLabel(t("en", "studio.prompt.label"), { exact: true });
  const text = await poll(
    () => editor.inputValue(),
    (value) => value.length > 0,
    15_000,
  );
  const marker = `<!-- local-smoke ${randomBytes(4).toString("hex")} -->`;
  await editor.fill(`${text.trimEnd()}\n\n${marker}\n`);
  const saved = page.waitForResponse(isPut(`${walk.origin}/api/local/personas/${PERSONA}/prompt`));
  await page.getByRole("button", { name: t("en", "studio.editor.save"), exact: true }).click();
  const status = (await saved).status();
  const own = join(walk.home, "personas", PERSONA, "prompt.md");
  const landed = existsSync(own) && readFileSync(own, "utf8").includes(marker);
  const untouched = treeHash(join(ROOT, "personas")) === templates;
  walk.checks.add(
    "prompt",
    status === 200 && landed && untouched,
    `PUT ${status}; ${landed ? "in" : "missing from"} <home>/personas/${PERSONA}/prompt.md; ` +
      `personas/ ${untouched ? "unchanged" : "CHANGED"}`,
  );
}

async function indexFacts(walk: Walk): Promise<void> {
  const { page, checks } = walk;
  await page.goto(`${walk.origin}/personas/${PERSONA}/knowledge`);
  await page.getByRole("button", { name: t("en", "studio.facts.new"), exact: true }).click();
  await page.getByPlaceholder(t("en", "studio.facts.newNamePlaceholder")).fill(FACT_FILE);
  const lines = `${FACT_LINES.join("\n")}\n`;
  await page.getByPlaceholder(t("en", "studio.facts.placeholder")).fill(lines);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      decodeURIComponent(new URL(response.url()).pathname) ===
        `/api/local/personas/${PERSONA}/facts/${FACT_FILE}`,
  );
  await page.getByRole("button", { name: t("en", "studio.editor.save"), exact: true }).click();
  const status = (await saved).status();
  const file = join(walk.home, "sources", PERSONA, "facts", FACT_FILE);
  const written = existsSync(file) && readFileSync(file, "utf8") === lines;
  checks.add(
    "fact file",
    status === 200 && written,
    `PUT ${status}; ${written ? "in" : "missing from"} <home>/sources/${PERSONA}/facts/`,
  );

  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url() === `${walk.origin}/api/local/jobs`,
  );
  await page.getByRole("button", { name: t("en", "studio.facts.ingest"), exact: true }).click();
  const job = (await (await started).json()) as JobSnapshot;
  const ended = await poll(
    async () => (await (await walk.api("GET", `/api/local/jobs/${job.id}`)).json()) as JobSnapshot,
    (snapshot) => snapshot.status !== "running",
    JOB_TIMEOUT_MS,
  );
  const metaPath = join(walk.home, "personas", PERSONA, "index", "persona_facts.meta.json");
  const meta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as { rows?: unknown })
    : {};
  const { seen } = walk.embeddings;
  checks.add(
    "ingest-facts",
    ended.status === "succeeded" &&
      meta.rows === FACT_LINES.length &&
      seen.refused === 0 &&
      seen.inputs >= FACT_LINES.length,
    `job ${ended.status}, ${String(meta.rows ?? "no")} rows indexed; the fake embeddings server ` +
      `took ${seen.inputs} texts in ${seen.requests} request(s) and refused ${seen.refused}` +
      (ended.status === "succeeded" ? "" : `; ${ended.stderrTail.trim().split("\n").at(-1) ?? ""}`),
  );

  const card = page
    .getByText(t("en", "jobs.command.ingest-facts"), { exact: true })
    .locator("xpath=..")
    .filter({ hasText: t("en", "jobs.status.succeeded") });
  const finished = await shows(card);
  const jobs = join(walk.home, "jobs");
  const outputs = [".ndjson", ".log"].map((ext) => modeOf(join(jobs, `${job.id}${ext}`)));
  const locks = join(walk.home, "locks");
  checks.add(
    "job files",
    finished &&
      existsSync(join(jobs, `${job.id}.json`)) &&
      modeOf(jobs) === "0700" &&
      outputs.every((value) => value === "0600") &&
      modeOf(locks) === "0700",
    `the studio ${finished ? "shows" : "doesn't show"} it done; jobs/ ${modeOf(jobs)}, its events ` +
      `and log ${outputs.join(" and ")}; locks/ ${modeOf(locks)}`,
  );
}

async function jobsPage(walk: Walk): Promise<void> {
  const { page } = walk;
  await page.goto(`${walk.origin}/jobs`);
  const link = page.getByRole("link", { name: t("en", "jobs.command.ingest-facts"), exact: true });
  const row = page.getByRole("listitem").filter({ has: link });
  const listed = await shows(row.filter({ hasText: t("en", "jobs.status.succeeded") }));
  walk.checks.add(
    "jobs page",
    listed,
    listed
      ? `lists ${t("en", "jobs.command.ingest-facts")} as ${t("en", "jobs.status.succeeded")}`
      : (await visibleText(row)) || "no row",
  );
}

/** Settles the bodies read so far; null for one the browser couldn't give. */
async function settled(bodies: readonly Promise<string | null>[]): Promise<(string | null)[]> {
  const all = Promise.all(bodies);
  return (await Promise.race([all, Bun.sleep(10_000).then(() => null)])) ?? bodies.map(() => null);
}

async function smoke(options: Options): Promise<Checks> {
  const checks = new Checks();
  if (!(await buildWeb(checks, false))) return checks;
  const templates = treeHash(join(ROOT, "personas"));
  const run = new Run();
  const { home } = run;
  const id = randomBytes(4).toString("hex");
  const keys: Record<string, string> = {
    SONIOX_API_KEY: `not-a-real-key-soniox-${id}`,
    OPENROUTER_API_KEY: `not-a-real-key-openrouter-${id}`,
    FISH_API_KEY: `not-a-real-key-fish-${id}`,
    EMBED_API_KEY: `not-a-real-key-embed-${id}`,
  };
  const embeddings = fakeEmbeddings(keys.EMBED_API_KEY);
  run.defer(embeddings.stop);
  const env = childEnv(home);
  try {
    const problem = await isolationProblem(env, home);
    checks.add(
      "isolation",
      problem === null,
      problem ?? "both load-env.ts files skip the .env and use the temporary home",
    );
    if (problem !== null) return checks;

    const server = await run.boot(env, checks);
    if (server === null) return checks;
    const { link, origin, secret, stdout, stderr } = server;
    const bodies: Promise<string | null>[] = [];
    const api = async (method: string, path: string, body?: string): Promise<Response> => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body,
      });
      const text = await response.text();
      bodies.push(Promise.resolve(text));
      return new Response(text, { status: response.status, headers: response.headers });
    };

    let browser: Browser;
    try {
      browser = await chromium.launch({ ...chrome(), headless: !options.headful });
    } catch (error) {
      checks.add("browser", false, error instanceof Error ? error.message.split("\n")[0] : "");
      return checks;
    }
    run.browser = browser;
    const context = await browser.newContext({ locale: "en-US" });
    const problems: string[] = [];
    await reportCsp(context, problems);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("dialog", (dialog) => void dialog.accept());
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("response", (response) => {
      if (response.url().startsWith(`${origin}/api/`)) {
        bodies.push(response.text().catch(() => null));
      }
    });
    const walk: Walk = {
      options,
      checks,
      page,
      context,
      origin,
      link,
      home,
      keys,
      embeddings,
      api,
    };

    if (
      (await checks.step("sign-in", () => signIn(walk))) &&
      (await checks.step("keys", () => keysStep(walk)))
    ) {
      await checks.step("credentials.json", () => credentialsAtRest(walk));
      await checks.step("prompt", () => savePrompt(walk, templates));
      if (await checks.step("ingest-facts", () => indexFacts(walk))) {
        await checks.step("jobs page", () => jobsPage(walk));
      }
    }
    checks.add(
      "page health",
      problems.length === 0,
      problems.length === 0 ? "no page errors or CSP violations" : problems.slice(0, 3).join("; "),
    );

    const texts = await settled(bodies);
    const code = await run.stop();
    checks.add("shutdown", code === 0, `the server exited ${String(code)}`);
    const scanned = [...texts, stdout.text, stderr.text].filter((text) => text !== null);
    const echoed = Object.entries(keys)
      .filter(([, value]) => scanned.some((text) => text.includes(value)))
      .map(([name]) => name);
    const unread = texts.filter((text) => text === null).length;
    checks.add(
      "no key echoed",
      echoed.length === 0,
      echoed.length > 0
        ? `echoed: ${echoed.join(", ")}`
        : `none in ${texts.length - unread} API answers (${unread} unreadable) or the server's output`,
    );
  } finally {
    await run.end(checks, templates);
  }
  return checks;
}

/** A silent 16-bit mono WAV: without a capture file, Chrome's fake microphone beeps. */
function silentWav(seconds: number, rate = 48_000): Uint8Array {
  const bytes = seconds * rate * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const ascii = (at: number, text: string) => {
    for (const [i, char] of [...text].entries()) view.setUint8(at + i, char.charCodeAt(0));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  return new Uint8Array(view.buffer);
}

/** What the page reports to the run, through functions the context exposes. */
interface CallHooks {
  smokeRtvi(type: string, data: unknown): Promise<void>;
  smokeAudio(playing: boolean, db: number): Promise<void>;
}

/**
 * Installed in the page before its own scripts: copies the RTVI messages off the transport's data
 * channel, and samples the bot's <audio> element, whether it plays and how loud.
 */
function observeCall({ intervalMs, floorDb }: { intervalMs: number; floorDb: number }): void {
  const hooks = window as unknown as CallHooks;
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (
    this: RTCPeerConnection,
    label: string,
    init?: RTCDataChannelInit,
  ): RTCDataChannel {
    const channel = create.call(this, label, init);
    channel.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string" || !event.data.startsWith("{")) return;
      try {
        const message = JSON.parse(event.data) as {
          label?: unknown;
          type?: unknown;
          data?: unknown;
        };
        if (message.label === "rtvi-ai" && typeof message.type === "string") {
          if (message.type !== "metrics") void hooks.smokeRtvi(message.type, message.data ?? null);
        }
      } catch {
        // A keepalive or a signalling line, not RTVI.
      }
    });
    return channel;
  };

  // Created once a stream plays, after the click on Call: before any gesture it starts suspended.
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let samples = new Float32Array(0);
  let trackId: string | null = null;
  let lastTime = 0;
  setInterval(() => {
    const audio = document.querySelector("audio");
    const stream = audio?.srcObject instanceof MediaStream ? audio.srcObject : null;
    const track = stream?.getAudioTracks()[0];
    if (!audio || !stream || !track) {
      trackId = null;
      return;
    }
    if (track.id !== trackId || context === null || analyser === null) {
      trackId = track.id;
      context ??= new AudioContext();
      void context.resume().catch(() => undefined);
      analyser ??= context.createAnalyser();
      source?.disconnect();
      source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      samples = new Float32Array(analyser.fftSize);
      lastTime = audio.currentTime;
    }
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const rms = Math.sqrt(sum / samples.length);
    const db = rms > 0 ? Math.max(floorDb, 20 * Math.log10(rms)) : floorDb;
    const playing = !audio.paused && audio.currentTime > lastTime;
    lastTime = audio.currentTime;
    void hooks.smokeAudio(playing, Math.round(db * 10) / 10);
  }, intervalMs);
}

interface Picture {
  /** As the browser resolved it. */
  readonly src: string;
  readonly loaded: boolean;
  readonly natural: readonly [number, number];
  /** The box it shows in, as laid out. */
  readonly box: readonly [number, number];
}

/** One entry of the call page's transcript, as it reads. */
interface Line {
  readonly kind: "you" | "bot" | "selfie";
  /** Without the screen-reader prefix that names the speaker. */
  readonly text: string;
  /** Delivery cues shown as emoji chips, and directions shown as notes. */
  readonly cues: number;
  readonly directions: number;
  readonly pictures: readonly Picture[];
  /** Pictures that failed to load and show the expired note instead. */
  readonly expired: number;
}

interface Labels {
  /** The screen-reader prefixes of the viewer's and the persona's bubbles. */
  readonly you: string;
  readonly bot: string;
  readonly expired: string;
}

/** Runs in the page: the transcript's entries, without the thinking dots and notes between. */
function readTranscript({ you, bot, expired }: Labels): Line[] {
  const content = document.querySelector('[role="log"]')?.firstElementChild;
  if (!content) return [];
  const shown = (element: Element): string => {
    const copy = element.cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  };
  const lines: Line[] = [];
  for (const element of Array.from(content.children)) {
    const label = element.querySelector(".sr-only")?.textContent ?? "";
    if (label === you || label === bot) {
      lines.push({
        kind: label === you ? "you" : "bot",
        text: shown(element),
        cues: element.querySelectorAll('span[role="img"]').length,
        directions: element.querySelectorAll("span[title]:not([role])").length,
        pictures: [],
        expired: 0,
      });
      continue;
    }
    const images = Array.from(element.querySelectorAll("img"));
    const gone = (element.textContent ?? "").split(expired).length - 1;
    if (images.length === 0 && gone === 0) continue;
    lines.push({
      kind: "selfie",
      text: "",
      cues: 0,
      directions: 0,
      expired: gone,
      pictures: images.map((image) => {
        const box = (image.closest("div") ?? image).getBoundingClientRect();
        return {
          src: image.src,
          loaded: image.complete && image.naturalWidth > 0,
          natural: [image.naturalWidth, image.naturalHeight],
          box: [Math.round(box.width), Math.round(box.height)],
        };
      }),
    });
  }
  return lines;
}

/** RTVI messages that show the bot is still working on a turn. */
const BOT_ACTIVITY = new Set([
  "bot-started-speaking",
  "bot-stopped-speaking",
  "bot-llm-started",
  "bot-llm-stopped",
  "bot-tts-started",
  "bot-output",
  "bot-llm-text",
  "bot-tts-text",
  "llm-function-call-started",
  "llm-function-call-in-progress",
  "llm-function-call-stopped",
]);

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

interface Sample {
  readonly at: number;
  readonly playing: boolean;
  readonly db: number;
}

/** What the page's observers reported, stamped as it arrived, and the bot's turn state. */
class CallLog {
  /** When Call was clicked. */
  calledAt = 0;
  readonly rtvi: { readonly at: number; readonly type: string; readonly data: unknown }[] = [];
  readonly audio: Sample[] = [];
  #speaking = false;
  #llm = false;
  readonly #tools = new Set<unknown>();
  #lastActivity = 0;
  #lastSpeech = 0;

  addRtvi(type: string, data: unknown): void {
    const at = Date.now();
    this.rtvi.push({ at, type, data });
    if (!BOT_ACTIVITY.has(type)) return;
    this.#lastActivity = at;
    if (type === "bot-started-speaking") {
      this.#speaking = true;
      this.#lastSpeech = at;
    } else if (type === "bot-stopped-speaking") this.#speaking = false;
    else if (type === "bot-llm-started") this.#llm = true;
    else if (type === "bot-llm-stopped") this.#llm = false;
    else if (type === "llm-function-call-in-progress") this.#tools.add(field(data, "tool_call_id"));
    else if (type === "llm-function-call-stopped") this.#tools.delete(field(data, "tool_call_id"));
  }

  addAudio(playing: boolean, db: number): void {
    this.audio.push({ at: Date.now(), playing, db });
  }

  /** The bot has spoken since `since` and been quiet for SETTLE_MS. */
  settled(since: number): boolean {
    const idle = !this.#speaking && !this.#llm && this.#tools.size === 0;
    return idle && this.#lastSpeech >= since && Date.now() - this.#lastActivity >= SETTLE_MS;
  }

  first(type: string, since: number, match: (data: unknown) => boolean = () => true) {
    return this.rtvi.find((event) => event.at >= since && event.type === type && match(event.data));
  }

  /** The bot's audio between `from` and `to`. */
  sound(from: number, to = Number.POSITIVE_INFINITY) {
    const span = this.audio.filter((sample) => sample.at >= from && sample.at < to);
    const audible = span.filter((sample) => sample.db >= AUDIBLE_DB);
    const playing = span.filter((sample) => sample.playing);
    return {
      firstAudible: audible[0]?.at ?? null,
      audibleMs: audible.length * SAMPLE_MS,
      playingMs: playing.length * SAMPLE_MS,
      peak: span.reduce((peak, sample) => Math.max(peak, sample.db), FLOOR_DB),
      heard: audible.length >= MIN_SAMPLES || playing.length >= MIN_SAMPLES,
    };
  }
}

/** The call page's transcript, read every SAMPLE_MS, with when each entry first showed. */
class TranscriptWatch {
  lines: readonly Line[] = [];
  readonly shownAt: number[] = [];
  #running = true;
  readonly #done: Promise<void>;

  constructor(page: Page, labels: Labels) {
    this.#done = (async () => {
      while (this.#running) {
        const lines = await page.evaluate(readTranscript, labels).catch(() => null);
        if (lines !== null) {
          while (this.shownAt.length < lines.length) this.shownAt.push(Date.now());
          this.lines = lines;
        }
        await Bun.sleep(SAMPLE_MS);
      }
    })();
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#done;
  }
}

/** When `test` first held, checked every SAMPLE_MS; null once `ms` ran out. */
async function waitFor(test: () => boolean | Promise<boolean>, ms: number): Promise<number | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await test()) return Date.now();
    if (Date.now() > deadline) return null;
    await Bun.sleep(SAMPLE_MS);
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function quote(text: string, max = 80): string {
  return `"${text.length > max ? `${text.slice(0, max)}…` : text}"`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Markup the TTS reads and a viewer should never see as written: `[cue]`, `<tag>`, `</tag>`. */
const RAW_MARKUP = /\[[^\]\n]+\]|<\/?[A-Za-z][^<>\n]*>/;

interface CallView {
  readonly page: Page;
  readonly origin: string;
  readonly checks: Checks;
  readonly log: CallLog;
  readonly watch: TranscriptWatch;
  /** The persona's short name, as the page names her. */
  readonly short: string;
  readonly timings: [label: string, ms: number | null][];
  /** One line per turn: its stages in the order they happened. */
  readonly turns: string[];
}

/** What the page says is wrong, from its alerts. */
async function alerts(page: Page): Promise<string> {
  return (await visibleText(page.getByRole("alert"))) || "no alert shown";
}

function messageBox(view: CallView): Locator {
  const name = t("en", "call.input.placeholder", { name: view.short });
  return view.page.getByRole("textbox", { name, exact: true });
}

/** The viewer's last line reading `text`, and the first bot line after it; -1 for none. */
function answerTo(lines: readonly Line[], text: string): { asked: number; answer: number } {
  const asked = lines.findLastIndex((line) => line.kind === "you" && line.text === text);
  const answer =
    asked === -1
      ? -1
      : lines.findIndex((line, i) => i > asked && line.kind === "bot" && line.text !== "");
  return { asked, answer };
}

/** Types `text` and sends it with Enter; when it went. */
async function send(view: CallView, text: string): Promise<number> {
  const box = messageBox(view);
  await box.fill(text);
  const sent = Date.now();
  await box.press("Enter");
  return sent;
}

/** Whether the bot's audio from `from` on was heard, and how, for a check's detail. */
function audioCheck(view: CallView, from: number, to: number) {
  const sound = view.log.sound(from, to);
  const detail =
    `the audio element played ${seconds(sound.playingMs)}; peak ${sound.peak} dBFS, ` +
    `${seconds(sound.audibleMs)} audible` +
    (sound.firstAudible === null ? "" : `, the first ${seconds(sound.firstAudible - from)} in`);
  return { pass: sound.heard, detail, firstAudible: sound.firstAudible };
}

/**
 * A turn's stages between `from` and `to`, in the order they happened and timed from `base`:
 * each LLM run and tool call, the bot's first speech, and the page's own `marks`.
 */
function stages(
  view: CallView,
  label: string,
  [from, to, base, baseName]: readonly [number, number, number, string],
  marks: readonly (readonly [string, number | null])[],
): void {
  const points: [string, number][] = [];
  let spoke = false;
  for (const { at, type, data } of view.log.rtvi) {
    if (at < from || at >= to) continue;
    if (type === "bot-llm-started") points.push(["llm", at]);
    else if (type === "llm-function-call-started") {
      points.push([String(field(data, "function_name") ?? "tool call"), at]);
    } else if (type === "bot-started-speaking" && !spoke) {
      spoke = true;
      points.push(["speaking", at]);
    }
  }
  for (const [name, at] of marks) if (at !== null) points.push([name, at]);
  points.sort((a, b) => a[1] - b[1]);
  const path = points.map(([name, at]) => `${name} ${seconds(at - base)}`).join(" > ");
  view.turns.push(`  ${label.padEnd(9)} ${path || "nothing"}  (from ${baseName})`);
}

async function greeting(view: CallView, connected: number): Promise<boolean> {
  const { checks, log, watch, short } = view;
  const first = () => watch.lines.findIndex((line) => line.kind === "bot" && line.text !== "");
  await waitFor(() => first() !== -1, TURN_TIMEOUT_MS);
  const done = await waitFor(() => log.settled(log.calledAt), TURN_TIMEOUT_MS);
  const index = first();
  const shownAt = index === -1 ? null : watch.shownAt[index]!;
  checks.add(
    "greeting text",
    shownAt !== null,
    shownAt === null
      ? `no line from ${short} within ${seconds(TURN_TIMEOUT_MS)} of connecting`
      : `${quote(watch.lines[index]!.text)} ${seconds(shownAt - connected)} after connecting`,
  );
  const end = done ?? Date.now();
  const audio = audioCheck(view, connected, end);
  checks.add("greeting audio", audio.pass, `${audio.detail} (from connecting)`);
  stages(
    view,
    "greeting",
    [log.calledAt, end, connected, "connecting"],
    [
      ["text", shownAt],
      ["audible", audio.firstAudible],
    ],
  );
  return shownAt !== null;
}

async function question(view: CallView): Promise<void> {
  const { checks, log, watch } = view;
  const sent = await send(view, QUESTION);
  await waitFor(() => answerTo(watch.lines, QUESTION).answer !== -1, TURN_TIMEOUT_MS);
  const done = await waitFor(() => log.settled(sent), TURN_TIMEOUT_MS);
  const { asked, answer } = answerTo(watch.lines, QUESTION);
  const shownAt = answer === -1 ? null : watch.shownAt[answer]!;
  const end = done ?? Date.now();
  const audio = audioCheck(view, sent, end);
  stages(
    view,
    "reply",
    [sent, end, sent, "sending"],
    [
      ["text", shownAt],
      ["audible", audio.firstAudible],
    ],
  );
  checks.add(
    "reply",
    shownAt !== null && audio.pass,
    asked === -1
      ? "the question never showed as sent"
      : shownAt === null
        ? `no answer within ${seconds(TURN_TIMEOUT_MS)} of sending`
        : `${quote(watch.lines[answer]!.text)} ${seconds(shownAt - sent)} after sending; ` +
          `${audio.detail} (from sending)`,
  );
}

async function selfie(view: CallView): Promise<void> {
  const { checks, log, watch, origin } = view;
  const sent = await send(view, SELFIE_REQUEST);
  const pictures = () => {
    const { asked } = answerTo(watch.lines, SELFIE_REQUEST);
    return asked === -1
      ? undefined
      : watch.lines.find((line, i) => i > asked && line.kind === "selfie");
  };
  const landed = await waitFor(() => {
    const line = pictures();
    return line !== undefined && (line.expired > 0 || line.pictures.some((p) => p.loaded));
  }, SELFIE_TIMEOUT_MS);
  // She may say more once it lands.
  const end = (await waitFor(() => log.settled(sent), 30_000)) ?? Date.now();
  const { answer } = answerTo(watch.lines, SELFIE_REQUEST);
  const message = log.first("server-message", sent, (data) => field(data, "type") === "selfie");
  stages(
    view,
    "selfie",
    [sent, end, sent, "asking"],
    [
      ["message", message?.at ?? null],
      ["picture", landed],
      ["text", answer === -1 ? null : watch.shownAt[answer]!],
      ["audible", log.sound(sent, end).firstAudible],
    ],
  );
  // The bot may leave out function names, depending on its RTVI settings.
  const tool = log.first("llm-function-call-started", sent);
  const name = String(field(tool?.data, "function_name") ?? "a tool");
  const steps =
    (tool ? `${name} called ${seconds(tool.at - sent)}` : "no tool called") +
    (message ? `, its message ${seconds(message.at - sent)} after asking` : ", no selfie message");
  const line = pictures();
  const picture = line?.pictures.find((p) => p.loaded);
  if (landed === null || picture === undefined) {
    const why = line?.expired
      ? "the picture failed to load"
      : `no picture within ${seconds(SELFIE_TIMEOUT_MS)}`;
    checks.add("selfie", false, `${why}; ${steps}`);
    return;
  }
  const url = new URL(picture.src);
  const sameOrigin = url.origin === origin && url.pathname.startsWith("/api/selfie/");
  const [width, height] = picture.box;
  const threeByFour = height > 0 && Math.abs(width / height - 3 / 4) < 0.02;
  checks.add(
    "selfie",
    sameOrigin && threeByFour,
    `${sameOrigin ? url.pathname : `from ${url.origin}${url.pathname}`} ` +
      `${picture.natural[0]}x${picture.natural[1]} in a ${width}x${height} box, ` +
      `${seconds(landed - sent)} after asking; ${steps}`,
  );
}

/** Every bot line shows its markup as chips and notes, or drops it; none shows it as written. */
function markup(view: CallView): void {
  const bot = view.watch.lines.filter((line) => line.kind === "bot");
  if (bot.length === 0) return;
  const raw = bot.filter((line) => RAW_MARKUP.test(line.text));
  const sent = view.log.rtvi.filter(
    (event) => event.type === "bot-output" && RAW_MARKUP.test(String(field(event.data, "text"))),
  ).length;
  const cues = bot.reduce((sum, line) => sum + line.cues, 0);
  const directions = bot.reduce((sum, line) => sum + line.directions, 0);
  view.checks.add(
    "markup",
    raw.length === 0,
    raw.length > 0
      ? `shown as written: ${raw.map((line) => quote(line.text, 60)).join("; ")}`
      : `${sent} bot-output message(s) carried markup; the page shows ${cues} cue chip(s), ` +
          `${directions} direction(s), and no [..] or <tag>`,
  );
}

async function hangUp(view: CallView): Promise<void> {
  const { page, checks } = view;
  const ended = t("en", "call.state.ended");
  const stateLine = page.getByText(new RegExp(`^${escapeRegExp(ended)}`)).first();
  const again = page.getByRole("button", { name: t("en", "call.again"), exact: true });
  if (await again.isVisible()) {
    checks.add("hang-up", false, `the call had already ended: ${await alerts(page)}`);
    return;
  }
  const clicked = Date.now();
  await page.getByRole("button", { name: t("en", "call.hangUp"), exact: true }).click();
  const shown = await waitFor(
    async () => (await again.isVisible()) && (await stateLine.isVisible()),
    15_000,
  );
  view.timings.push(["Hang up > ended", shown === null ? null : shown - clicked]);
  checks.add(
    "hang-up",
    shown !== null,
    shown === null
      ? `no "${ended}" within 15 s: ${await alerts(page)}`
      : `"${await stateLine.innerText()}" and ${t("en", "call.again")} ` +
          `${seconds(shown - clicked)} after ${t("en", "call.hangUp")}`,
  );
}

async function converse(view: CallView, options: Options): Promise<void> {
  const { page, checks, log } = view;
  const box = messageBox(view);
  const again = page.getByRole("button", { name: t("en", "call.again"), exact: true });
  log.calledAt = Date.now();
  await page
    .getByRole("button", { name: t("en", "call.start", { name: view.short }), exact: true })
    .click();
  // The box shows, disabled, from the click on; a call that fails offers Call again instead.
  const open = async () =>
    (await box.count()) === 1 && (await box.isEnabled({ timeout: 1000 }).catch(() => false));
  const settledAt = await waitFor(
    async () => (await open()) || (await again.isVisible()),
    CONNECT_TIMEOUT_MS,
  );
  const connected = settledAt !== null && (await open()) ? settledAt : null;
  view.timings.push(["Call > connected", connected === null ? null : connected - log.calledAt]);
  checks.add(
    "connected",
    connected !== null,
    connected === null
      ? `not within ${seconds(CONNECT_TIMEOUT_MS)}: ${await alerts(page)}`
      : `the message box opened ${seconds(connected - log.calledAt)} after Call`,
  );
  if (connected === null) return;
  if (await greeting(view, connected)) {
    await question(view);
    if (options.selfie) await selfie(view);
  }
  markup(view);
  const errors = log.rtvi.filter((event) => event.type === "error");
  const botError = t("en", "call.botError.title", { name: view.short });
  const shown = await page.getByText(botError, { exact: true }).isVisible();
  checks.add(
    "bot errors",
    errors.length === 0 && !shown,
    errors.length === 0 && !shown
      ? "none reported"
      : `${errors.length} RTVI error(s): ${errors.map((e) => JSON.stringify(e.data)).join("; ")}` +
          (shown ? `; the page shows "${botError}"` : ""),
  );
  await hangUp(view);
}

/** The active persona and what a call needs, from GET status once its probes have answered. */
async function readiness(server: Server, options: Options, checks: Checks): Promise<Status | null> {
  const read = async () =>
    (await (
      await fetch(`${server.origin}/api/local/status`, {
        headers: { authorization: `Bearer ${server.secret}` },
      })
    ).json()) as Status;
  const status = await poll(
    read,
    (s) => (!s.memory.configured || s.memory.reachable !== null) && s.persona.voice.ok !== null,
    10_000,
  );
  const missing = Object.entries(status.keys)
    .filter(([, set]) => !set)
    .map(([name]) => name);
  const { persona, memory } = status;
  const ready =
    persona.id === PERSONA &&
    missing.length === 0 &&
    persona.voice.id !== null &&
    (!options.selfie || status.selfieReferences > 0);
  const recall = status.index.tables.filter((table) => table.built).length;
  checks.add(
    "ready",
    ready,
    [
      persona.id === PERSONA
        ? `${persona.id} (${persona.name})`
        : `the active persona isn't ${PERSONA}`,
      missing.length === 0 ? "keys set" : `missing ${missing.join(", ")}`,
      persona.voice.id === null
        ? "no voice"
        : `voice from ${persona.voice.source}, ${persona.voice.ok === false ? "unknown to Fish" : "known to Fish"}`,
      !memory.configured
        ? "memory off"
        : memory.reachable
          ? "memory on: Qdrant answers, so the call is remembered"
          : "memory configured, Qdrant down",
      recall === 0 ? "recall off (no index)" : `recall on (${recall} tables)`,
      `${status.selfieReferences} selfie reference(s)`,
    ].join("; "),
  );
  return ready ? status : null;
}

/** The server's warnings and errors, the newest last. */
function serverTrouble(server: Server, lines = 15): string[] {
  return `${server.stdout.text}\n${server.stderr.text}`
    .split("\n")
    .filter((line) => /\| (WARNING|ERROR|CRITICAL) +\|/.test(line))
    .slice(-lines);
}

async function callSmoke(options: Options): Promise<Checks> {
  const checks = new Checks();
  if (!(await buildWeb(checks, true))) return checks;
  const templates = treeHash(join(ROOT, "personas"));
  const run = new Run();
  const env = childEnv(run.home, true);
  try {
    const problem = await callIsolationProblem(env, run.home);
    checks.add(
      "isolation",
      problem === null,
      problem ?? "the server applies the .env and writes only to the temporary home",
    );
    if (problem !== null) return checks;
    const server = await run.boot(env, checks);
    if (server === null) return checks;
    const status = await readiness(server, options, checks);
    if (status === null) return checks;
    const short = status.persona.shortName.trim() || status.persona.name;

    const mic = join(run.temp, "silence.wav");
    writeFileSync(mic, silentWav(1));
    let browser: Browser;
    try {
      browser = await chromium.launch({
        ...chrome(),
        headless: false,
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-audio-capture=${mic}`,
        ],
      });
    } catch (error) {
      checks.add("browser", false, error instanceof Error ? error.message.split("\n")[0] : "");
      return checks;
    }
    run.browser = browser;
    const context = await browser.newContext({ locale: "en-US" });
    await context.grantPermissions(["microphone"], { origin: server.origin });
    const log = new CallLog();
    await context.exposeFunction("smokeRtvi", (type: string, data: unknown) => {
      log.addRtvi(type, data);
    });
    await context.exposeFunction("smokeAudio", (playing: boolean, db: number) => {
      log.addAudio(playing, db);
    });
    await context.addInitScript(observeCall, { intervalMs: SAMPLE_MS, floorDb: FLOOR_DB });
    const problems: string[] = [];
    await reportCsp(context, problems);
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console error: ${message.text()}`);
    });
    page.setDefaultTimeout(20_000);

    // The link code works on any path: the page trades it for the cookie and drops the fragment.
    await page.goto(`${server.origin}/call${new URL(server.link).hash}`);
    const start = page.getByRole("button", {
      name: t("en", "call.start", { name: short }),
      exact: true,
    });
    const opened = await shows(start);
    const url = new URL(page.url());
    checks.add(
      "call page",
      opened && url.pathname === "/call" && url.hash === "",
      `signed in on ${url.pathname}${url.hash ? " with the fragment left" : ""}; ` +
        (opened ? `${t("en", "call.start", { name: short })} shows` : await alerts(page)),
    );
    if (opened) {
      const labels: Labels = {
        you: `${t("en", "call.you")}: `,
        bot: `${short}: `,
        expired: t("en", "call.selfie.expired"),
      };
      const watch = new TranscriptWatch(page, labels);
      const view: CallView = {
        page,
        origin: server.origin,
        checks,
        log,
        watch,
        short,
        timings: [],
        turns: [],
      };
      try {
        await checks.step("call", () => converse(view, options));
      } finally {
        await watch.stop();
      }
      checks.notes.push("transcript");
      for (const [i, line] of watch.lines.entries()) {
        const at = `+${seconds(watch.shownAt[i]! - log.calledAt)}`.padStart(9);
        const who =
          line.kind === "you" ? t("en", "call.you") : line.kind === "bot" ? short : "selfie";
        const text =
          line.kind !== "selfie"
            ? line.text
            : [
                ...line.pictures.map(
                  (p) => `${new URL(p.src).pathname} ${p.natural[0]}x${p.natural[1]}`,
                ),
                ...(line.expired > 0 ? [`${line.expired} expired`] : []),
              ].join(", ");
        checks.notes.push(`  ${at}  ${who}  ${text}`);
      }
      checks.notes.push(
        `timings  ${view.timings
          .map(([label, ms]) => `${label} ${ms === null ? "n/a" : seconds(ms)}`)
          .join(" | ")}`,
        ...view.turns,
      );
    }
    checks.add(
      "page health",
      problems.length === 0,
      problems.length === 0
        ? "no page errors, console errors or CSP violations"
        : problems.slice(0, 3).join("; "),
    );
    if (!checks.pass) {
      const counts = new Map<string, number>();
      for (const event of log.rtvi) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      checks.notes.push(
        `rtvi     ${[...counts].map(([type, n]) => `${type} ${n}`).join(", ") || "none"}`,
      );
      for (const line of serverTrouble(server)) checks.notes.push(`server   ${line}`);
    }
    const code = await run.stop();
    checks.add("shutdown", code === 0, `the server exited ${String(code)}`);
  } finally {
    await run.end(checks, templates);
  }
  return checks;
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  if (argv[0] === PROBE_FLAG && argv[1] !== undefined) {
    await probeEnv(argv[1]);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const checks = options.call ? await callSmoke(options) : await smoke(options);
  const how = options.call
    ? `call${options.selfie ? " + selfie" : ""}  headful`
    : `${options.headful ? "headful" : "headless"}  ${options.offline ? "offline" : "online"}`;
  console.log(`\nlocal smoke  ${how}`);
  for (const check of checks.list) {
    console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name.padEnd(16)} ${check.detail}`);
  }
  for (const note of checks.notes) console.log(note);
  console.log(checks.pass ? "PASS" : "FAIL");
  return checks.pass ? 0 : 1;
}

process.exit(
  await main().catch((error) => {
    console.error(error);
    return 1;
  }),
);
