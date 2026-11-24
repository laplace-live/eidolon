// The shell's call as its readers take it: what changes a few times a call, apart from the call as
// it goes, so only what shows the call renders again with each of its events.
import { createContext, useContext, useLayoutEffect } from "react";
import type { CallPhase } from "./phase";
import type { CallSignals } from "./signals";
import type { CallStages } from "./stages";
import type { CallLayout, CallTarget } from "./target";
import type { CallHandle } from "./use-call";

/** What changes a few times a call: whom it is with, how far it got, how it shows. */
export interface CallPresence {
  readonly target: CallTarget | null;
  readonly phase: CallPhase;
  /** Placed and not over: starting, connecting, live or ending. */
  readonly up: boolean;
  /** A chat call's id in its chat's log, once the log names it; null before, and for /call. */
  readonly serverCall: string | null;
  /** A chat call with a model: its video screen, or the dock. Each call starts on "screen". */
  readonly layout: CallLayout;
  /** Someone on the call had a model as it was placed, and not every stage failed or found none. */
  readonly video: boolean;
  /** A view of the call is mounted: the screen, the dock, or /call's room for its own call. */
  readonly shown: boolean;
  /** Places a call, unless one is up. Call it inside the click that places it. */
  start(target: CallTarget): void;
  /** Forgets a call that is over: the bar and the dock stop showing it. Ignored while it is up. */
  close(): void;
  setLayout(layout: CallLayout): void;
  /** Counts a mounted view of the call; the function it returns uncounts it. Stable. */
  show(): () => void;
  /** Stable for the shell's life. */
  readonly signals: CallSignals;
  /** Stable for the shell's life. */
  readonly stages: CallStages;
}

/** The call as it goes: every RTVI event makes a new one. */
export type ShellCall = CallPresence & CallHandle;

export const CallPresenceContext = createContext<CallPresence | null>(null);
export const ShellCallContext = createContext<ShellCall | null>(null);

/** Throws outside CallProvider. */
export function useCallPresence(): CallPresence {
  const presence = useContext(CallPresenceContext);
  if (presence === null) throw new Error("useCallPresence needs a CallProvider");
  return presence;
}

/** Throws outside CallProvider. Re-renders with every RTVI event: read it only where the call shows. */
export function useShellCall(): ShellCall {
  const call = useContext(ShellCallContext);
  if (call === null) throw new Error("useShellCall needs a CallProvider");
  return call;
}

/**
 * Marks the calling component as a view of the call while it is mounted and `on`; the bar hides
 * meanwhile. Counted in a layout effect, so the bar never paints for a frame while a view mounts,
 * and a screen giving way to the dock in one commit leaves the count at one.
 */
export function useShowsCall(on = true): void {
  const { show } = useCallPresence();
  useLayoutEffect(() => (on ? show() : undefined), [on, show]);
}
