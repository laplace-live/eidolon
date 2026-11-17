// Pieces the task card, the waiting bar and the Tasks list share: a task's status, model, spend,
// her lines it waits to read, its plan and files, and the fields a start's approval changes its
// model and web access with.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useId } from "react";
import { ModelPicker } from "@/components/settings-form/model-picker";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { accountsQuery } from "@/lib/accounts";
import type { TaskModel, TaskSnapshot, TaskStatus, TaskTodoItem, TaskWebMode } from "@/lib/api";
import { formatSpend } from "@/lib/format";
import { providerById, providerName, providerOfAccount, roleById } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { type ModelChoice, WEB_MODES } from "./choice";
import { STATUS_LABELS, TODO_STATUS_LABELS, WEB_MODE_HELP, WEB_MODE_LABELS } from "./labels";
import { nextPauseAt, pathIn, queuedLines } from "./state";

/** Where Settings sets Assistant Mode up. */
export const ASSISTANT_SETTINGS = "/settings?tab=assistant";

const STATUS_ICONS = {
  "awaiting-approval": CircleAlertIcon,
  running: LoaderCircleIcon,
  paused: CirclePauseIcon,
  interrupted: CirclePauseIcon,
  succeeded: CircleCheckIcon,
  failed: CircleXIcon,
  cancelled: CircleSlashIcon,
} as const satisfies Record<TaskStatus, unknown>;

/** Green for done, red for failed, amber for what waits on the owner, gray otherwise. */
const STATUS_CLASS: Record<TaskStatus, string> = {
  "awaiting-approval": "border-transparent bg-warning/10 text-warning",
  running: "bg-card",
  paused: "border-transparent bg-warning/10 text-warning",
  interrupted: "border-transparent bg-warning/10 text-warning",
  succeeded: "border-transparent bg-success/10 text-success",
  failed: "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20",
  cancelled: "border-transparent bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { readonly status: TaskStatus }) {
  const { t } = useLingui();
  const Icon = STATUS_ICONS[status];
  return (
    <Badge variant="outline" data-status={status} className={STATUS_CLASS[status]}>
      <Icon className={cn(status === "running" && "animate-spin text-muted-foreground")} />
      {t(STATUS_LABELS[status])}
    </Badge>
  );
}

/** An account's name as Settings lists it, else its provider's. */
export function useAccountName(): (account: string) => string {
  const accounts = useQuery(accountsQuery).data?.accounts;
  return (account) =>
    accounts?.find((entry) => entry.id === account)?.name ?? providerName(account);
}

/** "anthropic/claude-sonnet-5.5 · OpenRouter". */
export function ModelText({
  model,
  className,
}: {
  readonly model: TaskModel;
  readonly className?: string;
}) {
  const accountName = useAccountName();
  return (
    <span className={cn("min-w-0 break-words", className)}>
      <span className="font-mono">{model.model}</span>
      <span className="text-muted-foreground"> · {accountName(model.account)}</span>
    </span>
  );
}

/** What it spent, and the spend it pauses at next. */
export function SpendText({
  task,
}: {
  readonly task: Pick<TaskSnapshot, "spentUsd" | "spendPauseUsd">;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const next = nextPauseAt(task.spentUsd, task.spendPauseUsd);
  return (
    <span className="tabular-nums">
      {formatSpend(task.spentUsd, lang)}
      <span className="text-muted-foreground">
        {" · "}
        {next === null
          ? t`no spend pause`
          : t`pauses at ${ph({ amount: formatSpend(next, lang) })}`}
      </span>
    </span>
  );
}

const TODO_ICONS = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  done: CircleCheckIcon,
} as const satisfies Record<TaskTodoItem["status"], unknown>;

/** Each item with a key of its own: its text, and how often that text came before. */
export function keyed<T>(items: readonly T[], text: (item: T) => string) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const said = text(item);
    const before = seen.get(said) ?? 0;
    seen.set(said, before + 1);
    return { item, key: `${before}:${said}` };
  });
}

/** Her lines it waits to read, shown wherever an answer lets it read them: text, never markup. */
export function QueuedLines({ task }: { readonly task: TaskSnapshot }) {
  const { t } = useLingui();
  const lines = queuedLines(task);
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-queued>
      <p className="text-muted-foreground text-xs">
        {t`She passed these on, and it reads them first when it goes on:`}
      </p>
      {keyed(lines, (line) => line).map(({ item, key }) => (
        <blockquote key={key} className="whitespace-pre-wrap break-words border-l-2 pl-3">
          {item}
        </blockquote>
      ))}
    </div>
  );
}

