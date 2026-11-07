import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ExternalLinkIcon,
  Trash2Icon,
} from "lucide-react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type CheckProvider, type CredentialState, errorKey, type RequiredKey } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  CHECK_OF,
  checkTone,
  KEY_PAGES,
  REQUIRED,
  type Tone,
  verdictKey,
  warningKey,
} from "./credentials";
import { hasString } from "./field";
import type { CheckOutcome, Keys } from "./use-keys";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "text-success",
  warn: "text-warning",
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
      <div className={cn("flex items-start gap-2 text-sm", TONE_CLASS.error)} role="status">
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
    <div className="flex flex-col gap-1.5 text-sm" role="status">
      <div className={cn("flex items-start gap-2", TONE_CLASS[tone])}>
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="font-medium">{t(verdictKey(provider, result, hasString))}</span>
      </div>
      {result.message && (
        <p className="wrap-anywhere pl-6 text-muted-foreground text-xs">{result.message}</p>
      )}
      {result.credit !== null && (
        <p className="pl-6 text-muted-foreground text-xs">
          {t("settings.check.credit", { amount: formatUsd(result.credit, lang) })}
        </p>
      )}
      {result.warnings.map((warning) => {
        const key = warningKey(warning.code, hasString);
        return (
          <div key={warning.code} className={cn("flex items-start gap-2", TONE_CLASS.warn)}>
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
        <p className="pl-6 text-muted-foreground text-xs">{t("settings.check.envOverride")}</p>
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

const STATE = {
  saved: { dot: "bg-success", key: "settings.credentials.state.saved" },
  env: { dot: "bg-success", key: "settings.credentials.state.env" },
  // A call can't start without a required key; any other may stay unset.
  missing: { dot: "bg-warning", key: "settings.credentials.state.unset" },
  unset: { dot: "bg-muted-foreground/40", key: "settings.credentials.state.unset" },
} as const;

function stateOf(name: string, state: CredentialState | undefined): keyof typeof STATE {
  if (state?.set) return state.source === "env" ? "env" : "saved";
  return (REQUIRED as readonly string[]).includes(name) ? "missing" : "unset";
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
  const shown = STATE[stateOf(name, state)];
  const links = pages ? KEY_PAGES[name as RequiredKey] : undefined;
  const typed = keys.typed[name] ?? "";
  const fromEnv = state?.source === "env";
  return (
    <Field className="max-w-xl">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <FieldLabel htmlFor={id}>{t(`settings.credentials.${name}`)}</FieldLabel>
          <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
            <span aria-hidden className={cn("size-1.5 rounded-full", shown.dot)} />
            {t(shown.key)}
          </Badge>
        </div>
        <code className="w-full font-mono text-muted-foreground text-xs sm:w-auto">{name}</code>
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
            fromEnv
              ? "settings.credentials.envPlaceholder"
              : state?.set
                ? "settings.credentials.replace"
                : "settings.credentials.placeholder",
          )}
          onChange={(event) => keys.setTyped(name, event.target.value)}
          disabled={keys.saving}
        />
        {provider && (
          <Button
            type="button"
            variant="outline"
            size="lg"
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
            size="icon-lg"
            className="text-muted-foreground hover:text-destructive"
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
          <span className="whitespace-nowrap [&_a:hover]:text-primary [&_a]:underline [&_a]:underline-offset-4">
            <a href={links.key} target="_blank" rel="noreferrer noopener">
              {t("settings.credentials.getKey")}
              <ExternalLinkIcon className="ml-0.5 inline size-3" />
            </a>
            {" · "}
            <a href={links.credit} target="_blank" rel="noreferrer noopener">
              {t("settings.credentials.addCredit")}
              <ExternalLinkIcon className="ml-0.5 inline size-3" />
            </a>
          </span>
        </FieldDescription>
      )}
      {fromEnv && <FieldDescription>{t("settings.credentials.envOverride")}</FieldDescription>}
      {provider && outcome && <CheckResultView provider={provider} outcome={outcome} />}
    </Field>
  );
}
