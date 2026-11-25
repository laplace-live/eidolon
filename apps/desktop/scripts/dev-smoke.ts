// `pnpm smoke:desktop:dev`, the dev smoke: Playwright's Electron driver on the unpackaged app,
// its backend from source, on the kit's fakes, temporary data home and profile, in background mode
// under the focus watch and the window watch (all off with --headful). It builds the web app and
// apps/desktop/dist first, so it never runs on a stale build (--no-build runs on what is there),
// and prints one line per step. The run's folder holds results.json and the screenshots, and goes
// after a pass, as the kit has it; --keep copies them beside it first.
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import type {
  CharacterModel,
  CharacterModels,
  Status,
  TaskSnapshot,
} from "../../bot/src/local/api.ts";
import {
  COMPANION_FILE,
  COMPANION_LINES,
  EDGE_DIP,
  feetOf,
  MIN_SHOWN,
} from "../src/main/companion.ts";
import { COMPANION_PAGE } from "../src/main/policy.ts";
import { STRINGS } from "../src/main/strings.ts";
import type { Rectangle } from "../src/main/window-options.ts";
import { BRIDGE } from "../src/shared/bridge.ts";
import { buildApp, missingBuilds } from "./dev-smoke/build.ts";
import { type Microphone, microphoneWav } from "./dev-smoke/speech.ts";
import { described, type Step, Steps, until, writeResults } from "./dev-smoke/steps.ts";
import { type WindowReport, watchWindows } from "./dev-smoke/windows.ts";
import {
  CHAT_MESSAGE,
  COMPANION_LINE,
  COMPANION_REPLY,
  FILES_REPLY,
  GREETING,
  HEARD_REPLY,
  REPLY,
  SELFIE_REPLY,
  SELFIE_REQUEST,
  TASK_ACK,
  TASK_GOAL,
  TASK_LINE,
  TASK_MODEL,
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
/** main.log's line for a Choose Folder that background mode answered with no folder. */
const NO_FOLDER_DIALOG = "Eidolon: background mode didn't open the folder dialog";
/** How main.log's line for a notification background mode kept off screen starts. */
const NOTICE = "Eidolon: background mode didn't show a notification: ";
/** main.log's line when main lets the page go over its beforeunload. */
const LET_GO = "Eidolon: the page asked to stay (beforeunload); letting it go";
/** main.log's line once the window has loaded the failure page. */
const FAILED_SHOWN = "Eidolon: the window shows eidolon-app://shell/failed";
/** In main.log's line for a box background mode answered, just before the box's words. */
const BOX = "to a message box: ";
/** main.log's line for the quit box over an unsaved edit, with nothing else running. */
const UNSAVED_QUIT_BOX = `Eidolon: background mode answered "${STRINGS.en.label.quit}" ${BOX}${STRINGS.en.text.quitTitle} ${STRINGS.en.text.unsavedLost(null)}`;
/** What Settings' Desktop App says under each option this copy can't offer, by why. */
const DESKTOP_NOTES = {
  background: "Background mode leaves this computer as it is.",
  unpackaged: "Available in the installed app only.",
} as const;
const MODEL_FIXTURE = join(ROOT, "apps/bot/test/local/fixtures/psd2live/tml.p2lrt");
/** What Settings says under Desktop Companion in background mode. */
const COMPANION_NOTE = "Background mode never shows her.";
/** How main.log's line for a menu background mode closed with no pick starts, before its labels. */
const MENU_LINE = "Eidolon: background mode didn't open a menu: ";
/** Her menu with no call of hers up, the test rig her one model, which has no outfits. */
const HER_MENU = "Call, Open LAPLACE Eidolon, Appearance, Size, Always on Top, Hide";
/** How her menu starts while a call of hers is up. */
const HER_CALL_MENU = "Hang Up, Mute Microphone, Open LAPLACE Eidolon";
/** `window.eidolonCompanion`'s members, sorted. */
const HER_BRIDGE = [
  "drag",
  "drawn",
  "follow",
  "hit",
  "link",
  "menu",
  "onCursor",
  "platform",
  "shape",
];
/** Her reply's words, as the chat shows them after its direction. */
const COMPANION_WORDS = COMPANION_REPLY.replace(/^\[[^\]]*\]\s*/, "");

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
  /** A tool result's: `started` once her start_task call made its task, named in `result`. */
  readonly stage?: string;
  readonly result?: { readonly task?: unknown };
}

/** A chat of hers the page has open. */
interface OpenChat {
  readonly id: string;
  readonly log: Locator;
  readonly box: Locator;
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

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Her page's root's data attributes, by their dataset names. */
type HerData = Readonly<Record<string, string | undefined>>;

/** A mouse event for her window, at a point of it, or of the screen with `global`. */
interface HerInput {
  readonly type: "mouseMove" | "mouseDown" | "mouseUp";
  readonly at: Point;
  readonly global?: boolean;
  readonly button?: "left" | "right";
  /** The left button held, as through a drag. */
  readonly held?: boolean;
}

/** What her page showed while a watch ran: data-speaking read true, and the widest data-mouth. */
interface Heard {
  readonly speaking: boolean;
  readonly widest: number;
}

/** Her eyes in her window, `data-probe`'s `x,y`, or her picture's centre; null while she loads. */
function probeOf(data: HerData): Point | null {
  const [x, y] = (data.probe ?? "").split(",").map(Number);
  return data.probe && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function placed(bounds: Rectangle | null): string {
  return bounds === null
    ? "gone"
    : `${bounds.width}×${bounds.height} at (${bounds.x}, ${bounds.y})`;
}

/**
 * The desktop companion's window as the step drives it: her page, found by its address, and what
 * it logged; input reaches it through sendInputEvent, never the system's cursor. Declared above
 * the walk, which runs at the module's top level: a class, unlike a function, isn't hoisted.
 */
class Her {
  /** Console errors and uncaught exceptions on her page, from its first load. */
  readonly errors: string[] = [];
  readonly #app: ElectronApplication;
  readonly #watched = new WeakSet<Page>();
  #page: Page | null = null;

  constructor(app: ElectronApplication) {
    this.#app = app;
  }

  get page(): Page {
    if (this.#page === null) throw new Error("her page wasn't found");
    return this.#page;
  }

  /** Her page, found again by its address, since her page loaded again may come as another Page. */
  async find(timeoutMs = 15_000): Promise<Page> {
    const page = await until(
      `a window at ${COMPANION_PAGE}`,
      () => this.#app.windows().find((candidate) => candidate.url() === COMPANION_PAGE),
      timeoutMs,
      100,
    );
    if (!this.#watched.has(page)) {
      this.#watched.add(page);
      page.setDefaultTimeout(15_000);
      page.on("console", (message) => {
        if (message.type() === "error") this.errors.push(message.text());
      });
      page.on("pageerror", (error) => this.errors.push(error.message));
    }
    this.#page = page;
    return page;
  }

  data(): Promise<HerData> {
    return this.page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-companion-root]");
      return root === null ? {} : { ...root.dataset };
    });
  }

  /** Her data once `done` holds for it; throws naming `what` at the timeout. */
  when(what: string, done: (data: HerData) => boolean, timeoutMs: number): Promise<HerData> {
    return until(
      what,
      async () => {
        const data = await this.data();
        return done(data) ? data : null;
      },
      timeoutMs,
      50,
    );
  }

  /** Her eyes in her window, once she is drawn. */
  async probe(): Promise<Point> {
    const point = probeOf(
      await this.when("her eye point", (data) => probeOf(data) !== null, 10_000),
    );
    if (point === null) throw new Error("her page has no eye point");
    return point;
  }