/** The plan the worker keeps with its todo tool. */
export function TodoList({ items }: { readonly items: readonly TaskTodoItem[] }) {
  const { t } = useLingui();
  return (
    <ol className="flex flex-col gap-1.5">
      {keyed(items, (item) => item.text).map(({ item, key }) => {
        const Icon = TODO_ICONS[item.status];
        return (
          <li key={key} className="flex gap-2 text-sm">
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                item.status === "done" ? "text-success" : "text-muted-foreground",
                item.status === "in_progress" && "text-foreground",
              )}
            />
            <span className="sr-only">{t(TODO_STATUS_LABELS[item.status])}: </span>
            <span
              className={cn(
                "min-w-0 break-words",
                item.status === "done" && "text-muted-foreground line-through",
              )}
            >
              {item.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The files it wrote, each from its folder when it lies there. */
export function FileList({
  folder,
  files,
}: {
  readonly folder: string;
  readonly files: readonly string[];
}) {
  return (
    <ul className="flex flex-col gap-1">
      {files.map((path) => (
        <li key={path} className="wrap-anywhere font-mono text-xs" title={path}>
          {pathIn(folder, path)}
        </li>
      ))}
    </ul>
  );
}

/**
 * The account and model a start's approval runs it on: the role picker Settings uses, its models
 * listed live where the provider lists any.
 */
export function ModelChoiceFields({
  base,
  choice,
  missing,
  disabled,
  onChange,
}: {
  /** The task's own. */
  readonly base: TaskModel;
  readonly choice: ModelChoice;
  /** The account picked has no model yet. */
  readonly missing: boolean;
  readonly disabled: boolean;
  readonly onChange: (choice: ModelChoice) => void;
}) {
  const { t } = useLingui();
  const ids = { account: useId(), model: useId() };
  const accounts = useQuery(accountsQuery).data?.accounts;
  const accountName = useAccountName();
  const role = roleById("assistant");
  const account = choice.account || base.account;
  const options = (accounts ?? []).filter(
    (entry) => providerById(entry.provider)?.offers[role.category] !== undefined,
  );
  // A task's own account stays choosable after it is removed.
  const listed = options.some((entry) => entry.id === base.account)
    ? options
    : [...options, { id: base.account, name: accountName(base.account) }];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={ids.account}>{t`Account`}</FieldLabel>
        <Select
          value={account}
          onValueChange={(next) => onChange({ account: next, model: "" })}
          disabled={disabled}
        >
          <SelectTrigger id={ids.account} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {listed.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field data-invalid={missing}>
        <FieldLabel htmlFor={ids.model}>{t`Model`}</FieldLabel>
        <ModelPicker
          id={ids.model}
          account={account}
          provider={providerOfAccount(account, accounts)}
          category={role.category}
          draft={choice.model}
          fallback={account === base.account ? base.model : null}
          invalid={missing}
          locked={disabled}
          onDraft={(model) => onChange({ ...choice, model })}
        />
        {missing && <FieldError>{t`Pick a model for this account.`}</FieldError>}
      </Field>
    </div>
  );
}

/** Which sites a task may fetch from, with what the choice means. */
export function WebAccessField({
  value,
  disabled,
  onChange,
}: {
  readonly value: TaskWebMode;
  readonly disabled: boolean;
  readonly onChange: (mode: TaskWebMode) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  return (
    <Field>
      <FieldLabel id={`${id}-label`}>{t`Web Access`}</FieldLabel>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={value}
        // Clicking the chosen item again deselects it in Radix; keep the choice instead.
        onValueChange={(next) => {
          const mode = WEB_MODES.find((candidate) => candidate === next);
          if (mode) onChange(mode);
        }}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        className="flex-wrap"
      >
        {WEB_MODES.map((mode) => (
          <ToggleGroupItem key={mode} value={mode} className="h-8 px-3">
            {t(WEB_MODE_LABELS[mode])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldDescription>{t(WEB_MODE_HELP[value])}</FieldDescription>
    </Field>
  );
}
