// A browser walk through the local web app on a throwaway data home: sign-in, the wizard's keys step
// in English and 简体中文, saved keys, an embeddings account added and picked in Settings, a saved
// prompt, a facts index built through the studio, a text chat from greeting to delete, and a group
// chat with a second persona. The keys are fake, so the providers refuse them for free, and the
// embeddings, the chats' replies and the director's decisions come from a fake server, so nothing is
// billed. --call instead places a real call from the call page
// with the .env's keys, which bills them.
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
import { PROVIDERS } from "@eidolon/providers/catalog";
import type { Subprocess } from "bun";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright-core";
import type { JobSnapshot, PersonasResponse, Status } from "../src/local/api.ts";
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

type Lang = "en" | "zh-Hans";

/** A .po catalog's messages, as `context\u0004message` → translation. */
function loadCatalog(lang: Lang): ReadonlyMap<string, string> {
  const messages = new Map<string, string>();
  const unquote = (line: string): string => JSON.parse(line.slice(line.indexOf('"')));
  let context = "";
  let id: string | null = null;
  let text: string | null = null;
  let field: "context" | "id" | "text" = "id";
  const flush = () => {
    if (id) messages.set(`${context}\u0004${id}`, text ?? "");
    context = "";
    id = text = null;
  };
  const file = join(ROOT, "apps/web/src/locales", `${lang}.po`);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("msgctxt ")) {
      flush();
      context = unquote(line);
      field = "context";
    } else if (line.startsWith("msgid ")) {
      if (field !== "context") flush();
      id = unquote(line);
      field = "id";
    } else if (line.startsWith("msgstr ")) {
      text = unquote(line);
      field = "text";
    } else if (line.startsWith('"')) {
      if (field === "context") context += unquote(line);
      else if (field === "id") id = (id ?? "") + unquote(line);
      else text = (text ?? "") + unquote(line);
    }
  }
  flush();
  return messages;
}

const CATALOGS: Readonly<Record<Lang, ReadonlyMap<string, string>>> = {
  en: loadCatalog("en"),
  "zh-Hans": loadCatalog("zh-Hans"),
};

/**
 * `message`, the app's English source text, as `lang` shows it, its `{name}` placeholders filled.
 * Throws for a message the app's catalog doesn't have, so a reworded string fails here first.
 */
function t(
  lang: Lang,
  message: string,
  vars: Readonly<Record<string, string>> = {},
  context = "",
): string {
  const text = CATALOGS[lang].get(`${context}\u0004${message}`);
  if (text === undefined) throw new Error(`the ${lang} catalog has no message "${message}"`);
  return (text || message).replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** What a check that ended in `code` shows: the provider's own sentence, else the shared one. */
const VERDICTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "invalid-key": {
    soniox:
      "Soniox rejected this key. A key from an EU, Japan or India project doesn't work either: Eidolon supports US projects only.",
    default: "The provider rejected this key.",
  },
  ok: { default: "Key accepted" },
};

function verdict(lang: Lang, provider: string, code: string): string {
  const texts = VERDICTS[code] ?? {};
  return t(lang, texts[provider] ?? texts.default ?? code);
}

/** The accounts a fresh install's calls need, each its provider's default. */
const REQUIRED = ["soniox", "openrouter", "fish"] as const;
/** The fake embeddings server's account: the first OpenAI-compatible one takes the provider's id. */
const EMBED_ACCOUNT = "openai-compatible";
const EMBED_ACCOUNT_NAME = "Local smoke embeddings";
const FAKE_MODELS = ["fake-embedding-small", "fake-embedding-large"];
const FAKE_MODEL = "fake-embedding-large";
/** The chat model the fake server streams from, which the chat walk gives her mind. */
const MIND_MODEL = "fake-chat";
/** What the fake mind answers a greeting kickoff with. */
const GREETING = "晚上好呀，今天也来陪我聊天啦？";
const CHAT_MESSAGE = "今天过得怎么样？";
/** Its reply to CHAT_MESSAGE, in two chunks: the second waits REPLY_HOLD_MS, so the page shows
 * the first alone. */
const REPLY = ["还不错哦，", "[laughing] 刚刚在看猫猫视频。"] as const;
const REPLY_HOLD_MS = 2000;
const CHAT_TITLE = "Local smoke chat";
/** The group chat's second persona, made from no template. */
const SECOND = {
  id: "local-smoke-kuro",
  name: "黑川茶茶",
  shortName: "茶茶",
  summary: "A horror-game streamer who stays up late",
} as const;
/** The OpenRouter account the director's Decisions requests reach the fake server through. */
const DECISIONS_ACCOUNT_NAME = "Local smoke decisions";
/** The viewer's group line after the mention the composer completes. */
const GROUP_TEXT = "你今晚玩什么？";
const GROUP_MESSAGE = `@${SECOND.shortName} ${GROUP_TEXT}`;
/** The second persona's answer, which invites the first. */
const SECOND_REPLY = "在玩恐怖游戏呢，奶绿要一起吗？";
/** The first persona's answer to her, a hop later. */
const HOP_REPLY = "不要不要，我最怕黑了！";

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

/** One chat completion request the fake server took, as far as the walk reads it. */
interface ChatRequest {
  readonly model?: unknown;
  readonly stream?: unknown;
  readonly stop?: unknown;
  readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[];
}

