// Above the composer while a task of the open chat waits on the owner: its question and its card's
// answers, so nobody has to scroll back to the card.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import type { TaskSnapshot } from "@/lib/api";
import { TaskPrompt } from "./cards";

export function WaitingBar({
  task,
  others,
  onShow,
}: {
  readonly task: TaskSnapshot;
  /** More of the chat's tasks waiting, asked about once this one is answered. */
  readonly others: number;
  /** Scrolls the log to the task's card. */
  readonly onShow: () => void;
}) {
  const { t } = useLingui();
  return (
    <section
      aria-label={t`Waiting for You`}
      data-waiting={task.id}
      className="flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 dark:bg-warning/10"
    >
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="min-w-0 flex-1 truncate">{task.brief.goal}</span>
        {others > 0 && <span className="shrink-0">{t`${ph({ count: others })} more waiting`}</span>}
        <Button variant="link" size="xs" className="h-auto shrink-0 p-0" onClick={onShow}>
          {t`Show Task`}
        </Button>
      </div>
      <TaskPrompt task={task} compact />
    </section>
  );
}
