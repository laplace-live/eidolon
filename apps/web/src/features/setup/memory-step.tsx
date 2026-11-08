import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { SectionCardSkeleton } from "@/components/section-card";
import type { CheckOutcome } from "@/components/settings-form/check-result";
import { CheckResultView } from "@/components/settings-form/check-result";
import { controlFor, draftOf, parseDraft } from "@/components/settings-form/controls";
import { INVALID_MESSAGES } from "@/components/settings-form/labels";
import { settingsQuery } from "@/components/settings-form/queries";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type ApiError, asApiError, call } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { CopyCommand } from "./copy-command";
import { StepCard } from "./step-card";
import {
  memoryStepAction,
  QDRANT_COMMAND,
  QDRANT_HOST,
  QDRANT_PORT,
  type QdrantAddress,
  savedQdrant,
} from "./wizard";

const HOST = "memory.qdrant.host";
const PORT = "memory.qdrant.port";
const PORT_CONTROL = controlFor({ path: PORT, env: "MEM0_QDRANT_PORT", kind: "int", scope: "app" });

function Instruction({ n, children }: { readonly n: number; readonly children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-card font-medium text-muted-foreground text-xs">
        {n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </li>
  );
}

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
  const { t, i18n } = useLingui();
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
  // The address this visit checked and saved.
  const [saved, setSaved] = useState<QdrantAddress | null>(null);

  if (settings.isPending) return <SectionCardSkeleton rows={3} />;
  if (settings.isError) {
    return <ErrorAlert error={settings.error} />;
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
  const typed = portValue === null ? null : { host: hostValue, port: portValue };
  const memory = status.data?.memory;
  const on = saved !== null || (memory?.configured === true && memory.reachable === true);
  const action = memoryStepAction({
    on,
    fromEnv,
    saved: saved ?? savedQdrant(hostRow?.value, portRow?.value),
    typed,
  });

  async function checkAndSave() {
    if (typed === null) return;
    setBusy(true);
    setFailure(null);
    try {
      // The environment's address wins over the files, so only it can be checked.
      const value = fromEnv ? undefined : `${typed.host}:${typed.port}`;
      const result = await call("POST /api/local/credentials/check", {
        body: { provider: "qdrant", value },
      });
      setOutcome({ result });
      if (result.ok && !fromEnv) {
        await call("PUT /api/local/settings", {
          body: { scope: "app", values: { [HOST]: typed.host, [PORT]: typed.port } },
        });
        setSaved(typed);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["settings"] }),
          queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
        ]);
      } else if (result.ok) {
        setSaved(typed);
      }
    } catch (error) {
      setFailure(asApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      title={t`Memory (Optional)`}
      description={t`With memory on, she remembers you from one call to the next. It needs Qdrant, a database you run in Docker on this machine. Skip it and everything else still works.`}
      onBack={onBack}
      busy={busy}
      footer={
        action === "next" ? (
          <Button onClick={onDone}>{t`Continue`}</Button>
        ) : (
          <>
            {/* Once memory is on, going on keeps the address it runs on. */}
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {on ? t`Continue` : t`Skip`}
            </Button>
            <Button onClick={() => void checkAndSave()} disabled={busy || typed === null}>
              {busy && <Spinner />}
              {on ? t`Check and Save` : t`Check and Turn On`}
            </Button>
          </>
        )
      }
    >
      {on && (
        <Alert>
          <CircleCheckIcon className="text-success" />
          <AlertTitle>{t`Memory is on.`}</AlertTitle>
        </Alert>
      )}
      <ol className="flex flex-col gap-5 text-sm">
        <Instruction
          n={1}
        >{t`Install Docker Desktop, or Docker Engine on Linux, and start it.`}</Instruction>
        <Instruction n={2}>
          <div className="flex flex-col gap-2.5">
            {t`Run this once in a terminal:`}
            <CopyCommand command={QDRANT_COMMAND} />
            <span className="text-muted-foreground text-xs">{t`It answers only on this machine, keeps its data in a Docker volume and restarts with Docker.`}</span>
          </div>
        </Instruction>
        <Instruction
          n={3}
        >{t`Check it below. Already running Qdrant here? Just check its address.`}</Instruction>
      </ol>

      <div className="grid max-w-xl gap-4 sm:grid-cols-[1fr_8rem]">
        <Field>
          <FieldLabel htmlFor={hostId}>{t`Qdrant Host`}</FieldLabel>
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
          <FieldLabel htmlFor={portId}>{t`Qdrant Port`}</FieldLabel>
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
          {!portParsed.ok && (
            <FieldError>
              {INVALID_MESSAGES[portParsed.error]
                ? i18n._({ ...INVALID_MESSAGES[portParsed.error], values: { min: 1, max: 65535 } })
                : portParsed.error}
            </FieldError>
          )}
        </Field>
      </div>
      {fromEnv && (
        <FieldDescription>
          {t`Set by ${ph({ env: hostRow?.env ?? "MEM0_QDRANT_HOST" })} in the environment, which wins over the value saved here. Change it there.`}
        </FieldDescription>
      )}

      {outcome && <CheckResultView provider="qdrant" outcome={outcome} />}
      {failure && <ErrorAlert error={failure} />}
    </StepCard>
  );
}
