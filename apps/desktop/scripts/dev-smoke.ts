// `bun run smoke:desktop:dev`, the dev smoke: Playwright's Electron driver on the unpackaged app,
// its backend from source, on the kit's fakes, temporary data home and profile, in background mode
// under the focus watch and the window watch (all off with --headful). It builds the web app and
// apps/desktop/dist first, so it never runs on a stale build (--no-build runs on what is there),
// and prints one line per step. The run's folder holds results.json and the screenshots, and goes
// after a pass, as the kit has it; --keep copies them beside it first.
import {
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { STRINGS } from "../src/main/strings.ts";
import { buildApp, missingBuilds } from "./dev-smoke/build.ts";
import { type Microphone, microphoneWav } from "./dev-smoke/speech.ts";
import { described, type Step, Steps, until, writeResults } from "./dev-smoke/steps.ts";
import { type WindowReport, watchWindows } from "./dev-smoke/windows.ts";
import {
  CHAT_MESSAGE,
  FILES_REPLY,
  GREETING,
  HEARD_REPLY,
  REPLY,
  SELFIE_REPLY,
  SELFIE_REQUEST,
  VOICE_TRANSCRIPT,
} from "./smoke/fakes.ts";
import { applicationType } from "./smoke/focus.ts";
import {
  type AppLaunch,
  devApp,
  electronBinary,
  errorLines,
  fakeMicrophoneArgs,
  LINES,
  localToken,
  parseSmokeArgs,
  ROOT,
  type Smoke,
  sleep,
  startSmoke,
} from "./smoke/kit.ts";
import { descendants, processTable, type Started } from "./smoke/processes.ts";

const LABEL = "smoke-desktop-dev";
const OWN_ARGS = ["--no-build", "--keep"];
const PERSONA = "milky-green";
/** The unpackaged app's version, as main gives it. */
const DESKTOP_VERSION = "0.0.0-dev";
const SERVER_VERSION: string = JSON.parse(
  readFileSync(join(ROOT, "apps", "bot", "package.json"), "utf8"),
).version;
/** The page's language and labels, whatever the machine's: the language step switches it. */
const LANGUAGE_ARGS = ["--lang=en-US"];
/** A setting the server reads only when it starts: a new value puts Settings' Restart banner up. */
const RESTART_SETTING = "access.anonRateLimitPerHour";
const UPLOADED_TEXT = "从前有一只猫，它每天都在花店门口晒太阳。\n";
const ATTACHED_LINE = "看看这张图和这个故事";
/** main.log's line once background mode saved a download: where, and how it ended. */
const DOWNLOADED = /background mode's download to (.+): (\w+)$/;
const SIGN_IN = /This Window Isn't Signed In|Open Eidolon from Your Terminal/;

const { rest } = parseSmokeArgs(process.argv.slice(2));
const unknown = rest.filter((arg) => !OWN_ARGS.includes(arg));
if (unknown.length > 0) {
  console.error(`${LABEL}: unknown ${unknown.join(" ")}; it takes --headful, --no-build, --keep`);
  process.exit(2);
}
if (rest.includes("--no-build")) {
  const missing = missingBuilds();
  if (missing.length > 0) {
    console.error(`${LABEL}: --no-build, and there's no ${missing.join(", ")}`);
    process.exit(1);
  }
} else {
  const building = Date.now();
  await buildApp();
  console.log(
    `${LABEL}: built apps/web/dist and apps/desktop/dist in ${seconds(Date.now() - building)}`,
  );
}
// Electron's package downloads its binary on the first require, blocking: before the focus watch.
electronBinary();

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function after(line: string): string {
  return line.replace(/^.*?Eidolon: /, "");
}

interface PersonaNames {
  readonly name: string;
  readonly shortName: string;
}

interface ChatEvent {
  readonly type: string;
  readonly speaker?: unknown;
  readonly text?: string;
  readonly modality?: string;
  readonly attachments?: readonly { readonly name: string; readonly kind: string }[];
}

/** One launch of the app under Playwright, with what its page logged. */
interface Driven {
  readonly app: ElectronApplication;
  readonly main: Started;
  readonly page: Page;
  readonly pid: number;
  /** Console errors and uncaught exceptions on the page, from its first load. */
  readonly errors: string[];
}

/** The run's state, which later steps build on. */
interface Walk {
  readonly smoke: Smoke;
  readonly steps: Steps;
  readonly launch: AppLaunch;
  readonly background: boolean;
  readonly downloads: string;
  microphone: Microphone | null;
  persona: PersonaNames | null;
  chatId: string | null;
}

const smoke = await startSmoke({ label: LABEL });
console.log(
  `${LABEL}: the unpackaged app on ${process.platform}-${process.arch}, ${smoke.args.headful ? "headful" : "in background mode"}; the run's folder is ${smoke.run.root}`,
);
const results = join(smoke.run.root, "results");
const steps = new Steps(smoke.checks, results);
const windowWatch = watchWindows({
  ours: underSmoke,
  skip:
    process.platform !== "darwin"
      ? "it runs on macOS only"
      : smoke.args.headful
        ? "--headful"
        : null,
  doing: () => steps.current ?? "between steps",
});
await windowWatch.ready;
const startedAt = Date.now();
const walk: Walk = {
  smoke,
  steps,
  launch: devApp(smoke.run),
  background: !smoke.args.headful,
  downloads: join(smoke.run.profile, "downloads"),
  microphone: null,
  persona: null,
  chatId: null,
};

try {
  await walkApp(walk);
} catch (error) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  smoke.checks.add(`${LABEL} ran to its end`, false, text.split("\n").slice(0, 4).join(" | "));
}
const watched = await windowWatch.stop();
checkWindows(watched);

const record = (): object => ({
  smoke: LABEL,
  startedAt: new Date(startedAt).toISOString(),
  seconds: (Date.now() - startedAt) / 1000,
  headful: smoke.args.headful,
  platform: `${process.platform}-${process.arch}`,
  microphone: walk.microphone,
  steps: steps.records,
  checks: smoke.checks.list,
  windowWatch: watched,
  fakes: smoke.fakes.counts(),
});
writeResults(results, record());
const kept = rest.includes("--keep") ? `${smoke.run.root}-results` : null;
if (kept !== null) cpSync(results, kept, { recursive: true });
const code = await smoke.finish();
for (const folder of [results, kept]) {
  if (folder === null || !existsSync(folder)) continue;
  console.log(`${LABEL}: results in ${writeResults(folder, record())}`);
}
process.exit(code);

