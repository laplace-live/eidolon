// Adding or editing one provider account: which provider, then its name, key, API base and the
// provider's own settings. A key is typed, checked and saved, and never shown back.

import { ph, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { KeyLinks } from "@/components/settings-form/account-key-field";
import { type CheckOutcome, CheckResultView } from "@/components/settings-form/check-result";
import { keyPages } from "@/components/settings-form/credentials";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { refreshAccounts } from "@/lib/accounts";
import { type AccountUpdate, type AccountView, asApiError, call } from "@/lib/api";
import { ACCOUNT_FIELD_LABELS, CATEGORY_LABELS } from "@/lib/labels";
import { type Category, PROVIDERS, type Provider, providerById } from "@/lib/providers";

/** What a provider offers, in the viewer's language: "Chat · Voice". */
export function offersText(provider: Provider): string {
  return (Object.keys(provider.offers) as Category[])
    .map((category) => t(CATEGORY_LABELS[category]))
    .join(" · ");
}

function ProviderList({ onPick }: { readonly onPick: (provider: Provider) => void }) {
  const { t } = useLingui();
  return (
    <Command className="rounded-lg border">
      <CommandInput placeholder={t`Search providers`} />
      <CommandList className="max-h-96">
        <CommandEmpty>{t`No provider by that name.`}</CommandEmpty>
        <CommandGroup>
          {PROVIDERS.map((provider) => (
            <CommandItem
              key={provider.id}
              value={`${provider.name} ${provider.id}`}
              onSelect={() => onPick(provider)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{provider.name}</span>
                <span className="truncate text-muted-foreground text-xs">
                  {offersText(provider)}
                </span>
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

/** Where a value comes from, when another layer than the account's own sets it. */
function sourceNote(source: string | null, variable: string | null): string | null {
  if (source === "env")
    return t`Set by ${ph({ env: variable ?? "" })} in the environment, which wins over a value saved here.`;
  if (source === "settings")
    return t`Set by ${ph({ env: variable ?? "" })} in settings.yaml; a value saved here replaces it.`;
  if (source === "credentials")
    return t`Saved in credentials.json under the provider's own variable; saving a new one moves it into this account.`;
  return null;
}

export interface AccountDialogProps {
  readonly open: boolean;
  /** The account to edit; null adds one. */
  readonly account: AccountView | null;
  readonly onClose: () => void;
}

export function AccountDialog({ open, account, onClose }: AccountDialogProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const ids = { name: useId(), key: useId(), base: useId() };
  const [provider, setProvider] = useState<Provider | null>(null);
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [options, setOptions] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);

  // Every opening starts from the account as saved, or from nothing.
  useEffect(() => {
    if (!open) return;
    setProvider(account === null ? null : (providerById(account.provider) ?? null));
    setName(account?.saved ? account.name : "");
    setApiKey("");
    setBaseUrl(account?.baseUrl.source === "account" ? (account.baseUrl.value ?? "") : "");
    setOptions(
      Object.fromEntries(
        Object.entries(account?.options ?? {})
          .filter(([, option]) => option.source === "account")
          .map(([key, option]) => [key, option.value ?? ""]),
      ),
    );
    setOutcome(null);
  }, [open, account]);

  const check = useMutation({
    mutationFn: () =>
      call("POST /api/local/accounts/check", {
        body: {
          ...(account === null ? { provider: provider?.id } : { account: account.id }),
          apiKey: apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        },
      }),
    onSuccess: (result) => setOutcome({ result }),
    onError: (error) => setOutcome({ error: asApiError(error) }),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (provider === null) throw new Error("no provider");
      const body: { -readonly [K in keyof AccountUpdate]: AccountUpdate[K] } = {};
      const typedName = name.trim();
      if (typedName !== "") body.name = typedName;
      else if (account?.saved) body.name = null;
      if (apiKey.trim() !== "") body.apiKey = apiKey.trim();
      const typedBase = baseUrl.trim();
      if (typedBase !== "") body.baseUrl = typedBase;
      else if (account?.baseUrl.source === "account") body.baseUrl = null;
      const changed: Record<string, string | null> = {};
      for (const field of provider.fields ?? []) {
        const typed = (options[field.key] ?? "").trim();
        if (typed !== "") changed[field.key] = typed;
        else if (account?.options[field.key]?.source === "account") changed[field.key] = null;
      }
      if (Object.keys(changed).length > 0) body.options = changed;
      return account === null
        ? call("POST /api/local/accounts", { body: { provider: provider.id, ...body } })
        : call("PUT /api/local/accounts/:id", { params: { id: account.id }, body });
    },
    onSuccess: async (saved) => {
      toast.success(t`${ph({ name: saved.name })} saved.`);
      await refreshAccounts(queryClient);
      onClose();
    },
  });

  const removeKey = useMutation({
    mutationFn: () =>
      call("PUT /api/local/accounts/:id", {
        params: { id: account?.id ?? "" },
        body: { apiKey: null },
      }),
    onSuccess: async () => {
      toast.success(t`Key removed.`);
      await refreshAccounts(queryClient);
      onClose();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  const busy = save.isPending || removeKey.isPending;
  const keySource = account?.key.source ?? null;
  const takesKey = provider !== null && provider.credential !== null;
  const needsBase = provider !== null && provider.baseUrl === null && provider.baseUrlEnv !== null;
  const pages = provider === null ? undefined : keyPages(provider.id);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {account !== null
              ? t`Edit ${ph({ name: account.name })}`
              : provider === null
                ? t`Add a Provider`
                : t`Add a ${ph({ provider: provider.name })} Account`}
          </DialogTitle>
          <DialogDescription>
            {provider === null
              ? t`Pick the provider this account is with. You can add more than one of a provider.`
              : t`Its key goes only to ${ph({ provider: provider.name })}, and stays on this machine.`}
          </DialogDescription>
        </DialogHeader>
        {provider === null ? (
          <ProviderList onPick={setProvider} />
        ) : (
          <form id="account-form" onSubmit={submit} noValidate>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor={ids.name}>{t`Name`}</FieldLabel>
                <Input
                  id={ids.name}
                  value={name}
                  maxLength={80}
                  placeholder={account?.name ?? provider.name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
                <FieldDescription>{t`How Settings and the studio list it, such as “OpenAI (work)”.`}</FieldDescription>
              </Field>
              {takesKey && (
                <Field>
                  <FieldLabel htmlFor={ids.key}>
                    {provider.keyOptional ? t`API Key (If the Server Asks for One)` : t`API Key`}
                  </FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id={ids.key}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKey}
                      placeholder={
                        keySource === "env"
                          ? t`Set in the environment`
                          : keySource !== null
                            ? t`Paste a new key to replace it`
                            : t`Paste the key`
                      }
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        setOutcome(null);
                      }}
                      disabled={busy}
                    />
                    {(keySource === "account" || keySource === "credentials") && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        disabled={busy}
                        onClick={() => removeKey.mutate()}
                      >
                        {t`Remove Key`}
                      </Button>
                    )}
                  </div>
                  {pages && (
                    <FieldDescription className="[&_a:hover]:text-primary [&_a]:underline [&_a]:underline-offset-4">
                      <KeyLinks pages={pages} />
                    </FieldDescription>
                  )}
                  {keySource !== null && keySource !== "account" && (
                    <FieldDescription>
                      {sourceNote(keySource, provider.credential)}
                    </FieldDescription>
                  )}
                </Field>
              )}
              {(provider.baseUrlEnv !== null || provider.baseUrl !== null) && (
                <Field>
                  <FieldLabel htmlFor={ids.base}>
                    {needsBase ? t`API Base (Required)` : t`API Base`}
                  </FieldLabel>
                  <Input
                    id={ids.base}
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono md:text-[0.8125rem]"
                    value={baseUrl}
                    placeholder={
                      account?.baseUrl.source !== "account"
                        ? (account?.baseUrl.value ?? provider.baseUrl ?? "https://")
                        : (provider.baseUrl ?? "https://")
                    }
                    onChange={(event) => {
                      setBaseUrl(event.target.value);
                      setOutcome(null);
                    }}
                    disabled={busy}
                  />
                  <FieldDescription>
                    {sourceNote(account?.baseUrl.source ?? null, provider.baseUrlEnv) ??
                      (needsBase
                        ? t`Your server's OpenAI-compatible base, such as http://127.0.0.1:1234/v1.`
                        : t`Leave it empty for the provider's own API, or point it at a proxy or another region.`)}
                  </FieldDescription>
                </Field>
              )}
              {(provider.fields ?? []).map((field) => (
                <Field key={field.key}>
                  <FieldLabel htmlFor={`${ids.base}-${field.key}`}>
                    {ACCOUNT_FIELD_LABELS[field.key]
                      ? t(ACCOUNT_FIELD_LABELS[field.key])
                      : field.label}
                  </FieldLabel>
                  <Input
                    id={`${ids.base}-${field.key}`}
                    autoComplete="off"
                    spellCheck={false}
                    value={options[field.key] ?? ""}
                    placeholder={account?.options[field.key]?.value ?? ""}
                    onChange={(event) =>
                      setOptions((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                    disabled={busy}
                  />
                  {sourceNote(account?.options[field.key]?.source ?? null, field.env) && (
                    <FieldDescription>
                      {sourceNote(account?.options[field.key]?.source ?? null, field.env)}
                    </FieldDescription>
                  )}
                </Field>
              ))}
              {outcome && <CheckResultView provider={provider.id} outcome={outcome} />}
              {save.isError && <ErrorAlert error={save.error} />}
              {removeKey.isError && <ErrorAlert error={removeKey.error} />}
            </FieldGroup>
          </form>
        )}
        {provider !== null && (
          <DialogFooter className="gap-2 sm:justify-between">
            {account === null ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setProvider(null)}
                disabled={busy}
              >
                <ArrowLeftIcon data-icon="inline-start" />
                {t`Other Provider`}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || check.isPending}
                onClick={() => check.mutate()}
              >
                {check.isPending && <Spinner />}
                {t`Check`}
              </Button>
              <Button type="submit" form="account-form" disabled={busy}>
                {save.isPending && <Spinner />}
                {account === null ? t`Add Account` : t`Save`}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