  /** Her window's bounds as main has them; null with no window at her page. */
  bounds(): Promise<Rectangle | null> {
    return this.#app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()
          .find((win) => win.webContents.getURL() === url)
          ?.getBounds() ?? null,
      COMPANION_PAGE,
    );
  }

  /** One mouse event into her window, its screen point taken from her window's place now. */
  async send(input: HerInput): Promise<void> {
    const sent = await this.#app.evaluate(
      ({ BrowserWindow }, { url, input }) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url);
        if (win === undefined) return false;
        const place = win.getBounds();
        const x = input.global === true ? input.at.x - place.x : input.at.x;
        const y = input.global === true ? input.at.y - place.y : input.at.y;
        win.webContents.sendInputEvent({
          type: input.type,
          x,
          y,
          globalX: place.x + x,
          globalY: place.y + y,
          ...(input.button === undefined ? {} : { button: input.button, clickCount: 1 }),
          ...(input.held === true ? { modifiers: ["leftbuttondown" as const] } : {}),
        });
        return true;
      },
      { url: COMPANION_PAGE, input },
    );
    if (!sent) throw new Error("her window is gone");
  }

  /**
   * A move her page must see, data-moves growing within 1 s, so a lost input never passes for a
   * probe that read wrong.
   */
  async move(at: Point, drag: { readonly global?: boolean; readonly held?: boolean } = {}) {
    const before = Number((await this.data()).moves ?? 0);
    await this.send({ type: "mouseMove", at, ...drag });
    const seen = await this.when("the move", (data) => Number(data.moves ?? 0) > before, 1000).then(
      () => true,
      () => false,
    );
    if (!seen) throw new Error("her page never saw the injected move");
  }

  /** A move onto `at`, which must find her there: her window takes clicks then. */
  async hover(at: Point): Promise<void> {
    await this.move(at);
    await this.when("data-hit true over her", (data) => data.hit === "true", 2000);
  }

  async click(at: Point, button: "left" | "right"): Promise<void> {
    await this.send({ type: "mouseDown", at, button });
    await this.send({ type: "mouseUp", at, button });
  }

  /** Starts a watch in her page that reads her data every 50 ms. */
  async watch(): Promise<void> {
    await this.page.evaluate(() => {
      const g = globalThis as { __devSmokeHeard?: { speaking: boolean; widest: number } };
      const heard = { speaking: false, widest: 0 };
      g.__devSmokeHeard = heard;
      const timer = setInterval(() => {
        if (g.__devSmokeHeard !== heard) clearInterval(timer);
        const data = document.querySelector<HTMLElement>("[data-companion-root]")?.dataset;
        if (data === undefined) return;
        if (data.speaking === "true") heard.speaking = true;
        heard.widest = Math.max(heard.widest, Number(data.mouth ?? 0));
      }, 50);
    });
  }

  /** What the watch saw since it started. */
  heard(): Promise<Heard> {
    return this.page.evaluate(() => {
      const g = globalThis as { __devSmokeHeard?: { speaking: boolean; widest: number } };
      return {
        speaking: g.__devSmokeHeard?.speaking ?? false,
        widest: g.__devSmokeHeard?.widest ?? 0,
      };
    });
  }

  /**
   * Reads her data at each animation frame until data-speaking has read true and, with `mouth`,
   * data-mouth has read above 0.2; what it saw, met or not.
   */
  async speaks(mouth: boolean, timeoutMs: number): Promise<Heard & { readonly met: boolean }> {
    await this.page.evaluate(() => {
      (globalThis as { __devSmokeSpeaks?: Heard }).__devSmokeSpeaks = {
        speaking: false,
        widest: 0,
      };
    });
    const met = await this.page
      .waitForFunction(
        (mouth) => {
          const seen = (globalThis as { __devSmokeSpeaks?: { speaking: boolean; widest: number } })
            .__devSmokeSpeaks;
          const data = document.querySelector<HTMLElement>("[data-companion-root]")?.dataset;
          if (seen === undefined || data === undefined) return false;
          if (data.speaking === "true") seen.speaking = true;
          seen.widest = Math.max(seen.widest, Number(data.mouth ?? 0));
          return seen.speaking && (!mouth || seen.widest > 0.2);
        },
        mouth,
        { polling: "raf", timeout: timeoutMs },
      )
      .then(
        () => true,
        () => false,
      );
    const seen = await this.page.evaluate(
      () =>
        (globalThis as { __devSmokeSpeaks?: Heard }).__devSmokeSpeaks ?? {
          speaking: false,
          widest: 0,
        },
    );
    return { met, ...seen };
  }

  /** The alpha of her window's own pixels at (2, 2) and at `point`, from a capture of it. */
  capture(
    point: Point,
  ): Promise<{ readonly empty: boolean; readonly corner: number; readonly at: number }> {
    return this.#app.evaluate(
      async ({ BrowserWindow }, { url, point }) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url);
        if (win === undefined) throw new Error("her window is gone");
        // With no stayHidden, her page counts as visible while the capture runs.
        const image = await win.webContents.capturePage();
        if (image.isEmpty()) return { empty: true, corner: -1, at: -1 };
        const size = image.getSize();
        const scale = size.width / win.getBounds().width;
        const bitmap = image.toBitmap();
        const alpha = (x: number, y: number) => {
          const column = Math.min(size.width - 1, Math.round(x * scale));
          const row = Math.min(size.height - 1, Math.round(y * scale));
          return bitmap[(row * size.width + column) * 4 + 3] ?? -1;
        };
        return { empty: false, corner: alpha(2, 2), at: alpha(point.x, point.y) };
      },
      { url: COMPANION_PAGE, point },
    );
  }

  /** Forces the dark scheme on her page, as the theme would, or puts back what it had. */
  async dark(on: boolean): Promise<void> {
    await this.page.evaluate((on) => {
      const root = document.documentElement;
      const g = globalThis as { __devSmokeScheme?: { scheme: string; dark: boolean } };
      if (on) {
        g.__devSmokeScheme = {
          scheme: root.style.colorScheme,
          dark: root.classList.contains("dark"),
        };
        root.style.colorScheme = "dark";
        root.classList.add("dark");
      } else if (g.__devSmokeScheme !== undefined) {
        root.style.colorScheme = g.__devSmokeScheme.scheme;
        root.classList.toggle("dark", g.__devSmokeScheme.dark);
      }
      return new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    }, on);
  }
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
    "Choose Folder: no dialog in background mode, and main's pick in the draft",
    (step) => chooseFolder(walk, first, step),
  );
  await steps.run("Settings' Desktop App: both options left as they are", (step) =>
    desktopOptions(walk, first, step),
  );
  if (walk.background) {
    await steps.run(
      "the desktop companion: never on screen, drawn and guarded, her mood and voice from the chat, her mouth from the call, Pop Out",
      (step) => companion(walk, first, step),
    );
  } else {
    console.log("(the desktop companion's step is off: --headful would show her and her menu)");
  }
  await steps.run("a task that waits: the watch's notices of its start and its end", (step) =>
    waitingTask(walk, first, step),
  );
  await steps.run(
    "attach: after a quit, a server started first is used, restarted and left running",
    (step) => attach(walk, first, step),
  );
  await steps.run(
    "quit: over an unsaved edit, the failure page and Try Again, then --quit's box warns of it and stops main and the backend, leaving nothing",
    (step) => quit(walk, step),
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
  const footer = page.getByText(/^LAPLACE Eidolon \S+( · server \S+)?$/);
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
  const expected = `LAPLACE Eidolon ${DESKTOP_VERSION} · server ${SERVER_VERSION}`;
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

/** A new chat of hers alone, from the sidebar's New Chat, once her greeting shows. */
async function startChat(page: Page, persona: PersonaNames): Promise<OpenChat> {
  await page.getByRole("button", { name: "New Chat" }).first().click();
  await page.getByRole("menuitemcheckbox", { name: persona.name }).click();
  await page.getByRole("menuitem", { name: "Start Chat" }).click();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const log = page.getByRole("log", { name: "Conversation" });
  await log.getByText(GREETING).waitFor({ timeout: 30_000 });
  const box = page.getByRole("textbox", { name: `Message ${persona.shortName}` });
  return { id, log, box };
}

async function chat(walk: Walk, driven: Driven, step: Step) {
  const { smoke } = walk;
  const { fakes } = smoke;
  const { page } = driven;
  const persona = await personaNames(page);
  walk.persona = persona;

  const { id, log, box } = await startChat(page, persona);
  walk.chatId = id;

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
    const strip = document.querySelector("[data-title-strip]");
    const control = strip?.querySelector("button");
    const top = (selector: string): number | null =>
      document.querySelector(selector)?.getBoundingClientRect().top ?? null;
    const overlay = (
      navigator as Navigator & { windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect } }
    ).windowControlsOverlay;
    return {
      shell: document.documentElement.dataset.shell ?? null,
      rows: rows.length,
      below: rows.filter((row) => row.closest('[data-slot="sidebar"], main') !== null).length,
      strip: strip == null ? null : regionOf(strip),
      height: strip?.getBoundingClientRect().height ?? 0,
      start: control?.getBoundingClientRect().left ?? 0,
      control: control == null ? null : regionOf(control),
      sidebar: top('[data-slot="sidebar-container"]'),
      card: top('[data-slot="sidebar-inset"]'),
      lights: overlay?.getTitlebarAreaRect().x ?? 0,
    };
  });
  const mark = process.platform === "darwin" ? "mac" : "win";
  // Without titleBarOverlay macOS publishes no env(titlebar-area-*), and the strip's buttons sit
  // under the traffic lights.
  const clear =
    process.platform !== "darwin" || (chrome.lights > 0 && chrome.start >= chrome.lights - 8);
  step.check(
    "the preload marks the page, whose strip drags while its buttons don't, above the sidebar and the page",
    chrome.shell === mark &&
      chrome.strip === "drag" &&
      chrome.control === "no-drag" &&
      chrome.below === 0 &&
      (chrome.sidebar ?? 0) >= chrome.height &&
      (chrome.card ?? 0) >= chrome.height &&
      chrome.height > 0 &&
      clear,
    `data-shell=${chrome.shell}; the strip ${chrome.strip}, ${chrome.height} px tall, its buttons ${chrome.control} from ${chrome.start} px (the overlay's area from ${chrome.lights}); the sidebar from ${chrome.sidebar}, the page from ${chrome.card}; ${chrome.rows} drag rows, ${chrome.below} below the strip`,
  );
  await step.shot(page, "chrome");

  // The strip's Back and Forward, through the app's own pages and over an unsaved edit.
  const path = (): string => new URL(page.url()).pathname;
  const from = path();
  await page.getByRole("link", { name: "Studio" }).first().click();
  await page.waitForURL(`eidolon-app://app/personas/${PERSONA}`);
  await page.getByRole("link", { name: "Prompt", exact: true }).click();
  await page.waitForURL(`eidolon-app://app/personas/${PERSONA}/prompt`);
  const area = page.getByLabel("System Prompt", { exact: true });
  await area.click();
  await area.pressSequentially(" unsaved");
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  const goBack = page.getByRole("button", { name: "Go Back" });
  const box = page.getByRole("alertdialog");
  await goBack.click();
  await box.getByRole("button", { name: "Keep Editing" }).click();
  await box.waitFor({ state: "hidden" });
  const kept = path();
  await goBack.click();
  await box.getByRole("button", { name: "Discard Changes" }).click();
  await page.waitForURL(`eidolon-app://app/personas/${PERSONA}`);
  // The box fades out after the navigation goes on.
  const left = await box.waitFor({ state: "hidden", timeout: 5000 }).then(
    () => true,
    () => false,
  );
  await goBack.click();
  await page.waitForURL(`eidolon-app://app${from}`);
  await page.getByRole("button", { name: "Go Forward" }).click();
  await page.waitForURL(`eidolon-app://app/personas/${PERSONA}`);
  step.check(
    "the strip's Back and Forward walk the app's pages; over an unsaved edit, Keep Editing stays and Discard Changes leaves",
    kept === `/personas/${PERSONA}/prompt` && left,
    `${from} → the studio → its prompt, edited; Back, Keep Editing: ${kept}; Back, Discard Changes: the studio, the box ${left ? "gone" : "still up"}; Back: ${from}; Forward: ${path()}`,
  );
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

