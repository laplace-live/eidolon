// How long Soniox and Deepgram take to acknowledge finalize() on a live stream, with words and
// without. U20 ends a turn on that acknowledgement and caps the wait for it at this p99 + 1 s; G5
// asks a cough during her reply to end its empty turn within 1.5 s. Streams real-time audio, at most
// 3 minutes of it per provider, and writes every finalize to --out. --fake plays both recognizers
// on 127.0.0.1 and checks the run against their script. README.md has the method.

// Must stay the first import: the .env and settings files, as the laplace-* commands load them.
import "../../../apps/cli/src/load-env.ts";
import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activePersona,
  errorText,
  logger,
  setLogLevel,
} from "../../../packages/config/src/index.ts";
import {
  connectWs,
  costOf,
  installedSources,
  listAccounts,
  Meter,
  ProviderConfigError,
  priceOf,
  type Selection,
  type Sources,
  selectRequired,
  setUsageSink,
  trySelect,
  type UsageRecord,
  type WsConnection,
  type WsData,
} from "../../../packages/providers/src/index.ts";
import { deepgramUrl } from "../../../packages/providers/src/stt/deepgram.ts";
import { sttLanguage } from "../../../packages/providers/src/stt/index.ts";
import { sonioxConfig, sonioxUrl } from "../../../packages/providers/src/stt/soniox.ts";
import { pcmBytes, textOf } from "../../../packages/providers/src/stt/stream.ts";
import { installUsageLedger } from "../../../packages/usage/src/index.ts";
import { VAD_STOP_SECS } from "../../../packages/voice/src/input/vad.ts";
import { FAKE_WORDS, FakeRecognizers, type Scripted } from "./fake.ts";

const RATE = 16000;
const FRAME_SAMPLES = 320;
const FRAME_MS = 20;
const BUDGET_SECONDS = 180;
// Enough for 20 finalizes against the fake, whose one unanswered finalize costs its full wait.
const FAKE_BUDGET_SECONDS = 60;
const ACK_TIMEOUT_MS = 5_000;
/** Where a call's VAD calls finalize(): its stop edge, this long after the sound ends. */
const VAD_STOP_MS = VAD_STOP_SECS * 1000;
const LEAD_IN_MS = 1_000;
const SETTLE_MS = 300;
const CAP_MARGIN_MS = 1_000;
const GATE_MS = 1_500;
const MIN_FINALIZES = 20;
// σ of the room tone under everything: about -55 dBFS, the parity fixtures' quiet.
const ROOM_TONE = 60;
const COUGH_PEAK = 16384;
const COUGH_LENGTHS_MS = [150, 200, 250, 300, 175, 225, 275];
// The voice e2e-call.ts renders its question with.
const SAY_VOICE = "Flo (Chinese (China mainland))";
const SENTENCES = [
  "你好呀，好久不见。",
  "今天天气怎么样？",
  "我刚下班回来。",
  "你昨天直播玩的什么游戏？",
  "晚上吃什么好呢？",
  "给我唱首歌吧。",
  "坚果最近还好吗？",
  "我们下次什么时候见？",
];
// `say` pads its render with half a second of silence; speech ends at the last sample above this.
const SPEECH_FLOOR = 300;
// A fake answers within this of its scripted delay.
const FAKE_TOLERANCE_MS = 60;

type Case = "speech" | "cough" | "silence";
const CASES: readonly Case[] = ["speech", "cough", "silence"];
/** Room tone before each case's sound; a silence's whole episode is room tone. */
const GAP_MS: Readonly<Record<Case, number>> = { speech: 400, cough: 400, silence: 1_000 };

type ProviderId = "soniox" | "deepgram";
const PROVIDERS: readonly ProviderId[] = ["soniox", "deepgram"];
const NAMES: Readonly<Record<ProviderId, string>> = { soniox: "Soniox", deepgram: "Deepgram" };

interface Finalize {
  readonly index: number;
  readonly case: Case;
  /** The sentence, or the cough's length. */
  readonly label: string;
  /** Seconds of audio streamed when finalize() went out. */
  readonly at: number;
  /** ms from finalize() to its acknowledgement; null when none came within 5 s. */
  latencyMs: number | null;
  /** ms to an acknowledgement that came after 5 s, but before the next finalize(). */
  lateMs: number | null;
  /** What the acknowledging event carries: a finalized final's text, or "" for a bare `finalized`. */
  words: string;
  /** The recognizer sent any words, interim or final, during the finalize's episode. */
  heard: boolean;
}

