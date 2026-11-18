// /stop's dialog: the chat's live tasks, newest first, each with the card's Stop.

import { useLingui } from "@lingui/react/macro";
import { SquareIcon } from "lucide-react";
import { useId } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { TaskSnapshot } from "@/lib/api";
import { StatusBadge } from "./parts";
import { useAnswering, useChatTask, useStopTask } from "./queries";
import { ended } from "./state";

function StopRow({
  chatId,
  read,
  onStopped,
}: {
  readonly chatId: string;
  /** The task as /stop read it; the chat's polled list keeps it current. */
  readonly read: TaskSnapshot;
  readonly onStopped: () => void;
}) {
  const { t } = useLingui();
  const goalId = useId();
  const task = useChatTask(chatId, read.id) ?? read;
  const stop = useStopTask(task.id);
  const busy = useAnswering(task.id);
  return (
    <li className="flex items-start gap-3 rounded-lg border bg-card p-3" data-stop={task.id}>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <p id={goalId} className="line-clamp-2 whitespace-pre-line break-words font-medium text-sm">
          {task.brief.goal}
        </p>
        <StatusBadge status={task.status} />
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="shrink-0"
        aria-describedby={goalId}
        disabled={busy || ended(task.status)}
        onClick={() => stop.mutate(undefined, { onSuccess: onStopped })}
      >
        {stop.isPending ? <Spinner /> : <SquareIcon />}
        {t`Stop`}
      </Button>
    </li>
  );
}

export function StopPicker({
  chatId,
  open,
  tasks,
  onOpenChange,
}: {
  readonly chatId: string;
  readonly open: boolean;
  /** The live tasks /stop read, newest first; kept while the dialog closes. */
  readonly tasks: readonly TaskSnapshot[];
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {tasks.length === 1 ? t`Stop this task?` : t`Stop which task?`}
          </AlertDialogTitle>
          <AlertDialogDescription>{t`It stops at once and can't go on afterwards. The files it already wrote stay.`}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {tasks.map((task) => (
            <StopRow
              key={task.id}
              chatId={chatId}
              read={task}
              onStopped={() => onOpenChange(false)}
            />
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
