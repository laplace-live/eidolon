import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type CheckProvider, type CredentialState, errorKey, type RequiredKey } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CHECK_OF, checkTone, KEY_PAGES, type Tone, verdictKey, warningKey } from "./credentials";
import { hasString } from "./field";
import type { CheckOutcome, Keys } from "./use-keys";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
};

const TONE_ICON = { ok: CircleCheckIcon, warn: CircleAlertIcon, error: CircleXIcon } as const;

/** A provider check's verdict in the viewer's language, with the server's English as detail. */
export function CheckResultView({
  provider,
  outcome,
}: {
  readonly provider: CheckProvider;
  readonly outcome: CheckOutcome;
}) {
  const t = useT();
  const lang = useLang();
  if (outcome.error) {
    return (
      <div className={cn("flex items-start gap-1.5 text-sm", TONE_CLASS.error)} role="status">
        <CircleXIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          {t("settings.check.couldNotRun")} {t(errorKey(outcome.error))}
        </span>
      </div>
    );
  }
  const { result } = outcome;
  const tone = checkTone(result);
  const Icon = TONE_ICON[tone];
  return (
    <div className="flex flex-col gap-1 text-sm" role="status">
      <div className={cn("flex items-start gap-1.5", TONE_CLASS[tone])}>
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="font-medium">{t(verdictKey(provider, result, hasString))}</span>
      </div>
      {result.message && <p className="pl-5.5 text-muted-foreground text-xs">{result.message}</p>}
      {result.credit !== null && (
        <p className="pl-5.5 text-muted-foreground text-xs">
          {t("settings.check.credit", {
            amount: new Intl.NumberFormat(lang, { style: "currency", currency: "USD" }).format(
              result.credit,
            ),
          })}
        </p>
      )}
      {result.warnings.map((warning) => {
        const key = warningKey(warning.code, hasString);
        return (
          <div key={warning.code} className={cn("flex items-start gap-1.5", TONE_CLASS.warn)}>
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              {key ? t(key) : warning.message}
              {key && warning.message && (
                <span className="block text-muted-foreground text-xs">{warning.message}</span>
              )}
            </span>
          </div>
        );
      })}
      {result.envOverride && (
        <p className="pl-5.5 text-muted-foreground text-xs">{t("settings.check.envOverride")}</p>
      )}
    </div>
  );
}

export interface KeyFieldProps {
  readonly name: string;
  readonly keys: Keys;
  /** The sign-up link and credit note, for the keys a call needs. */
  readonly pages?: boolean;
  /** A remove button for a key saved in credentials.json. */
  readonly removable?: boolean;
  readonly onRemove?: () => void;
}

function stateBadge(state: CredentialState | undefined) {
  if (!state?.set) return { variant: "outline", key: "settings.credentials.state.unset" } as const;
  return state.source === "env"
    ? ({ variant: "secondary", key: "settings.credentials.state.env" } as const)
    : ({ variant: "secondary", key: "settings.credentials.state.saved" } as const);
}

/** One API key: typed, never shown back, checked against its provider. */
export function KeyField({
  name,
  keys,
  pages = false,
  removable = false,
  onRemove,
}: KeyFieldProps) {
  const t = useT();
  const id = useId();
  const state = keys.credentials.data?.[name];
  const provider = CHECK_OF[name];
  const outcome = keys.outcomes[name];
  const checking = keys.checking.has(name);
  const badge = stateBadge(state);
  const links = pages ? KEY_PAGES[name as RequiredKey] : undefined;
  const typed = keys.typed[name] ?? "";
  return (
    <Field>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel htmlFor={id}>{t(`settings.credentials.${name}`)}</FieldLabel>
        <Badge variant={badge.variant}>
          {state?.set && <ShieldCheckIcon />}
          {t(badge.key)}
        </Badge>
        <code className="text-muted-foreground text-xs">{name}</code>
      </div>
      <div className="flex gap-2">
        <Input
          id={id}
          name={name}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          placeholder={t(
            state?.set ? "settings.credentials.replace" : "settings.credentials.placeholder",
          )}
          onChange={(event) => keys.setTyped(name, event.target.value)}
          disabled={keys.saving}
        />
        {provider && (
          <Button
            type="button"
            variant="outline"
            disabled={checking || keys.saving || (typed.trim() === "" && !state?.set)}
            onClick={() => void keys.check(name, typed)}
          >
            {checking && <Spinner />}
            {t("settings.credentials.check")}
          </Button>
        )}
        {removable && state?.source === "credentials" && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("settings.credentials.remove")}
            disabled={keys.saving}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      {links && (
        <FieldDescription>
          {t(`settings.credentials.${name}.note`)}{" "}
          <a href={links.key} target="_blank" rel="noreferrer noopener">
            {t("settings.credentials.getKey")}
            <ExternalLinkIcon className="ml-0.5 inline size-3" />
          </a>
          {" · "}
          <a href={links.credit} target="_blank" rel="noreferrer noopener">
            {t("settings.credentials.addCredit")}
            <ExternalLinkIcon className="ml-0.5 inline size-3" />
          </a>
        </FieldDescription>
      )}
      {state?.source === "env" && (
        <FieldDescription>{t("settings.credentials.envOverride", { env: name })}</FieldDescription>
      )}
      {provider && outcome && <CheckResultView provider={provider} outcome={outcome} />}
    </Field>
  );
}
