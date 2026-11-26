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
  const on = enabledRow ? flagOn(enabledRow, true) : status.data?.memory.configured !== false;
  const action = memoryStepAction({ on, fromEnv });

  async function saveEnabled(enabled: boolean) {
    setBusy(true);
    setFailure(null);
    try {
      const response = await call("PUT /api/local/settings", {
        body: { scope: "app", values: { [ENABLED]: enabled } },
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
      description={t`With memory on, she remembers you from one call or chat to the next. Memories stay on this computer in your data home — no extra server or Docker container needed. It's on by default, and you can turn it off anytime.`}
      onBack={onBack}
      busy={busy}
      footer={
        action === "next" ? (
          <>
            {!fromEnv && on && (
              <Button variant="ghost" onClick={() => void saveEnabled(false)} disabled={busy}>
                {t`Turn Off`}
              </Button>
            )}
            <Button onClick={onDone} disabled={busy}>{t`Continue`}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t`Skip`}
            </Button>
            <Button onClick={() => void saveEnabled(true)} disabled={busy}>
              {busy && <Spinner />}
              {t`Turn On Memory`}
            </Button>
          </>
        )
      }
    >
      {on ? (
        <Alert>
          <CircleCheckIcon className="text-success" />
          <AlertTitle>{t`Memory is on.`}</AlertTitle>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>{t`Memory is off.`}</AlertTitle>
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
