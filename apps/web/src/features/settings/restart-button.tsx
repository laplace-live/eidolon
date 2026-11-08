import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { COMMAND_LABELS } from "@/features/jobs/labels";
import { jobsQuery } from "@/features/jobs/queries";
import type { JobSnapshot } from "@/lib/api";
import { runningJobs } from "@/lib/jobs";
import { useRestart } from "./restart";

/** What the confirmation names: the running jobs, or null when the list couldn't be read. */
interface Asking {
  readonly jobs: readonly JobSnapshot[] | null;
}

/** POST restart, which interrupts every running job: while any runs, it asks first. */
export function RestartButton({
  label,
  variant = "default",
  size = "sm",
}: {
  readonly label: string;
  readonly variant?: "default" | "outline";
  readonly size?: "sm" | "default";
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const { restart, restarting } = useRestart();
  const [checking, setChecking] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);

  async function begin() {
    setChecking(true);
    const jobs = await queryClient
      .fetchQuery({ ...jobsQuery, staleTime: 0 })
      .then(runningJobs, () => null);
    setChecking(false);
    if (jobs?.length === 0) void restart();
    else setAsking({ jobs });
  }

  const ephemeral = asking?.jobs?.some((job) => job.ephemeral) ?? false;
  return (
    <>
      <Button
        size={size}
        variant={variant}
        disabled={restarting || checking}
        onClick={() => void begin()}
      >
        {(restarting || checking) && <Spinner />}
        {restarting ? t`Restarting…` : label}
      </Button>
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Restart and interrupt running jobs?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {asking?.jobs
                ? t`Restarting interrupts these jobs. What they finished is kept, and you can resume each from its page once Eidolon is back.`
                : t`Eidolon couldn't list its jobs. A restart interrupts any that still run; you can resume each from its page once Eidolon is back.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {asking?.jobs && (
            <ul className="flex flex-col gap-1 text-sm">
              {asking.jobs.map((job) => (
                <li key={job.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{t(COMMAND_LABELS[job.command])}</span>
                  <span className="font-mono text-muted-foreground text-xs leading-5">
                    {job.persona}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {ephemeral && (
            <p className="text-muted-foreground text-xs">
              {t`Link checks and plans don't resume: run them again afterwards.`}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Keep Them Running`}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void restart()}>
              {t`Restart`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