/** Latencies in ms, by nearest rank; null when nothing was acknowledged. */
interface Stats {
  readonly count: number;
  readonly acknowledged: number;
  /** No acknowledgement within 5 s. */
  readonly never: number;
  readonly withWords: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

type Summary = Readonly<Record<Case | "all", Stats>>;

interface Verdict {
  /** U20's cap on the wait for an acknowledgement: p99 + 1 s, from finalize(). */
  readonly capMs: number | null;
  /** ms from a cough's end to the end of its empty turn under U20, at the coughs' p99. */
  readonly coughTurnMs: number | null;
  /** The same for a cough never acknowledged, which the cap ends. */
  readonly cappedTurnMs: number | null;
  readonly gateReachable: boolean;
}

interface ProviderReport {
  readonly provider: ProviderId;
  readonly account: string | null;
  readonly model: string | null;
  readonly language: string | null;
  readonly skipped: string | null;
  readonly connectMs: number | null;
  readonly audioSeconds: number;
  readonly costUsd: number | null;
  /** Why the run ended before its budget did. */
  readonly stopped: string | null;
  /** Acknowledgements with no finalize() waiting, outside the late window. */
  readonly unmatchedAcks: number;
  readonly finalizes: readonly Finalize[];
  readonly summary: Summary | null;
  readonly verdict: Verdict | null;
}

interface Target {
  readonly provider: ProviderId;
  readonly selection: Selection;
  readonly language: string | null;
}

interface Sound {
  readonly label: string;
  readonly pcm: Int16Array;
}

interface Episode {
  readonly case: Case;
  readonly label: string;
  readonly sound: Int16Array | null;
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A seeded uniform generator on [0, 1) (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * A cough: Gaussian noise through a one-pole high-pass at 250 Hz and a one-pole low-pass at 3 kHz,
 * under a 10 ms linear attack and an exponential decay whose time constant is a quarter of its
 * length, scaled to peak at -6 dBFS.
 */
function cough(ms: number, seed: number): Int16Array {
  const rand = mulberry32(seed);
  const n = Math.round((ms / 1000) * RATE);
  const dt = 1 / RATE;
  const highRc = 1 / (2 * Math.PI * 250);
  const lowRc = 1 / (2 * Math.PI * 3000);
  const a = highRc / (highRc + dt);
  const b = dt / (lowRc + dt);
  const attack = 0.01 * RATE;
  const out = new Float64Array(n);
  let previous = 0;
  let high = 0;
  let low = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const x = gaussian(rand);
    high = a * (high + x - previous);
    previous = x;
    low += b * (high - low);
    const envelope = i < attack ? i / attack : Math.exp(-(i - attack) / (n / 4));
    out[i] = low * envelope;
    peak = Math.max(peak, Math.abs(out[i] as number));
  }
  return Int16Array.from(out, (v) => Math.round((v / peak) * COUGH_PEAK));
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}: ${stderr.trim()}`);
}

/** `text` said by SAY_VOICE as 16 kHz mono PCM, cached in the OS temp folder. */
async function say(text: string): Promise<Int16Array> {
  const dir = join(tmpdir(), "eidolon-finalize-ack-audio");
  const key = createHash("sha1").update(`${SAY_VOICE}\n${text}`).digest("hex").slice(0, 12);
  const raw = join(dir, `${key}.s16le`);
  if (!(await Bun.file(raw).exists())) {
    await mkdir(dir, { recursive: true });
    const aiff = `${raw}.aiff`;
    const part = `${raw}.part`;
    try {
      await run(["say", "-v", SAY_VOICE, "-o", aiff, text]);
      const ffmpeg = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", aiff];
      await run([...ffmpeg, "-ar", "16000", "-ac", "1", "-f", "s16le", "-c:a", "pcm_s16le", part]);
      await rename(part, raw);
    } finally {
      await rm(aiff, { force: true });
      await rm(part, { force: true });
    }
  }
  const pcm = new Int16Array(await Bun.file(raw).arrayBuffer());
  let first = 0;
  while (first < pcm.length && Math.abs(pcm[first] as number) <= SPEECH_FLOOR) first++;
  let last = pcm.length;
  while (last > first && Math.abs(pcm[last - 1] as number) <= SPEECH_FLOOR) last--;
  // `say` exits 0 even for a voice that is not installed, and renders nothing.
  if (last - first < RATE / 4) {
    throw new Error(
      `say -v "${SAY_VOICE}" rendered no speech for ${text}; is the voice installed?`,
    );
  }
  return pcm.slice(first, last);
}

/** Speech, a cough and a silence, round after round, until the budget stops the run. */
function* episodes(speech: readonly Sound[]): Generator<Episode> {
  for (let round = 0; ; round++) {
    const sentence = speech[round % speech.length] as Sound;
    yield { case: "speech", label: sentence.label, sound: sentence.pcm };
    const ms = COUGH_LENGTHS_MS[round % COUGH_LENGTHS_MS.length] as number;
    yield { case: "cough", label: `${ms} ms cough`, sound: cough(ms, 1000 + round) };
    yield { case: "silence", label: `${GAP_MS.silence} ms of room tone`, sound: null };
  }
}

const soundMs = (sound: Int16Array | null) =>
  sound === null ? 0 : Math.ceil(sound.length / FRAME_SAMPLES) * FRAME_MS;

/** The most audio an episode can stream: its finalize never acknowledged. */
const worstMs = (episode: Episode) =>
  GAP_MS[episode.case] + soundMs(episode.sound) + VAD_STOP_MS + ACK_TIMEOUT_MS + SETTLE_MS;

/** 20 ms frames of room tone, with any sound over it, sent on the clock as a call's arrive. */
class Pacer {
  readonly #send: (pcm: Int16Array) => void;
  readonly #budgetFrames: number;
  readonly #tone = mulberry32(7);
  #next = performance.now();
  #frames = 0;

  constructor(send: (pcm: Int16Array) => void, budgetSeconds: number) {
    this.#send = send;
    this.#budgetFrames = (budgetSeconds * 1000) / FRAME_MS;
  }

  get seconds(): number {
    return (this.#frames * FRAME_MS) / 1000;
  }

  /** One frame, with `sound` (at most a frame's worth) over the room tone; false past the budget. */
  async frame(sound?: Int16Array): Promise<boolean> {
    if (this.#frames >= this.#budgetFrames) return false;
    const pcm = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const v = ROOM_TONE * gaussian(this.#tone) + (sound?.[i] ?? 0);
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    // Behind after a stall, frames go out at once and the clock catches up, as a call's do.
    const wait = this.#next - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    this.#send(pcm);
    this.#frames++;
    this.#next += FRAME_MS;
    return true;
  }

  async sound(pcm: Int16Array): Promise<boolean> {
    for (let start = 0; start < pcm.length; start += FRAME_SAMPLES) {
      if (!(await this.frame(pcm.subarray(start, start + FRAME_SAMPLES)))) return false;
    }
    return true;
  }

  async quiet(ms: number): Promise<boolean> {
    for (let i = 0; i < ms / FRAME_MS; i++) if (!(await this.frame())) return false;
    return true;
  }
}

interface Listener {
  words(): void;
  ack(words: string): void;
  error(message: string): void;
}

interface Wire {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly opening: string | null;
  readonly finalize: string;
  readonly closing: string | null;
  read(data: WsData, on: Listener): void;
}

/**
 * Soniox as its client speaks it: the acknowledgement is the `<fin>` token, and the event it makes
 * carries the final tokens since the previous one.
 */
function sonioxWire({ selection, language }: Target): Wire {
  let final: string[] = [];
  return {
    url: sonioxUrl(selection),
    headers: { Authorization: `Bearer ${selection.apiKey}` },
    opening: sonioxConfig(selection.model, language),
    finalize: '{"type": "finalize"}',
    closing: null,
    read(data, on) {
      const content = JSON.parse(textOf(data)) as {
        tokens?: readonly { text: string; is_final?: boolean }[];
        error_code?: unknown;
        error_message?: unknown;
        finished?: unknown;
      };
      for (const token of content.tokens ?? []) {
        if (token.is_final && token.text === "<fin>") {
          on.ack(final.join(""));
          final = [];
          continue;
        }
        if (token.text === "<end>") continue;
        if (token.is_final) final.push(token.text);
        if (token.text.trim()) on.words();
      }
      if (content.error_code || content.error_message) {
        on.error(`Soniox error ${content.error_code}: ${content.error_message}`);
      } else if (content.finished) {
        on.error("Soniox finished the stream");
      }
    },
  };
}

/**
 * Deepgram as its client speaks it: the acknowledgement is the final `Results` marked
 * `from_finalize`, and the event it makes carries that message's transcript.
 */
function deepgramWire({ selection, language }: Target): Wire {
  return {
    url: deepgramUrl(selection, language),
    headers: { Authorization: `Token ${selection.apiKey}` },
    opening: null,
    finalize: '{"type": "Finalize"}',
    closing: '{"type": "CloseStream"}',
    read(data, on) {
      if (typeof data !== "string") return;
      const message = JSON.parse(data) as {
        type?: unknown;
        is_final?: unknown;
        from_finalize?: unknown;
        channel?: { alternatives?: readonly { transcript?: string }[] };
      };
      if (message.type === "Error") on.error(`Deepgram error: ${data}`);
      if (message.type !== "Results") return;
      const transcript = message.channel?.alternatives?.[0]?.transcript ?? "";
      if (transcript.trim()) on.words();
      if (message.is_final && message.from_finalize) on.ack(transcript);
    },
  };
}

function skippedReport(provider: ProviderId, why: string, target?: Target): ProviderReport {
  return {
    provider,
    account: target?.selection.account.id ?? null,
    model: target?.selection.model ?? null,
    language: target?.language ?? null,
    skipped: why,
    connectMs: null,
    audioSeconds: 0,
    costUsd: null,
    stopped: null,
    unmatchedAcks: 0,
    finalizes: [],
    summary: null,
    verdict: null,
  };
}

function costFor(selection: Selection, audioSeconds: number): number | null {
  const price = priceOf(selection.provider.id, "stt", selection.model);
  return price === undefined ? null : costOf(price, { audioSeconds });
}

async function measure(
  target: Target,
  budgetSeconds: number,
  speech: readonly Sound[],
): Promise<ProviderReport> {
  const wire = target.provider === "soniox" ? sonioxWire(target) : deepgramWire(target);
  const connecting = performance.now();
  let socket: WsConnection;
  try {
    socket = await connectWs(wire.url, wire.headers, new AbortController().signal);
  } catch (error) {
    return skippedReport(target.provider, `couldn't connect: ${errorText(error)}`, target);
  }
  const connectMs = round(performance.now() - connecting);
  if (wire.opening !== null) socket.send(wire.opening);