/** One Decisions request the fake server took, as far as the walk reads it. */
interface DecisionsRequest {
  readonly state?: { readonly latest?: { readonly speaker?: unknown; readonly text?: unknown } };
  readonly questions?: Readonly<Record<string, unknown>>;
}

/** Whether a user message of the request holds `text`. */
function heard(request: ChatRequest, text: string): boolean {
  return (request.messages ?? []).some(
    (message) => message.role === "user" && String(message.content).includes(text),
  );
}

/**
 * The director's answer: SECOND_REPLY is addressed to the first persona and invites a reply, and
 * every other noul is 0, so the viewer's line goes to whoever it mentions and the chain then ends.
 */
function decisionsAnswer(request: DecisionsRequest): Response {
  const invited = request.state?.latest?.text === SECOND_REPLY;
  const noul = (key: string) =>
    invited && (key === "invites_reply" || key === `addressed_${PERSONA}`) ? 0.9 : 0;
  return Response.json({
    model: "fake-decider",
    answers: Object.fromEntries(
      Object.keys(request.questions ?? {}).map((key) => [key, { type: "noul", noul: noul(key) }]),
    ),
    usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
  });
}

/** An OpenAI chat completion stream of `texts`, each after the one before by `holdMs`. */
function completionStream(texts: readonly string[], holdMs: number): Response {
  const encoder = new TextEncoder();
  const data = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  const chunk = (delta: object, finish: string | null) =>
    data({
      id: "chatcmpl-local-smoke",
      object: "chat.completion.chunk",
      created: 0,
      model: MIND_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const [i, content] of texts.entries()) {
          if (i > 0) await Bun.sleep(holdMs);
          controller.enqueue(chunk(i === 0 ? { role: "assistant", content } : { content }, null));
        }
        controller.enqueue(chunk({}, "stop"));
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        controller.enqueue(data({ id: "chatcmpl-local-smoke", choices: [], usage }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        // The turn was stopped, which cancels the stream.
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * An OpenAI-compatible server that answers the fake key only: its embeddings, its model list,
 * streaming chat completions, which greet a kickoff and answer CHAT_MESSAGE and the group's lines,
 * and OpenRouter's Decisions route beside its v1 API.
 */
function fakeEmbeddings(key: string) {
  const seen = {
    requests: 0,
    inputs: 0,
    refused: 0,
    listed: 0,
    models: new Set<string>(),
    chats: [] as ChatRequest[],
    decisions: [] as DecisionsRequest[],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      if (
        route !== "POST /v1/embeddings" &&
        route !== "GET /v1/models" &&
        route !== "POST /v1/chat/completions" &&
        route !== "POST /alpha/decisions"
      ) {
        return new Response(null, { status: 404 });
      }
      if (request.headers.get("authorization") !== `Bearer ${key}`) {
        seen.refused++;
        return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
      }
      if (route === "POST /v1/chat/completions") {
        const body = (await request.json()) as ChatRequest;
        seen.chats.push(body);
        const last = body.messages?.at(-1);
        if (last?.role === "user" && last.content === CHAT_MESSAGE) {
          return completionStream(REPLY, REPLY_HOLD_MS);
        }
        if (heard(body, SECOND_REPLY)) return completionStream([HOP_REPLY], 0);
        if (heard(body, GROUP_MESSAGE)) return completionStream([SECOND_REPLY], 0);
        return completionStream([GREETING], 0);
      }
      if (route === "POST /alpha/decisions") {
        const body = (await request.json()) as DecisionsRequest;
        seen.decisions.push(body);
        return decisionsAnswer(body);
      }
      if (route === "GET /v1/models") {
        seen.listed++;
        return Response.json({
          object: "list",
          data: FAKE_MODELS.map((id) => ({ id, object: "model", owned_by: "local-smoke" })),
        });
      }
      const body = (await request.json()) as {
        input?: unknown;
        dimensions?: unknown;
        model?: unknown;
      };
      const inputs = (Array.isArray(body.input) ? body.input : [body.input]).map(String);
      const dimensions = typeof body.dimensions === "number" ? body.dimensions : 3072;
      seen.requests++;
      seen.inputs += inputs.length;
      seen.models.add(String(body.model));
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
  const dropped = new Set<string>([
    ...CREDENTIALS,
    ...SETTINGS.map((row) => row.env),
    ...PROVIDERS.flatMap((provider) => [
      ...(provider.baseUrlEnv === null ? [] : [provider.baseUrlEnv]),
      ...(provider.fields ?? []).map((field) => field.env),
    ]),
  ]);
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

/** The field an account's key sits in, with its Check button and its verdict. */
function keyField(page: Page, account: string): Locator {
  return page
    .locator('[data-slot="field"]')
    .filter({ has: page.locator(`input[name="${account}"]`) });
}

async function signIn(walk: Walk): Promise<void> {
  const { page } = walk;
  await page.goto(walk.link);
  await page.getByText(t("en", "Your API Keys"), { exact: true }).waitFor();
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

/** The refused-key verdicts in `lang` that didn't show, with what showed instead. */
async function missingVerdicts(page: Page, lang: Lang): Promise<string[]> {
  const missing: string[] = [];
  for (const account of REQUIRED) {
    const status = keyField(page, account).getByRole("status");
    if (!(await shows(status.filter({ hasText: verdict(lang, account, "invalid-key") }), 30_000))) {
      missing.push(`${account}: ${(await visibleText(status)) || "no verdict"}`);
    }
  }
  return missing;
}

async function switchLanguage(page: Page, from: Lang, to: Lang): Promise<void> {
  await page.getByRole("button", { name: t(from, "Language"), exact: true }).click();
  await page.getByText(t(to, "Your API Keys"), { exact: true }).waitFor();
}

/** The keys step in both languages; online, the providers check the fake keys. */
async function keysStep(walk: Walk): Promise<void> {
  const { page, checks, keys } = walk;
  if (walk.options.offline) {
    await switchLanguage(page, "en", "zh-Hans");
    const statuses: number[] = [];
    for (const account of REQUIRED) {
      const body = JSON.stringify({ apiKey: keys[account] });
      statuses.push((await walk.api("PUT", `/api/local/accounts/${account}`, body)).status);
    }
    checks.add(
      "keys",
      statuses.every((status) => status === 200),
      `offline: the step shows in both languages; keys saved by PUT accounts (${statuses.join(", ")})`,
    );
  } else {
    for (const account of REQUIRED) {
      await page.locator(`input[name="${account}"]`).fill(keys[account] as string);
    }
    for (const account of REQUIRED) {
      await keyField(page, account)
        .getByRole("button", { name: t("en", "Check"), exact: true })
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
    await switchLanguage(page, "en", "zh-Hans");
    const chinese = await missingVerdicts(page, "zh-Hans");
    const saved = Promise.all(
      REQUIRED.map((account) =>
        page.waitForResponse(isPut(`${walk.origin}/api/local/accounts/${account}`)),
      ),
    );
    await page
      .getByRole("button", { name: t("zh-Hans", "Save and Continue"), exact: true })
      .click();
    const statuses = (await saved).map((response) => response.status());
    const refused = await shows(
      page.getByText(t("zh-Hans", "Not every key passed its check"), { exact: true }),
      30_000,
    );
    checks.add(
      "keys (zh-Hans)",
      chinese.length === 0 && statuses.every((status) => status === 200) && refused,
      chinese.length > 0
        ? chinese.join("; ")
        : `the verdicts in Chinese; ${t("zh-Hans", "Save and Continue")} saved the keys ` +
            `(${statuses.join(", ")}) and ` +
            (refused ? "showed the rechecks failing" : "showed no failed recheck"),
    );
    const yaml = readFileSync(join(walk.home, "settings.yaml"), "utf8");
    checks.add(
      "cookie default",
      /cookiesFromBrowser: none/.test(yaml),
      "a new install's first save sets sources.cookiesFromBrowser: none",
    );
  }
  await switchLanguage(page, "zh-Hans", "en");
}

/** An OpenAI-compatible account for the fake embeddings server, added and picked in Settings. */
async function embeddingsAccount(walk: Walk): Promise<void> {
  const { page, checks } = walk;
  await page.goto(`${walk.origin}/settings?tab=providers`);
  await page.getByRole("button", { name: t("en", "Add Provider"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder(t("en", "Search providers")).fill("compatible");
  await dialog.getByRole("option", { name: /^OpenAI-compatible endpoint/ }).click();
  await dialog.getByLabel(t("en", "Name"), { exact: true }).fill(EMBED_ACCOUNT_NAME);
  await dialog
    .getByLabel(t("en", "API Key (If the Server Asks for One)"), { exact: true })
    .fill(walk.keys.embed as string);
  await dialog
    .getByLabel(t("en", "API Base (Required)"), { exact: true })
    .fill(walk.embeddings.url);
  await dialog.getByRole("button", { name: t("en", "Check"), exact: true }).click();
  const shown = dialog.getByRole("status");
  const passed = await shows(shown.filter({ hasText: verdict("en", EMBED_ACCOUNT, "ok") }), 15_000);
  const added = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === `${walk.origin}/api/local/accounts`,
  );
  await dialog.getByRole("button", { name: t("en", "Add Account"), exact: true }).click();
  const status = (await added).status();
  const listed = await shows(page.getByText(EMBED_ACCOUNT_NAME, { exact: true }));
  checks.add(
    "add account",
    passed && status === 201 && listed,
    `the check ${passed ? "passed" : `showed ${(await visibleText(shown)) || "no verdict"}`}` +
      `; POST accounts ${status}; Settings ${listed ? "lists" : "doesn't list"} it`,
  );

  const provider = page.getByLabel(t("en", "Embedding Provider"), { exact: true });
  await provider.click();
  await page.getByRole("option", { name: EMBED_ACCOUNT_NAME, exact: true }).click();
  // The field is plain text until the account's list arrives.
  const model = page.getByRole("combobox", {
    name: t("en", "Embedding Model"),
    exact: true,
  });
  const offered = await shows(model, 15_000);
  if (offered) {
    await model.click();
    await page.getByRole("option", { name: FAKE_MODEL, exact: true }).click();
  } else {
    await page.getByLabel(t("en", "Embedding Model"), { exact: true }).fill(FAKE_MODEL);
  }
  const saved = page.waitForResponse(isPut(`${walk.origin}/api/local/settings`));
  await page
    .locator("form", { has: provider })
    .getByRole("button", { name: t("en", "Save"), exact: true })
    .click();
  // Another embedding provider means every index is built again, which the page asks about first.
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: t("en", "Save Anyway"), exact: true })
    .click();
  const saveStatus = (await saved).status();
  const yaml = Bun.YAML.parse(readFileSync(join(walk.home, "settings.yaml"), "utf8")) as {
    embeddings?: { provider?: unknown; model?: unknown };
  };
  const picked =
    yaml.embeddings?.provider === EMBED_ACCOUNT && yaml.embeddings.model === FAKE_MODEL;
  checks.add(
    "pick account",
    offered && saveStatus === 200 && picked,
    `the model list ${offered ? "offered the fake server's models" : "never showed"}` +
      `; PUT settings ${saveStatus}; settings.yaml ` +
      (picked ? `embeds with ${EMBED_ACCOUNT} and ${FAKE_MODEL}` : "names another embedder"),
  );
}

async function credentialsAtRest(walk: Walk): Promise<void> {
  const path = join(walk.home, "credentials.json");
  const stored = JSON.parse(readFileSync(path, "utf8")) as {
    accounts?: Record<string, { apiKey?: unknown; baseUrl?: unknown } | undefined>;
  };
  const accounts = stored.accounts ?? {};
  const saved = REQUIRED.filter((account) => accounts[account]?.apiKey === walk.keys[account]);
  const embed = accounts[EMBED_ACCOUNT];
  const pointed = embed?.apiKey === walk.keys.embed && embed?.baseUrl === walk.embeddings.url;
  walk.checks.add(
    "credentials.json",
    mode(path) === 0o600 && saved.length === REQUIRED.length && pointed,
    `mode ${modeOf(path)}; ${saved.length} of ${REQUIRED.length} keys as typed; the embeddings ` +
      `account ${pointed ? "has its key and API base" : "lacks its key or API base"}`,
  );
  // Error answers are where an echo would hide: a parser's message, an unknown name.
  await walk.api("GET", "/api/local/accounts");
  await walk.api("PUT", "/api/local/accounts/soniox", `{"apiKey": "${walk.keys.soniox}"`);
  const unknown = JSON.stringify({ provider: "not-a-provider", apiKey: walk.keys.fish });
  await walk.api("POST", "/api/local/accounts", unknown);
  await walk.api("POST", "/api/local/accounts/check", unknown);
  await walk.api("GET", "/api/local/credentials");
  await walk.api(
    "PUT",
    "/api/local/credentials",
    JSON.stringify({ NOT_A_CREDENTIAL: walk.keys.openrouter }),
  );
}

async function savePrompt(walk: Walk, templates: string): Promise<void> {
  const { page } = walk;
  await page.goto(`${walk.origin}/personas/${PERSONA}/prompt`);
  const editor = page.getByLabel(t("en", "System Prompt"), { exact: true });
  const text = await poll(
    () => editor.inputValue(),
    (value) => value.length > 0,
    15_000,
  );
  const marker = `<!-- local-smoke ${randomBytes(4).toString("hex")} -->`;
  await editor.fill(`${text.trimEnd()}\n\n${marker}\n`);
  const saved = page.waitForResponse(isPut(`${walk.origin}/api/local/personas/${PERSONA}/prompt`));
  await page.getByRole("button", { name: t("en", "Save"), exact: true }).click();
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
  await page.getByRole("button", { name: t("en", "New File"), exact: true }).click();
  await page.getByPlaceholder(t("en", "facts.txt")).fill(FACT_FILE);
  const lines = `${FACT_LINES.join("\n")}\n`;
  await page.getByPlaceholder(t("en", "2024-05-01 她说……")).fill(lines);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      decodeURIComponent(new URL(response.url()).pathname) ===
        `/api/local/personas/${PERSONA}/facts/${FACT_FILE}`,
  );
  await page.getByRole("button", { name: t("en", "Save"), exact: true }).click();
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
  await page.getByRole("button", { name: t("en", "Index Facts"), exact: true }).click();
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
  const models = [...seen.models].join(", ") || "none";
  checks.add(
    "ingest-facts",
    ended.status === "succeeded" &&
      meta.rows === FACT_LINES.length &&
      seen.refused === 0 &&
      seen.inputs >= FACT_LINES.length &&
      models === FAKE_MODEL,
    `job ${ended.status}, ${String(meta.rows ?? "no")} rows indexed; the fake embeddings server ` +
      `took ${seen.inputs} texts in ${seen.requests} request(s) for ${models} and refused ` +
      `${seen.refused}` +
      (ended.status === "succeeded" ? "" : `; ${ended.stderrTail.trim().split("\n").at(-1) ?? ""}`),
  );

  const card = page
    .getByText(t("en", "Index Facts"), { exact: true })
    .locator("xpath=..")
    .filter({ hasText: t("en", "Done", {}, "job status") });
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
  const link = page.getByRole("link", { name: t("en", "Index Facts"), exact: true });
  const row = page.getByRole("listitem").filter({ has: link });
  const listed = await shows(row.filter({ hasText: t("en", "Done", {}, "job status") }));
  walk.checks.add(
    "jobs page",
    listed,
    listed
      ? `lists ${t("en", "Index Facts")} as ${t("en", "Done", {}, "job status")}`
      : (await visibleText(row)) || "no row",
  );
}

/** One event of a chat's log, as far as the walk reads it. */
interface LoggedEvent {
  readonly seq: number;
  readonly type: string;
  readonly text?: string;
  readonly speaker?: { readonly kind: string; readonly id?: string };
  readonly after?: number;
  readonly source?: string;
  readonly replies?: readonly { readonly persona: string }[];
  readonly scores?: Readonly<Record<string, number>>;
  readonly title?: string;
}

async function chatLog(walk: Walk, id: string): Promise<readonly LoggedEvent[]> {
  const response = await walk.api("GET", `/api/local/chats/${id}`);
  if (!response.ok) return [];
  return ((await response.json()) as { events: readonly LoggedEvent[] }).events;
}

function said(events: readonly LoggedEvent[], kind: "user" | "persona", text: string): boolean {
  return events.some((e) => e.type === "message" && e.speaker?.kind === kind && e.text === text);
}

/** A request's message roles in order, for a check's detail. */
function roles(request: ChatRequest | undefined): string {
  return (request?.messages ?? []).map((message) => String(message.role)).join(", ") || "none";
}

/**
 * A text chat with her mind on the fake server: New Chat and its greeting, a reply that streams in,
 * the history after a reload, then Rename and Delete from the chat's menus.
 */
async function chatWalk(walk: Walk): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats } = walk.embeddings.seen;
  // Off, since her gate and reranker would ask OpenRouter with the fake key.
  const configured = await walk.api(
    "PUT",
    "/api/local/settings",
    JSON.stringify({
      scope: "persona",
      persona: PERSONA,
      values: {
        "mind.provider": EMBED_ACCOUNT,
        "mind.model": MIND_MODEL,
        "knowledge.gate.enabled": false,
        "knowledge.rerank.enabled": false,
      },
    }),
  );
  if (!configured.ok) throw new Error(`PUT settings for her mind answered ${configured.status}`);
  const listed = (await (await walk.api("GET", "/api/local/personas")).json()) as PersonasResponse;
  const persona = listed.personas.find((entry) => entry.id === PERSONA);
  if (persona === undefined) throw new Error(`GET personas has no ${PERSONA}`);
  const short = persona.shortName.trim() || persona.name;

  await page.goto(`${origin}/`);
  await page
    .getByRole("link", { name: t("en", "Chats"), exact: true })
    .first()
    .click();
  await page.waitForURL(`${origin}/chats`);
  await page
    .getByRole("button", { name: t("en", "New Chat"), exact: true })
    .first()
    .click();
  await page.getByRole("menuitemcheckbox").filter({ hasText: persona.name }).click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url() === `${origin}/api/local/chats`,
  );
  await page.getByRole("menuitem", { name: t("en", "Start Chat"), exact: true }).click();
  const createStatus = (await created).status();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1) as string;
  const log = page.getByRole("log", { name: t("en", "Conversation"), exact: true });
  const greeted = await shows(log.getByText(GREETING, { exact: true }), 30_000);
  const kickoff = chats[0];
  const greetingStored = said(
    await poll(
      () => chatLog(walk, id),
      (events) => said(events, "persona", GREETING),
      10_000,
    ),
    "persona",
    GREETING,
  );
  const events = await chatLog(walk, id);
  checks.add(
    "chat greeting",
    createStatus === 201 &&
      greeted &&
      greetingStored &&
      events[0]?.type === "kickoff" &&
      chats.length === 1 &&
      kickoff?.model === MIND_MODEL &&
      kickoff.stream === true &&
      kickoff.messages?.[0]?.role === "system",
    `POST chats ${createStatus}; the page ${greeted ? "shows" : "doesn't show"} her greeting, ` +
      `the log ${greetingStored ? "stores" : "lacks"} it after a ` +
      `${events[0]?.type ?? "missing"} event; ` +
      `the fake server took ${chats.length} request(s), the first for ` +
      `${String(kickoff?.model)} with ${roles(kickoff)}`,
  );

  const box = page.getByRole("textbox", {
    name: t("en", "Message {name}", { name: short }),
    exact: true,
  });
  await box.fill(CHAT_MESSAGE);
  await box.press("Enter");
  const [head, tail] = [REPLY[0], "刚刚在看猫猫视频"];
  const partial = await waitFor(async () => {
    const shown = await visibleText(log);
    return shown.includes(head) && !shown.includes(tail);
  }, REPLY_HOLD_MS + 20_000);
  const whole = await waitFor(async () => (await visibleText(log)).includes(tail), 20_000);
  const chip = await shows(log.getByRole("img", { name: "laughing", exact: true }), 5_000);
  const shownText = await visibleText(log);
  const raw = RAW_MARKUP.exec(shownText)?.[0] ?? null;
  const reply = chats[1];
  const messages = reply?.messages ?? [];
  const seesGreeting = messages.some((m) => m.role === "assistant" && m.content === GREETING);
  const asked = messages.at(-1)?.content === CHAT_MESSAGE;
  const streamed =
    partial === null ? "never showed its first chunk alone" : "streamed in, its first chunk alone";
  checks.add(
    "chat reply",
    partial !== null && whole !== null && chip && raw === null && seesGreeting && asked,
    `her reply ${streamed} and ${whole === null ? "never finished" : "then whole"}; the cue ` +
      (raw !== null ? `shows as written: ${raw}` : chip ? "shows as a chip" : "is missing") +
      `; the mind's second request ${seesGreeting ? "has" : "lacks"} her greeting and ` +
      `${asked ? "ends on" : "doesn't end on"} the viewer's line (${roles(reply)})`,
  );

  const stored = await poll(
    () => chatLog(walk, id),
    (logged) => said(logged, "persona", REPLY.join("")),
    10_000,
  );
  const viewerLine = stored.find((e) => e.type === "message" && e.text === CHAT_MESSAGE);
  const decision = stored.find((e) => e.type === "decision");
  const chatDir = join(walk.home, "chats", id);
  const logFile = join(chatDir, "chat.jsonl");
  await page.reload();
  const history = await Promise.all(
    [GREETING, CHAT_MESSAGE, tail].map((text) => shows(log.getByText(text), 15_000)),
  );
  const row = page
    .getByRole("list", { name: t("en", "Chats"), exact: true })
    .getByRole("listitem")
    .filter({ hasText: tail });
  const inList = await shows(row);
  checks.add(
    "chat history",
    said(stored, "persona", REPLY.join("")) &&
      decision?.after === viewerLine?.seq &&
      decision?.source === "single" &&
      history.every(Boolean) &&
      inList &&
      modeOf(join(walk.home, "chats")) === "0700" &&
      modeOf(logFile) === "0600",
    `the log ${said(stored, "persona", REPLY.join("")) ? "stores" : "lacks"} her reply after a ` +
      `${decision?.source ?? "missing"} decision on seq ${String(decision?.after)}; ` +
      `after a reload ` +
      `the page shows ${history.filter(Boolean).length} of 3 lines and the list ` +
      `${inList ? "previews" : "doesn't preview"} her reply; ` +
      `chats/ ${modeOf(join(walk.home, "chats"))}, ` +
      `chat.jsonl ${modeOf(logFile)}`,
  );

  await row.getByRole("button", { name: t("en", "Chat Options"), exact: true }).click();
  await page.getByRole("menuitem", { name: t("en", "Rename"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(t("en", "Title"), { exact: true }).fill(CHAT_TITLE);
  const renamed = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url() === `${origin}/api/local/chats/${id}`,
  );
  await dialog.getByRole("button", { name: t("en", "Save"), exact: true }).click();
  const renameStatus = (await renamed).status();
  const headed = await shows(page.getByRole("heading", { name: CHAT_TITLE, exact: true }));
  const titled = await shows(row.filter({ hasText: CHAT_TITLE }));
  const titleStored = (await chatLog(walk, id)).some(
    (e) => e.type === "title" && e.title === CHAT_TITLE,
  );
  checks.add(
    "chat rename",
    renameStatus === 200 && headed && titled && titleStored,
    `PATCH ${renameStatus}; the header ${headed ? "shows" : "doesn't show"} the title, the list ` +
      `${titled ? "shows" : "doesn't show"} it, the log ${titleStored ? "stores" : "lacks"} it`,
  );

  // The chat's own header menu, after the list row's.
  await page
    .getByRole("button", { name: t("en", "Chat Options"), exact: true })
    .last()
    .click();
  await page.getByRole("menuitem", { name: t("en", "Delete"), exact: true }).click();
  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url() === `${origin}/api/local/chats/${id}`,
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: t("en", "Delete"), exact: true })
    .click();
  const deleteStatus = (await deleted).status();
  await page.waitForURL(`${origin}/chats`);
  const empty = await shows(page.getByText(t("en", "No chats yet"), { exact: true }));
  const gone = (await walk.api("GET", `/api/local/chats/${id}`)).status;
  checks.add(
    "chat delete",
    deleteStatus === 200 && empty && gone === 404 && !existsSync(chatDir),
    `DELETE ${deleteStatus}; the page ${empty ? "lists no chats" : "still lists one"}; GET the ` +
      `chat ${gone}; its folder ${existsSync(chatDir) ? "remains" : "is gone"}`,
  );
}

/** The short name over the run of lines that `text` is in, as the page labels a group's lines. */
async function speakerShown(
  log: Locator,
  text: string,
  names: readonly string[],
): Promise<string | null> {
  return log.evaluate(
    (root, [text, names]) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let element: Element | null = null;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.textContent?.includes(text)) {
          element = node.parentElement;
          break;
        }
      }
      // The run's label is hidden from a screen reader, whom her bubble names instead.
      for (; element !== null && element !== root; element = element.parentElement) {
        const labels = [...element.querySelectorAll("[aria-hidden='true']")]
          .map((label) => label.textContent?.trim() ?? "")
          .filter((label) => names.includes(label));
        if (labels.length > 0) return labels.length === 1 ? (labels[0] as string) : null;
      }
      return null;
    },
    [text, names] as const,
  );
}

