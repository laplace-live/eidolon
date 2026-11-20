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
import { Spinner } from "@/components/ui/spinner";
import { accountsQuery } from "@/lib/accounts";
import type { KeyStatus } from "@/lib/api";
import { ACCOUNT_FIELD_LABELS, KEY_NOTES, listOf, ROLE_LABELS } from "@/lib/labels";
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

export function AccountKeyField({
  need,
  keys,
  optional = false,
  note,
  missing = [],
}: {
  readonly need: KeyStatus;
  readonly keys: AccountKeys;
  /** Continue doesn't wait for it. */
  readonly optional?: boolean;
  /** What goes without it, under the field. */
  readonly note?: ReactNode;
  /** The provider's own settings a save found missing, by field key. */
  readonly missing?: readonly string[];
}) {
  const { t } = useLingui();
  const id = useId();
  const { data } = useQuery(accountsQuery);
  const account = data?.accounts.find((entry) => entry.id === need.account);
  const source = account?.key.source;
  const shown =
    source === "account" || source === "credentials" || source === "env"
      ? STATE[source]
      : STATE.missing;
  const typed = keys.typed[need.account] ?? "";
  const outcome = keys.outcomes[need.account];
  const links = keyPages(need.provider);
  const keyNote = KEY_NOTES[need.provider];
  const roles = useRoles(need);
  const fields = providerById(need.provider)?.fields ?? [];
  return (
    <Field className="max-w-xl">
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel htmlFor={id}>
          {optional
            ? t`${ph({ name: need.name })} API Key (Optional)`
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
            keys.checking.has(need.account) || keys.saving || (typed.trim() === "" && !need.set)
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
        return (
          <div key={field.key} className="flex flex-col gap-2 pt-1">
            <FieldLabel htmlFor={`${id}-${field.key}`}>{label ? t(label) : field.label}</FieldLabel>
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
