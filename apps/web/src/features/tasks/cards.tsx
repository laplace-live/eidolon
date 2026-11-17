// What a task waiting on the owner asks, with its answers: an approval to start, or for a path or a
// site, and Continue for one paused or interrupted. Its card shows the prompt whole; the waiting bar
// above the composer shows it in one line, sharing the card's draft.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon, CirclePauseIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Link } from "react-router";
import { parseDraft } from "@/components/settings-form/controls";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type {
  AssistantStatus,
  TaskApproveRequest,
  TaskPauseReason,
  TaskPending,
  TaskSnapshot,
  TaskWebMode,
} from "@/lib/api";
import { formatSpend } from "@/lib/format";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { approveBody, chosenModel, type ModelChoice } from "./choice";
import { useDraft } from "./draft";
import { pathGrant } from "./labels";
import { ASSISTANT_SETTINGS, ModelChoiceFields, WebAccessField } from "./parts";
import { useAnswering, useApproveTask, useContinueTask } from "./queries";
import { modeRefuses, offers, pauseDetail, pauseKind, waitingFor } from "./state";

/** What a waiting task waits for, in a line: the list's rows and the waiting bar say it. */
export function useWaitingText(): (task: TaskSnapshot) => string | null {
  const { t, i18n } = useLingui();
  const lang = useLang();
  return (task) => {
    const waiting = waitingFor(task);
    switch (waiting?.kind) {
      case undefined:
        return null;
      case "start":
        return t`Waiting for your OK to work in ${ph({ folder: waiting.folder })}`;
      case "path":
        return i18n._(pathGrant(waiting).line);
      case "fetch":
        return t`Waiting for your OK to fetch from ${ph({ host: waiting.host })}`;
      case "spend":
        return t`Waiting for your OK to spend more than ${ph({ spent: formatSpend(waiting.spentUsd, lang) })}`;
      case "stall":
        return t`Waiting for your OK to go on after repeating itself`;
      case "unpriced":
        return t`Waiting for your OK to go on without spend pauses`;
      case "paused":
        return t`Waiting for your OK to go on`;
      case "interrupted":
        return t`Waiting for you to continue it`;
    }
  };
}

/** Why Assistant Mode keeps an answer from going through, with the way to Settings. */
function ModeNote({
  assistant,
  compact,
}: {
  readonly assistant: AssistantStatus;
  readonly compact: boolean;
}) {
  const { t } = useLingui();
  const open = (
    <Link to={ASSISTANT_SETTINGS} className="underline underline-offset-4 hover:text-foreground">
      {t`Open Settings`}
    </Link>
  );
  return (
    <p className={cn("text-muted-foreground text-xs", compact && "basis-full")}>
      {assistant.enabled
        ? t`Assistant Mode isn't ready, so this can't go on yet.`
        : t`Assistant Mode is off, so this task can't go on. You can still stop it.`}{" "}
      {!compact && assistant.problem && <span className="wrap-anywhere">{assistant.problem} </span>}
      {open}
    </p>
  );
}

/** A path or a host, set apart from the sentence about it. */
function Asked({ children }: { readonly children: string }) {
  return (
    <p className="wrap-anywhere rounded-md border bg-card px-2.5 py-1.5 font-mono text-xs">
      {children}
    </p>
  );
}

/** The prompt's frame: a tinted part of the card, or the waiting bar's line. */
function Frame({
  compact,
  icon,
  question,
  line,
  children,
  note,
  actions,
}: {
  readonly compact: boolean;
  readonly icon: ReactNode;
  /** The card's: a question or a sentence, and what it means. */
  readonly question: string;
  /** The bar's. */
  readonly line: string;
  readonly children?: ReactNode;
  readonly note?: ReactNode;
  readonly actions: ReactNode;
}) {
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-sm">
          <span className="shrink-0 text-warning [&_svg]:size-4">{icon}</span>
          <span className="wrap-anywhere">{line}</span>
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
        {note}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t bg-warning/5 px-4 py-3 dark:bg-warning/10">
      <p className="flex items-start gap-2 font-medium text-sm">
        <span className="mt-0.5 shrink-0 text-warning [&_svg]:size-4">{icon}</span>
        <span className="min-w-0">{question}</span>
      </p>
      {children}
      {note}
      <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
    </div>
  );
}

