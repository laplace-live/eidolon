// End-to-end call against a running bot through the /ai page's own client stack: Chrome,
// @pipecat-ai/client-js and the small-webrtc transport. It touches only the public HTTP + WebRTC +
// RTVI contract, so it can score any bot at `--base-url`, local or deployed.
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { checkInvariants } from "./e2e/invariants.ts";
import {
  type ConnectResult,
  type EntrySource,
  FLOOR_DB,
  LEVEL_INTERVAL_MS,
  type LevelSample,
  type PageEntry,
} from "./e2e/protocol.ts";
import { isRtvi, pacingByTurn, type TimelineEntry } from "./e2e/turns.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_QUESTION = "你好呀，你今天心情怎么样？";
// What --barge-in says over her reply, and how far into the reply's audio it starts.
const BARGE_IN = "等一下，我想换个话题。";
const BARGE_IN_DELAY_MS = 800;
// A barge-in counts once her audio stops this soon after the caller starts talking.
const BARGE_IN_STOP_MS = 1500;
// Fully qualified: a bare "Flo" picks a non-Chinese Flo, which renders Chinese as silence.
const SAY_VOICE = "Flo (Chinese (China mainland))";
const AUDIBLE_DB = -50;
const MIN_AUDIBLE_SAMPLES = 3;
const MAX_QUESTION_CER = 0.3;
// Chrome's capture AGC adds about +14.5 dB to the fake mic, so the raw `say` render (-7.6 dBFS
// peak) arrives clipped at 0 dBFS and Soniox mishears it. At -12 dB it arrives at -5.1 dBFS.
const QUESTION_GAIN_DB = -12;
// Quiet time after the bot's last speaking, LLM or text event before its turn counts as over.
const SETTLE_MS = 2000;

const USAGE = `usage: bun apps/bot/scripts/e2e-call.ts [--text "<question>" | --audio [<wav>] | --barge-in [<wav>]] [options]

  --text "<q>"       type <q> after the greeting (the default mode; <q> defaults to ${DEFAULT_QUESTION})
  --audio [<wav>]    say it through Chrome's fake mic; without <wav>, synthesize the default question
  --barge-in [<wav>] type the default question, then talk over her reply with <wav>; without <wav>,
                     synthesize "${BARGE_IN}"
  --engine <name>    pipedog or native: the engine the bot runs, for the report and e2e-compare;
                     every bot but pipedog's is held to I6 (every bot-tts-started is stopped)
  --base-url <url>   bot origin (default http://localhost:7860)
  --out <file>       full JSON timeline (default: a new file in the OS temp dir)
  --timeout-ms <n>   budget for the whole run (default 90000)
  --audio-dir <dir>  cache for synthesized audio (default: <tmp>/eidolon-e2e-audio)
  --headful          show the browser and play the bot through the speakers`;

class UsageError extends Error {}

type Mode = "text" | "audio" | "barge-in";

interface Options {
  mode: Mode;
  question: string | null;
  audioFile: string | null;
  /** The WAV --barge-in plays; null to synthesize BARGE_IN. */
  bargeInFile: string | null;
  engine: "pipedog" | "native" | null;
  baseUrl: string;
  out: string;
  timeoutMs: number;
  audioDir: string;
  headful: boolean;
}