  const meter = new Meter(target.selection);
  const finalizes: Finalize[] = [];
  const sentAt = new Map<Finalize, number>();
  const waiting: Finalize[] = [];
  let lateFor: Finalize | null = null;
  let unmatchedAcks = 0;
  let heard = false;
  let stopped: string | null = null;
  let closing = false;

  const on: Listener = {
    words: () => {
      heard = true;
    },
    ack: (words) => {
      const now = performance.now();
      const record = waiting.shift();
      if (record === undefined) {
        if (lateFor !== null && lateFor.lateMs === null) {
          lateFor.lateMs = round(now - (sentAt.get(lateFor) as number));
        } else {
          unmatchedAcks++;
        }
        return;
      }
      record.latencyMs = round(now - (sentAt.get(record) as number));
      record.words = words;
      record.heard = heard || words.trim() !== "";
    },
    error: (message) => {
      stopped ??= message;
    },
  };
  const reading = (async () => {
    for await (const data of socket.messages) {
      try {
        wire.read(data, on);
      } catch (error) {
        logger.warning(`Unreadable message (${errorText(error)}): ${textOf(data).slice(0, 200)}`);
      }
    }
    if (!closing) stopped ??= `the server closed the connection (${socket.closeCode})`;
  })();

  const pacer = new Pacer((pcm) => {
    meter.add({ audioSeconds: pcm.length / RATE });
    socket.send(pcmBytes(pcm));
  }, budgetSeconds);
  const spent = () => {
    stopped ??= "the audio budget ran out mid-episode";
  };
  try {
    if (!(await pacer.quiet(LEAD_IN_MS))) spent();
    for (const episode of episodes(speech)) {
      if (stopped !== null || pacer.seconds * 1000 + worstMs(episode) > budgetSeconds * 1000) break;
      heard = false;
      if (!(await pacer.quiet(GAP_MS[episode.case]))) spent();
      if (episode.sound !== null && !(await pacer.sound(episode.sound))) spent();
      if (!(await pacer.quiet(VAD_STOP_MS))) spent();
      if (stopped !== null) break;
      const record: Finalize = {
        index: finalizes.length,
        case: episode.case,
        label: episode.label,
        at: round(pacer.seconds, 2),
        latencyMs: null,
        lateMs: null,
        words: "",
        heard: false,
      };
      socket.send(wire.finalize);
      const sent = performance.now();
      sentAt.set(record, sent);
      finalizes.push(record);
      waiting.push(record);
      lateFor = null;
      while (record.latencyMs === null && stopped === null) {
        if (performance.now() - sent >= ACK_TIMEOUT_MS) break;
        if (!(await pacer.frame())) spent();
      }
      if (record.latencyMs === null) {
        // An acknowledgement after this is late, until the next finalize() makes it ambiguous.
        waiting.splice(waiting.indexOf(record), 1);
        record.heard = heard;
        lateFor = record;
      }
      if (!(await pacer.quiet(SETTLE_MS))) spent();
    }
  } finally {
    closing = true;
    if (wire.closing !== null) socket.send(wire.closing);
    await socket.close();
    await reading;
    meter.flush();
  }
  const audioSeconds = round(pacer.seconds, 2);
  const summary = summarize(finalizes);
  return {
    provider: target.provider,
    account: target.selection.account.id,
    model: target.selection.model,
    language: target.language,
    skipped: null,
    connectMs,
    audioSeconds,
    costUsd: costFor(target.selection, audioSeconds),
    stopped,
    unmatchedAcks,
    finalizes,
    summary,
    verdict: verdictOf(summary),
  };
}