type Answer = TaskApproveRequest["answer"];

function ApprovalPrompt({
  task,
  pending,
  compact,
  assistant,
}: {
  readonly task: TaskSnapshot;
  readonly pending: TaskPending;
  readonly compact: boolean;
  readonly assistant: AssistantStatus | undefined;
}) {
  const { t, i18n } = useLingui();
  const lang = useLang();
  const line = useWaitingText()(task) ?? "";
  const approve = useApproveTask(task.id);
  const busy = useAnswering(task.id);
  const [choice, setChoice] = useDraft<ModelChoice>(`${task.id}:start:model`, {
    account: "",
    model: "",
  });
  const [web, setWeb] = useDraft<TaskWebMode>(`${task.id}:start:web`, task.web?.mode ?? "ask");
  const start = pending.kind === "start";
  const missing = start && chosenModel(choice, task.model) === "missing";
  const blocked = assistant !== undefined && (!assistant.enabled || !assistant.ready);
  const size = compact ? "sm" : "default";

  const button = (value: Answer, label: string, variant: "default" | "outline") => (
    <Button
      variant={variant}
      size={size}
      data-answer={value}
      disabled={
        busy || modeRefuses(pending.kind, value, assistant) || (value !== "deny" && missing)
      }
      onClick={() => {
        const body = approveBody(value, task, choice, web);
        if (body !== null) approve.mutate(body);
      }}
    >
      {approve.isPending && approve.variables?.answer === value && <Spinner />}
      {label}
    </Button>
  );
  const always = pending.kind !== "path" || pathGrant(pending).always !== null;
  const actions = (
    <>
      {button("deny", t`Deny`, "outline")}
      {always &&
        button(
          "always",
          pending.kind === "fetch" ? t`Allow Any Site` : t`Always Allow This Folder`,
          "outline",
        )}
      {button("once", t`Allow Once`, "default")}
    </>
  );
  const note =
    assistant !== undefined && blocked ? (
      <ModeNote assistant={assistant} compact={compact} />
    ) : undefined;
  const icon = <CircleAlertIcon />;

  switch (pending.kind) {
    case "start":
      return (
        <Frame
          compact={compact}
          icon={icon}
          question={t`Start this task?`}
          line={line}
          note={note}
          actions={actions}
        >
          <p className="text-muted-foreground text-xs">{t`It works in this folder on its own once you allow it. Eidolon makes the folder if it doesn't exist yet.`}</p>
          <Asked>{task.brief.folder}</Asked>
          <ModelChoiceFields
            base={task.model}
            choice={choice}
            missing={missing}
            disabled={busy}
            onChange={setChoice}
          />
          <WebAccessField value={web} disabled={busy} onChange={setWeb} />
          <p className="text-muted-foreground text-xs">
            {task.spendPauseUsd > 0
              ? t`It pauses each time its spend crosses another ${ph({ step: formatSpend(task.spendPauseUsd, lang) })}.`
              : t`Its spend pauses are off.`}{" "}
            {t`Always Allow This Folder adds it to Assistant Mode's folders, where tasks start without asking.`}
          </p>
        </Frame>
      );
    case "path": {
      const grant = pathGrant(pending);
      return (
        <Frame
          compact={compact}
          icon={icon}
          question={
            pending.access === "write"
              ? t`Let it write outside its folders?`
              : t`Let it read outside its folders?`
          }
          line={line}
          note={note}
          actions={actions}
        >
          <p className="text-muted-foreground text-xs">{t`It asked for this path, which none of its folders hold.`}</p>
          <Asked>{pending.path}</Asked>
          <p className="wrap-anywhere text-xs">{i18n._(grant.allow)}</p>
          {grant.always && (
            <p className="wrap-anywhere text-muted-foreground text-xs">{i18n._(grant.always)}</p>
          )}
        </Frame>
      );
    }
    case "fetch":
      return (
        <Frame
          compact={compact}
          icon={icon}
          question={t`Let it fetch from ${ph({ host: pending.host })}?`}
          line={line}
          note={note}
          actions={actions}
        >
          <p className="text-muted-foreground text-xs">{t`It asks before it fetches from a site for the first time. Allow Once lets this task use this site until it ends; Deny tells it it can't.`}</p>
          <Asked>{pending.host}</Asked>
          <p className="text-muted-foreground text-xs">{t`Allow Any Site lets this task fetch from any site without asking again.`}</p>
        </Frame>
      );
  }
}

