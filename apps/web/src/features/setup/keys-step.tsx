import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { SettingsForm } from "@/components/settings-form";
import { OPTIONAL, REQUIRED } from "@/components/settings-form/credentials";
import { KeyField } from "@/components/settings-form/key-field";
import { settingsQuery } from "@/components/settings-form/queries";
import { useKeys } from "@/components/settings-form/use-keys";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { type ApiError, asApiError, call } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { StepCard } from "./step-card";
import { cookieDefault, isNewInstall } from "./wizard";

/** The rows another provider's key needs beside it. */
const PROVIDER_SETTINGS = [
  "embeddings.baseUrl",
  "embeddings.model",
  "embeddings.dim",
  "rerank.baseUrl",
  "refine.baseUrl",
] as const;

/** Keys for the three providers a call needs, with "use another provider" folded beneath. */
export function KeysStep({ onDone }: { readonly onDone: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const keys = useKeys();
  const settings = useQuery(settingsQuery());
  // Decided from the first answers: once the keys are saved, the install no longer looks new.
  const newInstall = useRef<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [missing, setMissing] = useState(false);
  const [checksFailed, setChecksFailed] = useState(false);

  useEffect(() => {
    if (newInstall.current === null && settings.data && keys.credentials.data) {
      newInstall.current = isNewInstall(settings.data.settings, keys.credentials.data);
    }
  }, [settings.data, keys.credentials.data]);

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
      const { state } = await keys.save();
      if (REQUIRED.some((name) => !state?.[name]?.set)) {
        setMissing(true);
        return;
      }
      const outcomes = await Promise.all(REQUIRED.map((name) => keys.check(name)));
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
      title={t("setup.keys.title")}
      description={t("setup.keys.body")}
      footer={
        <>
          {checksFailed && (
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t("setup.keys.continueAnyway")}
            </Button>
          )}
          <Button onClick={() => void next()} disabled={busy || keys.credentials.isPending}>
            {busy && <Spinner />}
            {t("setup.keys.next")}
          </Button>
        </>
      }
    >
      {keys.credentials.isError && <ErrorAlert error={keys.credentials.error} />}
      <FieldGroup>
        {REQUIRED.map((name) => (
          <KeyField key={name} name={name} keys={keys} pages />
        ))}
      </FieldGroup>

      <Collapsible className="flex flex-col gap-4">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="group w-fit px-0 text-muted-foreground hover:bg-transparent"
          >
            <ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90" />
            {t("setup.keys.otherProviders")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-6">
          <p className="text-muted-foreground text-sm">{t("setup.keys.otherProvidersBody")}</p>
          <FieldGroup>
            {OPTIONAL.filter((name) => name !== "OPENAI_API_KEY").map((name) => (
              <KeyField key={name} name={name} keys={keys} />
            ))}
          </FieldGroup>
          <SettingsForm scope="app" paths={PROVIDER_SETTINGS} />
        </CollapsibleContent>
      </Collapsible>

      {missing && (
        <Alert variant="destructive">
          <AlertTitle>{t("setup.keys.missing")}</AlertTitle>
        </Alert>
      )}
      {checksFailed && (
        <Alert>
          <AlertTitle>{t("setup.keys.checksFailed")}</AlertTitle>
          <AlertDescription>{t("setup.keys.checksFailedBody")}</AlertDescription>
        </Alert>
      )}
      {failure && <ErrorAlert error={failure} />}
    </StepCard>
  );
}