/** Which of `pids` run under this smoke, where every launch of the app is its child. */
async function underSmoke(pids: readonly number[]): Promise<number[]> {
  const under = new Set(descendants(await processTable(), [process.pid]).map((row) => row.pid));
  return pids.filter((pid) => under.has(pid));
}

/** The window watch's check, after the last launch: no window of the app's was ever on screen. */
function checkWindows(report: WindowReport): void {
  if (report.skipped !== null) {
    console.log(`(the window watch is off: ${report.skipped})`);
    return;
  }
  const looked = `${report.looks} looks over ${report.seconds.toFixed(1)} s (longest gap ${report.maxGapMs} ms)`;
  const seen =
    report.failures.length > 0
      ? report.failures.join("; ")
      : report.windows === 0
        ? "no window on screen at all, so it couldn't have seen the app's"
        : `up to ${report.windows} windows on screen, none of them the app's`;
  smoke.checks.add(
    "the window watch: no window of the app's ever on screen",
    report.windows > 0 && report.failures.length === 0,
    `${looked}; ${seen}`,
  );
}

async function walkApp(walk: Walk): Promise<void> {
  const { smoke, steps } = walk;
  try {
    walk.microphone = await microphoneWav(smoke.run.scratch, VOICE_TRANSCRIPT);
  } catch (error) {
    console.log(`${LABEL}: no speech for the call: ${String(error)}`);
  }
  const launchedAt = Date.now();
  const first = await drive(walk, fakeMicrophoneArgs(walk.microphone?.file));
  await steps.run("cold start: Home at eidolon-app://app/", (step) =>
    coldStart(walk, first, launchedAt, step),
  );
  if (smoke.server() !== null) await smoke.checkCanary();
  await steps.run("a chat: her reply streams, files open in place, her selfie", (step) =>
    chat(walk, first, step),
  );
  await steps.run("the theme and the language reach main; the [data-shell] chrome", (step) =>
    themeAndLanguage(first, step),
  );
  await steps.run("Settings' Restart: a new backend on the same port", (step) =>
    restart(walk, first, step),
  );
  await steps.run("a call on Chromium's fake microphone: she answers, nothing is heard", (step) =>
    call(walk, first, step),
  );
  await steps.run("close and reopen: hidden, shown again, never in front", (step) =>
    closeAndReopen(walk, first, step),
  );
  await steps.run(
    "attach: after a quit, a server started first is used, restarted and left running",
    (step) => attach(walk, first, step),
  );
  await steps.run("quit: --quit stops main and the backend, leaving nothing", (step) =>
    quit(walk, step),
  );
}

/** Launches the unpackaged app under Playwright, the page's console watched from the start. */
async function drive(walk: Walk, extra: readonly string[]): Promise<Driven> {
  const { app, main } = await walk.smoke.drive(walk.launch, [...LANGUAGE_ARGS, ...extra]);
  const page = await app.firstWindow();
  // Every step here takes well under a second when it works.
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  if (walk.smoke.args.headful) await saveDownloadsHeadful(app, walk.downloads);
  const pid = main.child.pid;
  if (pid === undefined) throw new Error("the app has no pid");
  return { app, main, page, pid, errors };
}

/**
 * Background mode saves a download into the profile's downloads folder with no Save dialog. A
 * headful run would show the dialog, so the smoke makes main save it there too.
 */
async function saveDownloadsHeadful(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(
    ({ session }, { folder, sep }) => {
      session.defaultSession.on("will-download", (_event, item) => {
        item.setSavePath(`${folder}${sep}${item.getFilename()}`);
      });
    },
    { folder, sep },
  );
}

/** Home's footer, once the page shows Home; a sign-in screen, or any other page, fails. */
async function home(page: Page): Promise<string> {
  const signIn = page.getByText(SIGN_IN);
  try {
    await page
      .getByRole("heading", { name: "Readiness" })
      .or(signIn)
      .first()
      .waitFor({ timeout: 60_000 });
  } catch {
    throw new Error(`no Home within 60 s: the page is at ${page.url()}`);
  }
  if ((await signIn.count()) > 0) {
    throw new Error(`the page asks to sign in: "${await signIn.first().textContent()}"`);
  }
  if (page.url() !== "eidolon-app://app/") throw new Error(`Home is at ${page.url()}`);
  const footer = page.getByText(/^Eidolon \S+( · server \S+)?$/);
  await footer.waitFor({ timeout: 15_000 });
  return (await footer.textContent()) ?? "";
}

/**
 * Off screen as background mode has it: on macOS an accessory, and no window visible or focused.
 * A headful run shows the window, so it checks nothing.
 */
async function checkOffScreen(walk: Walk, driven: Driven, step: Step, when: string) {
  if (!walk.background) return;
  const windows = await driven.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      visible: win.isVisible(),
      focused: win.isFocused(),
    })),
  );
  const type =
    process.platform === "darwin" ? await applicationType(driven.pid).catch(() => null) : null;
  const accessory = process.platform !== "darwin" || type === "UIElement";
  step.check(
    `off screen ${when}`,
    accessory && windows.every((win) => !win.visible && !win.focused),
    `${when}: main ${type ?? "no LaunchServices entry"}, ${windows.length} window(s) ${JSON.stringify(windows)}`,
  );
}

/** Waits up to 2 s for the page's finite animations, such as a dialog opening, to end. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ending = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined));
    return Promise.race([Promise.all(ending), new Promise((done) => setTimeout(done, 2000))]);
  });
}

/** A request from the page itself, so main's forwarder adds the Bearer. */
async function pageFetch(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method: method ?? "GET",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { status: response.status, body: parsed };
    },
    { path, method: init.method, body: init.body },
  );
}

async function personaNames(page: Page): Promise<PersonaNames> {
  const { status, body } = await pageFetch(page, "/api/local/personas");
  const personas = (body as { personas?: { id: string; name: string; shortName?: string }[] })
    .personas;
  const persona = personas?.find((entry) => entry.id === PERSONA);
  if (status !== 200 || persona === undefined) throw new Error(`no ${PERSONA}: ${status}`);
  return { name: persona.name, shortName: persona.shortName?.trim() || persona.name };
}

async function chatEvents(walk: Walk, id: string): Promise<ChatEvent[]> {
  const response = await walk.smoke.api(`/api/local/chats/${id}`);
  if (!response.ok) throw new Error(`GET the chat: ${response.status}`);
  const read = (await response.json()) as { events?: ChatEvent[] };
  return read.events ?? [];
}

