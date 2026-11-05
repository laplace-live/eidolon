// A call's lifecycle as the page shows it. It is kept apart from the transport's own state, which
// client-js moves to "ready" when a connect that was cancelled mid-handshake finally returns.
import type { MicProblem } from "./media";

/** The bot's PipelineWorker cancels a call with no speech for its idle timeout, which eidolon keeps. */
export const IDLE_TIMEOUT_MS = 300_000;

/** The page hears the last speech a moment after the bot does. */
const IDLE_SLACK_MS = 15_000;

/** The bot and the page share a clock, but its timestamps may be cut to whole seconds. */
const CLOCK_SLACK_MS = 2000;

export type CallEnd =
  | { readonly kind: "hung-up" }
  | { readonly kind: "mic"; readonly problem: MicProblem }
  | { readonly kind: "ice"; readonly detail: string }
  /** The offer failed; `status` is its HTTP status when the bot answered at all. */
  | { readonly kind: "connect"; readonly status: number | null; readonly detail: string }
  | { readonly kind: "silence" }
  | { readonly kind: "dropped"; readonly byBot: boolean };

export type CallPhase =
  | { readonly name: "idle" }
  /** Checking the mic and fetching the ICE servers. */
  | { readonly name: "starting"; readonly startedAt: number }
  /** The offer is out; waiting for bot-ready. */
  | { readonly name: "connecting"; readonly startedAt: number }
  /** `answeredAt` is null until the bot first speaks. */
  | { readonly name: "live"; readonly startedAt: number; readonly answeredAt: number | null }
  | { readonly name: "ending"; readonly startedAt: number; readonly answeredAt: number | null }
  | {
      readonly name: "ended";
      readonly startedAt: number;
      readonly answeredAt: number | null;
      readonly endedAt: number;
      readonly end: CallEnd;
    };

export const IDLE: CallPhase = { name: "idle" };

export type PhaseEvent =
  | { readonly type: "start"; readonly at: number }
  /** The mic works and the ICE servers came: the offer goes out. */
  | { readonly type: "dial" }
  | { readonly type: "ready" }
  | { readonly type: "answered"; readonly at: number }
  | { readonly type: "hang-up" }
  /** The call never came up. */
  | { readonly type: "failed"; readonly at: number; readonly end: CallEnd }
  /** The transport went away. */
  | { readonly type: "disconnected"; readonly at: number; readonly end: CallEnd };

const HUNG_UP: CallEnd = { kind: "hung-up" };

function ended(
  phase: Exclude<CallPhase, { name: "idle" | "ended" }>,
  at: number,
  end: CallEnd,
): CallPhase {
  const answeredAt = "answeredAt" in phase ? phase.answeredAt : null;
  return { name: "ended", startedAt: phase.startedAt, answeredAt, endedAt: at, end };
}

export function reducePhase(phase: CallPhase, event: PhaseEvent): CallPhase {
  switch (event.type) {
    case "start":
      return phase.name === "idle" || phase.name === "ended"
        ? { name: "starting", startedAt: event.at }
        : phase;
    case "dial":
      return phase.name === "starting" ? { name: "connecting", startedAt: phase.startedAt } : phase;
    case "ready":
      return phase.name === "connecting"
        ? { name: "live", startedAt: phase.startedAt, answeredAt: null }
        : phase;
    case "answered":
      return phase.name === "live" && phase.answeredAt === null
        ? { ...phase, answeredAt: event.at }
        : phase;
    case "hang-up":
      if (phase.name === "live") return { ...phase, name: "ending" };
      return phase.name === "starting" || phase.name === "connecting"
        ? { name: "ending", startedAt: phase.startedAt, answeredAt: null }
        : phase;
    case "failed":
      // A hang-up mid-handshake fails the connect too.
      if (phase.name === "ending") return ended(phase, event.at, HUNG_UP);
      return phase.name === "starting" || phase.name === "connecting"
        ? ended(phase, event.at, event.end)
        : phase;
    case "disconnected":
      if (phase.name === "ending") return ended(phase, event.at, HUNG_UP);
      return phase.name === "connecting" || phase.name === "live"
        ? ended(phase, event.at, event.end)
        : phase;
  }
}

/** Why a live call ended that the viewer didn't hang up. */
export function endOf(byBot: boolean, silentMs: number): CallEnd {
  return byBot && silentMs >= IDLE_TIMEOUT_MS - IDLE_SLACK_MS
    ? { kind: "silence" }
    : { kind: "dropped", byBot };
}

/** A rejected connect: client-js puts the offer's HTTP status on its error. */
export function connectEnd(error: unknown): CallEnd {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (typeof status === "number") return { kind: "connect", status, detail: `HTTP ${status}` };
  return { kind: "connect", status: null, detail: error instanceof Error ? error.message : "" };
}

/** The bot's last failed session, when it failed after `since`: the call that started then. */
export function sessionErrorSince(
  error: { readonly message: string; readonly at: string } | null,
  since: number,
): string | null {
  if (error === null) return null;
  const at = Date.parse(error.at);
  return Number.isFinite(at) && at >= since - CLOCK_SLACK_MS ? error.message : null;
}
