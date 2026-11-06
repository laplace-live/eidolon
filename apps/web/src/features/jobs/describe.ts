// A job's events as sentences in the viewer's language. Messages the CLI wrote are English, so they
// only ever appear as detail beside a translated line.
import type { EventCode, Provider, Stage } from "@eidolon/ingest/progress";
import { formatDuration, formatUsd } from "@/lib/format";
import type { Lang, Translate } from "@/lib/i18n";
import type { LoggedEvent } from "@/lib/jobs";

export type Tone = "info" | "ok" | "warn" | "error";

export interface Described {
  readonly text: string;
  readonly detail: string | null;
  readonly tone: Tone;
}

export function stageName(t: Translate, stage: Stage | "pipeline"): string {
  return t(`jobs.stage.${stage}`);
}

/** Why something failed or was skipped: the code's string, naming the provider it is about. */
export function reasonText(
  t: Translate,
  code: EventCode | null | undefined,
  provider?: Provider | null,
): string | null {
  if (!code) return null;
  const reason = t(`events.${code}`);
  return provider
    ? t("jobs.reason.provider", { provider: t(`events.provider.${provider}`), reason })
    : reason;
}

function joined(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : null;
}

export function describeEvent(t: Translate, lang: Lang, event: LoggedEvent): Described {
  switch (event.type) {
    case "stage": {
      const stage = stageName(t, event.stage);
      const reason = reasonText(t, event.code, event.provider);
      if (event.status === "start") {
        return {
          text:
            event.total === undefined
              ? t("jobs.log.stageStart", { stage })
              : t("jobs.log.stageStartTotal", { stage, total: event.total }),
          detail: event.message ?? null,
          tone: "info",
        };
      }
      const tone: Tone =
        event.status === "failed" ? "error" : event.status === "done" ? "ok" : "warn";
      return {
        text: joined(t(`jobs.log.stage.${event.status}`, { stage }), reason) ?? "",
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
      const reason = reasonText(t, event.code, event.provider);
      const tone: Tone =
        event.status === "failed"
          ? "error"
          : event.status === "done"
            ? "ok"
            : event.status === "start"
              ? "info"
              : "warn";
      return {
        text: joined(`${position}${event.item}: ${t(`jobs.item.${event.status}`)}`, reason) ?? "",
        detail: joined(
          event.message,
          event.costUsd === undefined ? null : formatUsd(event.costUsd, lang),
        ),
        tone,
      };
    }
    case "entry":
      return {
        text: t("jobs.log.entry", { title: event.entry.title ?? event.entry.url }),
        detail: joined(
          event.entry.id,
          event.entry.durationSec === undefined ? null : formatDuration(event.entry.durationSec),
        ),
        tone: "info",
      };
    case "summary": {
      const stage = stageName(t, event.stage);
      const key = event.cancelled
        ? "jobs.log.summary.cancelled"
        : event.ok
          ? "jobs.log.summary.ok"
          : "jobs.log.summary.failed";
      return {
        text: t(key, { stage, duration: formatDuration(event.durationSec) }),
        detail: joined(
          event.costUsd === undefined ? null : formatUsd(event.costUsd, lang),
          ...(event.failures ?? []).map((failure) => `${failure.item}: ${failure.error}`),
        ),
        tone: event.cancelled ? "warn" : event.ok ? "ok" : "error",
      };
    }
  }
}