/** The server's bytes for a chat's file, as the page would load it. */
async function served(walk: Walk, path: string): Promise<Buffer> {
  const response = await walk.smoke.api(path);
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The server's status for `path`, asked as main's forwarder asks, or why it gave none. */
async function serverStatus(
  walk: Walk,
  path: string,
): Promise<{ readonly status: number | null; readonly detail: string }> {
  const { smoke } = walk;
  try {
    const response = await smoke.api(path);
    await response.body?.cancel();
    return { status: response.status, detail: `status ${response.status}` };
  } catch (error) {
    if (smoke.server() === null) {
      return { status: null, detail: "gone: no server holds the home any more" };
    }
    if (localToken(smoke.run.home) === null) {
      return { status: null, detail: "unreachable: the home has no local-token" };
    }
    return { status: null, detail: `no answer: ${described(error)}` };
  }
}

/** A link as the page has it: a download in place is an <a download> with no target. */
interface LinkShape {
  readonly tag: string;
  readonly download: string | null;
  readonly target: string | null;
}

function savesInPlace(link: LinkShape): boolean {
  return (
    link.tag === "a" &&
    link.download !== null &&
    (link.target === null || link.target === "" || link.target === "_self")
  );
}

function shapeOf(link: LinkShape): string {
  if (link.tag !== "a") return `a <${link.tag}>`;
  const download =
    link.download === null
      ? ""
      : link.download === ""
        ? " download"
        : ` download="${link.download}"`;
  return `an <a${download}${link.target === null ? "" : ` target="${link.target}"`}>`;
}

interface Saved {
  readonly ok: boolean;
  readonly detail: string;
  /** Where it was saved, or null when nothing was. */
  readonly path: string | null;
}

/**
 * Clicks `link`, which must be an <a download> that saves the chat's file at `path`: whole, into
 * the profile's downloads folder, and in background mode with main.log naming what and where. A
 * headful run finds it there as `name`. Main's downloadURL fallback saves a target="_blank" link
 * with the same lines in main.log, so only the link itself shows the page saved it in place.
 */
async function saves(walk: Walk, link: Locator, path: string, name: string): Promise<Saved> {
  const { smoke } = walk;
  const shape = await link.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    download: element.getAttribute("download"),
    target: element.getAttribute("target"),
  }));
  const inPlace = savesInPlace(shape);
  const from = smoke.log("main").length;
  await link.click();
  let saved: string | null = null;
  let logged = true;
  if (walk.background) {
    const done = await smoke
      .waitForLine("main", DOWNLOADED, { from, timeoutMs: 20_000 })
      .catch(() => null);
    const [, to, state] = (done === null ? null : DOWNLOADED.exec(done)) ?? [];
    const url = /background mode saves (\S+) to /.exec(smoke.log("main").slice(from))?.[1];
    logged = state === "completed" && url === `eidolon-app://app${path}`;
    saved = to ?? null;
  } else {
    const expected = join(walk.downloads, name);
    saved = await until(`a download at ${expected}`, () => existsSync(expected), 20_000).then(
      () => expected,
      () => null,
    );
  }
  const what = `${shapeOf(shape)}${inPlace ? "" : ", not an <a download> saving in place"}`;
  if (saved === null || !existsSync(saved)) {
    return { ok: false, detail: `${what}: nothing saved`, path: null };
  }
  const inFolder = dirname(realpathSync(saved)) === realpathSync(walk.downloads);
  const whole = readFileSync(saved).equals(await served(walk, path));
  return {
    ok: inPlace && logged && inFolder && whole,
    detail: `${what}: ${basename(saved)}${logged ? "" : " (main.log names another download)"} ${inFolder ? "in" : "outside"} the profile's downloads, ${whole ? "as served" : "not as served"}`,
    path: saved,
  };
}

/** A small PNG, a soft gradient, which the viewer and the screenshots show. */
function picture(): Buffer {
  const width = 96;
  const height = 64;
  const part = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row.set([120 + x, 160 + y, 220], 1 + x * 3);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    part("IHDR", header),
    part("IDAT", deflateSync(Buffer.concat(rows))),
    part("IEND", Buffer.alloc(0)),
  ]);
}

async function coldStart(walk: Walk, driven: Driven, launchedAt: number, step: Step) {
  const { smoke } = walk;
  const { page } = driven;
  if (walk.background) {
    await smoke.waitForLine("main", LINES.background, { timeoutMs: 30_000 });
    step.check("background mode is on and muted (main.log)", true, "background mode, muted");
  }
  await smoke.waitForLine("main", LINES.appShown, { timeoutMs: 60_000 });
  const footer = await home(page);
  const ms = Date.now() - launchedAt;
  step.check(
    "Home at eidolon-app://app/, not /setup",
    page.url() === "eidolon-app://app/",
    `Home in ${seconds(ms)}`,
  );
  const started = LINES.started.exec(smoke.log("main"));
  const server = smoke.server();
  step.check(
    "the backend main started holds the temporary home",
    started !== null && server !== null && Number(started[1]) === server.pid,
    `backend pid ${server?.pid} on ${server?.origin}`,
  );
  if (walk.background) {
    // Where 7860 is taken, main test-binds it, says so, and then asks for port 0 all the same.
    const tried = /port 7860 (is|turned out) taken/.test(smoke.log("main"));
    step.check(
      "background mode's backend takes a free port, never trying 7860",
      started?.[2] === "0" && !tried,
      `it asked for port ${started?.[2] ?? "none"}${tried ? " after trying 7860" : ""}, and listens on ${server?.port ?? "none"}`,
    );
  }
  if (server !== null) await smoke.processes.adopt("backend", server.pid);
  const page1 = await page.evaluate(() => {
    const bridge = (globalThis as { eidolonDesktop?: Record<string, unknown> }).eidolonDesktop;
    return {
      body: document.body.innerText,
      bridge:
        bridge === undefined
          ? null
          : { version: bridge.version, serverVersion: bridge.serverVersion },
      cookie: document.cookie,
    };
  });
  const locked = SIGN_IN.test(page1.body);
  step.check(
    "no sign-in",
    !locked && page1.cookie === "",
    locked ? "a sign-in screen" : "signed in",
  );
  const expected = `Eidolon ${DESKTOP_VERSION} · server ${SERVER_VERSION}`;
  const bridge = page1.bridge as { version?: string; serverVersion?: string } | null;
  step.check(
    "Home's two versions: the desktop's and the server's",
    footer === expected &&
      bridge?.version === DESKTOP_VERSION &&
      bridge.serverVersion === SERVER_VERSION,
    `"${footer}"`,
  );
  // Whatever the page logs as it settles.
  await sleep(1500);
  step.check(
    "no console errors",
    driven.errors.length === 0,
    driven.errors.length === 0 ? "no console errors" : driven.errors.slice(0, 3).join(" | "),
  );
  await checkOffScreen(walk, driven, step, "at Home");
  await step.shot(page, "home");
}

