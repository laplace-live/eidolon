// The arithmetic of measure.ts, apart from it so a test can import it without the .env and
// settings measure.ts loads first.

/** Fish's PCM as the bot asks for it: 44.1 kHz, signed 16-bit, mono. */
export const SAMPLE_RATE = 44_100;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/** The suggested threshold's margin over the largest gap inside a burst (README, "The margin"). */
export const MARGIN_FLOOR_MS = 100;
export const MARGIN_RATIO = 0.5;

/** One audio message: when it came, in ms from the run's start, and its PCM bytes. */
export interface Arrival {
  readonly t: number;
  readonly bytes: number;
}

export interface FlushRecord {
  readonly text: string;
  /** What to listen for in its audio. */
  readonly listen: string;
  readonly sentAt: number;
  readonly arrivals: readonly Arrival[];
  /** When the next flush, or the stop, went. */
  readonly movedOnAt: number;
}

export interface SerialRecord {
  readonly settleMs: number;
  readonly flushes: readonly FlushRecord[];
  readonly stopAt: number | null;
  /** Audio that came after the stop, which the last flush's settling missed. */
  readonly afterStop: readonly Arrival[];
  readonly finishAt: number | null;
  readonly error: string | null;
}

export interface PipelinedRecord {
  readonly texts: readonly string[];
  readonly sentAt: number;
  readonly arrivals: readonly Arrival[];
  readonly finishAt: number | null;
  readonly error: string | null;
}

/** Nearest-rank percentiles. */
export interface Stats {
  readonly n: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
}

export interface FlushSummary {
  /** From 1. */
  readonly flush: number;
  readonly messages: number;
  /** Flush to first audio. */
  readonly firstMs: number | null;
  /** First audio to last. */
  readonly burstMs: number | null;
  readonly maxGapMs: number | null;
  readonly audioSeconds: number;
  /** How long before its audio, played from its first message on, would run out the burst ended. */
  readonly slackMs: number | null;
  /** From its last audio, or its send when none came, to the next send. */
  readonly waitMs: number;
  /** Where its audio starts in the serial WAV. */
  readonly wavSeconds: number;
}

export interface Suggestion {
  readonly largestGapMs: number;
  readonly roundedMs: number;
  readonly marginMs: number;
  readonly idleMs: number;
}

export interface Projection {
  readonly idleMs: number;
  /** Silence before each flush after the first, had each gone `idleMs` after the last's audio. */
  readonly boundaryMs: readonly number[];
  readonly boundary: Stats | null;
  /** Silence inside bursts: audio that came slower than it plays. */
  readonly insideMs: number;
}

export interface SerialSummary {
  readonly flushes: readonly FlushSummary[];
  readonly gaps: Stats | null;
  readonly first: Stats | null;
  readonly suggestion: Suggestion | null;
  readonly projection: Projection | null;
  readonly afterStop: { readonly messages: number; readonly bytes: number };
  readonly finishAfterStopMs: number | null;
  /** Whether each flush came as one burst with a detectable end; false stops G5. */
  readonly clean: boolean;
  readonly reasons: readonly string[];
}

