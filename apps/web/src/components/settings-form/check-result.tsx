// A provider check's verdict in the viewer's language, with the server's English as detail.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon } from "lucide-react";
import type { ApiError, CheckResult } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { errorMessage } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { verdictMessage, warningMessage } from "./check-labels";
import { checkTone, type Tone } from "./credentials";

/** A check's verdict, or why the check itself couldn't run. */
export type CheckOutcome =
  | { readonly result: CheckResult; readonly error?: undefined }
  | { readonly error: ApiError; readonly result?: undefined };

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "text-success",
  warn: "text-warning",
  error: "text-destructive",
};

const TONE_ICON = { ok: CircleCheckIcon, warn: CircleAlertIcon, error: CircleXIcon } as const;

export function CheckResultView({
  provider,
  outcome,
}: {
  /** The provider's catalog id, whose own strings a verdict may have. */
  readonly provider: string;
  readonly outcome: CheckOutcome;
}) {
  const { t } = useLingui();
  const lang = useLang();
  if (outcome.error) {
    return (
      <div className={cn("flex items-start gap-2 text-sm", TONE_CLASS.error)} role="status">
        <CircleXIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          {t`The check couldn't run.`} {t(errorMessage(outcome.error))}
        </span>
      </div>
    );
  }
  const { result } = outcome;
  const tone = checkTone(result);
  const Icon = TONE_ICON[tone];
  return (
    <div className="flex flex-col gap-1.5 text-sm" role="status">
      <div className={cn("flex items-start gap-2", TONE_CLASS[tone])}>
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="font-medium">{t(verdictMessage(provider, result))}</span>
      </div>
      {result.message && (
        <p className="wrap-anywhere pl-6 text-muted-foreground text-xs">{result.message}</p>
      )}
      {result.credit !== null && (
        <p className="pl-6 text-muted-foreground text-xs">
          {t`Credit left: ${ph({ amount: formatUsd(result.credit, lang) })}`}
        </p>
      )}
      {result.warnings.map((warning) => {
        const label = warningMessage(warning.code);
        return (
          <div key={warning.code} className={cn("flex items-start gap-2", TONE_CLASS.warn)}>
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              {label ? t(label) : warning.message}
              {label && warning.message && (
                <span className="block text-muted-foreground text-xs">{warning.message}</span>
              )}
            </span>
          </div>
        );
      })}
      {result.envOverride && (
        <p className="pl-6 text-muted-foreground text-xs">{t`This checked the key from the environment, which wins over the one saved here.`}</p>
      )}
    </div>
  );
}