async function chat(walk: Walk, driven: Driven, step: Step) {
  const { smoke } = walk;
  const { fakes } = smoke;
  const { page } = driven;
  const persona = await personaNames(page);
  walk.persona = persona;

  await page.getByRole("button", { name: "New Chat" }).first().click();
  await page.getByRole("menuitemcheckbox", { name: persona.name }).click();
  await page.getByRole("menuitem", { name: "Start Chat" }).click();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  walk.chatId = id;
  const log = page.getByRole("log", { name: "Conversation" });
  await log.getByText(GREETING).waitFor({ timeout: 30_000 });
  const box = page.getByRole("textbox", { name: `Message ${persona.shortName}` });

  // Her reply: its first part shows long before the rest, which the fake holds back.
  await page.evaluate(
    ({ first, rest }) => {
      const conversation = document.querySelector('[role="log"]');
      const seen: { firstAt: number | null; restAt: number | null; sentAt: number } = {
        sentAt: performance.now(),
        firstAt: null,
        restAt: null,
      };
      (globalThis as { __devSmokeStream?: typeof seen }).__devSmokeStream = seen;
      const look = (): void => {
        const text = conversation?.textContent ?? "";
        if (seen.firstAt === null && text.includes(first)) seen.firstAt = performance.now();
        if (seen.restAt === null && text.includes(rest)) seen.restAt = performance.now();
      };
      if (conversation !== null) {
        new MutationObserver(look).observe(conversation, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      }
    },
    { first: REPLY[0].slice(0, 4), rest: REPLY[1].slice(0, 6) },
  );
  await box.fill(CHAT_MESSAGE);
  await page.evaluate(() => {
    const seen = (globalThis as { __devSmokeStream?: { sentAt: number } }).__devSmokeStream;
    if (seen !== undefined) seen.sentAt = performance.now();
  });
  await box.press("Enter");
  const stream = await until(
    "her whole reply",
    () =>
      page.evaluate(() => {
        const seen = (
          globalThis as {
            __devSmokeStream?: { firstAt: number | null; restAt: number | null; sentAt: number };
          }
        ).__devSmokeStream;
        return seen?.restAt == null ? null : seen;
      }),
    30_000,
    100,
  );
  const firstMs = (stream.firstAt ?? Number.NaN) - stream.sentAt;
  const gapMs = (stream.restAt ?? Number.NaN) - (stream.firstAt ?? Number.NaN);
  const record = fakes.streams.find((entry) => entry.texts[0] === REPLY[0]);
  step.check(
    "her reply streams through the forwarder, its first part shown long before the rest",
    stream.firstAt !== null &&
      gapMs >= fakes.replyHoldMs * 0.75 &&
      firstMs < fakes.replyHoldMs &&
      record !== undefined &&
      !record.cancelled,
    `first part shown ${Math.round(firstMs)} ms after sending, the rest ${Math.round(gapMs)} ms later (the fake held ${fakes.replyHoldMs} ms)`,
  );
  await step.shot(page, "chat");

  // A picture and a text file, set on the composer's input (never a click on it, which opens the
  // native file chooser).
  const pictureFile = join(smoke.run.scratch, "garden.png");
  writeFileSync(pictureFile, picture());
  const textFile = join(smoke.run.scratch, "story.txt");
  writeFileSync(textFile, UPLOADED_TEXT);
  await page.locator('form input[type="file"]').setInputFiles([pictureFile, textFile]);
  await box.fill(ATTACHED_LINE);
  const send = page.getByRole("button", { name: "Send" });
  await until("both files kept in the chat", () => send.isEnabled(), 20_000);
  const asked = fakes.chats.length;
  await send.click();
  await log.getByText(FILES_REPLY).waitFor({ timeout: 30_000 });
  const request = fakes.chats.slice(asked).find((entry) => {
    const content = entry.messages?.at(-1)?.content;
    return Array.isArray(content);
  });
  const parts = JSON.stringify(request?.messages?.at(-1)?.content ?? null);
  step.check(
    "her mind got the picture and the text file",
    parts.includes("image_url") && parts.includes(UPLOADED_TEXT.trim().slice(0, 6)),
    `her mind got ${parts.includes("image_url") ? "the picture" : "no picture"} and ${parts.includes(UPLOADED_TEXT.trim().slice(0, 6)) ? "the story" : "no story"}`,
  );
  const sent = (await chatEvents(walk, id))
    .filter((event) => event.type === "message")
    .flatMap((event) => event.attachments ?? []);
  const files = {
    image: sent.find((file) => file.kind === "image"),
    text: sent.find((file) => file.kind === "file"),
  };
  if (files.image === undefined || files.text === undefined) {
    throw new Error(`the chat keeps ${JSON.stringify(sent)}`);
  }
  const before = await windowsOf(driven);

  // The picture opens in the page's own viewer, whose Save saves it.
  await page.getByRole("button", { name: "Sent by you" }).click();
  const viewer = page.getByRole("dialog", { name: "Sent by you" });
  await viewer.waitFor({ timeout: 10_000 });
  const shown = await viewer
    .locator("img")
    .evaluate(
      (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth,
    );
  await settled(page);
  await step.shot(page, "picture-viewer");
  const savedImage = await saves(
    walk,
    viewer.getByRole("link", { name: "Save" }),
    `/api/local/chats/${id}/files/${files.image.name}`,
    files.image.name,
  );
  step.check(
    "the picture opens in the in-page viewer, and its Save saves it",
    Boolean(shown) && savedImage.ok,
    `the viewer shows it ${shown}px wide; its Save: ${savedImage.detail}`,
  );
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "hidden", timeout: 10_000 });

  // The text file saves through <a download>, under the name it was sent with.
  const savedText = await saves(
    walk,
    page.getByRole("link", { name: "story.txt" }),
    `/api/local/chats/${id}/files/${files.text.name}`,
    "story.txt",
  );
  const asSent = savedText.path !== null && readFileSync(savedText.path, "utf8") === UPLOADED_TEXT;
  step.check(
    "the text file saves through <a download>",
    savedText.ok && asSent,
    `${savedText.detail}${asSent ? ", the story as sent" : ", not the story sent"}`,
  );
  const savedAs = savedText.path === null ? null : basename(savedText.path);
  step.check(
    "the text file keeps the name it was sent with",
    savedAs === "story.txt",
    savedAs === null ? "nothing saved" : `saved as ${savedAs}`,
  );
  const afterOpening = await windowsOf(driven);
  step.check(
    "opening them left the window on the chat, with no other window",
    afterOpening === before && page.url().endsWith(`/chats/${id}`),
    `${afterOpening} window(s), at ${new URL(page.url()).pathname}`,
  );

  // Her selfie, from the take_selfie tool on the fakes' image model.
  const status = await pageFetch(page, "/api/local/status");
  const references = (status.body as { selfieReferences?: number }).selfieReferences ?? 0;
  const images = fakes.count("POST /v1/images");
  const before2 = fakes.chats.length;
  await box.fill(SELFIE_REQUEST);
  await box.press("Enter");
  const offered = await until(
    "her mind's request for the selfie line",
    () =>
      fakes.chats
        .slice(before2)
        .find((entry) => JSON.stringify(entry.messages?.at(-1)?.content).includes(SELFIE_REQUEST)),
    20_000,
  ).then((entry) => (entry.tools ?? []).some((tool) => tool.function?.name === "take_selfie"));
  let photoName = "Sent by you";
  if (offered) {
    await log.getByText(SELFIE_REPLY).waitFor({ timeout: 30_000 });
    const photo = page.getByRole("button", { name: /^A photo from / });
    await photo.waitFor({ timeout: 15_000 });
    photoName = (await photo.locator("img").getAttribute("alt")) ?? "her photo";
    step.check(
      "her selfie, drawn by the fakes' image model, shows in the chat",
      fakes.count("POST /v1/images") === images + 1,
      `take_selfie offered with ${references} outfit reference(s); the image model drew ${fakes.count("POST /v1/images") - images}`,
    );
    await photo.click();
  } else {
    // On the fakes' image model, only a persona with no outfit to draw goes without the tool.
    step.check(
      "the chat offers take_selfie while the persona has an outfit to draw",
      references === 0,
      `the chat offered no take_selfie, with ${references} outfit reference(s); the picture sent above stands in for her photo`,
    );
    await page.getByRole("button", { name: "Sent by you" }).click();
  }
  const selfieViewer = page.getByRole("dialog");
  await selfieViewer.waitFor({ timeout: 10_000 });
  const selfieSrc = await selfieViewer.locator("img").getAttribute("src");
  const selfieShown = await selfieViewer
    .locator("img")
    .evaluate(
      (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth,
    );
  await settled(page);
  await step.shot(page, "selfie-viewer");
  if (selfieSrc === null) throw new Error("the viewer shows no picture");
  const savedSelfie = await saves(
    walk,
    selfieViewer.getByRole("link", { name: "Save" }),
    selfieSrc,
    selfieSrc.split("/").at(-1) ?? "",
  );
  step.check(
    "her photo opens in the viewer, and its Save saves it",
    Boolean(selfieShown) && savedSelfie.ok,
    `${photoName}: ${selfieShown}px wide in the viewer; its Save: ${savedSelfie.detail}`,
  );
  await page.keyboard.press("Escape");
  await selfieViewer.waitFor({ state: "hidden", timeout: 10_000 });
}

async function windowsOf(driven: Driven): Promise<number> {
  return driven.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** The web app's Chinese for `english`, from its catalog. */
function inChinese(english: string): string {
  const catalog = readFileSync(join(ROOT, "apps", "web", "src", "locales", "zh-Hans.po"), "utf8");
  const quoted = JSON.stringify(english);
  const found = new RegExp(`^msgid ${escaped(quoted)}\\nmsgstr (".*")$`, "m").exec(catalog);
  if (found === null) throw new Error(`zh-Hans.po has no ${quoted}`);
  return JSON.parse(found[1]) as string;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function themeAndLanguage(driven: Driven, step: Step) {
  const { page, app } = driven;
  const theme = () => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  const initial = await theme();
  const pick = async (label: string, source: string): Promise<boolean> => {
    await page.getByRole("button", { name: "Theme" }).first().click();
    await page.getByRole("menuitemradio", { name: label }).click();
    return until(
      `themeSource ${source}`,
      async () => ((await theme()) === source ? true : null),
      10_000,
    );
  };
  await pick("Dark", "dark");
  const dark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await pick("Light", "light");
  const light = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await pick("Dark", "dark");
  step.check(
    "the theme setting reaches main's nativeTheme.themeSource as it is",
    initial === "system" && dark && !light,
    `themeSource ${initial} → dark (dark colours ${dark}) → light (${light}) → dark`,
  );

  const menus = () =>
    app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? []);
  const english = STRINGS.en.label.editMenu;
  const chinese = STRINGS["zh-Hans"].label.editMenu;
  const before = await menus();
  await page.getByRole("button", { name: "Language" }).first().click();
  const switched = await until(
    `the menus in Chinese (${chinese})`,
    async () => {
      const labels = await menus();
      return labels.includes(chinese) ? labels : null;
    },
    10_000,
  );
  await step.shot(page, "dark-chinese");
  await page
    .getByRole("button", { name: inChinese("Language") })
    .first()
    .click();
  const back = await until(
    `the menus in English (${english})`,
    async () => {
      const labels = await menus();
      return labels.includes(english) ? labels : null;
    },
    10_000,
  );
  step.check(
    "the language reaches main, whose menus follow it",
    before.includes(english),
    `menus ${before.join("/")} → ${switched.join("/")} → ${back.join("/")}`,
  );
  await pick("System", "system");

  const chrome = await page.evaluate(() => {
    const regionOf = (element: Element): string => {
      const style = getComputedStyle(element) as CSSStyleDeclaration & Record<string, string>;
      return style.getPropertyValue("app-region") || style.getPropertyValue("-webkit-app-region");
    };
    const rows = [...document.querySelectorAll("[data-window-drag]")];
    const sidebarRow = rows.find((row) => row.closest('[data-sidebar="sidebar"]') !== null);
    const pageRow = rows.find((row) => row.closest('[data-sidebar="sidebar"]') === null);
    const control = sidebarRow?.querySelector("a, button");
    return {
      shell: document.documentElement.dataset.shell ?? null,
      fullscreen: document.documentElement.hasAttribute("data-fullscreen"),
      rows: rows.length,
      sidebar: sidebarRow === undefined ? null : regionOf(sidebarRow),
      sidebarTop: sidebarRow === undefined ? null : getComputedStyle(sidebarRow).paddingTop,
      page: pageRow === undefined ? null : regionOf(pageRow),
      control: control == null ? null : regionOf(control),
    };
  });
  const mark = process.platform === "darwin" ? "mac" : "win";
  // Without titleBarOverlay macOS publishes no env(titlebar-area-*), and the row sits under the
  // traffic lights.
  const clear = process.platform !== "darwin" || Number.parseFloat(chrome.sidebarTop ?? "0") > 0;
  step.check(
    "the preload marks the page, whose title-bar rows drag and whose controls don't",
    chrome.shell === mark &&
      chrome.sidebar === "drag" &&
      chrome.page === "drag" &&
      chrome.control === "no-drag" &&
      clear,
    `data-shell=${chrome.shell}; ${chrome.rows} drag rows (sidebar ${chrome.sidebar}, padded ${chrome.sidebarTop} at the top; page ${chrome.page}); a control in one ${chrome.control}`,
  );
  await step.shot(page, "chrome");
}

/** Puts Settings' Restart banner up: a setting the server reads only when it starts. */
async function needRestart(page: Page, value: number): Promise<void> {
  const put = await pageFetch(page, "/api/local/settings", {
    method: "PUT",
    body: { scope: "app", values: { [RESTART_SETTING]: value } },
  });
  if (put.status !== 200) throw new Error(`PUT settings: ${put.status}`);
}

/** Settings' Restart, from its banner, until the page says it's back. */
async function restartFromSettings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.waitForURL("eidolon-app://app/settings", { timeout: 10_000 });
  const banner = page.getByRole("alert").filter({ hasText: "Restart to apply saved settings" });
  await banner.waitFor({ timeout: 15_000 });
  await banner.getByRole("button", { name: "Restart" }).click();
  await page.getByText("Eidolon restarted.").waitFor({ timeout: 60_000 });
}

async function restart(walk: Walk, driven: Driven, step: Step) {
  const { smoke } = walk;
  const { page } = driven;
  const before = smoke.server();
  if (before === null) throw new Error("no backend to restart");
  await needRestart(page, 61);
  const from = smoke.log("main").length;
  await restartFromSettings(page);
  const now = await until(
    "the new backend's lock",
    () => {
      const server = smoke.server();
      return server !== null && server.pid !== before.pid ? server : null;
    },
    15_000,
  );
  await smoke.processes.adopt("backend", now.pid);
  const log = smoke.log("main").slice(from);
  const exited = new RegExp(`the backend \\(pid ${before.pid}\\) exited \\(75\\)`).test(log);
  const started = LINES.started.exec(log);
  const held = log.includes("the backend restarts; requests wait for it to listen again");
  step.check(
    "the backend restarts on the same port, with a new pid",
    now.port === before.port &&
      held &&
      exited &&
      started !== null &&
      Number(started[1]) === now.pid,
    `pid ${before.pid} → ${now.pid}, port ${before.port} → ${now.port}; main.log: ${held ? "requests held from the forwarded restart" : "no hold from the forwarded restart"}, ${exited ? "exit 75" : "no exit 75"}`,
  );
  const banner = await page
    .getByRole("alert")
    .filter({ hasText: "Restart to apply saved settings" })
    .count();
  const status = await pageFetch(page, "/api/local/status");
  step.check(
    "the page comes back: its toast, no banner, and the new backend answers it",
    banner === 0 && status.status === 200,
    `"Eidolon restarted."; status ${status.status}`,
  );
  await step.shot(page, "restarted");
}

async function call(walk: Walk, driven: Driven, step: Step) {
  const { smoke } = walk;
  const { fakes } = smoke;
  const { page, app } = driven;
  const persona = walk.persona;
  const id = walk.chatId;
  if (persona === null || id === null) throw new Error("it needs the chat step's chat");
  if (walk.microphone === null) throw new Error("there's no speech for the fake microphone");
  await page.locator(`a[href="/chats/${id}"]`).first().click();
  await page.waitForURL(`eidolon-app://app/chats/${id}`, { timeout: 10_000 });
  // Each RTCPeerConnection the call opens, for its stats.
  await page.evaluate(() => {
    const Original = globalThis.RTCPeerConnection;
    const peers: RTCPeerConnection[] = [];
    (globalThis as { __devSmokePeers?: RTCPeerConnection[] }).__devSmokePeers = peers;
    globalThis.RTCPeerConnection = class extends Original {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        peers.push(this);
      }
    };
  });
  const from = smoke.log("main").length;
  const speechBefore = fakes.count("POST /v1/audio/speech");
  await page.getByRole("button", { name: "Call", exact: true }).click();
  const dock = page.getByRole("region", { name: `Call with ${persona.shortName}` });
  await dock.waitFor({ timeout: 20_000 });
  if (walk.background) {
    const granted = await smoke.waitForLine(
      "main",
      "background mode gave the page the microphone without asking macOS",
      { from, timeoutMs: 15_000 },
    );
    step.check("the microphone: Chromium's fake device, macOS never asked", true, after(granted));
  }
  // Whether the window is audible, every 250 ms until the call's checks are done.
  const audible: boolean[] = [];
  let sampled = false;
  const sampling = (async () => {
    while (!sampled) {
      const now = await app
        .evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((win) => win.webContents.isCurrentlyAudible()),
        )
        .catch(() => null);
      if (now === null) return;
      audible.push(now);
      await sleep(250);
    }
  })();
  try {
    await answered(walk, driven, step, id, speechBefore);
  } finally {
    sampled = true;
    await sampling;
  }
  if (walk.background) {
    const muted = await audioServiceMuted(driven.pid);
    step.check(
      "nothing is heard: the window never audible, the audio service muted",
      audible.length > 0 && audible.every((value) => !value) && muted === true,
      `audible in ${audible.filter(Boolean).length} of ${audible.length} samples; the audio service ${muted ? "has" : "lacks"} --mute-audio`,
    );
  }
  await smoke.processes.snapshot();
  await dock.getByRole("button", { name: "Hang Up" }).click();
  await dock.waitFor({ state: "hidden", timeout: 15_000 });
  const ended = await until(
    "the call's end in the chat's log",
    async () => (await chatEvents(walk, id)).find((event) => event.type === "call-ended"),
    15_000,
    500,
  );
  step.check("Hang Up ends it", ended !== undefined, "hung up");
}