function parseOptions(argv: string[]): Options {
  let text: string | undefined;
  let audio: string | true | undefined;
  let bargeIn: string | true | undefined;
  let engine: Options["engine"] = null;
  let baseUrl = "http://localhost:7860";
  let out: string | undefined;
  let timeoutMs = 90_000;
  let audioDir = join(tmpdir(), "eidolon-e2e-audio");
  let headful = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = flag === arg ? undefined : arg.slice(eq + 1);
    const optional = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i++;
      return next;
    };
    const required = (): string => {
      const value = optional();
      if (!value) throw new UsageError(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case "--text":
        text = optional() ?? DEFAULT_QUESTION;
        break;
      case "--audio":
        audio = optional() ?? true;
        break;
      case "--barge-in":
        bargeIn = optional() ?? true;
        break;
      case "--engine": {
        const name = required();
        if (name !== "pipedog" && name !== "native") {
          throw new UsageError("--engine is pipedog or native");
        }
        engine = name;
        break;
      }
      case "--base-url":
        baseUrl = required().replace(/\/+$/, "");
        break;
      case "--out":
        out = resolve(required());
        break;
      case "--timeout-ms":
        timeoutMs = Number(required());
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          throw new UsageError("--timeout-ms needs a positive integer");
        }
        break;
      case "--audio-dir":
        audioDir = resolve(required());
        break;
      case "--headful":
        headful = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if ([text, audio, bargeIn].filter((given) => given !== undefined).length > 1) {
    throw new UsageError("--text, --audio and --barge-in are mutually exclusive");
  }
  const mode: Mode = audio !== undefined ? "audio" : bargeIn !== undefined ? "barge-in" : "text";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  return {
    mode,
    question:
      mode === "audio" ? (audio === true ? DEFAULT_QUESTION : null) : (text ?? DEFAULT_QUESTION),
    audioFile: typeof audio === "string" ? resolve(audio) : null,
    bargeInFile: typeof bargeIn === "string" ? resolve(bargeIn) : null,
    engine,
    baseUrl,
    out: out ?? join(tmpdir(), `eidolon-e2e-${mode}-${stamp}.json`),
    timeoutMs,
    audioDir,
    headful,
  };
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}: ${stderr.trim()}`);
  return stdout;
}

const FFMPEG = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"];
const WAV_48K_MONO = ["-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le"];

/** `text` said by SAY_VOICE through `filter`, as a 48 kHz mono WAV, cached in `dir`. */
async function synthesize(
  dir: string,
  name: string,
  text: string,
  filter: string,
): Promise<string> {
  const key = createHash("sha1").update(`${SAY_VOICE}\n${text}\n${filter}`).digest("hex");
  const wav = join(dir, `${name}-${key.slice(0, 12)}.wav`);
  if (await Bun.file(wav).exists()) return wav;
  await mkdir(dir, { recursive: true });
  const aiff = `${wav}.aiff`;
  try {
    // `say` exits 0 even for a voice that is not installed, and renders nothing.
    await run(["say", "-v", SAY_VOICE, "-o", aiff, text]);
    const probe = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"];
    const seconds = Number(await run([...probe, aiff]));
    if (!(seconds > 0.5)) {
      throw new Error(
        `say -v "${SAY_VOICE}" rendered ${seconds} s of speech; is the voice installed?`,
      );
    }
    await run([...FFMPEG, "-i", aiff, "-af", filter, ...WAV_48K_MONO, wav]);
  } finally {
    await rm(aiff, { force: true });
  }
  return wav;
}

/** The default question, with 1 s of silence before it and 10 s after. */
function synthesizeQuestion(dir: string): Promise<string> {
  const filter = `volume=${QUESTION_GAIN_DB}dB,adelay=1000:all=1,apad=pad_dur=10`;
  return synthesize(dir, "question", DEFAULT_QUESTION, filter);
}

/**
 * What --barge-in says, with a little silence after. It plays through WebAudio, which Chrome's
 * capture AGC never touches, so it keeps `say`'s level.
 */
function synthesizeBargeIn(dir: string): Promise<string> {
  return synthesize(dir, "barge-in", BARGE_IN, "apad=pad_dur=0.5");
}

/** A silent mic for text mode: with no file, Chrome's fake device beeps into the call. */
async function silence(dir: string): Promise<string> {
  const wav = join(dir, "silence.wav");
  if (await Bun.file(wav).exists()) return wav;
  await mkdir(dir, { recursive: true });
  await run([
    ...FFMPEG,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "1",
    ...WAV_48K_MONO,
    wav,
  ]);
  return wav;
}

async function bundlePage(): Promise<string> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "e2e", "page.ts")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
  });
  if (!build.success) throw new AggregateError(build.logs, "bundling e2e/page.ts failed");
  return build.outputs[0]!.text();
}

interface LevelPoint extends LevelSample {
  t: number;
}

// Leaves out botTtsStopped: pipecat's Fish service never closes its audio context, so that event
// only fires once the TTS idle timeout lapses, well after the bot has gone quiet.
const BOT_ACTIVITY = new Set([
  "botStartedSpeaking",
  "botStoppedSpeaking",
  "botLlmStarted",
  "botLlmStopped",
  "botTtsStarted",
  "botOutput",
  "botTranscript",
  "botLlmText",
  "botTtsText",
  "llmRawText",
  "ttsRawText",
  "llmFunctionCallStarted",
  "llmFunctionCallInProgress",
  "llmFunctionCallStopped",
]);

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

/** Collects the timeline and follows the bot's turn state from the RTVI events in it. */
class Recorder {
  readonly startedAt = Date.now();
  readonly timeline: TimelineEntry[] = [];
  readonly levels: LevelPoint[] = [];
  private speaking = false;
  private llm = false;
  private readonly toolCalls = new Set<unknown>();
  private lastBotActivity = 0;
  private lastSpeechStart = 0;
  private ended: string | undefined;

  add({ at, source, event, data }: PageEntry): void {
    const t = at - this.startedAt;
    if (source === "level") {
      this.levels.push({ t, ...(data as LevelSample) });
      return;
    }
    this.timeline.push(data === undefined ? { t, source, event } : { t, source, event, data });
    if (source === "rtvi") this.follow(event, at, data);
    else if (source === "harness" && (event === "browserClosed" || event === "pageCrashed")) {
      this.ended ??= event;
    }
  }

  note(source: EntrySource, event: string, data?: unknown): void {
    this.add({ at: Date.now(), source, event, data });
  }

  private follow(event: string, at: number, data: unknown): void {
    if (event === "disconnected") this.ended ??= event;
    if (!BOT_ACTIVITY.has(event)) return;
    this.lastBotActivity = at;
    if (event === "botStartedSpeaking") {
      this.speaking = true;
      this.lastSpeechStart = at;
    } else if (event === "botStoppedSpeaking") this.speaking = false;
    else if (event === "botLlmStarted") this.llm = true;
    else if (event === "botLlmStopped") this.llm = false;
    else if (event === "llmFunctionCallInProgress") this.toolCalls.add(field(data, "tool_call_id"));
    else if (event === "llmFunctionCallStopped") this.toolCalls.delete(field(data, "tool_call_id"));
  }

  /** Resolves once the bot has spoken since `since` and gone idle, false on timeout or hangup. */
  async waitForTurn(since: number, deadline: number, phase: string): Promise<boolean> {
    while (Date.now() < deadline) {
      if (this.ended) {
        this.note("harness", "aborted", { phase, reason: this.ended });
        return false;
      }
      const idle = !this.speaking && !this.llm && this.toolCalls.size === 0;
      if (this.lastSpeechStart >= since && idle && Date.now() - this.lastBotActivity >= SETTLE_MS) {
        this.note("harness", "turnComplete", { phase });
        return true;
      }
      await Bun.sleep(LEVEL_INTERVAL_MS);
    }
    this.note("harness", "timeout", { phase });
    return false;
  }

  /** Resolves once the bot has started speaking since `since`, false on timeout or hangup. */
  async waitForSpeech(since: number, deadline: number, phase: string): Promise<boolean> {
    while (Date.now() < deadline) {
      if (this.ended) {
        this.note("harness", "aborted", { phase, reason: this.ended });
        return false;
      }
      if (this.lastSpeechStart >= since) return true;
      await Bun.sleep(10);
    }
    this.note("harness", "timeout", { phase });
    return false;
  }

  async within<T>(work: Promise<T>, deadline: number, phase: string): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<undefined>((done) => {
      timer = setTimeout(() => {
        this.note("harness", "timeout", { phase });
        done(undefined);
      }, deadline - Date.now());
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Where the harness's page server serves --barge-in's WAV. */
const BARGE_IN_PATH = "/barge-in.wav";

async function converse(page: Page, options: Options, recorder: Recorder, deadline: number) {
  const dialed = Date.now();
  const connected: ConnectResult | undefined = await recorder.within(
    page.evaluate((o) => window.e2e!.connect(o), {
      baseUrl: options.baseUrl,
      holdMic: options.mode === "audio",
    }),
    deadline,
    "connect",
  );
  if (!connected) return;
  recorder.note("harness", connected.ok ? "connected" : "connectFailed", connected);
  if (!connected.ok) return;
  if (!(await recorder.waitForTurn(dialed, deadline, "greeting"))) return;
  const asked = Date.now();
  if (options.mode === "audio") {
    await page.evaluate(() => window.e2e!.askByVoice());
  } else {
    const question = options.question ?? DEFAULT_QUESTION;
    await page.evaluate((text) => window.e2e!.sendText(text), question);
  }
  if (options.mode !== "barge-in") {
    await recorder.waitForTurn(asked, deadline, "reply");
    return;
  }
  if (!(await recorder.waitForSpeech(asked, deadline, "reply"))) return;
  await Bun.sleep(BARGE_IN_DELAY_MS);
  const barged = Date.now();
  const played = await recorder.within(
    page.evaluate((url) => window.e2e!.bargeIn(url), BARGE_IN_PATH),
    deadline,
    "barge-in",
  );
  if (played === undefined) return;
  await recorder.waitForTurn(barged, deadline, "after barge-in");
}

async function call(
  options: Options,
  fakeMic: string,
  bargeInWav: string | null,
  recorder: Recorder,
): Promise<unknown> {
  const deadline = recorder.startedAt + options.timeoutMs;
  const html = await Bun.file(join(import.meta.dir, "e2e", "page.html")).text();
  const script = await bundlePage();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/") return new Response(html, { headers: { "content-type": "text/html" } });
      if (pathname === "/page.js") {
        return new Response(script, { headers: { "content-type": "text/javascript" } });
      }
      if (pathname === BARGE_IN_PATH && bargeInWav !== null) {
        return new Response(Bun.file(bargeInWav), { headers: { "content-type": "audio/wav" } });
      }
      return new Response(null, { status: pathname === "/favicon.ico" ? 204 : 404 });
    },
  });
  // The /ai page lives on another origin than the bot, so this page does too.
  const origin = `http://127.0.0.1:${server.port}`;
  let browser: Browser | undefined;
  let closing = false;
  let stats: unknown = null;
  try {
    const launched = Date.now();
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: !options.headful,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${fakeMic}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    browser.on("disconnected", () => {
      if (!closing)
        recorder.note("harness", "browserClosed", { afterLaunchMs: Date.now() - launched });
    });
    recorder.note("harness", "browser", { version: browser.version(), origin });
    const context = await browser.newContext();
    await context.grantPermissions(["microphone"], { origin });
    const page = await context.newPage();
    await page.exposeFunction("e2eEmit", (entry: PageEntry) => recorder.add(entry));
    page.on("console", (message) => {
      const type = message.type();
      if (type === "error" || type === "warning") recorder.note("console", type, message.text());
    });
    page.on("pageerror", (error) => recorder.note("console", "pageerror", error.message));
    page.on("crash", () => recorder.note("harness", "pageCrashed"));
    await page.goto(origin);
    await page.waitForFunction(() => window.e2e !== undefined, undefined, { timeout: 15_000 });
    try {
      await converse(page, options, recorder, deadline);
    } catch (error) {
      recorder.note("harness", "error", String(error));
    }
    stats = await recorder.within(
      page.evaluate(() => window.e2e!.stats()).catch(() => null),
      Date.now() + 5_000,
      "stats",
    );
    await recorder.within(
      page.evaluate(() => window.e2e!.disconnect()).catch(() => undefined),
      Date.now() + 5_000,
      "disconnect",
    );
  } finally {
    closing = true;
    await browser?.close();
    server.stop(true);
  }
  return stats;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function textOf(entries: TimelineEntry[], event: string): string {
  return entries
    .filter((entry) => isRtvi(entry, event))
    .map((entry) => String(field(entry.data, "text") ?? ""))
    .join("");
}

