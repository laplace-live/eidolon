// Settings' Assistant Mode cards: its rows, what keeps tasks from starting or searching, a way to the
// Tasks list, and the question a save asks before turning the mode off, which stops every task not
// yet ended; and Models by Kind, with each kind that runs on Assistant Mode's model for now.

import type { MessageDescriptor } from "@lingui/core";
import { msg, ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListTodoIcon, TriangleExclamationPointIcon } from "lucide-react";
import { Link } from "wouter";
import type { CardPath } from "@/components/settings-form/controls";
import { type SaveQuestion, SettingsCard } from "@/components/settings-form/settings-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { stoppedByTurningOff } from "@/features/tasks/queries";
import type { TaskProfile } from "@/lib/api";
import { statusQuery } from "@/lib/query";

interface CardProps {
  readonly paths: readonly CardPath[];
  readonly title: string;
  readonly description: string;
}

export function AssistantCard({ paths, title, description }: CardProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const assistant = useQuery(statusQuery).data?.assistant;
  const searchProblem = assistant?.search.problem ?? null;

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
          <TriangleExclamationPointIcon />
          <AlertTitle>{t`Tasks can't start yet`}</AlertTitle>
          <AlertDescription>
            {t`Choose the account and model tasks run on here, and add a key for that account in Providers.`}
            {assistant.problem && <span className="block wrap-anywhere">{assistant.problem}</span>}
          </AlertDescription>
        </Alert>
      )}
      {assistant?.enabled && searchProblem !== null && (
        <Alert data-search-problem>
          <TriangleExclamationPointIcon />
          <AlertDescription className="wrap-anywhere">
            {t`Web search is off: ${ph({ problem: searchProblem })}`}
          </AlertDescription>
        </Alert>
      )}
    </SettingsCard>
  );
}

/** A kind whose own account or model can't run, so its tasks take Assistant Mode's. */
const KIND_FALLBACKS: Readonly<Record<TaskProfile, MessageDescriptor>> = {
  quick: msg`Quick tasks run on Assistant Mode's model for now`,
  coding: msg`Coding tasks run on Assistant Mode's model for now`,
  research: msg`Research tasks run on Assistant Mode's model for now`,
};

export function KindsCard({ paths, title, description }: CardProps) {
  const { t } = useLingui();
  const kinds = useQuery(statusQuery).data?.assistant.kinds;
  const fallbacks = (Object.keys(KIND_FALLBACKS) as TaskProfile[]).flatMap((kind) => {
    const reason = kinds?.[kind] ?? null;
    return reason === null ? [] : [{ kind, reason }];
  });
  return (
    <SettingsCard scope="app" paths={paths} title={title} description={description}>
      {fallbacks.map(({ kind, reason }) => (
        <Alert key={kind} data-kind-fallback={kind}>
          <TriangleExclamationPointIcon />
          <AlertTitle>{t(KIND_FALLBACKS[kind])}</AlertTitle>
          <AlertDescription className="wrap-anywhere">{reason}</AlertDescription>
        </Alert>
      ))}
    </SettingsCard>
  );
}
