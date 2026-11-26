import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { SectionCardSkeleton } from "@/components/section-card";
import { refreshSettings, settingsQuery } from "@/components/settings-form/queries";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { type ApiError, asApiError, call } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { StepCard } from "./step-card";
import { flagOn, memoryStepAction } from "./wizard";

const ENABLED = "memory.enabled";

/** Viewer memory runs in-process on Zvec inside the data home; turning it on sets `memory.enabled`. */
export function MemoryStep({
  onBack,
  onDone,
}: {
  readonly onBack: () => void;
  readonly onDone: () => void;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const status = useQuery(statusQuery);
  const settings = useQuery(settingsQuery());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  if (settings.isPending) return <SectionCardSkeleton rows={2} />;
  if (settings.isError) {
    return <ErrorAlert error={settings.error} />;
  }

  const enabledRow = settings.data.settings.find((row) => row.path === ENABLED);
  const fromEnv = Boolean(enabledRow?.envOverride);
  const on = flagOn(enabledRow, false) || status.data?.memory.configured === true;
  const action = memoryStepAction({ on, fromEnv });

  async function turnOn() {
    setBusy(true);
    setFailure(null);
    try {
      const response = await call("PUT /api/local/settings", {
        body: { scope: "app", values: { [ENABLED]: true } },
      });
      await refreshSettings(queryClient, undefined, response);
    } catch (error) {
      setFailure(asApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      title={t`Memory (Optional)`}
      description={t`With memory on, she remembers you from one call or chat to the next. Memories stay on this computer in your data home — no extra server or Docker container needed. Skip it and everything else still works.`}
      onBack={onBack}
      busy={busy}
      footer={
        action === "next" ? (
          <Button onClick={onDone}>{t`Continue`}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t`Skip`}
            </Button>
            <Button onClick={() => void turnOn()} disabled={busy}>
              {busy && <Spinner />}
              {t`Turn On Memory`}
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
      {fromEnv && (
        <FieldDescription>
          {t`Set by ${ph({ env: enabledRow?.envName ?? "MEM0_ENABLED" })} in the environment, which wins over the value saved here. Change it there.`}
        </FieldDescription>
      )}
      {failure && <ErrorAlert error={failure} />}
    </StepCard>
  );
}