/** Her answer to the fake microphone's speech, in the chat's log and over WebRTC. */
async function answered(walk: Walk, driven: Driven, step: Step, id: string, speechBefore: number) {
  const { fakes } = walk.smoke;
  const { page } = driven;
  const heard = await until(
    "her answer heard on the call, in the chat's log",
    async () => {
      const events = await chatEvents(walk, id);
      return events.find(
        (event) =>
          event.type === "message" &&
          event.modality === "call" &&
          event.text?.includes(HEARD_REPLY),
      );
    },
    90_000,
    500,
  );
  const events = await chatEvents(walk, id);
  const said = events.find(
    (event) =>
      event.type === "message" &&
      event.modality === "call" &&
      event.text?.includes(VOICE_TRANSCRIPT),
  );
  const sessions = fakes.realtime;
  step.check(
    "the fake microphone's speech reached her hearing, and she answered it",
    said !== undefined &&
      heard !== undefined &&
      sessions.some((session) => session.appended > 0 && session.commits > 0),
    `hearing: ${sessions.map((s) => `${s.appended} chunks, ${s.commits} segment(s)`).join("; ")}; the log: "${said?.text}" → "${heard.text}"`,
  );
  await sleep(1500);
  const stats = await page.evaluate(async () => {
    const peers = (globalThis as { __devSmokePeers?: RTCPeerConnection[] }).__devSmokePeers ?? [];
    const out: { state: string; packets: number; energy: number; playing: boolean }[] = [];
    const audio = document.querySelector("audio");
    for (const peer of peers) {
      let packets = 0;
      let energy = 0;
      (await peer.getStats()).forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          packets += report.packetsReceived ?? 0;
          energy += report.totalAudioEnergy ?? 0;
        }
      });
      out.push({
        state: peer.connectionState,
        packets,
        energy,
        playing: audio !== null && !audio.paused && audio.srcObject !== null,
      });
    }
    return out;
  });
  const connected = stats.find((peer) => peer.state === "connected");
  step.check(
    "the call connects, and her voice arrives over WebRTC",
    connected !== undefined &&
      connected.packets > 0 &&
      connected.energy > 0 &&
      connected.playing &&
      fakes.count("POST /v1/audio/speech") > speechBefore,
    connected === undefined
      ? `no connected peer: ${JSON.stringify(stats)}`
      : `${connected.packets} audio packets in, energy ${connected.energy.toFixed(3)}, the page's player ${connected.playing ? "playing" : "idle"}; ${fakes.count("POST /v1/audio/speech") - speechBefore} line(s) spoken`,
  );
  await step.shot(page, "call");
}

