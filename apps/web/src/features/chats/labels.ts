import type { ChatEventOf } from "@eidolon/chat";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** What she is doing while a tool runs, by the tool's name. */
const TOOL_STATES: Readonly<Record<string, MessageDescriptor>> = {
  take_selfie: msg`Taking a selfie…`,
  recall_streams: msg`Looking through the stream archive…`,
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