/** Settings at the section its nav names `label`, from the sidebar's link. */
async function settingsSection(page: Page, label: string, tab: string): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.waitForURL(/^eidolon-app:\/\/app\/settings/, { timeout: 10_000 });
  await page
    .getByRole("navigation", { name: "Settings Sections" })
    .getByRole("link", { name: label, exact: true })
    .click();
  await page.waitForURL(`eidolon-app://app/settings?tab=${tab}`, { timeout: 10_000 });
}

/** Whether the app's settings.yaml names `text` anywhere. */
function savedSettingsName(walk: Walk, text: string): boolean {
  const file = join(walk.smoke.run.home, "settings.yaml");
  return existsSync(file) && readFileSync(file, "utf8").includes(text);
}

/**
 * Assistant Mode's Choose Folder, beside a line typed into its folders: main's own handler, whose
 * dialog background mode answers with none; then main's handler replaced by one that answers a
 * folder, as the dialog would, which the page adds to the draft and leaves unsaved. The replacement
 * stays for the rest of this launch, which saves no folder.
 */
async function chooseFolder(walk: Walk, driven: Driven, step: Step) {
  const { smoke } = walk;
  const { page, app } = driven;
  await settingsSection(page, "Assistant Mode", "assistant");
  const box = page.getByLabel("Assistant Folders", { exact: true });
  const button = page.getByRole("button", { name: "Choose Folder", exact: true });
  await button.waitFor({ timeout: 15_000 });
  const typed = join(smoke.run.scratch, "notes");
  await box.fill(typed);
  // Headful, main's own handler would open the dialog.
  if (walk.background) {
    const from = smoke.log("main").length;
    await button.click();
    const line = await smoke
      .waitForLine("main", NO_FOLDER_DIALOG, { from, timeoutMs: 10_000 })
      .catch(() => null);
    // The page's answer follows main's line: a moment for a draft it would change.
    await sleep(500);
    const kept = await box.inputValue();
    step.check(
      "background mode opens no folder dialog, and the draft stays as typed",
      line !== null && kept === typed,
      `${line === null ? "main.log says nothing of the dialog" : after(line)}; the draft ${kept === typed ? "stays as typed" : `reads ${JSON.stringify(kept)}`}`,
    );
  }
  const picked = join(smoke.run.scratch, "Picked Folder");
  mkdirSync(picked);
  await app.evaluate(
    ({ ipcMain }, { channel, folder }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => folder);
    },
    { channel: BRIDGE.chooseFolder, folder: picked },
  );
  await button.click();
  const drafted = await until(
    "the picked folder in the draft",
    async () => {
      const value = await box.inputValue();
      return value === typed ? null : value;
    },
    10_000,
  );
  await step.shot(page, "choose-folder");
  const saved = savedSettingsName(walk, picked);
  step.check(
    "a folder main answers joins the draft as a line of its own, unsaved",
    drafted === `${typed}\n${picked}` && !saved,
    `main's handler, replaced, answered ${picked}: the draft reads ${JSON.stringify(drafted)}; settings.yaml ${saved ? "names it" : "doesn't name it"}`,
  );
}

/**
 * Settings' Desktop App: Open at Login and the terminal command each say why this copy leaves the
 * computer as it is, background mode before the unpackaged app, and offer nothing to click.
 */
async function desktopOptions(walk: Walk, driven: Driven, step: Step) {
  const { page } = driven;
  await settingsSection(page, "Desktop", "desktop");
  const note = walk.background ? DESKTOP_NOTES.background : DESKTOP_NOTES.unpackaged;
  const options = [
    ["login-item", (row: Locator) => row.getByRole("switch")],
    ["terminal-command", (row: Locator) => row.getByRole("button")],
  ] as const;
  const found: string[] = [];
  let pass = true;
  for (const [option, controlOf] of options) {
    const row = page.locator(`[data-desktop-option="${option}"]`);
    const says = await row
      .getByText(note, { exact: true })
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    const controls = controlOf(row);
    const count = await controls.count();
    const disabled = await controls.evaluateAll((elements) =>
      elements.every((element) => (element as HTMLButtonElement).disabled),
    );
    pass &&= says && count === 1 && disabled;
    found.push(
      `${option}: ${says ? "says so" : `doesn't say "${note}"`}, ${count} control(s) ${disabled ? "disabled" : "enabled"}`,
    );
  }
  await step.shot(page, "desktop-options");
  step.check(`both say "${note}", their controls disabled`, pass, found.join("; "));
}

/** The test rig as her active model, imported through the API unless she has a model already. */
async function activeRig(walk: Walk): Promise<string> {
  const { smoke } = walk;
  const listed = await smoke.api(`/api/local/personas/${PERSONA}/models`);
  if (!listed.ok) throw new Error(`GET her models: ${listed.status}`);
  const { models } = (await listed.json()) as CharacterModels;
  let id = models[0]?.id;
  if (id === undefined) {
    const imported = await smoke.api(`/api/local/personas/${PERSONA}/models?filename=tml.p2lrt`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(readFileSync(MODEL_FIXTURE)),
    });
    if (imported.status !== 201) throw new Error(`POST the test rig: ${imported.status}`);
    id = ((await imported.json()) as CharacterModel).id;
  }
  await setModel(walk, id);
  return id;
}

/** Her active model, or none with null, through the API. */
async function setModel(walk: Walk, id: string | null): Promise<void> {
  const put = await walk.smoke.api("/api/local/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "persona",
      persona: PERSONA,
      values: { "appearance.model": id },
    }),
  });
  await put.body?.cancel();
  if (put.status !== 200) throw new Error(`PUT settings: ${put.status}`);
}