/** The nearest-rank percentile of ascending `sorted`: below 100 samples, p99 is the maximum. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number;
}

function statsOf(records: readonly Finalize[]): Stats {
  const latencies = records
    .flatMap((record) => (record.latencyMs === null ? [] : [record.latencyMs]))
    .sort((a, b) => a - b);
  return {
    count: records.length,
    acknowledged: latencies.length,
    never: records.length - latencies.length,
    withWords: records.filter((record) => record.latencyMs !== null && record.words.trim() !== "")
      .length,
    p50: percentile(latencies, 0.5),
    p90: percentile(latencies, 0.9),
    p99: percentile(latencies, 0.99),
    max: latencies.at(-1) ?? null,
  };
}

function summarize(records: readonly Finalize[]): Summary {
  const of = (kind: Case) => statsOf(records.filter((record) => record.case === kind));
  return {
    all: statsOf(records),
    speech: of("speech"),
    cough: of("cough"),
    silence: of("silence"),
  };
}

/**
 * Under U20 a cough's empty turn ends at the VAD's stop, then at the acknowledgement, or at the cap
 * when none comes. The gate is reachable when the coughs' p99 ends it in time, and the cap would
 * too for any cough left unacknowledged.
 */
function verdictOf(summary: Summary): Verdict {
  const { all, cough } = summary;
  if (all.p99 === null) {
    return { capMs: null, coughTurnMs: null, cappedTurnMs: null, gateReachable: false };
  }
  const capMs = all.p99 + CAP_MARGIN_MS;
  const cappedTurnMs = VAD_STOP_MS + capMs;
  const coughTurnMs = cough.p99 === null ? null : VAD_STOP_MS + Math.min(cough.p99, capMs);
  const gateReachable =
    coughTurnMs !== null && coughTurnMs < GATE_MS && (cough.never === 0 || cappedTurnMs < GATE_MS);
  return { capMs, coughTurnMs, cappedTurnMs, gateReachable };
}

