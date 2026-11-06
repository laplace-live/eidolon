import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useId, useState } from "react";
import { controlFor, draftOf, parseDraft } from "@/components/settings-form/controls";
import { CheckResultView } from "@/components/settings-form/key-field";
import { settingsQuery } from "@/components/settings-form/queries";
import type { CheckOutcome } from "@/components/settings-form/use-keys";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { type ApiError, call, errorKey } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { CopyCommand } from "./copy-command";
import { asApiError } from "./personas";
import { StepCard } from "./step-card";
import { QDRANT_COMMAND, QDRANT_HOST, QDRANT_PORT } from "./wizard";

const HOST = "memory.qdrant.host";
const PORT = "memory.qdrant.port";
const PORT_CONTROL = controlFor({ path: PORT, kind: "int", scope: "app" });

/**
 * Memory is Qdrant, run in Docker. The check probes the typed address before anything is saved,
 * so memory's engine, which keeps the first config it opens with, only ever sees one that works.
 */
export function MemoryStep({
  onBack,
  onDone,
}: {
  readonly onBack: () => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const hostId = useId();
  const portId = useId();
  const queryClient = useQueryClient();
  const status = useQuery(statusQuery);
  const settings = useQuery(settingsQuery());
  const [host, setHost] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  if (settings.isPending) return <Skeleton className="h-80 w-full" />;
  if (settings.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t(errorKey(settings.error))}</AlertTitle>
        <AlertDescription>{settings.error.message}</AlertDescription>
      </Alert>
    );
  }

  const find = (path: string) => settings.data.settings.find((row) => row.path === path);
  const hostRow = find(HOST);
  const portRow = find(PORT);
  const fromEnv = Boolean(hostRow?.envOverride || portRow?.envOverride);
  const hostText = host ?? draftOf(hostRow?.value, { type: "text" });
  const portText = port ?? draftOf(portRow?.value, PORT_CONTROL);
  const hostValue = hostText.trim() || QDRANT_HOST;
  const portParsed = parseDraft(portText, PORT_CONTROL);
  const portValue = portParsed.ok ? ((portParsed.value as number | null) ?? QDRANT_PORT) : null;
  const memory = status.data?.memory;
  const on = saved || (memory?.configured === true && memory.reachable === true);

  async function checkAndSave() {
    if (portValue === null) return;
    setBusy(true);
    setFailure(null);
    try {
      // The environment's address wins over the files, so only it can be checked.
      const value = fromEnv ? undefined : `${hostValue}:${portValue}`;
      const result = await call("POST /api/local/credentials/check", {
        body: { provider: "qdrant", value },
      });
      setOutcome({ result });
      if (result.ok && !fromEnv) {
        await call("PUT /api/local/settings", {
          body: { scope: "app", values: { [HOST]: hostValue, [PORT]: portValue } },
        });
        setSaved(true);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["settings"] }),
          queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
        ]);
      } else if (result.ok) {
        setSaved(true);
      }
    } catch (error) {
      setFailure(asApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      title={t("setup.memory.title")}
      description={t("setup.memory.body")}
      onBack={onBack}
      busy={busy}
      footer={
        on ? (
          <Button onClick={onDone}>{t("setup.next")}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t("setup.memory.skip")}
            </Button>
            <Button onClick={() => void checkAndSave()} disabled={busy || portValue === null}>
              {busy && <Spinner />}
              {t("setup.memory.check")}
            </Button>
          </>
        )
      }
    >
      {on && (
        <Alert>
          <CheckIcon />
          <AlertTitle>{t("setup.memory.on")}</AlertTitle>
        </Alert>
      )}
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm">
        <li>{t("setup.memory.docker")}</li>
        <li>
          {/* A flex <li> is no longer a list item, and would lose its number. */}
          <div className="flex flex-col gap-2">
            {t("setup.memory.run")}
            <CopyCommand command={QDRANT_COMMAND} />
            <span className="text-muted-foreground text-xs">{t("setup.memory.runNote")}</span>
          </div>
        </li>
        <li>{t("setup.memory.checkHint")}</li>
      </ol>

      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field>
          <FieldLabel htmlFor={hostId}>{t("settings.memory.qdrant.host")}</FieldLabel>
          <Input
            id={hostId}
            value={hostText}
            placeholder={QDRANT_HOST}
            disabled={busy || fromEnv}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setHost(event.target.value);
              setOutcome(null);
            }}
          />
        </Field>
        <Field data-invalid={!portParsed.ok}>
          <FieldLabel htmlFor={portId}>{t("settings.memory.qdrant.port")}</FieldLabel>
          <Input
            id={portId}
            value={portText}
            inputMode="numeric"
            placeholder={String(QDRANT_PORT)}
            disabled={busy || fromEnv}
            aria-invalid={!portParsed.ok}
            onChange={(event) => {
              setPort(event.target.value);
              setOutcome(null);
            }}
          />
          {!portParsed.ok && <FieldError>{t(portParsed.error, { min: 1, max: 65535 })}</FieldError>}
        </Field>
      </div>
      {fromEnv && (
        <FieldDescription>
          {t("settings.form.envOverride", { env: hostRow?.env ?? "MEM0_QDRANT_HOST" })}
        </FieldDescription>
      )}

      {outcome && <CheckResultView provider="qdrant" outcome={outcome} />}
      {failure && (
        <Alert variant="destructive">
          <AlertTitle>{t(errorKey(failure))}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
    </StepCard>
  );
}
