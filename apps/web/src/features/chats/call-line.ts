import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { formatDuration } from "@/lib/format";
import type { CallItem } from "./items";

/**
 * A call's edge as its quiet line across the log: its start names her, with how long it lasted once
 * it has ended, as "Call with 奶绿 · 3:12".
 */
export function callLine(item: CallItem, name: string): MessageDescriptor {
  if (item.edge === "ended") return msg`Call ended`;
  return item.durationMs === null
    ? msg`Call with ${ph({ name })}`
    : msg`Call with ${ph({ name })} · ${ph({ duration: formatDuration(item.durationMs / 1000) })}`;
}