/**
 * `provider`'s account in the active persona's settings: her hearing role's own when it is that
 * provider's, else the first of its accounts with a key; the reason to skip it otherwise.
 */
function resolveTarget(
  provider: ProviderId,
  active: Selection | null,
  sources: Sources,
  model: string | null,
): Target | string {
  let selection: Selection;
  if (active?.provider.id === provider) {
    if (active.apiKey === undefined) return `${active.account.name}, her hearing role, has no key`;
    selection = active;
  } else {
    const account = listAccounts(sources).find(
      (entry) => entry.provider.id === provider && entry.apiKey !== undefined,
    );
    if (account === undefined) return `no ${NAMES[provider]} account has an API key`;
    // Her STT_MODEL is her own provider's model.
    const read = (variable: string) =>
      variable === "STT_PROVIDER"
        ? account.id
        : variable === "STT_MODEL"
          ? undefined
          : sources.read(variable);
    try {
      selection = selectRequired("hearing", { ...sources, read });
    } catch (error) {
      if (error instanceof ProviderConfigError) return error.message;
      throw error;
    }
  }
  if (model !== null) selection = { ...selection, model };
  return { provider, selection, language: sttLanguage(selection) };
}

function fakeTarget(provider: ProviderId, base: string): Target {
  const id = `${provider}-fake`;
  const values: Record<string, string> = { STT_PROVIDER: id };
  const entry = { id, provider, name: null, apiKey: "fake-key", baseUrl: base, options: {} };
  const selection = selectRequired("hearing", {
    read: (variable) => values[variable],
    env: (variable) => values[variable],
    accounts: new Map([[id, entry]]),
  });
  return { provider, selection, language: sttLanguage(selection) };
}

