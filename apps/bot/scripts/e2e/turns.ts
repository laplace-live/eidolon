// A call's timeline cut into her turns, and how each played: what e2e-call.ts reports and
// e2e-compare.ts holds the candidate to. Reads only the timeline and the audible spans, so it
// scores reports recorded before it existed too.
import type { EntrySource } from "./protocol.ts";

export interface TimelineEntry {
  t: number;
  source: EntrySource;
  event: string;
  data?: unknown;
}

export type Turn = "greeting" | "reply" | "barge-in";

/** How one of her turns played. */
export interface Pacing {
  /** bot-tts-started → bot-started-speaking. */
  ttsToSpeakingMs: number | null;
  /** The silences between her audible spans: sentence to sentence. */
  gapsMs: number[];
  /** bot-stopped-speaking after her last audible audio ended; negative when it came first. */
  stoppedAfterAudioMs: number | null;
  /** Whether bot-tts-stopped came in the turn. */
  ttsStopped: boolean;
}

export const isRtvi = (entry: TimelineEntry, event: string): boolean =>
  entry.source === "rtvi" && entry.event === event;

/** A turn's [from, to), and where its stops may still land. */
interface TurnWindow {
  readonly from: number;
  readonly to: number;
  readonly stopsBefore: number;
}

/** Where each turn starts and ends: the greeting until the question, the reply, the barge-in. */
function turnWindows(
  timeline: readonly TimelineEntry[],
  end: number,
): Partial<Record<Turn, TurnWindow>> {
  const at = (match: (e: TimelineEntry) => boolean) => timeline.find(match)?.t;
  const connected = at((e) => isRtvi(e, "transportStateChanged") && e.data === "connected");
  const asked = at((e) => e.source === "harness" && /^ask(Text|Voice)$/.test(e.event));
  const barged = at((e) => e.source === "harness" && e.event === "bargeIn");
  const cutIn =
    barged === undefined ? undefined : at((e) => e.t >= barged && isRtvi(e, "userStoppedSpeaking"));
  const window = (from: number, to: number, stopsBefore = to): TurnWindow => ({
    from,
    to,
    stopsBefore,
  });
  return {
    greeting: window(connected ?? 0, asked ?? end + 1),
    // The reply cut off stops once the server hears the caller, after the browser started talking.
    ...(asked === undefined ? {} : { reply: window(asked, barged ?? end + 1, cutIn ?? end + 1) }),
    ...(barged === undefined ? {} : { "barge-in": window(cutIn ?? barged, end + 1) }),
  };
}

/** How her turn in `window` played, from its RTVI events and her audible spans. */
function pacing(
  timeline: readonly TimelineEntry[],
  botSpans: readonly (readonly [number, number])[],
  { from, to, stopsBefore }: TurnWindow,
): Pacing {
  const first = (event: string, after: number, before = to) =>
    timeline.find((e) => e.t >= after && e.t < before && isRtvi(e, event));
  const since = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? null : b - a;
  const tts = first("botTtsStarted", from);
  const speaking = tts && first("botStartedSpeaking", tts.t);
  const own = botSpans.filter(([start]) => start >= from && start < to);
  const last = own.at(-1);
  const stopped = last && first("botStoppedSpeaking", last[0], stopsBefore);
  return {
    ttsToSpeakingMs: since(tts?.t, speaking?.t),
    gapsMs: own.slice(1).map(([start], i) => start - (own[i] as readonly [number, number])[1]),
    stoppedAfterAudioMs: since(last?.[1], stopped?.t),
    ttsStopped: first("botTtsStopped", from, stopsBefore) !== undefined,
  };
}

/** Every turn's pacing. */
export function pacingByTurn(
  timeline: readonly TimelineEntry[],
  botSpans: readonly (readonly [number, number])[],
  end: number,
): Partial<Record<Turn, Pacing>> {
  const out: Partial<Record<Turn, Pacing>> = {};
  for (const [turn, window] of Object.entries(turnWindows(timeline, end))) {
    out[turn as Turn] = pacing(timeline, botSpans, window);
  }
  return out;
}