/** The system message of a request, or "". */
function systemOf(request: ChatRequest | undefined): string {
  const first = request?.messages?.[0];
  return first?.role === "system" ? String(first.content) : "";
}

/**
 * A group chat of her and a persona made from no template, with the director on the fake server:
 * New Chat with both and no greeting, an @-mention the composer completes, the second persona's
 * answer, the first's answer to her a hop later, and each line under its persona's name.
 */
async function groupChatWalk(walk: Walk): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats, decisions } = walk.embeddings.seen;
  const made = await walk.api(
    "POST",
    "/api/local/personas",
    JSON.stringify({ ...SECOND, voiceId: "0".repeat(32) }),
  );
  if (made.status !== 201) throw new Error(`POST personas answered ${made.status}`);
  const account = await walk.api(
    "POST",
    "/api/local/accounts",
    JSON.stringify({
      provider: "openrouter",
      name: DECISIONS_ACCOUNT_NAME,
      apiKey: walk.keys.embed,
      baseUrl: walk.embeddings.url,
    }),
  );
  if (account.status !== 201) throw new Error(`POST accounts answered ${account.status}`);
  const gate = ((await account.json()) as { id: string }).id;
  for (const persona of [PERSONA, SECOND.id]) {
    const configured = await walk.api(
      "PUT",
      "/api/local/settings",
      JSON.stringify({
        scope: "persona",
        persona,
        values: {
          "mind.provider": EMBED_ACCOUNT,
          "mind.model": MIND_MODEL,
          "knowledge.gate.enabled": false,
          "knowledge.rerank.enabled": false,
          // The director asks the active persona's gate role, on, though her retrieval gate is off.
          ...(persona === PERSONA ? { "knowledge.gate.provider": gate } : {}),
        },
      }),
    );
    if (!configured.ok)
      throw new Error(`PUT settings for ${persona} answered ${configured.status}`);
  }
  const listed = (await (await walk.api("GET", "/api/local/personas")).json()) as PersonasResponse;
  const first = listed.personas.find((entry) => entry.id === PERSONA);
  const second = listed.personas.find((entry) => entry.id === SECOND.id);
  if (first === undefined || second === undefined) {
    throw new Error(`GET personas lacks ${first === undefined ? PERSONA : SECOND.id}`);
  }
  const short = (persona: typeof first) => persona.shortName.trim() || persona.name;

  await page.goto(`${origin}/chats`);
  await page
    .getByRole("button", { name: t("en", "New Chat"), exact: true })
    .first()
    .click();
  for (const persona of [first, second]) {
    await page.getByRole("menuitemcheckbox").filter({ hasText: persona.name }).click();
  }
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url() === `${origin}/api/local/chats`,
  );
  const asked = chats.length;
  await page.getByRole("menuitem", { name: t("en", "Start Group Chat"), exact: true }).click();
  const createStatus = (await posted).status();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1) as string;
  // Untitled, the page names it by who is in it.
  const title = [short(first), short(second)].join(t("en", ", ", {}, "list separator"));
  const headed = await shows(page.getByRole("heading", { name: title, exact: true }));
  const opened = await chatLog(walk, id);
  const live = (await walk.api("GET", `/api/local/chats/${id}/live`)).status;
  checks.add(
    "group chat",
    createStatus === 201 && headed && opened.length === 0 && live === 204 && chats.length === asked,
    `POST chats ${createStatus} with ${first.id} and ${second.id}, the template-free one; the ` +
      `header ${headed ? "shows" : "doesn't show"} ${title}; the log holds ` +
      `${opened.map((e) => e.type).join(", ") || "nothing"}; GET live ${live}, and the fake ` +
      `server took ${chats.length - asked} greeting request(s)`,
  );

  const box = page.getByRole("textbox", { name: t("en", "Message everyone"), exact: true });
  await box.click();
  await box.pressSequentially(`@${SECOND.shortName.slice(0, 1)}`);
  const offered = await shows(
    page
      .getByRole("listbox", { name: t("en", "Mention"), exact: true })
      .getByRole("option")
      .filter({ hasText: second.name }),
  );
  await box.press("Tab");
  await box.pressSequentially(GROUP_TEXT);
  const typed = await box.inputValue();
  const noted = await shows(
    page.getByText(t("en", "Mentioned: {names}", { names: short(second) }), { exact: true }),
  );
  const decided = decisions.length;
  await box.press("Enter");
  const log = page.getByRole("log", { name: t("en", "Conversation"), exact: true });
  const answered = await shows(log.getByText(SECOND_REPLY), 30_000);
  const followed = await shows(log.getByText(HOP_REPLY), 30_000);
  const stored = await poll(
    () => chatLog(walk, id),
    (events) =>
      said(events, "persona", HOP_REPLY) &&
      events.filter((e) => e.type === "decision").length === 3,
    10_000,
  );
  const line = (text: string) => stored.find((e) => e.type === "message" && e.text === text);
  const [viewerLine, secondLine, hopLine] = [GROUP_MESSAGE, SECOND_REPLY, HOP_REPLY].map(line);
  const picks = stored
    .filter((e) => e.type === "decision")
    .map((e) => ({
      after: e.after,
      source: e.source,
      replies: (e.replies ?? []).map((reply) => reply.persona),
    }));
  const expected = [
    { after: viewerLine?.seq, source: "mention", replies: [SECOND.id] },
    { after: secondLine?.seq, source: "model", replies: [PERSONA] },
    { after: hopLine?.seq, source: "model", replies: [] },
  ];
  const asks = decisions.slice(decided);
  const questioned = (index: number) =>
    Object.keys(asks[index]?.questions ?? {})
      .sort()
      .join(" ");
  const theirs = chats.find((c) => heard(c, GROUP_MESSAGE) && !heard(c, SECOND_REPLY));
  const hers = chats.find((c) => heard(c, SECOND_REPLY));
  const stops = (request: ChatRequest | undefined) =>
    Array.isArray(request?.stop) ? (request.stop as unknown[]).map(String) : [];
  const heldBack =
    stops(theirs).includes(`\n${first.name}：`) && stops(hers).includes(`\n${second.name}：`);
  const introduced =
    systemOf(theirs).includes(`这是群聊，群里还有：${first.name}；`) &&
    systemOf(hers).includes(`这是群聊，群里还有：${second.name}；`);
  checks.add(
    "group mention",
    offered &&
      typed === GROUP_MESSAGE &&
      noted &&
      answered &&
      followed &&
      secondLine?.speaker?.id === SECOND.id &&
      hopLine?.speaker?.id === PERSONA &&
      JSON.stringify(picks) === JSON.stringify(expected) &&
      asks.length === 3 &&
      questioned(1) === `addressed_${PERSONA} interested_${PERSONA} invites_reply` &&
      heldBack &&
      introduced,
    `@ ${offered ? "offered" : "didn't offer"} ${second.name}, the box read ${quote(typed)} ` +
      `${noted ? "and named" : "without naming"} whom it mentions; the page ` +
      `${answered ? "shows" : "lacks"} her answer and ${followed ? "shows" : "lacks"} ` +
      `${short(first)}'s a hop later; decisions ${JSON.stringify(picks)}; the fake server took ` +
      `${asks.length} Decisions request(s), the second asking ${questioned(1) || "nothing"}; ` +
      `their minds ${heldBack ? "got" : "lacked"} each other's stop sequences and ` +
      `${introduced ? "were" : "weren't"} told who else is here`,
  );

  const names = [short(first), short(second)];
  const shown = await Promise.all(
    [SECOND_REPLY, HOP_REPLY].map((text) => speakerShown(log, text, names)),
  );
  await page.reload();
  const reloaded = await shows(log.getByText(HOP_REPLY), 15_000);
  const after = await Promise.all(
    [SECOND_REPLY, HOP_REPLY].map((text) => speakerShown(log, text, names)),
  );
  const expectedNames = [short(second), short(first)];
  checks.add(
    "group names",
    JSON.stringify(shown) === JSON.stringify(expectedNames) &&
      reloaded &&
      JSON.stringify(after) === JSON.stringify(expectedNames),
    `her answer shows under ${String(shown[0])} and the hop's under ${String(shown[1])}; ` +
      `after a reload, ${reloaded ? `${String(after[0])} and ${String(after[1])}` : "neither shows"}`,
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
    soniox: `not-a-real-key-soniox-${id}`,
    openrouter: `not-a-real-key-openrouter-${id}`,
    fish: `not-a-real-key-fish-${id}`,
    embed: `not-a-real-key-embed-${id}`,
  };
  const embeddings = fakeEmbeddings(keys.embed as string);
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
      const embedder = await checks.step("embeddings account", () => embeddingsAccount(walk));
      await checks.step("credentials.json", () => credentialsAtRest(walk));
      await checks.step("prompt", () => savePrompt(walk, templates));
      if (embedder && (await checks.step("ingest-facts", () => indexFacts(walk)))) {
        await checks.step("jobs page", () => jobsPage(walk));
      }
      if (embedder) {
        await checks.step("chat", () => chatWalk(walk));
        await checks.step("group chat", () => groupChatWalk(walk));
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
  const name = t("en", "Type a message to {name}", { name: view.short });
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
  const ended = t("en", "Call ended");
  const stateLine = page.getByText(new RegExp(`^${escapeRegExp(ended)}`)).first();
  const again = page.getByRole("button", { name: t("en", "Call Again"), exact: true });
  if (await again.isVisible()) {
    checks.add("hang-up", false, `the call had already ended: ${await alerts(page)}`);
    return;
  }
  const clicked = Date.now();
  await page.getByRole("button", { name: t("en", "Hang Up"), exact: true }).click();
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
      : `"${await stateLine.innerText()}" and ${t("en", "Call Again")} ` +
          `${seconds(shown - clicked)} after ${t("en", "Hang Up")}`,
  );
}