const ms = (value: number | null) => (value === null ? "-" : String(Math.round(value)));
const seconds = (value: number | null) => (value === null ? "-" : `${(value / 1000).toFixed(2)} s`);
const usd = (value: number | null) => (value === null ? "unpriced" : `$${value.toFixed(4)}`);

function printReport(name: string, report: ProviderReport): void {
  if (report.skipped !== null) {
    console.log(`\n${name}: skipped, ${report.skipped}`);
    return;
  }
  const summary = report.summary as Summary;
  const verdict = report.verdict as Verdict;
  console.log(
    `\n${name} (${report.model}, account ${report.account}, language ${report.language ?? "detected"})`,
  );
  console.log(
    `  ${summary.all.count} finalizes over ${report.audioSeconds} s of audio (${usd(report.costUsd)}); connected in ${report.connectMs} ms`,
  );
  if (report.stopped !== null) console.log(`  stopped early: ${report.stopped}`);
  if (report.unmatchedAcks > 0) {
    console.log(`  ${report.unmatchedAcks} acknowledgements came with no finalize() waiting`);
  }
  const header = ["case", "n", "acked", "words", "never", "p50", "p90", "p99", "max"];
  const rows = (["speech", "cough", "silence", "all"] as const).map((kind) => {
    const s = summary[kind];
    const counts = [s.count, s.acknowledged, s.withWords, s.never].map(String);
    return [kind, ...counts, ...[s.p50, s.p90, s.p99, s.max].map(ms)];
  });
  for (const row of [header, ...rows]) {
    console.log(
      `  ${row.map((cell, i) => (i === 0 ? cell.padEnd(8) : cell.padStart(6))).join("")}`,
    );
  }
  console.log("  (ms from finalize() to its acknowledgement; never: none within 5 s)");
  if (verdict.capMs === null) {
    console.log("  U20's cap: none, since nothing was acknowledged");
    return;
  }
  console.log(`  U20's cap, p99 + 1 s: ${seconds(verdict.capMs)} after finalize()`);
  const coughs = summary.cough;
  const turn =
    verdict.coughTurnMs === null
      ? "no cough was acknowledged"
      : `at the coughs' p99, its empty turn ends ${seconds(verdict.coughTurnMs)} after the cough (the VAD's ${VAD_STOP_MS} ms stop, then the acknowledgement)`;
  const capped =
    coughs.never === 0
      ? `one never acknowledged would end at the cap, ${seconds(verdict.cappedTurnMs)} after`
      : `${coughs.never} were never acknowledged, and the cap ends those ${seconds(verdict.cappedTurnMs)} after`;
  console.log(
    `  G5 gate (a cough's empty turn ends within 1.5 s): ${verdict.gateReachable ? "reachable" : "NOT reachable"}; ${turn}; ${capped}`,
  );
}

/** The arithmetic on twenty latencies and two misses, worked out by hand. */
function checkArithmetic(): string[] {
  const problems: string[] = [];
  const latencies = [150, 30, 200, 90, 10, 120, 60, 180, 40, 110, 70, 20, 160, 50, 140, 80, 190];
  const records: Finalize[] = [...latencies, 130, 170, 100, null, null].map((latencyMs, i) => ({
    index: i,
    case: "cough",
    label: "",
    at: 0,
    latencyMs,
    lateMs: null,
    words: i < 5 ? "嗯" : "",
    heard: false,
  }));
  const stats = statsOf(records);
  const expected: Stats = {
    count: 22,
    acknowledged: 20,
    never: 2,
    withWords: 5,
    p50: 100,
    p90: 180,
    p99: 200,
    max: 200,
  };
  if (JSON.stringify(stats) !== JSON.stringify(expected)) {
    problems.push(`stats ${JSON.stringify(stats)}, by hand ${JSON.stringify(expected)}`);
  }
  const verdicts: [Summary, Verdict][] = [
    // A 200 ms p99 caps at 1.2 s: a missed cough ends 1.4 s after it, inside the gate.
    [
      { all: stats, speech: stats, cough: stats, silence: stats },
      { capMs: 1200, coughTurnMs: 400, cappedTurnMs: 1400, gateReachable: true },
    ],
    // A 400 ms p99 caps at 1.4 s: a missed cough would end 1.6 s after it.
    [
      {
        all: { ...stats, p99: 400 },
        speech: stats,
        cough: { ...stats, p99: 400 },
        silence: stats,
      },
      { capMs: 1400, coughTurnMs: 600, cappedTurnMs: 1600, gateReachable: false },
    ],
    // The same, with every cough acknowledged.
    [
      {
        all: { ...stats, p99: 400 },
        speech: stats,
        cough: { ...stats, p99: 400, never: 0 },
        silence: stats,
      },
      { capMs: 1400, coughTurnMs: 600, cappedTurnMs: 1600, gateReachable: true },
    ],
  ];
  for (const [summary, want] of verdicts) {
    const got = verdictOf(summary);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(`verdict ${JSON.stringify(got)}, by hand ${JSON.stringify(want)}`);
    }
  }
  return problems;
}