export interface PipelinedSummary {
  readonly messages: number;
  readonly firstMs: number | null;
  readonly burstMs: number | null;
  readonly gaps: Stats | null;
  /** The three largest gaps, each with how much audio had come before it. */
  readonly largestGaps: readonly { readonly ms: number; readonly atSeconds: number }[];
  readonly audioSeconds: number;
  /** Silence, in all, when its audio plays from its first message on. */
  readonly stallMs: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export function stats(values: readonly number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => round1(sorted[Math.ceil(q * sorted.length) - 1] as number);
  return { n: sorted.length, p50: rank(0.5), p90: rank(0.9), p99: rank(0.99), max: rank(1) };
}

export function msOf(bytes: number): number {
  return bytes / BYTES_PER_MS;
}

const totalBytes = (arrivals: readonly Arrival[]) => arrivals.reduce((n, a) => n + a.bytes, 0);

export function gapsOf(arrivals: readonly Arrival[]): number[] {
  return arrivals.slice(1).map((arrival, i) => round1(arrival.t - (arrivals[i] as Arrival).t));
}

/** The largest gap rounded up to 10 ms, plus the larger of the floor and half of it. */
export function suggest(largestGapMs: number): Suggestion {
  const roundedMs = Math.ceil(largestGapMs / 10) * 10;
  const marginMs = Math.max(MARGIN_FLOOR_MS, Math.ceil((roundedMs * MARGIN_RATIO) / 10) * 10);
  return { largestGapMs, roundedMs, marginMs, idleMs: roundedMs + marginMs };
}

/**
 * The silence before each message when messages play back to back from the first one's arrival,
 * none before it arrives.
 */
export function playout(arrivals: readonly Arrival[]): number[] {
  let cursor = arrivals[0]?.t ?? 0;
  return arrivals.map((arrival) => {
    const silence = Math.max(0, arrival.t - cursor);
    cursor = Math.max(cursor, arrival.t) + msOf(arrival.bytes);
    return round1(silence);
  });
}

/**
 * The serial run replayed as G5 would send it: each flush `idleMs` after the last one's final
 * audio, its audio at the offsets measured from its own send.
 */
export function project(flushes: readonly FlushRecord[], idleMs: number): Projection {
  const shifted: Arrival[] = [];
  const firsts = new Set<number>();
  let send = 0;
  for (const flush of flushes) {
    const last = flush.arrivals.at(-1);
    if (last === undefined) continue;
    if (shifted.length > 0) firsts.add(shifted.length);
    for (const arrival of flush.arrivals) {
      shifted.push({ t: send + arrival.t - flush.sentAt, bytes: arrival.bytes });
    }
    send += last.t - flush.sentAt + idleMs;
  }
  const silences = playout(shifted);
  const boundaryMs = silences.filter((_, i) => firsts.has(i));
  const insideMs = silences.reduce((sum, ms, i) => (firsts.has(i) ? sum : sum + ms), 0);
  return { idleMs, boundaryMs, boundary: stats(boundaryMs), insideMs: round1(insideMs) };
}

export function summarizeSerial(record: SerialRecord): SerialSummary {
  let wavBytes = 0;
  const flushes = record.flushes.map((flush, i): FlushSummary => {
    const first = flush.arrivals[0];
    const last = flush.arrivals.at(-1);
    const bytes = totalBytes(flush.arrivals);
    const gaps = gapsOf(flush.arrivals);
    const burstMs = first && last ? round1(last.t - first.t) : null;
    const summary = {
      flush: i + 1,
      messages: flush.arrivals.length,
      firstMs: first ? round1(first.t - flush.sentAt) : null,
      burstMs,
      maxGapMs: gaps.length > 0 ? Math.max(...gaps) : null,
      audioSeconds: round4(msOf(bytes) / 1000),
      slackMs: burstMs === null ? null : round1(msOf(bytes) - burstMs),
      waitMs: round1(flush.movedOnAt - (last?.t ?? flush.sentAt)),
      wavSeconds: round4(msOf(wavBytes) / 1000),
    };
    wavBytes += bytes;
    return summary;
  });
  const gaps = stats(record.flushes.flatMap((flush) => gapsOf(flush.arrivals)));
  const heard = flushes.filter((flush) => flush.firstMs !== null);
  const suggestion = heard.length > 0 ? suggest(gaps?.max ?? 0) : null;
  const reasons: string[] = [];
  if (record.error !== null) reasons.push(`the session failed: ${record.error}`);
  for (const flush of flushes) {
    if (flush.firstMs === null) reasons.push(`flush ${flush.flush} brought no audio`);
  }
  if (record.afterStop.length > 0) {
    reasons.push(
      `${record.afterStop.length} audio messages came after the last flush had been quiet ${record.settleMs} ms`,
    );
  }
  if (suggestion !== null && suggestion.idleMs >= record.settleMs) {
    reasons.push(
      `the suggested threshold, ${suggestion.idleMs} ms, is not under the ${record.settleMs} ms this run waited, so a pause inside a burst can't be told from its end`,
    );
  }
  return {
    flushes,
    gaps,
    first: stats(heard.map((flush) => flush.firstMs as number)),
    suggestion,
    projection: suggestion === null ? null : project(record.flushes, suggestion.idleMs),
    afterStop: { messages: record.afterStop.length, bytes: totalBytes(record.afterStop) },
    finishAfterStopMs:
      record.finishAt === null || record.stopAt === null
        ? null
        : round1(record.finishAt - record.stopAt),
    clean: reasons.length === 0 && suggestion !== null,
    reasons,
  };
}

export function summarizePipelined(record: PipelinedRecord): PipelinedSummary {
  const { arrivals } = record;
  const first = arrivals[0];
  const last = arrivals.at(-1);
  let before = 0;
  const placed = arrivals.map((arrival, i) => {
    const gap = i === 0 ? null : round1(arrival.t - (arrivals[i - 1] as Arrival).t);
    const at = { ms: gap, atSeconds: round4(msOf(before) / 1000) };
    before += arrival.bytes;
    return at;
  });
  const largestGaps = placed
    .filter((gap): gap is { ms: number; atSeconds: number } => gap.ms !== null)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3);
  return {
    messages: arrivals.length,
    firstMs: first ? round1(first.t - record.sentAt) : null,
    burstMs: first && last ? round1(last.t - first.t) : null,
    gaps: stats(gapsOf(arrivals)),
    largestGaps,
    audioSeconds: round4(msOf(totalBytes(arrivals)) / 1000),
    stallMs: round1(playout(arrivals).reduce((sum, ms) => sum + ms, 0)),
  };
}

/** A mono 16-bit WAV at SAMPLE_RATE of `pcm`, in order. */
export function wavFile(pcm: readonly Int16Array[]): Uint8Array {
  const bytes = pcm.reduce((n, chunk) => n + chunk.byteLength, 0);
  const out = new Uint8Array(44 + bytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => out.set(new TextEncoder().encode(text), at);
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  let at = 44;
  // Typed arrays use the host's byte order; every host Bun ships for is little-endian, as WAV is.
  for (const chunk of pcm) {
    out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), at);
    at += chunk.byteLength;
  }
  return out;
}