/** Whether the audio service under main's pid runs with Chromium's --mute-audio. */
async function audioServiceMuted(pid: number): Promise<boolean | null> {
  const table = await processTable();
  const service = descendants(table, [pid]).find((row) =>
    row.command.includes("audio.mojom.AudioService"),
  );
  return service === undefined ? null : /(^|\s)--mute-audio(\s|$)/.test(service.command);
}

async function closeAndReopen(walk: Walk, driven: Driven, step: Step) {
  const { smoke } = walk;
  const from = smoke.log("main").length;
  await driven.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const hidden = await smoke.waitForLine("main", "Eidolon: the window is hidden", {
    from,
    timeoutMs: 10_000,
  });
  const serving = await serverStatus(walk, "/api/local/status");
  const windows = await windowsOf(driven);
  step.check(
    "closing hides the window, and the backend keeps serving",
    windows === 1 && serving.status === 200,
    `${after(hidden)}; ${windows} window kept; the backend: ${serving.detail}`,
  );
  await checkOffScreen(walk, driven, step, "after the close");
  const SECOND = "a second launch of the same app and profile shows it again, and exits";
  const second = smoke.launch("second", walk.launch, LANGUAGE_ARGS);
  const exit = await Promise.race([second.exited, sleep(30_000).then(() => null)]);
  if (exit === null) {
    second.child.kill("SIGKILL");
    step.check(SECOND, false, "the second launch still ran after 30 s, so the smoke killed it");
    return;
  }
  const shown = await smoke.waitForLine("main", "Eidolon: the window is shown", {
    from,
    timeoutMs: 10_000,
  });
  const spawned = LINES.started.test(smoke.log("main").slice(from));
  step.check(
    SECOND,
    exit.code === 0 && !spawned,
    `the second launch exited ${exit.code ?? exit.signal}${spawned ? ", and a backend started" : ""}; ${after(shown)}`,
  );
  await checkOffScreen(walk, driven, step, "after the second launch");
  const status = await pageFetch(driven.page, "/api/local/status");
  step.check("the page still works", status.status === 200, `status ${status.status}`);
  await step.shot(driven.page, "reopened");
}