/** The run against the fake's script: each finalize's case, latency, words and usage. */
function checkFakeRun(
  reports: readonly ProviderReport[],
  scripted: readonly Scripted[],
  usage: readonly UsageRecord[],
): string[] {
  const problems: string[] = [];
  for (const report of reports) {
    const name = report.provider;
    if (report.skipped !== null) {
      problems.push(`${name} was skipped: ${report.skipped}`);
      continue;
    }
    if (report.stopped !== null) problems.push(`${name} stopped: ${report.stopped}`);
    if (report.finalizes.length < MIN_FINALIZES) {
      problems.push(`${name} made ${report.finalizes.length} finalizes, under ${MIN_FINALIZES}`);
    }
    if (report.audioSeconds > FAKE_BUDGET_SECONDS) {
      problems.push(`${name} streamed ${report.audioSeconds} s, over ${FAKE_BUDGET_SECONDS}`);
    }
    const script = scripted.filter((entry) => entry.dialect === name);
    if (script.length !== report.finalizes.length) {
      problems.push(`${name}: ${report.finalizes.length} finalizes, the fake saw ${script.length}`);
    }
    const expected: Finalize[] = [];
    report.finalizes.forEach((record, i) => {
      const entry = script[i];
      if (entry === undefined) return;
      const at = `${name} #${i} (${record.case})`;
      if (entry.heard !== record.case) problems.push(`${at}: the fake heard ${entry.heard}`);
      const answered = entry.delayMs !== null && entry.delayMs < ACK_TIMEOUT_MS;
      const near = (value: number | null, want: number) =>
        value !== null && value >= want - 2 && value <= want + FAKE_TOLERANCE_MS;
      if (answered && !near(record.latencyMs, entry.delayMs as number)) {
        problems.push(`${at}: ${record.latencyMs} ms, scripted ${entry.delayMs}`);
      }
      if (!answered && record.latencyMs !== null) {
        problems.push(`${at}: acknowledged in ${record.latencyMs} ms, scripted never`);
      }
      if (entry.delayMs !== null && !answered && !near(record.lateMs, entry.delayMs)) {
        problems.push(`${at}: late by ${record.lateMs} ms, scripted ${entry.delayMs}`);
      }
      const words = answered && record.case === "speech" ? FAKE_WORDS : "";
      if (record.words !== words) problems.push(`${at}: words "${record.words}", not "${words}"`);
      expected.push({ ...record, latencyMs: answered ? (entry.delayMs as number) : null });
    });
    // The measured summary is the script's, within what the fake's timers add.
    const want = summarize(expected);
    const got = report.summary as Summary;
    for (const kind of [...CASES, "all"] as const) {
      const [a, b] = [got[kind], want[kind]];
      for (const key of ["count", "acknowledged", "never", "withWords"] as const) {
        if (a[key] !== b[key]) {
          problems.push(`${name} ${kind} ${key}: ${a[key]}, scripted ${b[key]}`);
        }
      }
      for (const key of ["p50", "p90", "p99", "max"] as const) {
        const [measured, scriptedMs] = [a[key], b[key]];
        const off =
          measured === null || scriptedMs === null
            ? measured !== scriptedMs
            : measured < scriptedMs - 2 || measured > scriptedMs + FAKE_TOLERANCE_MS;
        if (off) problems.push(`${name} ${kind} ${key}: ${measured}, scripted ${scriptedMs}`);
      }
    }
    const reported = usage
      .filter((record) => record.provider === name && record.role === "hearing")
      .reduce((sum, record) => sum + (record.units.audioSeconds ?? 0), 0);
    if (Math.abs(reported - report.audioSeconds) > 1e-6) {
      problems.push(`${name} reported ${reported} s of usage, streamed ${report.audioSeconds} s`);
    }
  }
  return problems;
}

const USAGE = `usage: bun docs/benchmarks/2026-11-10-finalize-ack/measure.ts [options]

  --persona <id>         whose hearing role and accounts to use (default: the active persona)
  --out <file>           every finalize, as JSON (default: results.json beside this script;
                         with --fake, a file in the OS temp folder)
  --deepgram-model <id>  Deepgram's model (default: hers when she hears through Deepgram, else
                         the catalog's)
  --fake                 play Soniox and Deepgram on 127.0.0.1 and check the run; spends nothing`;

