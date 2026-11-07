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
import { jobsQuery } from "@/features/jobs/queries";
import type { JobSnapshot } from "@/lib/api";
import { useT } from "@/lib/i18n";
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
  /** A locale key. */
  readonly label: string;
  readonly variant?: "default" | "outline";
  readonly size?: "sm" | "default";
}) {
  const t = useT();
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
        {t(restarting ? "settings.restart.waiting" : label)}
      </Button>
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.restart.confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                asking?.jobs ? "settings.restart.confirm.body" : "settings.restart.confirm.unknown",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {asking?.jobs && (
            <ul className="flex flex-col gap-1 text-sm">
              {asking.jobs.map((job) => (
                <li key={job.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{t(`jobs.command.${job.command}`)}</span>
                  <span className="font-mono text-muted-foreground text-xs leading-5">
                    {job.persona}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {ephemeral && (
            <p className="text-muted-foreground text-xs">
              {t("settings.restart.confirm.ephemeral")}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.restart.confirm.keep")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void restart()}>
              {t("settings.restart.confirm.restart")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
