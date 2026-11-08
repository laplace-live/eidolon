// One account's key, as the setup wizard asks for it: typed, never shown back, checked at its
// provider.

import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useId } from "react";
import { QuietBadge } from "@/components/quiet-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { accountsQuery } from "@/lib/accounts";
import type { KeyStatus } from "@/lib/api";
import { KEY_NOTES, listOf, ROLE_LABELS } from "@/lib/labels";
import type { RoleId } from "@/lib/providers";
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

export function AccountKeyField({
  need,
  keys,
}: {
  readonly need: KeyStatus;
  readonly keys: AccountKeys;
}) {
  const { t } = useLingui();
  const id = useId();
  const { data } = useQuery(accountsQuery);
  const source = data?.accounts.find((account) => account.id === need.account)?.key.source;
  const shown =
    source === "account" || source === "credentials" || source === "env"
      ? STATE[source]
      : STATE.missing;
  const typed = keys.typed[need.account] ?? "";
  const outcome = keys.outcomes[need.account];
  const links = keyPages(need.provider);
  const note = KEY_NOTES[need.provider];
  const roles = listOf(need.roles.map((role) => t(ROLE_LABELS[role as RoleId])));
  return (
    <Field className="max-w-xl">
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel htmlFor={id}>{t`${ph({ name: need.name })} API Key`}</FieldLabel>
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
          <span className="whitespace-nowrap [&_a:hover]:text-primary [&_a]:underline [&_a]:underline-offset-4">
            <KeyLinks pages={links} />
          </span>
        )}
      </FieldDescription>
      {note && <FieldDescription>{t(note)}</FieldDescription>}
      {source === "env" && (
        <FieldDescription>{t`The environment's key wins over one saved here.`}</FieldDescription>
      )}
      {outcome && <CheckResultView provider={need.provider} outcome={outcome} />}
    </Field>
  );
}