/** A pick from her menu for the call, sent to the main window as main sends it (`companion-pick`). */
async function sendPick(driven: Driven, pick: "mute" | "unmute"): Promise<void> {
  await driven.app.evaluate(
    ({ BrowserWindow }, { url, channel, pick }) => {
      const main = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL() !== url);
      main?.webContents.send(channel, pick);
    },
    { url: COMPANION_PAGE, channel: BRIDGE.companionPick, pick },
  );
}

async function activeCalls(walk: Walk): Promise<number> {
  const response = await walk.smoke.api("/api/local/status");
  return ((await response.json()) as Partial<Status>).activeCalls ?? 0;
}

/** The feet companion.json keeps, or null for none, or for no file. */
function savedFeet(walk: Walk): Point | null {
  try {
    const file = join(walk.smoke.run.profile, COMPANION_FILE);
    const feet = (JSON.parse(readFileSync(file, "utf8")) as { feet?: Point | null }).feet;
    return feet ?? null;
  } catch {
    return null;
  }
}

/** Settings → Desktop's Desktop Companion switch. */
function companionSwitch(page: Page): Locator {
  return page.locator('[data-desktop-option="companion"]').getByRole("switch");
}

/**
 * The desktop companion, in background mode, which makes her and has her draw but never shows her:
 * the test rig her active model, Settings' switch turns her on; her page, off screen, has her bridge
 * alone, no permission, no other address and nothing painted around her; injected input hovers her,
 * a tap moves her face, a drag moves her window and her menu is logged; her chat sets her mood and
 * her voice message makes her speak; a call with her moves her mouth and Pop Out hides the window.
 * Without WebGL she is her picture and the call docks, and what needs a stage is skipped.
 */
async function companion(walk: Walk, driven: Driven, step: Step) {
  const model = await activeRig(walk);
  const her = new Her(driven.app);
  try {
    const stage = await turnOn(walk, driven, her, model, step);
    await checkOffScreen(walk, driven, step, "with her drawn");
    await herBridge(her, step);
    await noPermission(walk, her, step);
    await lockedToHerPage(walk, her, step);
    await transparent(her, stage, step);
    await hoverAndTap(walk, her, stage, step);
    await herDrag(walk, her, step);
    await herPlace(walk, driven, her, step);
    await modelShown(walk, driven, model, step);
    const menu = await herMenu(walk, her);
    step.check(
      "her menu is logged as background mode closes it",
      menu === `${MENU_LINE}${HER_MENU}`,
      menu ?? "main.log has no menu line within 5 s",
    );
    await moodAndVoice(walk, driven, her, step);
    const video = await callWithHer(walk, driven, her, stage, step);
    if (video) await popOut(walk, driven, her, step);
    else
      step.check(
        "Pop Out",
        true,
        "Pop Out skipped: the call docked, and Pop Out is the video screen's",
      );
    await checkOffScreen(walk, driven, step, "after her call");
    await turnOff(walk, driven, her, step);
    step.check(
      "her page logged no console error",
      her.errors.length === 0,
      her.errors.length === 0
        ? "her page logged no console error"
        : her.errors.slice(0, 3).join(" | "),
    );
  } finally {
    await putBack(walk, driven.page, step);
  }
}

/** Settings → Desktop turns her on, and her page draws her off screen; whether as her model. */
async function turnOn(walk: Walk, driven: Driven, her: Her, model: string, step: Step) {
  const { smoke } = walk;
  const { page } = driven;
  await settingsSection(page, "Desktop", "desktop");
  const noted = await page
    .locator('[data-desktop-option="companion"]')
    .getByText(COMPANION_NOTE, { exact: true })
    .waitFor({ timeout: 15_000 })
    .then(
      () => true,
      () => false,
    );
  const toggle = companionSwitch(page);
  await until("her switch, her state read", () => toggle.isEnabled(), 15_000);
  const was = await toggle.getAttribute("aria-checked");
  const from = smoke.log("main").length;
  await toggle.click();
  const on = await smoke
    .waitForLine("main", COMPANION_LINES.on, { from, timeoutMs: 10_000 })
    .catch(() => null);
  step.check(
    "Settings → Desktop's switch turns her on, the test rig her active model",
    noted && was === "false" && on !== null,
    `the test rig (${model}) made active through the API; her row ${noted ? "says" : "doesn't say"} "${COMPANION_NOTE}"; her switch read ${was}; ${on === null ? "main.log says nothing of her" : after(on)}`,
  );
  await her.find();
  const drawn = await smoke.waitForLine("main", LINES.companionDrawn, { from, timeoutMs: 60_000 });
  const offScreen = await smoke
    .waitForLine("main", LINES.companionOffScreen, { from, timeoutMs: 10_000 })
    .catch(() => null);
  const { view } = await her.when(
    "her view",
    (data) => data.view === "model" || data.view === "picture",
    10_000,
  );
  const shown = smoke.log("main").slice(from).includes(COMPANION_LINES.shown);
  step.check(
    "her page draws her, and background mode keeps her off screen",
    LINES.companionDrawn.exec(drawn)?.[1] === view && offScreen !== null && !shown,
    `${after(drawn)}; ${offScreen === null ? "no off-screen line" : after(offScreen)}${shown ? `, yet "${after(COMPANION_LINES.shown)}"` : ""}${view === "picture" ? "; her picture, with no WebGL here: what needs a stage is skipped" : ""}`,
  );
  return view === "model";
}

/** Her page has her bridge alone, and her mark, never the main window's. */
async function herBridge(her: Her, step: Step) {
  const seen = await her.page.evaluate(() => {
    const g = globalThis as { eidolonDesktop?: unknown; eidolonCompanion?: object };
    const root = document.documentElement;
    return {
      desktop: g.eidolonDesktop !== undefined,
      members: g.eidolonCompanion === undefined ? null : Object.keys(g.eidolonCompanion).sort(),
      marked: root.hasAttribute("data-companion"),
      shell: root.hasAttribute("data-shell"),
    };
  });
  step.check(
    "her page has eidolonCompanion alone, and data-companion, never data-shell",
    !seen.desktop &&
      JSON.stringify(seen.members) === JSON.stringify(HER_BRIDGE) &&
      seen.marked &&
      !seen.shell,
    `eidolonDesktop ${seen.desktop ? "is there" : "is undefined"}; eidolonCompanion ${seen.members === null ? "is undefined" : `has ${seen.members.join(", ")}`}; <html> ${seen.marked ? "has" : "lacks"} data-companion and ${seen.shell ? "has" : "lacks"} data-shell`,
  );
}

/** Her page asks for the microphone and reads its permissions: main denies her everything. */
async function noPermission(walk: Walk, her: Her, step: Step) {
  const { smoke } = walk;
  const from = smoke.log("main").length;
  const asked = await her.page.evaluate(async () => {
    const query = (name: string) =>
      navigator.permissions.query({ name: name as PermissionName }).then(
        (status) => status.state,
        (error: Error) => `refused (${error.name})`,
      );
    const media = await navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        for (const track of stream.getTracks()) track.stop();
        return "granted";
      },
      (error: Error) => error.name,
    );
    return {
      media,
      microphone: await query("microphone"),
      clipboard: await query("clipboard-write"),
    };
  });
  const denied = await smoke
    .waitForLine("main", "Eidolon: denied the page media", { from, timeoutMs: 5000 })
    .catch(() => null);
  step.check(
    "her page gets no permission: the microphone and clipboard writes denied",
    asked.media === "NotAllowedError" &&
      denied !== null &&
      asked.microphone === "denied" &&
      asked.clipboard === "denied",
    `getUserMedia({audio}): ${asked.media}, ${denied === null ? "main.log says nothing" : `"${after(denied)}"`}; the microphone's permission ${asked.microphone}, clipboard-write's ${asked.clipboard}`,
  );
}

