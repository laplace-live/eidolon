import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, LockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ErrorAlert } from "@/components/error-alert";
import { AccountKeyField } from "@/components/settings-form/account-key-field";
import { settingsQuery } from "@/components/settings-form/queries";
import { SettingsCard } from "@/components/settings-form/settings-card";
import { useAccountKeys } from "@/components/settings-form/use-account-keys";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { accountsQuery } from "@/lib/accounts";
import { type ApiError, asApiError, call } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { StepCard } from "./step-card";
import { cookieDefault, isNewInstall } from "./wizard";

/** The providers a call runs on, which decide the keys this step asks for. */
const CALL_PROVIDERS = [
  ["hearing.provider", "hearing.model"],
  ["mind.provider", "mind.model"],
  ["voice.provider", "voice.model"],
] as const;

/** Keys for the accounts a call needs, with "use other providers" folded beneath. */
export function KeysStep({ onDone }: { readonly onDone: () => void }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const keys = useAccountKeys();
  const settings = useQuery(settingsQuery());
  const status = useQuery(statusQuery);
  const accounts = useQuery(accountsQuery);
  const needed = status.data?.keys ?? [];
  const required = needed.map((key) => key.account);
  // Decided from the first answers: once the keys are saved, the install no longer looks new.
  const newInstall = useRef<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [missing, setMissing] = useState(false);
  const [checksFailed, setChecksFailed] = useState(false);

  useEffect(() => {
    if (newInstall.current === null && settings.data && accounts.data) {
      newInstall.current = isNewInstall(settings.data.settings, accounts.data.accounts);
    }
  }, [settings.data, accounts.data]);

  async function next() {
    setBusy(true);
    setFailure(null);
    setMissing(false);
    setChecksFailed(false);
    try {
      const cookie = settings.data
        ? cookieDefault(settings.data.settings, newInstall.current === true)
        : null;
      if (cookie) {
        await call("PUT /api/local/settings", { body: { scope: "app", values: cookie } });
        await queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
      await keys.save();
      const fresh = await queryClient.fetchQuery(statusQuery);
      if (fresh.keys.some((key) => !key.set)) {
        setMissing(true);
        return;
      }
      const outcomes = await Promise.all(required.map((account) => keys.check(account)));
      if (outcomes.every((outcome) => outcome?.result?.ok)) onDone();
      else setChecksFailed(true);
    } catch (error) {
      setFailure(asApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      title={t`Your API Keys`}
      description={t`Eidolon calls paid services with your own keys: by default Soniox hears you, OpenRouter thinks and Fish Audio speaks. Each needs credit on its account.`}
      note={
        <span className="flex items-center gap-1.5">
          <LockIcon className="size-3.5 shrink-0" aria-hidden />
          {t`Keys stay on this machine, readable only by you.`}
        </span>
      }
      footer={
        <>
          {checksFailed && (
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t`Continue Anyway`}
            </Button>
          )}
          <Button onClick={() => void next()} disabled={busy || accounts.isPending}>
            {busy && <Spinner />}
            {t`Save and Continue`}
          </Button>
        </>
      }
    >
      {accounts.isError && <ErrorAlert error={accounts.error} />}
      <FieldGroup className="gap-7">
        {needed.map((key) => (
          <AccountKeyField key={key.account} need={key} keys={keys} />
        ))}
      </FieldGroup>

      <Collapsible className="-mx-6 flex flex-col gap-6 border-t px-6 pt-4">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="group -ml-2.5 w-fit text-muted-foreground hover:text-foreground aria-expanded:bg-transparent"
          >
            <ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90" />
            {t`Use Other Providers (Optional)`}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-6">
          <p className="inline-links text-muted-foreground text-sm">
            <Trans>
              Pick who hears, thinks and speaks for her from the accounts you have. Add another
              provider's account under <Link to="/settings?tab=providers">Providers</Link>, then
              choose it here or in her studio.
            </Trans>
          </p>
          <SettingsCard
            scope="persona"
            paths={CALL_PROVIDERS}
            title={<span className="block text-base">{t`Who Hears, Thinks and Speaks`}</span>}
            description={t`Saved for the active persona. Claude, DeepSeek and others work through your OpenRouter key or with their own.`}
            onSaved={() => void queryClient.invalidateQueries({ queryKey: statusQuery.queryKey })}
          />
        </CollapsibleContent>
      </Collapsible>

      {missing && (
        <Alert variant="destructive">
          <AlertTitle>{t`Add every key above to continue.`}</AlertTitle>
        </Alert>
      )}
      {checksFailed && (
        <Alert>
          <AlertTitle>{t`Not every key passed its check`}</AlertTitle>
          <AlertDescription>{t`Calls fail with a key the provider refuses. Fix the keys marked above, or continue and fix them later in Settings.`}</AlertDescription>
        </Alert>
      )}
      {failure && <ErrorAlert error={failure} />}
    </StepCard>
  );
}
