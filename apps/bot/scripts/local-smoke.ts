// A browser walk through the local web app on a throwaway data home: sign-in, the wizard's keys step
// in English and 简体中文, saved keys, a saved prompt, and a facts index built through the studio.
// The keys are fake, so the providers refuse them for free, and the embeddings come from a fake
// server, so nothing is billed.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CREDENTIALS, dataHome, SETTINGS } from "@eidolon/config";
import type { Subprocess } from "bun";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright-core";
import type { JobSnapshot } from "../src/local/api.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_ENTRY = join(ROOT, "apps/bot/src/local/server.ts");
/** The server's and the job CLI's: each walks up to a .env and applies it over the environment. */
const LOAD_ENVS = ["apps/bot/src/load-env.ts", "apps/cli/src/load-env.ts"];
const PROBE_FLAG = "--probe-env";
const PERSONA = "milky-green";
// Named to match milky-green's knowledge.facts.files, or the ingest would leave it out.
const FACT_FILE = "local-smoke设定集.txt";
const FACT_LINES = [
  "2024-05-01 明前奶绿说她最喜欢的饮料是冰美式。",
  "明前奶绿的猫叫坚果，是拉普拉斯花店的店长。",
];
const JOB_TIMEOUT_MS = 120_000;

const USAGE = `usage: bun apps/bot/scripts/local-smoke.ts [--headful] [--offline]

Boots the local web app on a temporary data home, without the .env or any provider key, walks it
in Chrome, then deletes the home. Exits 0 when every check passes, 1 when one fails.

  --headful   show the browser (headless Chrome is killed on some Macs)
  --offline   skip the wizard's key checks, which send fake keys to Soniox, OpenRouter and Fish`;

class UsageError extends Error {}

interface Options {
  readonly headful: boolean;
  readonly offline: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let headful = false;
  let offline = false;
  for (const arg of argv) {
    if (arg === "--headful") headful = true;
    else if (arg === "--offline") offline = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return { headful, offline };
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

function t(lang: Lang, key: string): string {
  const text = STRINGS[lang].get(key);
  if (text === undefined) throw new Error(`no ${lang} string ${key}`);
  return text;
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

/** A child's output as it arrives. */
class Output {
  text = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.text += decoder.decode(chunk, { stream: true });
    })();
  }

  /** The first group of `pattern` once it shows; throws when `exited` settles or time runs out. */
  async waitFor(pattern: RegExp, exited: Promise<unknown>, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let over = false;
    void exited.then(() => {
      over = true;
    });
    for (;;) {
      const match = pattern.exec(this.text);
      if (match) return match[1] ?? match[0];
      if (over || Date.now() > deadline) throw new Error(`no ${pattern} in the output`);
      await Bun.sleep(100);
    }
  }

