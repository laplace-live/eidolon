// For the voice engine's G5: on Fish's live socket, does a flush sent only once the last one's
// audio has gone quiet come back as one burst and then silence, and how long must that silence
// last before it is the end (FISH_SEGMENT_IDLE_MS)? Billed per byte: it prints the cost first.
//
//   bun docs/benchmarks/2026-11-10-fish-flush/measure.ts --wav <path>

// Must stay the first import: the .env and settings files, as the laplace-* commands load them.
import "../../../apps/cli/src/load-env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { activePersona, errorText } from "../../../packages/config/src/index.ts";
import {
  costOf,
  hasKey,
  missingKey,
  modelInfo,
  ProviderConfigError,
  priceOf,
  type Selection,
  selectRequired,
  stripMarkup,
  textUnits,
  voiceOf,
  withUsageScope,
} from "../../../packages/providers/src/index.ts";
import { FISH_URL } from "../../../packages/providers/src/speech/stream/fish.ts";
import {
  openSpeech,
  SPEECH_STALL_MS,
  type SpeechStream,
  type UtteranceAudio,
} from "../../../packages/providers/src/speech/stream/index.ts";
import { within } from "../../../packages/providers/src/speech/stream/shared.ts";
import { accountUrl } from "../../../packages/providers/src/stt/stream.ts";
import { installUsageLedger } from "../../../packages/usage/src/index.ts";
import {
  type Arrival,
  type FlushRecord,
  type PipelinedRecord,
  type PipelinedSummary,
  type SerialRecord,
  type SerialSummary,
  type Stats,
  summarizePipelined,
  summarizeSerial,
  wavFile,
} from "./analyze.ts";

interface Line {
  readonly text: string;
  readonly listen: string;
}

// Mini-replies in her register, each opening with one direction as prompt.md asks, so each
// direction's carry into the next flush can be heard on its own (README, "The sentences").
const SENTENCES: readonly Line[] = [
  { text: "[压低声音，像在说悄悄话] 跟你说个秘密哦。", listen: "a whisper" },
  {
    text: "其实我昨天背着店长，偷偷吃了三块小蛋糕。",
    listen: "carry: still a whisper, from the flush before",
  },
  { text: "[正常音量，轻松自然] 好啦，不说这个了。", listen: "plain again" },
  { text: "[懒洋洋的，带点笑意] 嗯……今天花店人好多。", listen: "lazy, smiling" },
  {
    text: "[chuckling] 嘿嘿，我一个人包了二十多束花，<emphasis>手都酸了</emphasis>。",
    listen: "a laugh on 嘿嘿; 手都酸了 stressed; no tag read aloud",
  },
  { text: "嗯，好。", listen: "short" },
  { text: "[语速很慢，一字一顿] 你、听、好、了。", listen: "slow, one word at a time" },
  {
    text: "明天下午三点，花店门口，不见不散。",
    listen: "carry: still slower than plain, from the flush before",
  },
  { text: "[正常音量，轻松自然] 开玩笑的啦，你别当真，嗯。", listen: "plain again" },
  { text: "[温柔地安慰] 别难过了，我在呢。", listen: "gentle, comforting" },
  {
    text: "我没事，<whisper>你先走吧</whisper>。",
    listen: "carry: still gentle; whispered from 你先走吧 on",
  },
  {
    text: "一会儿我就过来找你，记得给我留一杯奶绿，少糖少冰，嗯。",
    listen: "voiced: the whisper closed in the flush before",
  },
  { text: "[突然来劲，语速变快] 哎呀你知道吗！", listen: "suddenly fast and excited" },
  {
    text: "坚果以前最喜欢趴在收银台上晒太阳，谁摸它它就翻肚皮，客人都说它才是真店长，对吧。",
    listen: "carry: still fast, from the flush before",
  },
  {
    text: "[有点失落，慢慢地说] [sighing] 唉…它跑路那天，我也是这种感觉，嗯。",
    listen: "a sigh on 唉, then slow and low",
  },
  { text: "[laughing] 哈哈哈，好啦好啦，不聊了，晚安！", listen: "a laugh on 哈哈哈" },
];

/** The pipelined run, sent as G2 sends a reply: every segment at once. */
const PIPELINED: readonly Line[] = SENTENCES.slice(0, 4);

/** The most the run may send, both runs together, in characters. */
const MAX_CHARACTERS = 600;

const USAGE = `usage: bun docs/benchmarks/2026-11-10-fish-flush/measure.ts [options]

  --wav <path>      the serial run's audio (default: serial.wav beside this script); the
                    pipelined run's goes beside it as <name>-pipelined.wav
  --out <path>      every arrival and the summary, as JSON (default: results.json beside this
                    script)
  --persona <id>    whose voice role speaks (default: the active persona)
  --settle-ms <n>   how long a flush's audio must stay quiet before the next is sent (default 2500)
  --warm-ms <n>     how long to let a session open before its first flush (default 2000)
  --dry-run         print the plan and its cost, and send nothing`;

