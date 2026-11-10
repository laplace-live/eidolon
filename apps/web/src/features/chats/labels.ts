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