function runs(started: Started): boolean {
  return started.child.exitCode === null && started.child.signalCode === null;
}

interface Quit {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Quits the app as a terminal would, with a second launch's --quit: it and main must exit 0, and
 * with `backend`, our own, main.log must say it exited 0.
 */
async function quitApp(walk: Walk, main: Started, backend: number | null): Promise<Quit> {
  const { smoke } = walk;
  await smoke.processes.snapshot();
  const from = smoke.log("main").length;
  const second = await smoke.quit(walk.launch);
  const exit = await Promise.race([main.exited, sleep(30_000).then(() => null)]);
  const exited =
    backend === null
      ? null
      : await smoke
          .waitForLine("main", new RegExp(`the backend \\(pid ${backend}\\) exited \\((\\w+)\\)`), {
            from,
            timeoutMs: 15_000,
          })
          .catch(() => null);
  const ok =
    second.code === 0 &&
    exit?.code === 0 &&
    (backend === null || exited?.endsWith("exited (0)") === true);
  const backendText =
    backend === null
      ? ""
      : `; ${exited === null ? `no exit line for the backend (pid ${backend}) in main.log` : after(exited)}`;
  return {
    ok,
    detail: `--quit ${second.code ?? second.signal} in ${second.ms} ms; main ${exit === null ? "still running" : (exit.code ?? exit.signal)}${backendText}`,
  };
}

async function attach(walk: Walk, first: Driven, step: Step) {
  const { smoke } = walk;
  // The launch before ends first, so that its backend leaves the data home.
  const ending = await quitApp(walk, first.main, smoke.server()?.pid ?? null);
  const gone = await smoke.processes.settle(10_000);
  step.check(
    "--quit ends the launch before, its backend with it",
    ending.ok && gone.length === 0,
    `${ending.detail}${gone.length > 0 ? `; still running: ${gone.join(", ")}` : ""}`,
  );

  const output = openSync(join(smoke.run.scratch, "server.output.log"), "a");
  let supervisor: Started | null = null;
  let driven: Driven | null = null;
  try {
    supervisor = smoke.processes.spawn(
      "server",
      process.execPath,
      [join(ROOT, "apps", "bot", "src", "local", "main.ts"), "--port", "0", "--no-open"],
      { cwd: smoke.run.scratch, env: smoke.env, stdio: ["ignore", output, output] },
    );
    closeSync(output);
    await attached(walk, supervisor, step, (launched) => {
      driven = launched;
    });
  } finally {
    // What a failure left running, so the step after starts on an empty home.
    const left = driven as Driven | null;
    if (left !== null && runs(left.main)) await smoke.quit(walk.launch).catch(() => undefined);
    if (supervisor !== null && runs(supervisor)) {
      supervisor.child.kill("SIGTERM");
      await Promise.race([supervisor.exited, sleep(20_000)]);
    }
  }
}

/** The app on a server started before it, from its supervisor, which the smoke then stops. */
async function attached(
  walk: Walk,
  supervisor: Started,
  step: Step,
  launched: (driven: Driven) => void,
) {
  const { smoke } = walk;
  const server = await until(
    "the server's lock and token",
    () => {
      const found = smoke.server();
      return found !== null && localToken(smoke.run.home) !== null ? found : null;
    },
    60_000,
  );
  await smoke.processes.snapshot();
  const from = smoke.log("main").length;
  const driven = await drive(walk, []);
  launched(driven);
  const { page } = driven;
  const using = await smoke.waitForLine("main", LINES.attached, { from, timeoutMs: 30_000 });
  const footer = await home(page);
  const ownSpawn = () =>
    /started the backend|no server answered/.test(smoke.log("main").slice(from));
  step.check(
    "the app uses the server started first on the home, and spawns none",
    using.endsWith(server.origin) && !ownSpawn(),
    `${after(using)} (supervisor pid ${supervisor.child.pid}, server pid ${server.pid})`,
  );
  const status = await pageFetch(page, "/api/local/status");
  step.check(
    "the page works on it",
    status.status === 200 && footer === `Eidolon ${DESKTOP_VERSION} · server ${SERVER_VERSION}`,
    `status ${status.status}; "${footer}"`,
  );

  // Settings' Restart while attached: a grace period while its supervisor starts the next server.
  await needRestart(page, 62);
  const restartFrom = smoke.log("main").length;
  await restartFromSettings(page);
  const next = await until(
    "the attached server's restart",
    () => {
      const found = smoke.server();
      return found !== null && found.pid !== server.pid ? found : null;
    },
    15_000,
  );
  const grace = smoke
    .log("main")
    .slice(restartFrom)
    .split(/\r?\n/)
    .find((line) => line.includes("restarts; requests wait for a server to prove itself"));
  const afterRestart = await pageFetch(page, "/api/local/status");
  step.check(
    "Restart while attached waits for its supervisor's next server, and takes nothing over",
    grace !== undefined &&
      next.port === server.port &&
      !ownSpawn() &&
      afterRestart.status === 200 &&
      runs(supervisor),
    `${grace === undefined ? "no grace period in main.log" : after(grace)}; server pid ${server.pid} → ${next.pid} on port ${next.port}; status ${afterRestart.status}`,
  );
  await step.shot(page, "attached-restarted");

  // A restart from outside the app, which tells main nothing.
  const outside = await smoke.api("/api/local/restart", { method: "POST" });
  const third = await until(
    "the server's restart from outside",
    () => {
      const found = smoke.server();
      return found !== null && found.pid !== next.pid ? found : null;
    },
    15_000,
  );
  const answered = await until(
    "the page's status from the server restarted outside",
    async () => {
      const answer = await pageFetch(page, "/api/local/status");
      return answer.status === 200 ? answer : null;
    },
    30_000,
    500,
  );
  await page.goto("eidolon-app://app/");
  const footerAgain = await home(page);
  step.check(
    "it survives the server restarting from outside: the page loads on the next server",
    outside.status === 200 && answered.status === 200 && footerAgain.length > 0 && !ownSpawn(),
    `POST restart ${outside.status}; server pid ${next.pid} → ${third.pid}; the page loads Home again`,
  );

  // Quitting the app leaves the server running; the smoke stops it.
  const quitFrom = smoke.log("main").length;
  const ending = await quitApp(walk, driven.main, null);
  const asked = smoke.log("main").slice(quitFrom).includes("to a message box");
  const still = await serverStatus(walk, "/api/local/status");
  step.check(
    "quitting the app asks nothing and leaves the server running",
    ending.ok && !asked && still.status === 200,
    `${ending.detail}; ${asked ? "a quit box" : "no quit box"}; the server: ${still.detail}`,
  );
  supervisor.child.kill("SIGTERM");
  const stopped = await Promise.race([supervisor.exited, sleep(20_000).then(() => null)]);
  const lock = smoke.server();
  step.check(
    "the smoke stops the server, which exits 0",
    stopped?.code === 0 && lock === null,
    `its supervisor exited ${stopped === null ? "late" : (stopped.code ?? stopped.signal)}; its lock ${lock === null ? "gone" : "left"}`,
  );
}

async function quit(walk: Walk, step: Step) {
  const { smoke } = walk;
  const from = smoke.log("main").length;
  const main = smoke.start(walk.launch, LANGUAGE_ARGS);
  try {
    const started = await smoke.waitForLine("main", LINES.started, { from, timeoutMs: 30_000 });
    await smoke.waitForLine("main", LINES.appShown, { from, timeoutMs: 60_000 });
    const pid = Number(LINES.started.exec(started)?.[1]);
    await smoke.processes.adopt("backend", pid);
    const ending = await quitApp(walk, main, pid);
    step.check("--quit: the second launch, main and the backend exit 0", ending.ok, ending.detail);
  } finally {
    if (runs(main)) await smoke.quit(walk.launch).catch(() => undefined);
  }
  const left = await smoke.processes.settle(10_000);
  step.check(
    "nothing is left running",
    left.length === 0,
    left.length === 0 ? "nothing left" : left.join(", "),
  );
  const errors = [
    ...errorLines(smoke.log("main"), "main"),
    ...errorLines(smoke.log("backend"), "backend"),
  ];
  step.check(
    "no error lines in main.log or backend.log",
    errors.length === 0,
    errors.length === 0 ? "no error lines in either log" : errors.slice(0, 3).join(" | "),
  );
}