/** Her window keeps her one page: a pushState loads it again, a navigation is cancelled, nothing opens. */
async function lockedToHerPage(walk: Walk, her: Her, step: Step) {
  const { smoke } = walk;
  let from = smoke.log("main").length;
  await her.page.evaluate(() => history.pushState(null, "", "/settings"));
  const left = await smoke
    .waitForLine("main", "the companion left its page", { from, timeoutMs: 5000 })
    .catch(() => null);
  const back = await her.find(5000).then(
    () => true,
    () => false,
  );
  const leftAt = left === null ? from : smoke.log("main").indexOf(left, from) + left.length;
  const again = await smoke
    .waitForLine("main", LINES.companionDrawn, { from: leftAt, timeoutMs: 30_000 })
    .catch(() => null);
  await her.find();
  await her.when(
    "her view again",
    (data) => data.view === "model" || data.view === "picture",
    10_000,
  );

  from = smoke.log("main").length;
  await her.page.evaluate(() => {
    location.assign("/settings");
    return true;
  });
  const cancelled = await smoke
    .waitForLine("main", "Eidolon: cancelled the companion's navigation to", {
      from,
      timeoutMs: 5000,
    })
    .catch(() => null);
  await sleep(500);
  const stayed = her.page.url() === COMPANION_PAGE;

  from = smoke.log("main").length;
  const none = await her.page.evaluate(() => window.open("https://example.com/") === null);
  const refused = await smoke
    .waitForLine("main", "Eidolon: the companion refused to open a window", {
      from,
      timeoutMs: 5000,
    })
    .catch(() => null);
  step.check(
    "her window keeps her one page: a pushState loads it again, a navigation is cancelled, no window opens",
    left !== null &&
      back &&
      again !== null &&
      cancelled !== null &&
      stayed &&
      none &&
      refused !== null,
    `pushState("/settings"): ${left === null ? "main.log says nothing" : after(left)}, ${back ? "back" : "not back"} at her page within 5 s, ${again === null ? "never drawn again" : "drawn again"}; location.assign: ${cancelled === null ? "not cancelled" : "cancelled"}, ${stayed ? "she stays" : `at ${her.page.url()}`}; window.open: ${none ? "null" : "a window"}, ${refused === null ? "main.log says nothing" : "refused"}`,
  );
}

/** A capture of her hidden window: nothing painted at its corner, light or dark, and her eyes opaque. */
async function transparent(her: Her, stage: boolean, step: Step) {
  const name = "her window paints nothing around her, in the dark scheme too";
  const probe = await her.probe();
  const light = await her.capture(probe);
  await her.dark(true);
  const dark = await her.capture(probe).finally(() => her.dark(false));
  if (light.empty || dark.empty) {
    step.check(name, false, "an empty capture of the hidden window");
    return;
  }
  step.check(
    name,
    light.corner === 0 && dark.corner === 0 && (!stage || light.at > 200),
    `a capture's alpha at (2, 2) ${light.corner}, with the dark scheme forced ${dark.corner}; at her eyes ${stage ? light.at : "not read: her picture"}`,
  );
}

/** Injected moves: over her eyes her window takes clicks, at her corner it doesn't; a tap on her head. */
async function hoverAndTap(walk: Walk, her: Her, stage: boolean, step: Step) {
  const probe = await her.probe();
  await her.hover(probe);
  await her.move({ x: 2, y: 2 });
  const corner = await her.when(
    "data-hit false at her corner",
    (data) => data.hit === "false",
    2000,
  );
  await her.hover(probe);
  const moves = (await her.data()).moves;
  step.check(
    "injected moves reach her page: her eyes take clicks, her corner passes them",
    corner.hit === "false",
    `data-hit true at her eyes (${probe.x}, ${probe.y}), false at (2, 2), true again; ${moves} moves seen`,
  );
  if (!stage) {
    step.check("a tap on her head", true, "a tap's area skipped: her picture is one area");
    return;
  }
  const before = JSON.stringify(walk.smoke.fakes.counts());
  await her.click(probe, "left");
  const pulse = await her
    .when("data-pulse shy", (data) => data.pulse === "shy", 2000)
    .then(
      () => true,
      () => false,
    );
  const asked = JSON.stringify(walk.smoke.fakes.counts()) !== before;
  step.check(
    "a tap on her head lends her shy, with no model call",
    pulse && !asked,
    `data-pulse ${pulse ? "shy" : `never shy, but "${(await her.data()).pulse}"`}; the fakes' counts ${asked ? "changed" : "unchanged"}`,
  );
}

/** A drag from her eyes, 60 px left and 40 up in four steps: her window follows, and her feet are kept. */
async function herDrag(walk: Walk, her: Her, step: Step) {
  const probe = await her.probe();
  await her.hover(probe);
  const start = await her.bounds();
  if (start === null) throw new Error("her window is gone");
  const grab = { x: start.x + probe.x, y: start.y + probe.y };
  await her.send({ type: "mouseDown", at: probe, button: "left" });
  for (let i = 1; i <= 4; i++) {
    await her.move({ x: grab.x - 15 * i, y: grab.y - 10 * i }, { global: true, held: true });
  }
  await her.send({
    type: "mouseUp",
    at: { x: grab.x - 60, y: grab.y - 40 },
    global: true,
    button: "left",
  });
  // The drop saves her feet: wait for them, not the window, which the last move put there.
  const dropped = await until(
    "her feet kept where the drag left her",
    async () => {
      const bounds = await her.bounds();
      const feet = savedFeet(walk);
      if (bounds === null || feet === null) return null;
      const own = feetOf(bounds);
      return feet.x === own.x && feet.y === own.y ? bounds : null;
    },
    2000,
    100,
  ).catch(() => null);
  const end = dropped ?? (await her.bounds());
  const moved =
    end !== null && Math.abs(end.x - start.x + 60) <= 2 && Math.abs(end.y - start.y + 40) <= 2;
  step.check(
    "a drag moves her window by the pointer's travel, and companion.json keeps her feet",
    dropped !== null && moved,
    `her window ${placed(start)} → ${placed(end)}; companion.json's feet ${JSON.stringify(savedFeet(walk))}`,
  );
}

/**
 * A drag far past her display's bottom right leaves a quarter of her window on it, which companion.json
 * keeps; then Settings → Desktop's Reset Position stands her at her first place, saving no feet.
 */
async function herPlace(walk: Walk, driven: Driven, her: Her, step: Step) {
  const probe = await her.probe();
  await her.hover(probe);
  const start = await her.bounds();
  if (start === null) throw new Error("her window is gone");
  const display = await driven.app.evaluate(
    ({ screen }, at) => screen.getDisplayNearestPoint(at).bounds,
    { x: Math.round(start.x + start.width / 2), y: Math.round(start.y + start.height / 2) },
  );
  const grab = { x: start.x + probe.x, y: start.y + probe.y };
  const far = { x: grab.x + display.width, y: grab.y + display.height };
  await her.send({ type: "mouseDown", at: probe, button: "left" });
  for (let i = 1; i <= 4; i++) {
    const at = {
      x: Math.round(grab.x + ((far.x - grab.x) * i) / 4),
      y: Math.round(grab.y + ((far.y - grab.y) * i) / 4),
    };
    await her.move(at, { global: true, held: true });
  }
  await her.send({ type: "mouseUp", at: far, global: true, button: "left" });
  const kept = await until(
    "her feet kept past the edge",
    async () => {
      const bounds = await her.bounds();
      const feet = savedFeet(walk);
      if (bounds === null || feet === null) return null;
      const own = feetOf(bounds);
      return feet.x === own.x && feet.y === own.y && bounds.x > start.x ? bounds : null;
    },
    3000,
    100,
  ).catch(() => null);
  const right = display.x + display.width;
  const bottom = display.y + display.height;
  const past =
    kept !== null &&
    kept.x + kept.width > right &&
    kept.y + kept.height > bottom &&
    right - kept.x >= Math.ceil(kept.width * MIN_SHOWN) &&
    bottom - kept.y >= Math.ceil(kept.height * MIN_SHOWN);
  step.check(
    "a drag takes her partly off the display, a quarter of her window still on it",
    past,
    `her window ${placed(start)} → ${placed(kept ?? (await her.bounds()))} on a display ${display.width}×${display.height} at (${display.x}, ${display.y}); companion.json's feet ${JSON.stringify(savedFeet(walk))}`,
  );
  const { page } = driven;
  await settingsSection(page, "Desktop", "desktop");
  const from = walk.smoke.log("main").length;
  await page
    .locator('[data-desktop-option="companion-place"]')
    .getByRole("button", { name: "Reset Position", exact: true })
    .click();
  const reset = await walk.smoke
    .waitForLine("main", COMPANION_LINES.placeReset, { from, timeoutMs: 5000 })
    .catch(() => null);
  const area = await driven.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const back = await until(
    "her window at her first place",
    async () => {
      const bounds = await her.bounds();
      if (bounds === null) return null;
      const edge = area.x + area.width - EDGE_DIP - (bounds.x + bounds.width);
      const floor = area.y + area.height - (bounds.y + bounds.height);
      return Math.abs(edge) <= 1 && Math.abs(floor) <= 1 ? bounds : null;
    },
    3000,
    100,
  ).catch(() => null);
  step.check(
    "Settings → Desktop's Reset Position stands her at her first place, saving no feet",
    reset !== null && back !== null && savedFeet(walk) === null,
    `${reset === null ? "main.log says nothing of a reset" : after(reset)}; her window ${placed(back ?? (await her.bounds()))} in a work area ${area.width}×${area.height} at (${area.x}, ${area.y}); companion.json's feet ${JSON.stringify(savedFeet(walk))}`,
  );
}

