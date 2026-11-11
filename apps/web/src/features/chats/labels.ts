import type { ChatEventOf, ReplyMode } from "@eidolon/chat";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { RecorderProblem } from "./use-recorder";

/** What she is doing while a tool runs, by the tool's name. */
const TOOL_STATES: Readonly<Record<string, MessageDescriptor>> = {
  take_selfie: msg`Taking a selfie…`,
  recall_streams: msg`Looking through the stream archive…`,
  voice: msg`Recording a voice message…`,
};

export function toolState(name: string): MessageDescriptor {
  return TOOL_STATES[name] ?? msg`Using a tool…`;
}

/** How a decision chose who answers, by its source. */
export const SOURCE_LABELS: Readonly<Record<ChatEventOf<"decision">["source"], MessageDescriptor>> =
  {
    single: msg`She's the only persona in this chat, so she answers every line.`,
    mention: msg`The line @-mentioned someone, and whoever a line mentions answers first.`,
    model: msg`The director chose from how it scored the line.`,
    fallback: msg`The director didn't answer in time, so simple rules chose: a mention, a name in the line, then the most talkative.`,
  };

/** Each reply mode's name, as a chat's settings and her studio offer it. */
export const REPLY_MODE_LABELS: Readonly<Record<ReplyMode, MessageDescriptor>> = {
  auto: msg({ message: "Auto", context: "reply mode" }),
  text: msg({ message: "Text", context: "reply mode" }),
  voice: msg({ message: "Voice", context: "reply mode" }),
};

/** What each reply mode does. */
export const REPLY_MODE_HELP: Readonly<Record<ReplyMode, MessageDescriptor>> = {
  auto: msg`Replies come as voice messages when a line suits one, more often after one of yours, and as text otherwise.`,
  text: msg`Replies always come as text.`,
  voice: msg`Replies always come as voice messages.`,
};

/** Why a recording didn't start or send, as a toast's title and line. */
export const RECORDER_PROBLEMS: Readonly<
  Record<RecorderProblem, { readonly title: MessageDescriptor; readonly body: MessageDescriptor }>
> = {
  denied: {
    title: msg`Your microphone is blocked`,
    body: msg`Allow microphone access for this page in your browser's site settings, then try again.`,
  },
  busy: {
    title: msg`Your microphone is in use`,
    body: msg`Another app is using your microphone. Close it, then try again.`,
  },
  missing: {
    title: msg`No microphone found`,
    body: msg`Connect a microphone, then try again.`,
  },
  insecure: {
    title: msg`The microphone isn't available here`,
    body: msg`Browsers allow the microphone only on secure pages. Open Eidolon at http://localhost or http://127.0.0.1.`,
  },
  unknown: {
    title: msg`Your microphone didn't start`,
    body: msg`Check your microphone, then try again.`,
  },
  short: {
    title: msg`Too short to send`,
    body: msg`Hold the microphone button while you talk, or click it to start and again to send.`,
  },
};