/** What the bot said, from the most sentence-like text event it sent. */
function botText(entries: TimelineEntry[]): string {
  const sentences = entries.filter(
    (entry) =>
      isRtvi(entry, "botOutput") &&
      !["word", "token"].includes(String(field(entry.data, "output_type"))),
  );
  // Pipecat reports each sentence twice, as `spoken: false` and then `spoken: true`.
  const spoken = sentences.filter((entry) => field(entry.data, "spoken") === true);
  const said = spoken.length > 0 ? spoken : sentences;
  if (said.length > 0) return said.map((e) => String(field(e.data, "text"))).join("");
  for (const event of ["botTranscript", "botTtsText", "botLlmText", "ttsRawText", "llmRawText"]) {
    const text = textOf(entries, event);
    if (text !== "") return text;
  }
  return "";
}

function userTranscript(entries: TimelineEntry[]): string {
  const final = (entry: TimelineEntry) => field(entry.data, "final") === true;
  const legacy = entries.filter((entry) => isRtvi(entry, "userTranscript") && final(entry));
  const input = entries.filter(
    (entry) =>
      isRtvi(entry, "userInput") &&
      field(entry.data, "input_type") === "transcription" &&
      final(entry),
  );
  return (legacy.length > 0 ? legacy : input).map((e) => String(field(e.data, "text"))).join("");
}

