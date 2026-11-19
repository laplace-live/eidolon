// Settings' Allowed Commands: what Always in This Folder on a task's card granted, each command in
// its folder, exactly as written, with Remove, after which it asks again.

import { useLingui } from "@lingui/react/macro";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorAlert } from "@/components/error-alert";
import { FieldSkeletons, SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CommandText } from "@/features/tasks/parts";
import { call } from "@/lib/api";
import { toastError } from "@/lib/feedback";

export const allowedCommandsQuery = queryOptions({
  queryKey: ["assistant", "commands"],
  queryFn: ({ signal }) => call("GET /api/local/assistant/commands", { signal }),
  // A task's card adds one from a chat, often in another tab.
  refetchOnWindowFocus: true,
});

export function AllowedCommandsCard() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const commands = useQuery(allowedCommandsQuery);
  const remove = useMutation({
    mutationFn: (id: string) =>
      call("DELETE /api/local/assistant/commands/:id", { params: { id } }),
    // Read again rather than installed: two Removes' answers can arrive out of order.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: allowedCommandsQuery.queryKey }),
    onError: (error) => {
      toastError(error);
      void queryClient.invalidateQueries({ queryKey: allowedCommandsQuery.queryKey });
    },
  });
  const list = commands.data?.commands ?? [];
  return (
    <SectionCard
      title={t`Allowed Commands`}
      description={t`Commands a task runs without asking, each only in its folder and only exactly as written, unless the task has fetched a page, searched the web or called an MCP server; what its own commands download doesn't count. Always in This Folder on a task's card adds one.`}
    >
      {commands.isPending ? (
        <FieldSkeletons rows={2} />
      ) : commands.isError ? (
        <ErrorAlert error={commands.error} />
      ) : list.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t`None yet.`}</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {list.map((entry) => {
            const removing = remove.isPending && remove.variables === entry.id;
            return (
              <li
                key={entry.id}
                data-allowed-command={entry.id}
                className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
                  <CommandText command={entry.command} className="max-h-32" sized />
                  <p className="wrap-anywhere font-mono text-muted-foreground text-xs">
                    {entry.folder}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={removing}
                  onClick={() => remove.mutate(entry.id)}
                >
                  {removing && <Spinner />}
                  {t`Remove`}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
