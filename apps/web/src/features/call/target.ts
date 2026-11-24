// Whom the tab's one call is with, as it was placed, and the rules the shell and the pages read
// from it: where it lives, whether it opens as video, and how each page shows it.
import type { ChatCallRequestData, PersonaSummary } from "@/lib/api";
import type { CallPhase } from "./phase";

/** Who is on a call, as it was placed: her name and picture, and the model she had active then. */
export type CastMember = Pick<
  PersonaSummary,
  "id" | "name" | "shortName" | "avatar" | "appearance"
>;

/** What the viewer called. `cast` is fixed as the call is placed, its host first. */
export type CallTarget =
  | { readonly kind: "solo"; readonly cast: readonly [CastMember] }
  | {
      readonly kind: "chat";
      readonly chatId: string;
      readonly group: boolean;
      readonly cast: readonly [CastMember, ...CastMember[]];
    };

/** How a chat call with a model shows: its video screen over the chat's column, or the dock. */
export type CallLayout = "screen" | "dock";

/** /call's call: the active persona, with no chat. */
export function soloTarget(persona: CastMember): CallTarget {
  return { kind: "solo", cast: [persona] };
}

/** A call in chat `chatId` to `host`, or with `everyone` to the whole chat, `host` first. */
export function chatTarget(
  chatId: string,
  host: CastMember,
  everyone: readonly CastMember[] | null,
): CallTarget {
  const others = everyone?.filter((member) => member.id !== host.id) ?? [];
  return { kind: "chat", chatId, group: everyone !== null, cast: [host, ...others] };
}

export function hostOf(target: CallTarget): CastMember {
  return target.cast[0];
}

export function callPath(target: CallTarget): string {
  return target.kind === "solo" ? "/call" : `/chats/${encodeURIComponent(target.chatId)}`;
}

/** The offer's requestData: undefined for /call; else the chat, its host, and `group` on a group call. */
export function offerData(target: CallTarget): ChatCallRequestData | undefined {
  if (target.kind === "solo") return undefined;
  const persona = hostOf(target).id;
  return target.group
    ? { chatId: target.chatId, persona, group: true }
    : { chatId: target.chatId, persona };
}

/** Placed and not over: starting, connecting, live or ending. */
export function isUp(phase: CallPhase): boolean {
  return phase.name !== "idle" && phase.name !== "ended";
}

export function hungUp(phase: CallPhase): boolean {
  return phase.name === "ended" && phase.end.kind === "hung-up";
}

/** Anyone on the call had a model active as it was placed. */
export function opensVideo(target: CallTarget): boolean {
  return target.cast.some((member) => member.appearance.model !== null);
}

/** The call bar shows: a call not closed, not hung up, and no view of it mounted. */
export function barShown(call: {
  readonly target: CallTarget | null;
  readonly phase: CallPhase;
  readonly shown: boolean;
}): boolean {
  return call.target !== null && call.phase.name !== "idle" && !hungUp(call.phase) && !call.shown;
}

/** A /call call that is over and was with a persona no longer active, `active` being the active one's id. */
export function outlived(
  call: { readonly target: CallTarget | null; readonly phase: CallPhase },
  active: string | null,
): boolean {
  const { target } = call;
  return (
    target?.kind === "solo" && !isUp(call.phase) && active !== null && hostOf(target).id !== active
  );
}

/** How a chat's page shows the tab's call. */
export interface ChatCallView {
  /** The call is this chat's, up, or over and not closed. */
  readonly mine: boolean;
  /** This chat's call is up. */
  readonly calling: boolean;
  /** A call is up somewhere else: another chat, or /call. */
  readonly elsewhere: boolean;
  /** This chat's call shows as its video screen. */
  readonly video: boolean;
  /** This chat's call shows in the dock: up without its screen, or over for a reason it keeps. */
  readonly docked: boolean;
}

/** An ended call never shows its screen: it docks, as a call without a model does. */
export function chatCallView(
  call: {
    readonly target: CallTarget | null;
    readonly phase: CallPhase;
    readonly layout: CallLayout;
    readonly video: boolean;
  },
  chatId: string,
): ChatCallView {
  const { target, phase } = call;
  const mine = target?.kind === "chat" && target.chatId === chatId;
  const calling = mine && isUp(phase);
  const video = calling && call.video && call.layout === "screen";
  return {
    mine,
    calling,
    elsewhere: isUp(phase) && !mine,
    video,
    docked: mine && phase.name !== "idle" && !hungUp(phase) && !video,
  };
}

/** How /call shows the tab's call, the active persona being `persona`. */
export interface SoloCallView {
  /** The call is /call's own, with her, up or over. */
  readonly own: boolean;
  /** A call is up that isn't /call's own: a chat's. */
  readonly elsewhere: boolean;
  /** /call's own call is up and shows as video. */
  readonly video: boolean;
}

/**
 * A solo call placed before the active persona changed isn't `own`, so /call shows the new persona
 * fresh rather than the old one's ending.
 */
export function soloCallView(
  call: { readonly target: CallTarget | null; readonly phase: CallPhase; readonly video: boolean },
  persona: string,
): SoloCallView {
  const { target, phase } = call;
  const own = target?.kind === "solo" && hostOf(target).id === persona;
  return { own, elsewhere: isUp(phase) && !own, video: own && isUp(phase) && call.video };
}
