// One account's key, as the setup wizard asks for it: typed, never shown back, checked at its
// provider, with the provider's own settings beside it. An account that takes no key is checked
// by reaching it.

import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { QuietBadge } from "@/components/quiet-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { accountsQuery } from "@/lib/accounts";
import type { KeyStatus } from "@/lib/api";
import {
  ACCOUNT_FIELD_LABELS,
  ACCOUNT_FIELD_OPTION_LABELS,
  KEY_NOTES,
  listOf,
  ROLE_LABELS,
} from "@/lib/labels";
import { providerById, type RoleId } from "@/lib/providers";
import { CheckResultView } from "./check-result";
import { type KeyPages, keyPages } from "./credentials";
import type { AccountKeys } from "./use-account-keys";

const STATE = {
  account: { dot: "bg-success", text: msg`Saved` },
  credentials: { dot: "bg-success", text: msg`Saved` },
  env: { dot: "bg-success", text: msg`From the environment` },
  missing: { dot: "bg-warning", text: msg`No key` },
} as const;

/** "Get a key · Add credit", to the provider's own pages. */
export function KeyLinks({ pages }: { readonly pages: KeyPages }) {
  const { t } = useLingui();
  return (
    <>
      {pages.key && (
        <a href={pages.key} target="_blank" rel="noreferrer noopener">
          {t`Get a key`}
          <ExternalLinkIcon className="ml-0.5 inline size-3" />
        </a>
      )}
      {pages.key && pages.credit && " · "}
      {pages.credit && (
        <a href={pages.credit} target="_blank" rel="noreferrer noopener">
          {t`Add credit`}
          <ExternalLinkIcon className="ml-0.5 inline size-3" />
        </a>
      )}
    </>
  );
}

function useRoles(need: KeyStatus): string {
  const { t } = useLingui();
  return listOf(need.roles.map((role) => t(ROLE_LABELS[role as RoleId])));
}

/** What setup asks of a key: Continue waits for a required one, and only recommends another. */
export type KeyTier = "required" | "recommended" | "optional";

