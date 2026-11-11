// A group call: every persona in the chat answers the caller, as the director chooses, one at a
// time and each in her own voice. The Floor runs the chat's answer (runChat) in call mode after each
// caller's line; this is what it asks of the group: whose Mouth speaks a turn, the label that names
// her as her audio starts, and the answer itself.
import {
  type ChatEvent,
  type ChatHeader,
  joinSegments,
  type ParticipantId,
  summarize,
} from "@eidolon/chat";
import { readPersonaIdentity, withPersona } from "@eidolon/config";
import type { CallChatOutput, CallChatRequest } from "@eidolon/engine";
import { selectRequired } from "@eidolon/providers";
import { Mouth, type SpokenReply, voiceTraits } from "../output/mouth.ts";
import type { CallDeps, Speaker } from "../types.ts";
import type { CallKit } from "./kit.ts";

export interface GroupFloor {
  /** Her Mouth, opened in her persona scope; undefined for a persona who isn't in the call. */
  mouthOf(
    persona: ParticipantId,
  ): { begin(reply: string, options?: { readonly audio?: boolean }): SpokenReply } | undefined;
  /** Her name, as the speaker label carries it. */
  nameOf(persona: ParticipantId): string;
  /** The chat's answer to the caller's line: the director's decisions and the turns they choose. */
  answer(request: CallChatRequest): AsyncIterable<CallChatOutput>;
}

/**
 * The server message a group call sends as each persona's audio starts, just before
 * `bot-started-speaking`, or before a reply in text alone's first words: who is speaking now.
 */
export function speakerLabel(
  persona: ParticipantId,
  name: string,
): Readonly<Record<string, unknown>> {
  return { type: "speaker", persona, name };
}

/** The seq of the caller's last line, which the chat's answer answers; null before one. */
export function lastViewerLine(events: readonly ChatEvent[]): number | null {
  const line = events.findLast(
    (event) => event.type === "message" && event.speaker.kind === "user",
  );
  return line?.seq ?? null;
}

/** Who answers on a group call: the chat's participants as its log stands. */
export function groupOf(chat: {
  readonly header: ChatHeader;
  readonly events: readonly ChatEvent[];
}): readonly ParticipantId[] {
  return summarize(chat.header, chat.events).participants;
}

interface MouthOptions {
  readonly kit: CallKit;
  readonly speaker: Speaker;
  readonly deps: Pick<CallDeps, "openSpeech" | "clock">;
}

/** Her Mouth on the call's Speaker, with the voice role of the persona scope it runs in. */
export function openMouth(
  persona: ParticipantId,
  { kit, speaker, deps }: MouthOptions,
  name: string,
): Mouth {
  const mouth = new Mouth({
    persona,
    speech: deps.openSpeech(),
    ...voiceTraits(selectRequired("voice")),
    speaker,
    join: joinSegments,
    clock: deps.clock,
    post: (event) => kit.post({ source: "mouth", event }),
  });
  kit.own(name, mouth);
  return mouth;
}

/**
 * Opens each persona's Mouth inside her own persona scope, so she speaks with her own voice role,
 * styles and markup, all of them on the call's one Speaker. `kit` closes them as the call ends.
 */
export function openGroup(
  personas: readonly ParticipantId[],
  options: MouthOptions & {
    readonly deps: Pick<CallDeps, "engine" | "runChat" | "openSpeech" | "clock">;
  },
): GroupFloor {
  const { deps } = options;
  const { runChat } = deps;
  if (runChat === undefined) throw new Error("A group call needs the engine's runChat");
  const mouths = new Map<ParticipantId, Mouth>();
  const names = new Map<ParticipantId, string>();
  for (const persona of personas) {
    names.set(persona, readPersonaIdentity(persona).name);
    mouths.set(
      persona,
      withPersona(persona, () => openMouth(persona, options, `${persona}'s voice`)),
    );
  }
  return {
    mouthOf: (persona) => mouths.get(persona),
    nameOf: (persona) => names.get(persona) ?? persona,
    answer: (request) => runChat(request, deps.engine),
  };
}