interface Options {
  readonly wav: string;
  readonly out: string;
  readonly settleMs: number;
  readonly warmMs: number;
  readonly dryRun: boolean;
}

class UsageError extends Error {}

function options(argv: readonly string[]): Options {
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse(argv).values;
  } catch (error) {
    throw new UsageError(errorText(error));
  }
  if (values.help) throw new UsageError("");
  const wholeMs = (name: string, value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new UsageError(`--${name} takes a whole number of ms`);
    }
    return parsed;
  };
  return {
    wav: values.wav ?? join(import.meta.dir, "serial.wav"),
    out: values.out ?? join(import.meta.dir, "results.json"),
    settleMs: wholeMs("settle-ms", values["settle-ms"], 2500),
    warmMs: wholeMs("warm-ms", values["warm-ms"], 2000),
    dryRun: values["dry-run"] ?? false,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    options: {
      wav: { type: "string" },
      out: { type: "string" },
      // load-env.ts reads it before any setting is.
      persona: { type: "string" },
      "settle-ms": { type: "string" },
      "warm-ms": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

const started = performance.now();
const now = () => Math.round((performance.now() - started) * 10) / 10;

/** Where a listener files what comes: one flush's audio, or what came after the stop. */
interface Sink {
  readonly arrivals: Arrival[];
  readonly pcm: Int16Array[];
}

const newSink = (): Sink => ({ arrivals: [], pcm: [] });

/** Reads an utterance's audio as it comes, stamping each message and filing it in `sink`. */
class Listener {
  sink: Sink = newSink();
  done = false;
  finishAt: number | null = null;
  /** Null once Fish's finish came, else why the audio ended. */
  readonly ended: Promise<string | null>;
  #arrived = Promise.withResolvers<void>();

  constructor(audio: AsyncIterable<UtteranceAudio>) {
    this.ended = this.#read(audio).finally(() => {
      this.done = true;
    });
  }

  async #read(audio: AsyncIterable<UtteranceAudio>): Promise<string | null> {
    for await (const event of audio) {
      const t = now();
      if (event.kind === "pcm") {
        this.sink.arrivals.push({ t, bytes: event.pcm.byteLength });
        this.sink.pcm.push(event.pcm);
        this.#arrived.resolve();
        this.#arrived = Promise.withResolvers<void>();
      } else if (event.kind === "end") {
        this.finishAt = t;
        return null;
      } else if (event.kind === "error") {
        return event.message;
      }
    }
    return "the session ended without a finish";
  }

  /**
   * Waits until the audio ends, or the sink has had none for `quietMs` since its last, or for
   * `firstMs` since `since` while it has none.
   */
  async settle(since: number, firstMs: number, quietMs: number): Promise<void> {
    while (!this.done) {
      const last = this.sink.arrivals.at(-1)?.t;
      const wait = (last === undefined ? since + firstMs : last + quietMs) - now();
      if (wait <= 0) return;
      await within(Promise.race([this.ended, this.#arrived.promise]), wait);
    }
  }
}

async function serialRun(
  stream: SpeechStream,
  settleMs: number,
): Promise<{ record: SerialRecord; pcm: Int16Array[] }> {
  const utterance = stream.utterance(null);
  const listener = new Listener(utterance.audio);
  const flushes: FlushRecord[] = [];
  const pcm: Int16Array[] = [];
  for (const [i, line] of SENTENCES.entries()) {
    if (listener.done) break;
    const sink = newSink();
    listener.sink = sink;
    const sentAt = now();
    utterance.say({ id: i, text: line.text });
    await listener.settle(sentAt, SPEECH_STALL_MS, settleMs);
    const flush = { ...line, sentAt, arrivals: sink.arrivals, movedOnAt: now() };
    flushes.push(flush);
    pcm.push(...sink.pcm);
    const first = sink.arrivals[0];
    const last = sink.arrivals.at(-1);
    console.error(
      first && last
        ? `flush ${i + 1}/${SENTENCES.length}: ${sink.arrivals.length} messages, the first ${ms(first.t - sentAt)} after the flush, the last ${ms(last.t - first.t)} after it; then waited ${ms(flush.movedOnAt - last.t)}`
        : `flush ${i + 1}/${SENTENCES.length}: no audio in ${ms(flush.movedOnAt - sentAt)}`,
    );
  }
  const after = newSink();
  listener.sink = after;
  let stopAt: number | null = null;
  let error: string | null;
  if (!listener.done) {
    stopAt = now();
    utterance.end();
    await listener.settle(stopAt, SPEECH_STALL_MS, SPEECH_STALL_MS);
  }
  if (listener.done) {
    error = await listener.ended;
  } else {
    utterance.cancel();
    error = `no finish within ${SPEECH_STALL_MS / 1000} s of the stop`;
  }
  pcm.push(...after.pcm);
  return {
    record: {
      settleMs,
      flushes,
      stopAt,
      afterStop: after.arrivals,
      finishAt: listener.finishAt,
      error,
    },
    pcm,
  };
}

async function pipelinedRun(
  stream: SpeechStream,
): Promise<{ record: PipelinedRecord; pcm: Int16Array[] }> {
  const utterance = stream.utterance(null);
  const listener = new Listener(utterance.audio);
  const sentAt = now();
  for (const [i, line] of PIPELINED.entries()) utterance.say({ id: i, text: line.text });
  utterance.end();
  await listener.settle(sentAt, SPEECH_STALL_MS, SPEECH_STALL_MS);
  let error: string | null;
  if (listener.done) {
    error = await listener.ended;
  } else {
    utterance.cancel();
    error = `no audio and no finish for ${SPEECH_STALL_MS / 1000} s`;
  }
  const { arrivals, pcm } = listener.sink;
  return {
    record: {
      texts: PIPELINED.map((line) => line.text),
      sentAt,
      arrivals,
      finishAt: listener.finishAt,
      error,
    },
    pcm,
  };
}

const ms = (value: number) => `${value.toFixed(1)} ms`;
const cell = (value: number | null, digits = 1) => (value === null ? "-" : value.toFixed(digits));

function spread(stats: Stats | null): string {
  return stats === null
    ? "none"
    : `p50 ${stats.p50}, p90 ${stats.p90}, p99 ${stats.p99}, max ${stats.max} ms (n=${stats.n})`;
}

const COLUMNS = [
  "#",
  "first ms",
  "burst ms",
  "max gap",
  "msgs",
  "audio s",
  "slack ms",
  "wait ms",
  "wav s",
  "listen for",
];

function row(cells: readonly string[]): string {
  return cells.map((text, i) => (i === cells.length - 1 ? ` ${text}` : text.padStart(9))).join("");
}

function report(serial: SerialSummary, pipelined: PipelinedSummary | null, settleMs: number) {
  const lines = [
    "",
    `serial: ${serial.flushes.length} flushes on one session, each sent once the last had been quiet ${settleMs} ms`,
    row(COLUMNS),
  ];
  for (const flush of serial.flushes) {
    lines.push(
      row([
        String(flush.flush),
        cell(flush.firstMs),
        cell(flush.burstMs),
        cell(flush.maxGapMs),
        String(flush.messages),
        cell(flush.audioSeconds, 2),
        cell(flush.slackMs),
        cell(flush.waitMs),
        cell(flush.wavSeconds, 2),
        SENTENCES[flush.flush - 1]?.listen ?? "",
      ]),
    );
  }
  lines.push(
    `gaps inside a burst: ${spread(serial.gaps)}`,
    `flush to first audio: ${spread(serial.first)}`,
    `after the stop: ${serial.afterStop.messages} audio messages; the finish came ${serial.finishAfterStopMs === null ? "never" : `${serial.finishAfterStopMs} ms after it`}`,
  );
  if (pipelined !== null) {
    const largest = pipelined.largestGaps
      .map((gap) => `${gap.ms} ms at ${gap.atSeconds.toFixed(2)} s`)
      .join(", ");
    lines.push(
      `pipelined: ${PIPELINED.length} sentences sent at once; first audio after ${cell(pipelined.firstMs)} ms, a ${cell(pipelined.burstMs)} ms burst of ${pipelined.messages} messages, ${pipelined.audioSeconds.toFixed(2)} s of audio`,
      `  gaps: ${spread(pipelined.gaps)}; largest ${largest || "none"}`,
      `  played as it came, its audio would stall ${pipelined.stallMs} ms in all`,
    );
  }
  const { suggestion, projection } = serial;
  if (suggestion !== null) {
    lines.push(
      "",
      `suggested FISH_SEGMENT_IDLE_MS = ${suggestion.idleMs}: the largest gap inside a burst, ${suggestion.largestGapMs} ms, rounded up to ${suggestion.roundedMs}, + ${suggestion.marginMs} ms margin`,
    );
  }
  if (projection !== null) {
    lines.push(
      `at ${projection.idleMs} ms, serial flushing would add silence before each sentence after the first: ${spread(projection.boundary)}; ${projection.insideMs} ms inside bursts`,
    );
    if ((projection.boundary?.p50 ?? 0) > 100) {
      lines.push(
        "  that is over 100 ms at the median: G5's bar is pipedog's gap between sentences + 100 ms",
      );
    }
  }
  lines.push(
    serial.clean
      ? "verdict: clean separation. Each flush came as one burst, and the suggested threshold tells its end from its pauses"
      : `verdict: NO CLEAN SEPARATION, G5's stop condition for serial flushes:\n${serial.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
  );
  console.log(lines.join("\n"));
}

function plan(selection: Selection): { characters: number; bytes: number } {
  const markup = modelInfo(selection.provider.id, "tts", selection.model)?.markup;
  let characters = 0;
  let bytes = 0;
  for (const line of [...SENTENCES, ...PIPELINED]) {
    const units = textUnits(stripMarkup(line.text, markup));
    characters += units.characters ?? 0;
    bytes += units.bytes ?? 0;
  }
  const price = priceOf(selection.provider.id, "tts", selection.model);
  const cost = price === undefined ? null : costOf(price, { characters, bytes });
  console.log(
    [
      `persona ${activePersona().id}: voice role on the ${selection.account.id} account, model ${selection.model}, voice ${voiceOf(selection) === undefined ? "unset" : "set"}`,
      `endpoint ${accountUrl(selection, FISH_URL)}`,
      `${SENTENCES.length} serial flushes, then ${PIPELINED.length} pipelined: ${characters} characters, ${bytes} bytes, ${cost === null ? "unpriced" : `about $${cost.toFixed(4)}`}`,
    ].join("\n"),
  );
  return { characters, bytes };
}

/** `serial.wav` → `serial-pipelined.wav`. */
function pipelinedPath(wav: string): string {
  const ext = extname(wav);
  return `${wav.slice(0, wav.length - ext.length)}-pipelined${ext || ".wav"}`;
}

async function measure(opts: Options, selection: Selection): Promise<number> {
  const stream = openSpeech();
  let serial: Awaited<ReturnType<typeof serialRun>>;
  let pipelined: Awaited<ReturnType<typeof pipelinedRun>> | null = null;
  try {
    // The bot opens a session at call setup, long before a reply: so the first flush's time to
    // audio leaves out the handshake.
    await Bun.sleep(opts.warmMs);
    serial = await serialRun(stream, opts.settleMs);
    if (serial.record.error === null) {
      await Bun.sleep(opts.warmMs);
      pipelined = await pipelinedRun(stream);
    }
  } finally {
    // Flushes the meter, which reports the run to the usage ledger.
    await stream.close();
  }
  const summary = {
    serial: summarizeSerial(serial.record),
    pipelined: pipelined === null ? null : summarizePipelined(pipelined.record),
  };
  const results = {
    date: new Date().toISOString(),
    persona: activePersona().id,
    account: selection.account.id,
    model: selection.model,
    settleMs: opts.settleMs,
    warmMs: opts.warmMs,
    sentences: SENTENCES,
    pipelinedSentences: PIPELINED.length,
    serial: serial.record,
    pipelined: pipelined?.record ?? null,
    summary,
  };
  const written: [string, string | Uint8Array][] = [
    [opts.out, `${JSON.stringify(results, null, 2)}\n`],
    [opts.wav, wavFile(serial.pcm)],
  ];
  if (pipelined !== null) written.push([pipelinedPath(opts.wav), wavFile(pipelined.pcm)]);
  for (const [path, data] of written) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  report(summary.serial, summary.pipelined, opts.settleMs);
  if (pipelined?.record.error) console.log(`the pipelined run failed: ${pipelined.record.error}`);
  console.log(`\nwrote ${written.map(([path]) => path).join(", ")}`);
  return serial.record.error === null && pipelined?.record.error === null ? 0 : 1;
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = options(Bun.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message === "" ? USAGE : `${error.message}\n\n${USAGE}`);
    return error.message === "" ? 0 : 2;
  }
  let selection: Selection;
  try {
    selection = selectRequired("voice");
  } catch (error) {
    if (!(error instanceof ProviderConfigError)) throw error;
    console.error(error.message);
    return 2;
  }
  if (selection.provider.id !== "fish") {
    console.error(
      `This measures Fish Audio's live socket, and ${activePersona().id}'s voice role is ${selection.provider.name}`,
    );
    return 2;
  }
  const { characters } = plan(selection);
  if (characters > MAX_CHARACTERS) {
    console.error(`That is over the run's cap of ${MAX_CHARACTERS} characters`);
    return 2;
  }
  if (opts.dryRun) return 0;
  if (!hasKey(selection)) {
    console.error(missingKey(selection).message);
    return 2;
  }
  installUsageLedger();
  return withUsageScope({ source: "job" }, () => measure(opts, selection));
}

process.exitCode = await main();