/** Character error rate of `heard` against `said`, ignoring case, spacing and punctuation. */
function charErrorRate(said: string, heard: string): number {
  const chars = (text: string) => [
    ...text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]/gu, ""),
  ];
  const ref = chars(said);
  const hyp = chars(heard);
  let row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (const [i, r] of ref.entries()) {
    const next = [i + 1];
    for (const [j, h] of hyp.entries()) {
      next.push(Math.min(row[j + 1]! + 1, next[j]! + 1, row[j]! + (r === h ? 0 : 1)));
    }
    row = next;
  }
  return row[hyp.length]! / Math.max(ref.length, 1);
}

/**
 * Runs of level samples at or above AUDIBLE_DB, bridging gaps up to 300 ms. Like every level
 * timestamp, the bounds mark the end of a sample's 100 ms window.
 */
function audibleSpans(levels: LevelPoint[], track: "bot" | "mic"): [number, number][] {
  const spans: [number, number][] = [];
  for (const point of levels) {
    if ((point[track] ?? FLOOR_DB) < AUDIBLE_DB) continue;
    const last = spans.at(-1);
    if (last && point.t - last[1] <= 3 * LEVEL_INTERVAL_MS) last[1] = point.t;
    else spans.push([point.t, point.t]);
  }
  return spans;
}