interface Options {
  readonly fake: boolean;
  readonly out: string | null;
  readonly deepgramModel: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  let fake = false;
  let out: string | null = null;
  let deepgramModel: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--fake") fake = true;
    else if (arg === "--out") out = value();
    else if (arg === "--deepgram-model") deepgramModel = value();
    // load-env.ts has applied it.
    else if (arg === "--persona") value();
    else if (arg.startsWith("--persona=")) continue;
    else throw new Error(`unknown argument ${arg}`);
  }
  return { fake, out, deepgramModel };
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(Bun.argv.slice(2));
  } catch (error) {
    console.error(`${errorText(error)}\n\n${USAGE}`);
    return 2;
  }
  setLogLevel("WARNING");
  const speech = await Promise.all(
    SENTENCES.map(async (label) => ({ label, pcm: await say(label) })),
  );

  const fake = options.fake ? new FakeRecognizers() : null;
  const usage: UsageRecord[] = [];
  const budget = fake === null ? BUDGET_SECONDS : FAKE_BUDGET_SECONDS;
  const targets: (Target | ProviderReport)[] = [];
  if (fake !== null) {
    setUsageSink((record) => usage.push(record));
    console.log(`Fake Soniox and Deepgram on ${fake.base}; nothing leaves this machine.`);
    for (const provider of PROVIDERS) targets.push(fakeTarget(provider, fake.base));
  } else {
    installUsageLedger();
    const sources = installedSources();
    const active = trySelect("hearing", sources, (error) => {
      console.log(`Her hearing role can't be read: ${error.message}`);
    });
    console.log(
      `Persona ${activePersona().id}; her hearing role: ${active === null ? "none" : `${active.provider.name} (${active.model})`}.`,
    );
    for (const provider of PROVIDERS) {
      const model = provider === "deepgram" ? options.deepgramModel : null;
      const target = resolveTarget(provider, active, sources, model);
      targets.push(typeof target === "string" ? skippedReport(provider, target) : target);
    }
  }

  console.log(
    `Each provider streams at most ${budget} s of real-time audio: ${SENTENCES.length} sentences by \`say\`, coughs and room tone, finalizing ${VAD_STOP_MS} ms after each.`,
  );
  for (const target of targets) {
    const name = NAMES[target.provider];
    if ("skipped" in target) {
      console.log(`  ${name}: skipped, ${target.skipped}`);
      continue;
    }
    const { selection, language } = target;
    console.log(
      `  ${name}: ${selection.model} (account ${selection.account.id}, language ${language ?? "detected"}), at most ${usd(costFor(selection, budget))}`,
    );
  }

  const reports: ProviderReport[] = [];
  try {
    for (const target of targets) {
      const name = NAMES[target.provider];
      const report = "skipped" in target ? target : await measure(target, budget, speech);
      reports.push(report);
      printReport(name, report);
    }
  } finally {
    fake?.stop();
  }

  const out =
    options.out ??
    (fake === null
      ? join(import.meta.dir, "results.json")
      : join(tmpdir(), `eidolon-finalize-ack-fake-${Date.now()}.json`));
  const document = {
    measuredAt: new Date().toISOString(),
    fake: fake !== null,
    persona: fake === null ? activePersona().id : null,
    method: {
      frameMs: FRAME_MS,
      budgetSeconds: budget,
      leadInMs: LEAD_IN_MS,
      gapMs: GAP_MS,
      vadStopMs: VAD_STOP_MS,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      settleMs: SETTLE_MS,
      roomToneSigma: ROOM_TONE,
      coughLengthsMs: COUGH_LENGTHS_MS,
      sayVoice: SAY_VOICE,
      percentile: "nearest rank",
      capMarginMs: CAP_MARGIN_MS,
      gateMs: GATE_MS,
    },
    providers: reports,
  };
  await Bun.write(out, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`\nWrote ${out}`);

  if (fake === null) return 0;
  const problems = [
    ...fake.problems,
    ...checkArithmetic(),
    ...checkFakeRun(reports, fake.scripted, usage),
  ];
  if (problems.length > 0) {
    console.log(`\nThe fake run failed ${problems.length} checks:`);
    for (const problem of problems) console.log(`  ${problem}`);
    return 1;
  }
  console.log("\nThe fake run passed: its finalizes, latencies, summary, arithmetic and usage.");
  return 0;
}

process.exitCode = await main();
