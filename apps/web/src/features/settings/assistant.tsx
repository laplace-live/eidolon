// Settings' Assistant Mode card: its rows, what keeps tasks from starting, a way to the Tasks list,
// and the question a save asks before turning the mode off, which stops every task not yet ended.

import { ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListTodoIcon, TriangleAlertIcon } from "lucide-react";
import { Link } from "react-router";
import type { CardPath } from "@/components/settings-form/controls";
import { type SaveQuestion, SettingsCard } from "@/components/settings-form/settings-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { stoppedByTurningOff } from "@/features/tasks/queries";
import { statusQuery } from "@/lib/query";

export function AssistantCard({
  paths,
  title,
  description,
}: {
  readonly paths: readonly CardPath[];
  readonly title: string;
  readonly description: string;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const assistant = useQuery(statusQuery).data?.assistant;

  async function confirm(values: Readonly<Record<string, unknown>>): Promise<SaveQuestion | null> {
    if (values["assistant.enabled"] !== false) return null;
    const live = await stoppedByTurningOff(queryClient);
    if (live === 0) return null;
    return {
      title: t`Turn off Assistant Mode?`,
      description:
        live === null
          ? t`Eidolon couldn't count its tasks. Turning Assistant Mode off stops any that are running or waiting for you.`
          : t`${plural(ph({ count: live }), { one: `# task is running or waiting for you. Turning Assistant Mode off stops it.`, other: `# tasks are running or waiting for you. Turning Assistant Mode off stops them.` })}`,
      cancel: t`Keep It On`,
      action: t`Turn Off`,
    };
  }

  return (
    <SettingsCard
      scope="app"
      paths={paths}
      title={title}
      description={description}
      confirm={confirm}
      // Turning the mode off stops the running tasks, which their cards then show.
      onSaved={() => void queryClient.invalidateQueries({ queryKey: ["tasks"] })}
      action={
        assistant?.enabled ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/tasks">
              <ListTodoIcon />
              {t`Open Tasks`}
            </Link>
          </Button>
        ) : undefined
      }
    >
      {assistant?.enabled && !assistant.ready && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>{t`Tasks can't start yet`}</AlertTitle>
          <AlertDescription>
            {t`Choose the account and model tasks run on here, and add a key for that account in Providers.`}
            {assistant.problem && <span className="block wrap-anywhere">{assistant.problem}</span>}
          </AlertDescription>
        </Alert>
      )}
    </SettingsCard>
  );
}