const BOT_TEXT_EVENTS = new Set([
  "botLlmText",
  "llmRawText",
  "botTranscript",
  "botOutput",
  "botTtsText",
  "ttsRawText",
]);

/** Each defined point of a turn, with the time since the one before it. */
function stages(points: [string, number | undefined][]) {
  const reached = points.filter((point): point is [string, number] => point[1] !== undefined);
  return reached.map(([stage, t], i) => ({
    stage,
    t,
    deltaMs: i === 0 ? 0 : t - reached[i - 1]![1],
  }));
}

function analyze(
  options: Options,
  micFile: string,
  bargeInWav: string | null,
  recorder: Recorder,
  browserStats: unknown,
) {
  const timeline = [...recorder.timeline];
  const { levels } = recorder;
  const end = Math.max(timeline.at(-1)?.t ?? 0, levels.at(-1)?.t ?? 0);
  const first = (match: (entry: TimelineEntry) => boolean, from = -Infinity, to = Infinity) =>
    timeline.find((entry) => entry.t >= from && entry.t < to && match(entry));
  const last = (match: (entry: TimelineEntry) => boolean, from = -Infinity, to = Infinity) =>
    timeline.findLast((entry) => entry.t >= from && entry.t < to && match(entry));
  const between = (from: number, to: number) =>
    timeline.filter((entry) => entry.t >= from && entry.t < to);
  const audible = (track: "bot" | "mic", from: number, to: number) =>
    levels.filter((p) => p.t >= from && p.t < to && (p[track] ?? FLOOR_DB) >= AUDIBLE_DB);
  const typed = options.mode !== "audio";

  const offer = first(
    (e) =>
      e.source === "http" &&
      e.event === "request" &&
      field(e.data, "method") === "POST" &&
      String(field(e.data, "url")).endsWith("/api/offer"),
  );
  const connected = first((e) => isRtvi(e, "transportStateChanged") && e.data === "connected");
  const ready = first((e) => isRtvi(e, "botReady"));
  const asked = first((e) => e.source === "harness" && /^ask(Text|Voice)$/.test(e.event));
  const barged = first((e) => e.source === "harness" && e.event === "bargeIn");
  const greetingFrom = connected?.t ?? 0;
  const greetingTo = asked?.t ?? end + 1;
  const replyTo = barged?.t ?? end + 1;

  const greetingText = botText(between(greetingFrom, greetingTo));
  const greetingAudio = audible("bot", greetingFrom, greetingTo);
  const replyText = asked ? botText(between(asked.t, replyTo)) : "";
  const replyAudio = asked ? audible("bot", asked.t, replyTo) : [];
  const userText = asked ? userTranscript(between(asked.t, replyTo)) : "";
  const replySpeech = asked && first((e) => isRtvi(e, "botStartedSpeaking"), asked.t, replyTo);
  const userTurns =
    asked && options.mode === "audio"
      ? between(asked.t, replySpeech?.t ?? end + 1).filter((e) => isRtvi(e, "userStoppedSpeaking"))
      : [];
  // Speech-to-text can end the user's turn at a pause mid-question; the bot answers the last one.
  const userStopped = userTurns.at(-1);
  const userCer =
    options.mode === "audio" && options.question !== null && userText !== ""
      ? charErrorRate(options.question, userText)
      : null;
  const spokenQuestion = asked ? audible("mic", asked.t, replyAudio[0]?.t ?? end + 1) : [];
  const questionEnd = typed ? asked?.t : (spokenQuestion.at(-1)?.t ?? userStopped?.t);
  const since = (from: number | undefined, to: number | undefined) =>
    from === undefined || to === undefined ? null : to - from;
  const botTurn = (from: number, to: number) => {
    const llm = first((e) => isRtvi(e, "botLlmStarted"), from, to);
    return {
      llm,
      text: first((e) => e.source === "rtvi" && BOT_TEXT_EVENTS.has(e.event), llm?.t ?? from, to),
      speaking: first((e) => isRtvi(e, "botStartedSpeaking"), from, to),
    };
  };
  const greetingTurn = botTurn(greetingFrom, greetingTo);
  const replyTurn = asked ? botTurn(userStopped?.t ?? asked.t, replyTo) : undefined;
  const finalTranscript =
    asked &&
    last(
      (e) =>
        (isRtvi(e, "userTranscript") || isRtvi(e, "userInput")) && field(e.data, "final") === true,
      asked.t,
      replyTurn?.llm?.t ?? replySpeech?.t,
    );

  // --barge-in: the caller talks over her reply; she stops, hears it out and answers it.
  const cutIn = barged && first((e) => isRtvi(e, "userStartedSpeaking"), barged.t);
  const cutOff = cutIn && first((e) => isRtvi(e, "botStoppedSpeaking"), cutIn.t);
  const bargeStopped = cutIn && first((e) => isRtvi(e, "userStoppedSpeaking"), cutIn.t);
  const bargeTurn = barged ? botTurn(bargeStopped?.t ?? barged.t, end + 1) : undefined;
  const bargeAudio = barged ? audible("bot", bargeStopped?.t ?? barged.t, end + 1) : [];
  const bargeText = barged ? botText(between(bargeStopped?.t ?? barged.t, end + 1)) : "";
  const bargeTranscript =
    cutIn &&
    last(
      (e) =>
        (isRtvi(e, "userTranscript") || isRtvi(e, "userInput")) && field(e.data, "final") === true,
      cutIn.t,
      bargeTurn?.llm?.t,
    );
  // She was talking when the caller cut in: her audio was audible just before.
  const talkingOver = cutIn ? audible("bot", cutIn.t - 500, cutIn.t + LEVEL_INTERVAL_MS) : [];

  const stagesMs = {
    greeting: stages([
      ["connected", connected?.t],
      ["bot-ready", ready?.t],
      ["llm", greetingTurn.llm?.t],
      ["text", greetingTurn.text?.t],
      ["speaking", greetingTurn.speaking?.t],
      ["audio", greetingAudio[0]?.t],
    ]),
    reply: stages([
      ["question end", questionEnd],
      ["vad stop", options.mode === "audio" ? userStopped?.t : undefined],
      ["transcript", options.mode === "audio" ? finalTranscript?.t : undefined],
      ["llm", replyTurn?.llm?.t],
      ["text", replyTurn?.text?.t],
      ["speaking", replyTurn?.speaking?.t],
      ["audio", replyAudio[0]?.t],
    ]),
    ...(barged
      ? {
          "barge-in": stages([
            ["barge-in", barged.t],
            ["user started", cutIn?.t],
            ["bot stopped", cutOff?.t],
            ["vad stop", bargeStopped?.t],
            ["transcript", bargeTranscript?.t],
            ["llm", bargeTurn?.llm?.t],
            ["text", bargeTurn?.text?.t],
            ["speaking", bargeTurn?.speaking?.t],
            ["audio", bargeAudio[0]?.t],
          ]),
        }
      : {}),
  };

  const latencyMs = {
    offerToConnected: since(offer?.t, connected?.t),
    connectedToBotReady: since(connected?.t, ready?.t),
    connectedToGreetingAudio: since(connected?.t, greetingAudio[0]?.t),
    questionEndToReplyAudio: since(questionEnd, replyAudio[0]?.t),
    questionEndToBotStartedSpeaking: since(questionEnd, replySpeech?.t),
    questionEndToUserStoppedSpeaking:
      options.mode === "audio" ? since(questionEnd, userStopped?.t) : null,
    ...(barged
      ? {
          userStartedToBotStopped: since(cutIn?.t, cutOff?.t),
          bargeInEndToReplyAudio: since(bargeStopped?.t, bargeAudio[0]?.t),
        }
      : {}),
  };

  const ms = (value: number | null) => (value === null ? "n/a" : `${value} ms`);
  const quote = (text: string) => (text.length > 60 ? `"${text.slice(0, 60)}..."` : `"${text}"`);
  const notAsked = "the question was never asked";
  const version = String(field(ready?.data, "version") ?? "");
  const checks: Check[] = [
    {
      name: "connected",
      pass: connected !== undefined,
      detail: connected ? `offer->connected ${ms(latencyMs.offerToConnected)}` : "never connected",
    },
    {
      name: "bot-ready",
      pass: ready !== undefined,
      detail: ready ? `protocol ${version}` : "no bot-ready message",
    },
    {
      name: "greeting text",
      pass: greetingText !== "",
      detail: greetingText ? quote(greetingText) : "no bot text before the question",
    },
    {
      name: "greeting audio",
      pass: greetingAudio.length >= MIN_AUDIBLE_SAMPLES,
      detail: `${greetingAudio.length * LEVEL_INTERVAL_MS} ms audible, first after connected ${ms(latencyMs.connectedToGreetingAudio)}`,
    },
  ];
  if (options.mode === "audio") {
    const heard = [
      userText ? quote(userText) : "no final user transcript",
      ...(userTurns.length > 1 ? [`${userTurns.length} user turns`] : []),
      ...(userCer === null ? [] : [`CER ${Math.round(userCer * 100)}%`]),
      `mic audible ${spokenQuestion.length * LEVEL_INTERVAL_MS} ms`,
    ];
    checks.push({
      name: "user transcript",
      pass: userText !== "" && (userCer === null || userCer <= MAX_QUESTION_CER),
      detail: !asked ? notAsked : heard.join(", "),
    });
  }
  checks.push(
    {
      name: "reply text",
      pass: replyText !== "",
      detail: !asked ? notAsked : replyText ? quote(replyText) : "no bot text after the question",
    },
    {
      name: "reply audio",
      pass: replyAudio.length >= MIN_AUDIBLE_SAMPLES,
      detail: !asked
        ? notAsked
        : `${replyAudio.length * LEVEL_INTERVAL_MS} ms audible, first after question end ${ms(latencyMs.questionEndToReplyAudio)}`,
    },
  );
  if (options.mode === "barge-in") {
    const stopMs = since(cutIn?.t, cutOff?.t);
    checks.push(
      {
        name: "barge-in",
        pass:
          cutIn !== undefined &&
          talkingOver.length > 0 &&
          stopMs !== null &&
          stopMs <= BARGE_IN_STOP_MS,
        detail: !barged
          ? "the barge-in never played"
          : !cutIn
            ? "no user-started-speaking after it"
            : talkingOver.length === 0
              ? "she was no longer audible when the caller cut in"
              : `bot-stopped-speaking ${ms(stopMs)} after user-started-speaking`,
      },
      {
        name: "barge-in reply",
        pass: bargeText !== "" && bargeAudio.length >= MIN_AUDIBLE_SAMPLES,
        detail: bargeText
          ? `${quote(bargeText)}, ${bargeAudio.length * LEVEL_INTERVAL_MS} ms audible`
          : "no bot text after the barge-in",
      },
    );
  }

  // The bot's messages as sent, which client-js's events only partly show.
  const wire = recorder.timeline
    .filter((e) => e.source === "wire")
    .map((e) => ({ type: e.event, data: e.data }));
  const invariants = checkInvariants(wire, { native: options.engine !== "pipedog" });
  checks.push({
    name: "rtvi invariants",
    pass: wire.length > 0 && invariants.length === 0,
    detail:
      wire.length === 0
        ? "no RTVI message captured off the data channel"
        : invariants.length === 0
          ? `I1-I10 hold over ${wire.length} messages${options.engine === "pipedog" ? " (I6 aside, for pipedog)" : ""}`
          : invariants
              .slice(0, 3)
              .map((v) => `${v.id} at ${v.index}: ${v.detail}`)
              .join("; "),
  });

  const spans = { bot: audibleSpans(levels, "bot"), mic: audibleSpans(levels, "mic") };
  const turns = pacingByTurn(recorder.timeline, spans.bot, end);

  for (const track of ["bot", "mic"] as const) {
    for (const [start, stop] of spans[track]) {
      timeline.push({ t: start, source: "level", event: `${track}AudioStart` });
      timeline.push({ t: stop, source: "level", event: `${track}AudioStop` });
    }
  }
  timeline.sort((a, b) => a.t - b.t);

  const errors = recorder.timeline.filter(
    (e) =>
      (e.source === "rtvi" && ["error", "messageError", "deviceError"].includes(e.event)) ||
      (e.source === "console" && e.event !== "warning") ||
      (e.source === "harness" &&
        [
          "error",
          "timeout",
          "aborted",
          "connectFailed",
          "browserClosed",
          "pageCrashed",
          "botAudioPlayFailed",
          "micTrackReplaceFailed",
        ].includes(e.event)),
  );
  const errorLabel = (e: TimelineEntry) => {
    const phase = field(e.data, "phase");
    return `${e.source} ${e.event}${phase === undefined ? "" : ` (${phase})`}`;
  };
  checks.push({
    name: "no errors",
    pass: errors.length === 0,
    detail: errors.length === 0 ? "none" : [...new Set(errors.map(errorLabel))].join(", "),
  });

  return {
    harness: {
      mode: options.mode,
      engine: options.engine,
      baseUrl: options.baseUrl,
      question: options.question,
      micFile,
      bargeIn:
        bargeInWav === null
          ? null
          : { file: bargeInWav, text: options.bargeInFile ? null : BARGE_IN },
      startedAt: new Date(recorder.startedAt).toISOString(),
      timeoutMs: options.timeoutMs,
      levelIntervalMs: LEVEL_INTERVAL_MS,
      audibleDb: AUDIBLE_DB,
    },
    pass: checks.every((check) => check.pass),
    checks,
    latencyMs,
    stagesMs,
    pacing: turns,
    invariants,
    bot: { ready: ready?.data ?? null, webrtc: browserStats },
    transcript: {
      greeting: greetingText,
      user: userText,
      userTurns: options.mode === "audio" ? userTurns.length : null,
      userCer,
      reply: replyText,
      ...(barged
        ? {
            bargeIn: bargeTranscript ? String(field(bargeTranscript.data, "text")) : "",
            afterBargeIn: bargeText,
          }
        : {}),
    },
    audibleSpans: spans,
    errors,
    timeline,
    levels,
  };
}

