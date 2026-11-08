// A job's events as sentences in the viewer's language. Messages the CLI wrote are English, so they
// only ever appear as detail beside a translated line.
import type { EventCode, Provider, Stage } from "@eidolon/ingest/progress";
import { ph, t } from "@lingui/core/macro";
import { formatDuration, formatUsd } from "@/lib/format";
import type { LoggedEvent } from "@/lib/jobs";
import type { Lang } from "@/locales/i18n";
import {
  EVENT_REASONS,
  ITEM_STATUS_WORDS,
  PROVIDER_LABELS,
  STAGE_LABELS,
  stageEndText,
} from "./labels";

export type Tone = "info" | "ok" | "warn" | "error";

export interface Described {
  readonly text: string;
  readonly detail: string | null;
  readonly tone: Tone;
}

/** A stage's name; the API types a snapshot's stage as any string, which then shows as it is. */
export function stageName(stage: string): string {
  const label = STAGE_LABELS[stage as Stage | "pipeline"];
  return label === undefined ? stage : t(label);
}

/** Why something failed or was skipped: the code's string, naming the provider it is about. */
export function reasonText(
  code: EventCode | null | undefined,
  provider?: Provider | null,
): string | null {
  if (!code) return null;
  const reason = t(EVENT_REASONS[code]);
  if (!provider) return reason;
  const name = t(PROVIDER_LABELS[provider]);
  return t`${ph({ provider: name })}: ${reason}`;
}

function joined(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : null;
}

export function describeEvent(lang: Lang, event: LoggedEvent): Described {
  switch (event.type) {
    case "stage": {
      const stage = stageName(event.stage);
      const reason = reasonText(event.code, event.provider);
      if (event.status === "start") {
        return {
          text:
            event.total === undefined
              ? t`${stage} started`
              : t`${stage} started: ${ph({ total: event.total })} to go`,
          detail: event.message ?? null,
          tone: "info",
        };
      }
      const tone: Tone =
        event.status === "failed" ? "error" : event.status === "done" ? "ok" : "warn";
      return {
        text: joined(stageEndText(event.status, stage), reason) ?? "",
        detail: event.message ?? null,
        tone,
      };
    }
    case "item": {
      const position =
        event.index === undefined
          ? ""
          : event.total === undefined
            ? `[${event.index}] `
            : `[${event.index}/${event.total}] `;
      const reason = reasonText(event.code, event.provider);
      const tone: Tone =
        event.status === "failed"
          ? "error"
          : event.status === "done"
            ? "ok"
            : event.status === "start"
              ? "info"
              : "warn";
      return {
        text:
          joined(`${position}${event.item}: ${t(ITEM_STATUS_WORDS[event.status])}`, reason) ?? "",
        detail: joined(
          event.message,
          event.costUsd === undefined ? null : formatUsd(event.costUsd, lang),
        ),
        tone,
      };
    }
    case "entry":
      return {
        text: t`Found ${ph({ title: event.entry.title ?? event.entry.url })}`,
        detail: joined(
          event.entry.id,
          event.entry.durationSec === undefined ? null : formatDuration(event.entry.durationSec),
        ),
        tone: "info",
      };
    case "summary": {
      const stage = stageName(event.stage);
      const duration = formatDuration(event.durationSec);
      return {
        text: event.cancelled
          ? t`${stage} cancelled after ${duration}`
          : event.ok
            ? t`${stage} completed in ${duration}`
            : t`${stage} ended with failures after ${duration}`,
        detail: joined(
          event.costUsd === undefined ? null : formatUsd(event.costUsd, lang),
          ...(event.failures ?? []).map((failure) => `${failure.item}: ${failure.error}`),
        ),
        tone: event.cancelled ? "warn" : event.ok ? "ok" : "error",
      };
    }
  }
}