/** Model Options' Show in Finder in Studio › Appearance, which background mode logs. */
async function modelShown(walk: Walk, driven: Driven, model: string, step: Step) {
  const { smoke } = walk;
  const { page } = driven;
  await page.goto(`eidolon-app://app/personas/${PERSONA}/appearance`);
  const from = smoke.log("main").length;
  await page.getByRole("button", { name: "Model Options", exact: true }).first().click();
  const reveal = process.platform === "win32" ? "Show in Explorer" : "Show in Finder";
  await page.getByRole("menuitem", { name: reveal, exact: true }).click();
  const file = join(smoke.run.home, "personas", PERSONA, "models", model, "model.p2lrt");
  const line = `Eidolon: background mode didn't show ${file} in the file manager`;
  const shown = await smoke.waitForLine("main", line, { from, timeoutMs: 5000 }).catch(() => null);
  step.check(
    "Studio's Model Options shows her model's file in Finder, which background mode logs",
    shown !== null,
    shown === null ? `main.log never said "${after(line)}"` : after(shown),
  );
}

/** A right-click on her eyes; main.log's line for her menu, from "Eidolon: ", or null. */
async function herMenu(walk: Walk, her: Her): Promise<string | null> {
  const probe = await her.probe();
  await her.hover(probe);
  const from = walk.smoke.log("main").length;
  await her.click(probe, "right");
  return walk.smoke.waitForLine("main", MENU_LINE, { from, timeoutMs: 5000 }).then(
    (line) => fromEidolon(line),
    () => null,
  );
}

/** Her reply in a new chat of hers sets her mood; her voice message, played, makes her speak. */
async function moodAndVoice(walk: Walk, driven: Driven, her: Her, step: Step) {
  const { smoke } = walk;
  const { page } = driven;
  const persona = walk.persona;
  if (persona === null) throw new Error("it needs the chat step's persona");
  const chat = await startChat(page, persona);
  await chat.box.fill(COMPANION_LINE);
  await chat.box.press("Enter");
  await chat.log.getByText(COMPANION_WORDS).first().waitFor({ timeout: 30_000 });
  const mood = await her
    .when("data-mood happy", (data) => (data.mood ?? "").split(" ").includes("happy"), 15_000)
    .then(
      (data) => data.mood ?? "",
      async () => `never happy, but "${(await her.data()).mood}"`,
    );
  step.check(
    "her reply in the chat open in the main window sets her mood",
    mood.split(" ").includes("happy"),
    `"${COMPANION_REPLY}": data-mood ${mood}`,
  );

  const patched = await smoke.api(`/api/local/chats/${chat.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ replyMode: "voice" }),
  });
  await patched.body?.cancel();
  const bubbles = page.getByRole("button", { name: /^(Play|Pause) Voice Message$/ });
  const before = await bubbles.count();
  await her.watch();
  await chat.box.fill(COMPANION_LINE);
  await chat.box.press("Enter");
  await until("her voice message", async () => (await bubbles.count()) > before, 30_000);
  const arrived = Date.now();
  // Playwright's page reads as focused, so her voice message plays as it arrives: that play ends
  // before Play is pressed.
  const own = await until(
    "her voice message's own play to end",
    async () => {
      const playing = (await page.getByRole("button", { name: "Pause Voice Message" }).count()) > 0;
      const heard = await her.heard();
      const speaking = (await her.data()).speaking === "true";
      if (playing || speaking || (!heard.speaking && Date.now() - arrived < 3000)) return null;
      return heard;
    },
    20_000,
    100,
  );
  await her.watch();
  const pressed = Date.now();
  await page.getByRole("button", { name: "Play Voice Message" }).last().click();
  const played = await until(
    "data-speaking true, then false",
    async () => {
      const heard = await her.heard();
      return heard.speaking && (await her.data()).speaking === "false" ? heard : null;
    },
    5000,
    50,
  ).catch(() => null);
  step.check(
    "her voice message, played, makes her speak, then stop",
    patched.ok && played !== null,
    `PATCH replyMode voice ${patched.status}; as it arrived it played on its own (the page reads as focused under Playwright), ${own.speaking ? "and she spoke" : "yet she never spoke"}; Play Voice Message: ${played === null ? "data-speaking never read true, then false, within 5 s" : `she spoke and stopped within ${Date.now() - pressed} ms, her mouth's widest ${played.widest.toFixed(2)} on the fakes' silent file`}`,
  );
}

/**
 * A call in the chat open now, with her: the video screen, her mouth from the call's second meter,
 * and her menu's call items; docked, without WebGL. Whether the video screen showed.
 */
async function callWithHer(walk: Walk, driven: Driven, her: Her, stage: boolean, step: Step) {
  const { smoke } = walk;
  const { page } = driven;
  const persona = walk.persona;
  if (persona === null) throw new Error("it needs the chat step's persona");
  if (walk.microphone === null) throw new Error("there's no speech for the fake microphone");
  const screen = page.locator("[data-call-screen]");
  const dock = page.getByRole("region", { name: `Call with ${persona.shortName}` });
  const from = smoke.log("main").length;
  await page.getByRole("button", { name: "Call", exact: true }).click();
  const speaks = her.speaks(stage, 60_000);
  await screen.or(dock).first().waitFor({ timeout: 20_000 });
  const video = (await screen.count()) > 0;
  const unthrottled = await smoke
    .waitForLine("main", COMPANION_LINES.unthrottled, { from, timeoutMs: 15_000 })
    .catch(() => null);
  const up = await her
    .when("data-call up", (data) => data.call === "up", 10_000)
    .then(
      () => true,
      () => false,
    );
  const heard = await speaks;
  const shape = video ? "the video screen" : "docked";
  step.check(
    stage
      ? "a call with her: the video screen, the window drawing on, her mouth from the call"
      : "a call with her, docked without WebGL: the window drawing on, her speaking from the call",
    video === stage && unthrottled !== null && up && heard.met,
    `${shape}; ${unthrottled === null ? "no unthrottled line" : after(unthrottled)}; data-call ${up ? "up" : "never up"}; data-speaking ${heard.speaking ? "read true" : "never read true"}, ${stage ? `data-mouth's widest ${heard.widest.toFixed(2)}` : "her mouth skipped: her picture"}`,
  );
  const menu = await herMenu(walk, her);
  step.check(
    "her menu during her call starts with Hang Up and Mute Microphone",
    menu?.startsWith(`${MENU_LINE}${HER_CALL_MENU}`) === true,
    menu ?? "main.log has no menu line within 5 s",
  );
  // Background mode closes her menu with no pick, so the smoke hands the app page her Mute and
  // Unmute as main does.
  const micOn = page.getByRole("button", { name: "Mute your mic" }).first();
  await until("the call live, its microphone on", () => micOn.isEnabled(), 30_000);
  await sendPick(driven, "mute");
  const muted = await page
    .getByRole("button", { name: "Unmute your mic" })
    .first()
    .waitFor({ timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  await sendPick(driven, "unmute");
  const unmuted = await micOn.waitFor({ timeout: 5000 }).then(
    () => true,
    () => false,
  );
  step.check(
    "her menu's Mute and Unmute, handed to the app page from main, set the call's microphone",
    muted && unmuted,
    `companion-pick mute: ${muted ? "the microphone off" : "nothing changed"}; unmute: ${unmuted ? "on again" : "still off"}`,
  );
  if (video) return true;
  const hangUp = smoke.log("main").length;
  await dock.getByRole("button", { name: "Hang Up" }).click();
  const throttled = await smoke
    .waitForLine("main", COMPANION_LINES.throttled, { from: hangUp, timeoutMs: 15_000 })
    .catch(() => null);
  step.check(
    "the dock's Hang Up ends her call, and the window's throttling is back on",
    throttled !== null,
    throttled === null ? "no throttled line" : after(throttled),
  );
  return false;
}

/** Pop Out hides the window while her call goes on; its Hang Up ends it; a launch shows it again. */
async function popOut(walk: Walk, driven: Driven, her: Her, step: Step) {
  const { smoke } = walk;
  const { page } = driven;
  const screen = page.locator("[data-call-screen]");
  let from = smoke.log("main").length;
  await screen.getByRole("button", { name: "Pop Out" }).click();
  const popped = await smoke
    .waitForLine("main", COMPANION_LINES.poppedOut, { from, timeoutMs: 15_000 })
    .catch(() => null);
  const hidden = await smoke
    .waitForLine("main", "Eidolon: the window is hidden", { from, timeoutMs: 5000 })
    .catch(() => null);
  const calls = await activeCalls(walk);
  step.check(
    "Pop Out hides the window, and her call goes on",
    popped !== null && hidden !== null && calls === 1,
    `${hidden === null ? "the window isn't hidden" : after(hidden)}; ${popped === null ? "no popped-out line" : after(popped)}; ${calls} call(s) up`,
  );
  // Hidden, the window's page still runs for her feed, and its call's stage draws nothing.
  const frames = () =>
    page.evaluate(() =>
      Number(
        document.querySelector<HTMLElement>("[data-call-screen] [data-avatar][data-frames]")
          ?.dataset.frames ?? Number.NaN,
      ),
    );
  // The page hears it a few frames after main logs it: wait for its mark, and a frame more.
  const marked = await page
    .waitForSelector("html[data-window-hidden]", { state: "attached", timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  await sleep(250);
  const before = await frames();
  await sleep(1000);
  const held = await frames();
  step.check(
    "hidden, the window's call draws no frame",
    marked && Number.isFinite(before) && held === before,
    `${marked ? "the page marked hidden" : "no data-window-hidden on the page"}; its stage's data-frames ${before}, and ${held} a second later`,
  );
  from = smoke.log("main").length;
  await screen.getByRole("button", { name: "Hang Up" }).click();
  const throttled = await smoke
    .waitForLine("main", COMPANION_LINES.throttled, { from, timeoutMs: 15_000 })
    .catch(() => null);
  const idle = await her
    .when("data-call idle", (data) => data.call === "idle", 10_000)
    .then(
      () => true,
      () => false,
    );
  step.check(
    "the hidden window's Hang Up ends her call, and its throttling is back on",
    throttled !== null && idle,
    `${throttled === null ? "no throttled line" : after(throttled)}; data-call ${idle ? "idle" : "not idle"}`,
  );
  from = smoke.log("main").length;
  const second = smoke.launch("a launch after Pop Out", walk.launch, LANGUAGE_ARGS);
  const exit = await Promise.race([second.exited, sleep(30_000).then(() => null)]);
  if (exit === null) second.child.kill("SIGKILL");
  const shown =
    exit === null
      ? null
      : await smoke
          .waitForLine("main", "Eidolon: the window is shown", { from, timeoutMs: 10_000 })
          .catch(() => null);
  step.check(
    "a second launch shows the window again",
    exit?.code === 0 && shown !== null,
    `the launch ${exit === null ? "still ran after 30 s, so the smoke killed it" : `exited ${exit.code ?? exit.signal}`}; ${shown === null ? "the window isn't shown" : after(shown)}`,
  );
}