/** The spend pause typed into the card: a number of dollars, 0 or more; null when it isn't one. */
function amountOf(draft: string): number | null {
  const parsed = parseDraft(draft, { type: "number" });
  return parsed.ok && typeof parsed.value === "number" && parsed.value >= 0 ? parsed.value : null;
}

function PausePrompt({
  task,
  kind,
  compact,
  assistant,
}: {
  readonly task: TaskSnapshot;
  readonly kind: TaskPauseReason | "interrupted";
  readonly compact: boolean;
  readonly assistant: AssistantStatus | undefined;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const field = useId();
  const line = useWaitingText()(task) ?? "";
  const resume = useContinueTask(task.id);
  const busy = useAnswering(task.id);
  const [step, setStep] = useDraft(
    `${task.id}:spend:${task.spendPauseUsd}`,
    String(task.spendPauseUsd),
  );
  const amount = amountOf(step);
  const changed = kind === "spend" && amount !== null && amount !== task.spendPauseUsd;
  const blocked = assistant !== undefined && (!assistant.enabled || !assistant.ready);
  const detail = kind === "interrupted" ? null : pauseDetail(task);
  const spent = formatSpend(task.spentUsd, lang);
  const each = formatSpend(task.spendPauseUsd, lang);

  const sentence: Record<TaskPauseReason | "interrupted", string> = {
    spend: t`It has spent ${ph({ spent })}, and pauses each time its spend crosses another ${ph({ each })}.`,
    stall: t`The same steps came three turns running, so it paused. Continue lets it try again.`,
    unpriced: t`Eidolon can't price what this task's model spends, so its spend pause can't work. Continuing turns its spend pause off.`,
    approval: t`It paused, and waits for you to let it go on.`,
    interrupted: t`Eidolon stopped while this task ran. Continue picks it up where it stopped.`,
  };

  return (
    <Frame
      compact={compact}
      icon={<CirclePauseIcon />}
      question={sentence[kind]}
      line={line}
      note={
        assistant !== undefined && blocked ? (
          <ModeNote assistant={assistant} compact={compact} />
        ) : undefined
      }
      actions={
        <Button
          size={compact ? "sm" : "default"}
          data-answer="continue"
          disabled={busy || blocked || (kind === "spend" && amount === null)}
          onClick={() => resume.mutate(changed && amount !== null ? { spendPauseUsd: amount } : {})}
        >
          {resume.isPending && <Spinner />}
          {t`Continue`}
        </Button>
      }
    >
      {detail && <p className="break-words text-muted-foreground text-xs">{detail}</p>}
      {kind === "spend" && (
        <Field data-invalid={amount === null} className="max-w-48">
          <FieldLabel htmlFor={field}>{t`Spend Pause`}</FieldLabel>
          <Input
            id={field}
            inputMode="decimal"
            autoComplete="off"
            value={step}
            aria-invalid={amount === null}
            onChange={(event) => setStep(event.target.value)}
            disabled={busy}
          />
          <FieldDescription>{t`In US dollars. 0 turns this task's spend pauses off.`}</FieldDescription>
          {amount === null && <FieldError>{t`Enter an amount of 0 or more.`}</FieldError>}
        </Field>
      )}
    </Frame>
  );
}

/** What `task` asks the owner, with its answers; nothing while it asks nothing. */
export function TaskPrompt({
  task,
  compact = false,
}: {
  readonly task: TaskSnapshot;
  readonly compact?: boolean;
}) {
  const assistant = useQuery(statusQuery).data?.assistant;
  const { pending } = task;
  if (offers(task).approve && pending !== undefined) {
    return <ApprovalPrompt task={task} pending={pending} compact={compact} assistant={assistant} />;
  }
  const kind = pauseKind(task);
  if (kind === null) return null;
  return <PausePrompt task={task} kind={kind} compact={compact} assistant={assistant} />;
}
