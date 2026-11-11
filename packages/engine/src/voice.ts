// Voice messages: how each persona answers a chat, her voice role speaking a whole reply, and the
// viewer's recorded clip heard as a line.
import {
  type ChatEvent,
  type ChatEventDraft,
  type ParticipantId,
  type ReplyMode,
  replyModeOf,
  summarize,
} from "@eidolon/chat";
import { chatReplyMode, logger, withPersona } from "@eidolon/config";
import { hasKey, selectRequired, trySelect, withUsageScope } from "@eidolon/providers";
import {
  type AudioClip,
  speechSupport,
  synthesize,
  transcribe,
} from "@eidolon/providers/speech-batch";
import type { EngineDeps, SpeechDeps, TurnRequest } from "./types.ts";

/** What her view reads for a voice message of the viewer's that was heard as nothing. */
export const UNHEARD = "（听不清）";

/** The batch speech clients, on the roles of the persona whose scope they run in. */
export const batchSpeech: SpeechDeps = {
  canSpeak: () => {
    const selection = trySelect("voice");
    return selection !== null && hasKey(selection) && speechSupport(selection).synthesize;
  },
  synthesize: (text, options) => synthesize(selectRequired("voice"), text, options),
  transcribe: (clip, options) => transcribe(selectRequired("hearing"), clip, options),
};

/**
 * How `persona` answers in `chat` now: the chat's reply mode, else hers. Voice and auto are text
 * while her voice role can't speak a voice message.
 */
export function replyModeFor(
  chat: TurnRequest["chat"],
  persona: ParticipantId,
  speech: SpeechDeps = batchSpeech,
): ReplyMode {
  const chosen = replyModeOf(chat.events);
  return withPersona(persona, () => {
    const mode = chosen ?? chatReplyMode();
    if (mode === "text" || speech.canSpeak()) return mode;
    if (mode === "voice") {
      logger.info(`[chat] ${persona} answers in text: her voice role can't speak a voice message`);
    }
    return "text";
  });
}

/** `events`, with each voice message of the viewer's heard as nothing reading UNHEARD. */
export function withUnheard(events: readonly ChatEvent[]): ChatEvent[] {
  return events.map((event) =>
    event.type === "message" &&
    event.speaker.kind === "user" &&
    event.modality === "voice" &&
    event.text === ""
      ? { ...event, text: UNHEARD }
      : event,
  );
}

/** The persona whose hearing role hears the viewer's voice messages in `chat`: its first. */
export function voiceHearer(chat: TurnRequest["chat"]): ParticipantId {
  const [first] = summarize(chat.header, chat.events).participants;
  if (first === undefined) throw new TypeError("a chat with no persona hears nothing");
  return first;
}

/**
 * The viewer's voice message `clip` in `chat`, heard by `voiceHearer`'s hearing role and saved, as
 * the message to store. A clip heard as nothing is kept with an empty transcript.
 */
export async function hearVoiceMessage(
  request: {
    readonly chat: TurnRequest["chat"];
    readonly clip: AudioClip;
    readonly signal: AbortSignal;
  },
  deps: Pick<EngineDeps, "saveAttachment" | "newId" | "speech">,
): Promise<Extract<ChatEventDraft, { readonly type: "message" }>> {
  const { chat, clip, signal } = request;
  const heard = await withPersona(voiceHearer(chat), () =>
    withUsageScope({ source: "chat", session: chat.header.id }, () =>
      deps.speech.transcribe(clip, { signal }),
    ),
  );
  signal.throwIfAborted();
  const saved = await deps.saveAttachment(clip.bytes, clip.mime);
  return {
    type: "message",
    id: deps.newId(),
    speaker: { kind: "user" },
    text: heard.text,
    modality: "voice",
    attachments: [timed(saved, heard.durationMs)],
  };
}

/** An audio attachment with its length, where known. */
export function timed<T extends { readonly kind: string }>(
  attachment: T,
  durationMs: number | null,
): T {
  return attachment.kind === "audio" && durationMs !== null
    ? { ...attachment, durationMs: Math.round(durationMs) }
    : attachment;
}