/** Settings → Desktop's switch turns her off, and her window goes. */
async function turnOff(walk: Walk, driven: Driven, her: Her, step: Step) {
  const { smoke } = walk;
  const { page } = driven;
  await settingsSection(page, "Desktop", "desktop");
  const toggle = companionSwitch(page);
  await until(
    "her switch reading on",
    async () =>
      (await toggle.isEnabled()) && (await toggle.getAttribute("aria-checked")) === "true",
    15_000,
  );
  const from = smoke.log("main").length;
  await toggle.click();
  const off = await smoke
    .waitForLine("main", COMPANION_LINES.off, { from, timeoutMs: 10_000 })
    .catch(() => null);
  const gone = await until(
    "no window at her page",
    async () => (await her.bounds()) === null,
    10_000,
  ).then(
    () => true,
    () => false,
  );
  step.check(
    "Settings → Desktop's switch turns her off, and her window goes",
    off !== null && gone,
    `${off === null ? "no turned-off line" : after(off)}; ${gone ? "no window at her page" : "her window is still there after 10 s"}`,
  );
}

/** What the steps after need: no call up, her off, and no active model. */
async function putBack(walk: Walk, page: Page, step: Step) {
  const left: string[] = [];
  try {
    if ((await activeCalls(walk)) > 0) {
      await page.getByRole("button", { name: "Hang Up" }).first().click({ timeout: 10_000 });
      await until("no call up", async () => (await activeCalls(walk)) === 0, 15_000, 250);
    }
  } catch (error) {
    left.push(`a call is up: ${described(error)}`);
  }
  try {
    await page.evaluate(async () => {
      const app = (
        globalThis as {
          eidolonDesktop?: { setCompanion?: (change: { on: boolean }) => Promise<unknown> };
        }
      ).eidolonDesktop;
      await app?.setCompanion?.({ on: false });
    });
  } catch (error) {
    left.push(`she may be on: ${described(error)}`);
  }
  try {
    await setModel(walk, null);
  } catch (error) {
    left.push(`the test rig may be active: ${described(error)}`);
  }
  step.check(
    "put back for the steps after: no call up, her off, no active model",
    left.length === 0,
    left.length === 0 ? "put back: no call up, her off, no active model" : left.join("; "),
  );
}

/** The task her start_task call made in chat `id`, once its `started` result is in the log. */
async function startedTask(walk: Walk, id: string): Promise<string | null> {
  const started = (await chatEvents(walk, id)).find(
    (event) => event.type === "tool-result" && event.stage === "started",
  );
  const task = started?.result?.task;
  return typeof task === "string" ? task : null;
}

async function taskSnapshot(walk: Walk, id: string): Promise<TaskSnapshot | null> {
  const response = await walk.smoke.api(`/api/local/tasks/${id}`);
  return response.ok ? ((await response.json()) as TaskSnapshot) : null;
}

/** main.log's line from "Eidolon: " on, for a notice of the task: her name, `phrase`, its goal. */
function noticeLine(name: string, phrase: string): string {
  return `${NOTICE}${name}: ${phrase} / ${TASK_GOAL}`;
}

/** A line of main.log from "Eidolon: " on, its time and level left out. */
function fromEidolon(line: string): string {
  return line.slice(line.indexOf("Eidolon: "));
}

/**
 * Her start_task call in a folder outside assistant.folders, once Assistant Mode runs on the fakes:
 * the task waits on its card, and main's watch, which polls every 30 s while no task runs, logs its
 * notice; Deny on the card stops it, and the watch logs that notice too. Headful, the unpackaged app
 * has no notifications.
 */