type Report = ReturnType<typeof analyze>;

function printSummary(report: Report, out: string): void {
  const { harness, latencyMs } = report;
  const about = field(report.bot.ready, "about");
  const library = [field(about, "library"), field(about, "library_version")].filter(Boolean);
  const protocol = String(field(report.bot.ready, "version") ?? "unknown");
  console.log(
    `\ne2e call  ${harness.mode}  ${harness.baseUrl}${harness.engine ? `  ${harness.engine}` : ""}  RTVI ${protocol}${library.length ? ` (${library.join(" ")})` : ""}`,
  );
  if (harness.question) console.log(`question  ${harness.question}`);
  for (const check of report.checks) {
    console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name.padEnd(16)} ${check.detail}`);
  }
  const ms = (value: number | null) => (value === null ? "n/a" : `${value} ms`);
  console.log(
    `latency   offer->connected ${ms(latencyMs.offerToConnected)} | connected->greeting audio ${ms(latencyMs.connectedToGreetingAudio)} | question end->first reply audio ${ms(latencyMs.questionEndToReplyAudio)}`,
  );
  for (const [turn, points] of Object.entries(report.stagesMs)) {
    const path = points.map((p, i) =>
      i === 0 ? p.stage : `${p.stage} ${p.deltaMs < 0 ? "" : "+"}${p.deltaMs}`,
    );
    if (points.length > 1) console.log(`${turn.padEnd(9)} ${path.join(" > ")} ms`);
  }
  for (const [turn, p] of Object.entries(report.pacing)) {
    const gaps = p.gapsMs.length > 0 ? p.gapsMs.join("/") : "none";
    console.log(
      `${turn.padEnd(9)} tts->speaking ${ms(p.ttsToSpeakingMs)} | gaps ${gaps} ms | stopped after audio ${ms(p.stoppedAfterAudioMs)} | bot-tts-stopped ${p.ttsStopped ? "yes" : "no"}`,
    );
  }
  if (report.transcript.user) console.log(`user      ${report.transcript.user}`);
  for (const error of report.errors.slice(0, 8)) {
    const detail = JSON.stringify(error.data ?? null);
    console.log(`error     +${error.t} ms ${error.source} ${error.event} ${detail.slice(0, 160)}`);
  }
  console.log(
    `timeline  ${out} (${report.timeline.length} events, ${report.levels.length} level samples)`,
  );
  console.log(report.pass ? "PASS" : "FAIL");
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
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
  const micFile =
    options.mode === "audio"
      ? (options.audioFile ?? (await synthesizeQuestion(options.audioDir)))
      : await silence(options.audioDir);
  const bargeInWav =
    options.mode === "barge-in"
      ? (options.bargeInFile ?? (await synthesizeBargeIn(options.audioDir)))
      : null;
  const recorder = new Recorder();
  // Chrome loops the capture file unless `%noloop` follows its path, and a looping question
  // would be asked again while the bot is still answering it.
  const capture = options.mode === "audio" ? `${micFile}%noloop` : micFile;
  const stats = await call(options, capture, bargeInWav, recorder);
  const report = analyze(options, micFile, bargeInWav, recorder, stats);
  await Bun.write(options.out, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report, options.out);
  return report.pass ? 0 : 1;
}

process.exit(
  await main().catch((error) => {
    console.error(error);
    return 2;
  }),
);