export function AccountKeyField({
  need,
  keys,
  tier,
  note,
  missing = [],
}: {
  readonly need: KeyStatus;
  readonly keys: AccountKeys;
  readonly tier: KeyTier;
  /** What goes without it, under the field. */
  readonly note?: ReactNode;
  /** The provider's own settings a save found missing, by field key. */
  readonly missing?: readonly string[];
}) {
  const { t } = useLingui();
  const id = useId();
  const { data } = useQuery(accountsQuery);
  const account = data?.accounts.find((entry) => entry.id === need.account);
  const provider = providerById(need.provider);
  const source = account?.key.source;
  const shown =
    source === "account" || source === "credentials" || source === "env"
      ? STATE[source]
      : provider?.keyOptional
        ? { dot: "bg-muted-foreground/50", text: msg`Optional` }
        : STATE.missing;
  const typed = keys.typed[need.account] ?? "";
  const typedBase = keys.baseUrls[need.account] ?? "";
  const hasBase = (typedBase.trim() || account?.baseUrl.value || provider?.baseUrl || "") !== "";
  const outcome = keys.outcomes[need.account];
  const links = keyPages(need.provider);
  const keyNote = KEY_NOTES[need.provider];
  const roles = useRoles(need);
  const fields = (provider?.fields ?? []).filter(
    (field) => field.key !== "sttProtocol" || need.roles.includes("hearing"),
  );
  const showBaseUrl = Boolean(provider?.keyOptional && provider.baseUrlEnv !== null);
  return (
    <Field className="max-w-xl">
      {showBaseUrl && provider && (
        <div className="flex flex-col gap-2 pb-1">
          <FieldLabel htmlFor={`${id}-baseUrl`}>
            {provider.baseUrl === null ? t`API Base (Required)` : t`API Base`}
          </FieldLabel>
          <Input
            id={`${id}-baseUrl`}
            name={`${need.account}-baseUrl`}
            type="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono md:text-[0.8125rem]"
            value={typedBase}
            placeholder={account?.baseUrl.value ?? provider.baseUrl ?? "http://127.0.0.1:1234/v1"}
            aria-invalid={missing.includes("baseUrl")}
            onChange={(event) => keys.setBaseUrl(need.account, event.target.value)}
            disabled={keys.saving}
          />
          <FieldDescription>
            {provider.id === "fish-speech"
              ? t`Your Fish Speech server's address, such as http://127.0.0.1:8080.`
              : t`Your server's OpenAI-compatible base, such as http://127.0.0.1:1234/v1.`}
          </FieldDescription>
          {missing.includes("baseUrl") && <FieldError>{t`Required.`}</FieldError>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel htmlFor={id}>
          {provider?.keyOptional
            ? t`${ph({ name: need.name })} API Key (If the Server Asks for One)`
            : tier === "optional"
              ? t`${ph({ name: need.name })} API Key (Optional)`
              : tier === "recommended"
                ? t`${ph({ name: need.name })} API Key (Recommended)`
                : t`${ph({ name: need.name })} API Key`}
        </FieldLabel>
        <QuietBadge dot={shown.dot}>{t(shown.text)}</QuietBadge>
      </div>
      <div className="flex gap-2">
        <Input
          id={id}
          name={need.account}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          placeholder={
            source === "env"
              ? t`Set in the environment`
              : need.set
                ? t`Paste a new key to replace it`
                : t`Paste the key`
          }
          onChange={(event) => keys.setTyped(need.account, event.target.value)}
          disabled={keys.saving}
        />
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={
            keys.checking.has(need.account) ||
            keys.saving ||
            (provider?.keyOptional ? !hasBase : typed.trim() === "" && !need.set)
          }
          onClick={() => void keys.check(need.account, typed)}
        >
          {keys.checking.has(need.account) && <Spinner />}
          {t`Check`}
        </Button>
      </div>
      <FieldDescription>
        {`${t`Used for: ${roles}.`} `}
        {links && (
          <span className="whitespace-nowrap [&_a:hover]:text-link [&_a]:underline [&_a]:underline-offset-4">
            <KeyLinks pages={links} />
          </span>
        )}
      </FieldDescription>
      {keyNote && <FieldDescription>{t(keyNote)}</FieldDescription>}
      {note && <FieldDescription>{note}</FieldDescription>}
      {source === "env" && (
        <FieldDescription>{t`The environment's key wins over one saved here.`}</FieldDescription>
      )}
      {fields.map((field) => {
        const label = ACCOUNT_FIELD_LABELS[field.key];
        const saved = account?.options[field.key]?.value ?? null;
        const optionLabels = ACCOUNT_FIELD_OPTION_LABELS[field.key];
        return (
          <div key={field.key} className="flex flex-col gap-2 pt-1">
            <FieldLabel htmlFor={`${id}-${field.key}`}>{label ? t(label) : field.label}</FieldLabel>
            {field.options ? (
              <Select
                value={keys.options[need.account]?.[field.key] ?? saved ?? field.default ?? ""}
                onValueChange={(value) => keys.setOption(need.account, field.key, value)}
                disabled={keys.saving}
              >
                <SelectTrigger
                  id={`${id}-${field.key}`}
                  className="w-full"
                  aria-invalid={missing.includes(field.key)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {optionLabels?.[option] ? t(optionLabels[option]) : option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={`${id}-${field.key}`}
                name={`${need.account}-${field.key}`}
                autoComplete="off"
                spellCheck={false}
                value={keys.options[need.account]?.[field.key] ?? ""}
                placeholder={saved ?? ""}
                aria-invalid={missing.includes(field.key)}
                onChange={(event) => keys.setOption(need.account, field.key, event.target.value)}
                disabled={keys.saving}
              />
            )}
            {missing.includes(field.key) && <FieldError>{t`Required.`}</FieldError>}
          </div>
        );
      })}
      {outcome && <CheckResultView provider={need.provider} outcome={outcome} />}
    </Field>
  );
}

/** An account that takes no key, such as Ollama on this computer: a Check that it answers. */
export function NoKeyField({
  need,
  keys,
}: {
  readonly need: KeyStatus;
  readonly keys: AccountKeys;
}) {
  const { t } = useLingui();
  const { data } = useQuery(accountsQuery);
  const base =
    data?.accounts.find((entry) => entry.id === need.account)?.baseUrl.value ??
    providerById(need.provider)?.baseUrl ??
    null;
  const outcome = keys.outcomes[need.account];
  const roles = useRoles(need);
  return (
    <Field className="max-w-xl">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm leading-snug">{need.name}</span>
        <QuietBadge dot="bg-success">{t`No key needed`}</QuietBadge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-muted-foreground text-sm">
          {base === null
            ? t`It takes no key.`
            : t`Eidolon reaches it at ${ph({ base })}, with no key.`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={keys.checking.has(need.account) || keys.saving}
          onClick={() => void keys.check(need.account)}
        >
          {keys.checking.has(need.account) && <Spinner />}
          {t`Check`}
        </Button>
      </div>
      <FieldDescription>{t`Used for: ${roles}.`}</FieldDescription>
      {outcome && <CheckResultView provider={need.provider} outcome={outcome} />}
    </Field>
  );
}