async function converse(view: CallView, options: Options): Promise<void> {
  const { page, checks, log } = view;
  const box = messageBox(view);
  const again = page.getByRole("button", { name: t("en", "Call Again"), exact: true });
  log.calledAt = Date.now();
  await page
    .getByRole("button", { name: t("en", "Call {name}", { name: view.short }), exact: true })
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
  const botError = t("en", "{name} ran into an error", { name: view.short });
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
  const missing = status.keys.filter((key) => !key.set).map((key) => key.name);
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
      name: t("en", "Call {name}", { name: short }),
      exact: true,
    });
    const opened = await shows(start);
    const url = new URL(page.url());
    checks.add(
      "call page",
      opened && url.pathname === "/call" && url.hash === "",
      `signed in on ${url.pathname}${url.hash ? " with the fragment left" : ""}; ` +
        (opened ? `${t("en", "Call {name}", { name: short })} shows` : await alerts(page)),
    );
    if (opened) {
      const labels: Labels = {
        you: `${t("en", "You", {}, "call transcript speaker")}: `,
        bot: `${short}: `,
        expired: t("en", "This photo has expired"),
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
          line.kind === "you"
            ? t("en", "You", {}, "call transcript speaker")
            : line.kind === "bot"
              ? short
              : "selfie";
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