async function waitingTask(walk: Walk, driven: Driven, step: Step) {
  const { smoke } = walk;
  const { fakes } = smoke;
  const { page } = driven;
  const persona = walk.persona;
  if (persona === null) throw new Error("it needs the chat step's persona");
  const put = await pageFetch(page, "/api/local/settings", {
    method: "PUT",
    body: {
      scope: "app",
      values: { "assistant.provider": "openrouter", "assistant.model": TASK_MODEL },
    },
  });
  if (put.status !== 200) throw new Error(`PUT settings: ${put.status}`);
  await until(
    "Assistant Mode ready on the fakes' account",
    async () =>
      ((await pageFetch(page, "/api/local/status")).body as Partial<Status>).assistant?.ready,
    15_000,
  );
  // assistant.folders holds none, so a task anywhere asks to start.
  const folder = join(smoke.run.scratch, "screenshots");
  fakes.taskFolder = folder;
  const chat = await startChat(page, persona);
  const from = smoke.log("main").length;
  const asked = fakes.chats.length;
  await chat.box.fill(TASK_LINE);
  await chat.box.press("Enter");
  const task = await until(
    "her start_task's task in the chat's log",
    () => startedTask(walk, chat.id),
    30_000,
    500,
  ).catch(() => null);
  if (task === null) {
    const line = fakes.chats
      .slice(asked)
      .find((request) => request.messages?.at(-1)?.content === TASK_LINE);
    const offered = (line?.tools ?? []).some((tool) => tool.function?.name === "start_task");
    throw new Error(
      `no task started: her answer to the line ${line === undefined ? "never reached her mind" : offered ? "was offered start_task" : "wasn't offered start_task"}`,
    );
  }
  const card = chat.log.locator(`article[data-task="${task}"]`);
  const asks = await card
    .getByText("Start this task?", { exact: true })
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  await chat.log.getByText(TASK_ACK, { exact: true }).waitFor({ timeout: 20_000 });
  const waiting = await taskSnapshot(walk, task);
  step.check(
    "her start_task outside assistant.folders waits on its card",
    asks && waiting?.status === "awaiting-approval" && waiting.pending?.kind === "start",
    `task ${task} ${waiting?.status ?? "unread"}, waiting for ${waiting?.pending?.kind ?? "nothing"}; its card ${asks ? "asks" : "doesn't ask"} "Start this task?"`,
  );
  await step.shot(page, "task-waits");
  // Main's words follow the page's language, English here.
  const { notice } = STRINGS.en;
  if (walk.background) {
    const shown = await smoke
      .waitForLine("main", NOTICE, { from, timeoutMs: 60_000 })
      .catch(() => null);
    step.check(
      "the watch tells of the wait: her name, the start's words and her goal",
      shown !== null && fromEidolon(shown) === noticeLine(persona.name, notice.start),
      shown === null ? "main.log has no notice within 60 s" : after(shown),
    );
  }

  const denied = smoke.log("main").length;
  await card.locator('[data-answer="deny"]').click();
  const ended = await until(
    "the task stopped by Deny",
    async () => {
      const now = await taskSnapshot(walk, task);
      return now?.status === "cancelled" ? now : null;
    },
    15_000,
    300,
  ).catch(() => null);
  step.check(
    "Deny on its card stops it",
    ended?.denied === true,
    ended === null ? "the task didn't stop within 15 s" : `task ${task} cancelled by Deny`,
  );
  if (walk.background) {
    const shown = await smoke
      .waitForLine("main", NOTICE, { from: denied, timeoutMs: 45_000 })
      .catch(() => null);
    const notices = smoke
      .log("main")
      .slice(from)
      .split(/\r?\n/)
      .filter((line) => line.includes(NOTICE)).length;
    step.check(
      "the watch tells of its end, and of each once",
      shown !== null &&
        fromEidolon(shown) === noticeLine(persona.name, notice.cancelled) &&
        notices === 2,
      `${shown === null ? "main.log has no notice within 45 s of Deny" : after(shown)}; ${notices} notice(s) since the line`,
    );
  }
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
  const quitFrom = smoke.log("main").length;
  const ending = await quitApp(walk, first.main, smoke.server()?.pid ?? null);
  const gone = await smoke.processes.settle(10_000);
  const asked = smoke.log("main").slice(quitFrom).includes(BOX);
  step.check(
    "--quit ends the launch before, its backend with it, and asks nothing",
    ending.ok && gone.length === 0 && !asked,
    `${ending.detail}; ${asked ? "a quit box" : "no quit box"}${gone.length > 0 ? `; still running: ${gone.join(", ")}` : ""}`,
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
    status.status === 200 &&
      footer === `LAPLACE Eidolon ${DESKTOP_VERSION} · server ${SERVER_VERSION}`,
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
  const asked = smoke.log("main").slice(quitFrom).includes(BOX);
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

/** Types into the persona's System Prompt, and leaves the edit unsaved. */
async function editPrompt(page: Page): Promise<{ readonly ok: boolean; readonly detail: string }> {
  await page.goto(`eidolon-app://app/personas/${PERSONA}/prompt`);
  const area = page.getByLabel("System Prompt", { exact: true });
  await area.click();
  await area.pressSequentially(" unsaved");
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  const save = await page.getByRole("button", { name: "Save", exact: true }).isEnabled();
  return { ok: save, detail: `"Unsaved changes", Save ${save ? "enabled" : "disabled"}` };
}

function inOrder(
  text: string,
  lines: readonly string[],
): { readonly ok: boolean; readonly detail: string } {
  const found: string[] = [];
  let rest = text.split(/\r?\n/);
  for (const line of lines) {
    const at = rest.findIndex((candidate) => candidate.includes(line));
    if (at === -1) {
      found.push(`no "${after(line)}"${found.length > 0 ? " after that" : ""}`);
      return { ok: false, detail: found.join(" → ") };
    }
    found.push(after(rest[at]));
    rest = rest.slice(at + 1);
  }
  return { ok: true, detail: found.join(" → ") };
}

/** The backend Try Again started, and main.log's line for the failure the kill caused. */
interface Retried {
  readonly pid: number;
  readonly failure: string;
}

/**
 * Kills `backend` while the page holds an unsaved edit: main must let the page go to load the
 * failure page, whose Try Again starts a backend and loads Home. Null when the failure page didn't
 * show.
 */
async function killAndRetry(
  walk: Walk,
  page: Page,
  backend: number,
  step: Step,
): Promise<Retried | null> {
  const { smoke } = walk;
  const failure = "Eidolon: the backend failed (exited)";
  const from = smoke.log("main").length;
  process.kill(backend, "SIGKILL");
  await smoke.waitForLine("main", FAILED_SHOWN, { from, timeoutMs: 15_000 }).catch(() => null);
  const log = smoke.log("main").slice(from);
  const shown = inOrder(log, [
    `Eidolon: the backend (pid ${backend}) exited (SIGKILL)`,
    failure,
    LET_GO,
    FAILED_SHOWN,
  ]);
  step.check(
    "the backend killed: main lets the page go for the failure page",
    shown.ok,
    shown.detail,
  );
  const failed = log.split(/\r?\n/).find((line) => line.includes(failure));
  if (!shown.ok || failed === undefined) return null;
  await step.shot(page, "failed-over-unsaved");
  const retryFrom = smoke.log("main").length;
  await page.getByRole("button", { name: STRINGS.en.label.tryAgain, exact: true }).click();
  const started = await smoke.waitForLine("main", LINES.started, {
    from: retryFrom,
    timeoutMs: 30_000,
  });
  const pid = Number(LINES.started.exec(started)?.[1]);
  await smoke.processes.adopt("backend", pid);
  await home(page);
  step.check("Try Again: another backend, and Home", pid !== backend, `${after(started)}; Home`);
  return { pid, failure: failed };
}

/**
 * The last launch spawns its own backend again, and the page holds an unsaved edit, whose
 * beforeunload asks it to stay: main must let it go to load the failure page when the backend dies,
 * and at the quit, or the failure page never shows and the quit stops with the window hidden and the
 * backend already stopped. The quit's box, which background mode answers, warns of the edit.
 */
async function quit(walk: Walk, step: Step) {
  const { smoke } = walk;
  const from = smoke.log("main").length;
  let main: Started | null = null;
  let killed: Retried | null = null;
  try {
    const driven = await drive(walk, []);
    main = driven.main;
    const { page } = driven;
    const started = await smoke.waitForLine("main", LINES.started, { from, timeoutMs: 30_000 });
    const first = Number(LINES.started.exec(started)?.[1]);
    await smoke.processes.adopt("backend", first);
    await home(page);
    const edited = await editPrompt(page);
    step.check("the System Prompt holds an unsaved edit", edited.ok, edited.detail);
    killed = await killAndRetry(walk, page, first, step);
    if (killed === null) return;
    const again = await editPrompt(page);
    step.check("the System Prompt holds an unsaved edit again", again.ok, again.detail);
    await step.shot(page, "unsaved-prompt");
    const quitFrom = smoke.log("main").length;
    const ending = await quitApp(walk, driven.main, killed.pid);
    step.check("--quit: the second launch, main and the backend exit 0", ending.ok, ending.detail);
    if (walk.background) {
      const asked = inOrder(smoke.log("main").slice(quitFrom), [UNSAVED_QUIT_BOX, LINES.quitting]);
      step.check(
        "main.log: the quit box says the unsaved edit will be lost, then the quit goes on",
        asked.ok,
        asked.detail,
      );
    }
    const said = inOrder(smoke.log("main").slice(quitFrom), [
      LINES.quitting,
      "Eidolon: the window is hidden",
      `Eidolon: the backend (pid ${killed.pid}) exited (0)`,
      LET_GO,
      "Eidolon: the window is closed",
    ]);
    step.check("main.log: the quit lets the page go, then closes the window", said.ok, said.detail);
  } finally {
    if (main !== null && runs(main)) await smoke.quit(walk.launch).catch(() => undefined);
  }
  const left = await smoke.processes.settle(10_000);
  step.check(
    "nothing is left running",
    left.length === 0,
    left.length === 0 ? "nothing left" : left.join(", "),
  );
  const caused = killed.failure;
  const errors = [
    ...errorLines(smoke.log("main"), "main").filter((line) => line !== caused),
    ...errorLines(smoke.log("backend"), "backend"),
  ];
  step.check(
    "no error lines in main.log or backend.log but the failure the kill caused",
    errors.length === 0,
    errors.length === 0
      ? "no error lines in either log but the kill's"
      : errors.slice(0, 3).join(" | "),
  );
}