  tail(lines = 20): string {
    return this.text.trimEnd().split("\n").slice(-lines).join("\n");
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
 * credential or EIDOLON_* reads, plus the .env opt-out and the temporary data home.
 */
function childEnv(home: string): Record<string, string> {
  const dropped = new Set<string>([...CREDENTIALS, ...SETTINGS.map((row) => row.env)]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !dropped.has(name) && !name.startsWith("EIDOLON_")) {
      env[name] = value;
    }
  }
  return { ...env, EIDOLON_NO_DOTENV: "1", EIDOLON_HOME: home };
}

/** Run as a child: imports one load-env.ts and reports the data home and the variables it set. */
async function probeEnv(path: string): Promise<void> {
  const before = { ...process.env };
  await import(path);
  const names = new Set([...Object.keys(before), ...Object.keys(process.env)]);
  const changed = [...names].filter((name) => before[name] !== process.env[name]).length;
  process.stdout.write(JSON.stringify({ home: dataHome(), changed }));
}

/**
 * Null when both load-env.ts files, run with `env`, apply no .env and use `home`; else why not.
 * Only a count of variables is shown: a .env holds real keys.
 */
async function isolationProblem(env: Record<string, string>, home: string): Promise<string | null> {
  for (const rel of LOAD_ENVS) {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", import.meta.path, PROBE_FLAG, join(ROOT, rel)],
      { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    let report: { home?: unknown; changed?: unknown };
    try {
      report = JSON.parse(out) as typeof report;
    } catch {
      return `${rel} could not be probed (exit ${code}): ${err.trim().split("\n").at(-1) ?? ""}`;
    }
    if (report.changed !== 0) {
      return `${rel} applied a .env (${String(report.changed)} variables) under EIDOLON_NO_DOTENV=1`;
    }
    if (typeof report.home !== "string" || resolve(report.home) !== resolve(home)) {
      return `${rel} would use ${String(report.home)} as the data home, not the temporary one`;
    }
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
  const stored = await page.evaluate(() =>
    JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
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
      !leaked,
    `landed on ${url.pathname}${url.hash || " without the fragment"}; cookie ` +
      (cookie ? `HttpOnly=${cookie.httpOnly} SameSite=${cookie.sameSite}` : "missing") +
      `; web storage ${leaked ? "holds a token" : "holds no token"}`,
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
  const row = page.locator("tr").filter({ has: link });
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
  if (!existsSync(join(ROOT, "apps/web/dist/index.html"))) {
    const build = Bun.spawn([process.execPath, "run", "build:web"], {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if ((await build.exited) !== 0) {
      checks.add("build", false, "bun run build:web failed");
      return checks;
    }
  }
  const templates = treeHash(join(ROOT, "personas"));
  const temp = mkdtempSync(join(tmpdir(), "eidolon-local-smoke-"));
  const home = join(temp, "home");
  const run = randomBytes(4).toString("hex");
  const keys: Record<string, string> = {
    SONIOX_API_KEY: `not-a-real-key-soniox-${run}`,
    OPENROUTER_API_KEY: `not-a-real-key-openrouter-${run}`,
    FISH_API_KEY: `not-a-real-key-fish-${run}`,
    EMBED_API_KEY: `not-a-real-key-embed-${run}`,
  };
  const embeddings = fakeEmbeddings(keys.EMBED_API_KEY);
  const env = childEnv(home);
  let server: Subprocess | null = null;
  let browser: Browser | null = null;
  const stop = async (): Promise<number | null> => {
    await browser?.close().catch(() => undefined);
    browser = null;
    const child = server;
    server = null;
    if (child === null) return null;
    child.kill("SIGTERM");
    const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => null)]);
    if (code === null) child.kill("SIGKILL");
    return code;
  };
  const interrupt = (): void => {
    void stop().finally(() => {
      embeddings.stop();
      rmSync(temp, { recursive: true, force: true });
      process.exit(130);
    });
  };
  process.once("SIGINT", interrupt);
  try {
    const problem = await isolationProblem(env, home);
    checks.add(
      "isolation",
      problem === null,
      problem ?? "both load-env.ts files skip the .env and use the temporary home",
    );
    if (problem !== null) return checks;

    const child = Bun.spawn(
      [process.execPath, "--no-env-file", SERVER_ENTRY, "--port", "0", "--no-open"],
      { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    server = child;
    const stdout = new Output(child.stdout);
    const stderr = new Output(child.stderr);
    let link: string;
    try {
      link = await stdout.waitFor(/^Eidolon is ready: (\S+)$/m, child.exited, 60_000);
    } catch {
      checks.add("boot", false, `no link printed:\n${stderr.tail()}`);
      return checks;
    }
    const token = join(home, "local-token");
    checks.add(
      "boot",
      modeOf(token) === "0600" && modeOf(home) === "0700",
      `link printed; the temporary home ${modeOf(home)}, its local-token ${modeOf(token)}`,
    );
    const { origin } = new URL(link);
    const secret = readFileSync(token, "utf8").trim();
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

    try {
      browser = await chromium.launch({ executablePath: CHROME, headless: !options.headful });
    } catch (error) {
      checks.add("browser", false, error instanceof Error ? error.message.split("\n")[0] : "");
      return checks;
    }
    const context = await browser.newContext({ locale: "en-US" });
    const problems: string[] = [];
    await context.exposeFunction("smokeCspViolation", (text: string) => {
      problems.push(`CSP ${text}`);
    });
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        const page = window as unknown as { smokeCspViolation(text: string): void };
        page.smokeCspViolation(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
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
    const code = await stop();
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
    await stop();
    embeddings.stop();
    process.off("SIGINT", interrupt);
    const unchanged = treeHash(join(ROOT, "personas")) === templates;
    checks.add("templates", unchanged, `personas/ ${unchanged ? "unchanged" : "CHANGED"}`);
    rmSync(temp, { recursive: true, force: true });
    checks.add("cleanup", !existsSync(temp), `${temp} ${existsSync(temp) ? "remains" : "deleted"}`);
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
  const checks = await smoke(options);
  const how = `${options.headful ? "headful" : "headless"}  ${options.offline ? "offline" : "online"}`;
  console.log(`\nlocal smoke  ${how}`);
  for (const check of checks.list) {
    console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name.padEnd(16)} ${check.detail}`);
  }
  console.log(checks.pass ? "PASS" : "FAIL");
  return checks.pass ? 0 : 1;
}

process.exit(
  await main().catch((error) => {
    console.error(error);
    return 1;
  }),
);
