// A monospace editor for a persona's text files: a counter, Save and Revert, and a guard against
// leaving the page with edits unsaved.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
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
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatCount } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { textCounts } from "./files";

/** Asks whether to leave unsaved edits behind. */
export function LeaveDialog({
  open,
  onStay,
  onLeave,
}: {
  readonly open: boolean;
  readonly onStay: () => void;
  readonly onLeave: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onStay();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("studio.editor.leaveTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("studio.editor.leaveBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("studio.editor.stay")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onLeave}>
            {t("studio.editor.leave")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Asks before a navigation, or a reload, would drop unsaved edits. */
function UnsavedGuard({ dirty }: { readonly dirty: boolean }) {
  const blocker = useBlocker(dirty);
  useBeforeUnload((event) => {
    if (dirty) event.preventDefault();
  });
  return (
    <LeaveDialog
      open={blocker.state === "blocked"}
      onStay={() => blocker.reset?.()}
      onLeave={() => blocker.proceed?.()}
    />
  );
}

export interface TextEditorProps {
  /** The text as saved. */
  readonly value: string;
  /** Saves `text` and resolves to the text as the server keeps it. */
  readonly onSave: (text: string) => Promise<string>;
  readonly saving: boolean;
  /** Names the editor for screen readers. */
  readonly label: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Keeps Save off, as while a new file has no name, without locking the text. */
  readonly saveDisabled?: boolean;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** Buttons beside Save. */
  readonly actions?: ReactNode;
  /** Shown under the editor, such as a parser's errors. */
  readonly children?: ReactNode;
  readonly className?: string;
}

export function TextEditor({
  value,
  onSave,
  saving,
  label,
  placeholder,
  disabled = false,
  saveDisabled = false,
  onDirtyChange,
  actions,
  children,
  className,
}: TextEditorProps) {
  const t = useT();
  const lang = useLang();
  const id = useId();
  const [base, setBase] = useState(value);
  const [draft, setDraft] = useState(value);
  // A newer saved text replaces the draft unless the draft has edits of its own.
  if (value !== base) {
    setBase(value);
    if (draft === base) setDraft(value);
  }
  const dirty = draft !== value;
  const counts = textCounts(draft);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  async function save() {
    if (!dirty || saving || disabled || saveDisabled) return;
    try {
      const saved = await onSave(draft);
      setBase(saved);
      setDraft(saved);
    } catch {
      // The caller says why; the draft stays for another try.
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Textarea
        id={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className="field-sizing-fixed h-[60vh] min-h-64 resize-y font-mono text-sm leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("studio.editor.counts", {
            chars: formatCount(counts.chars, lang),
            lines: formatCount(counts.lines, lang),
          })}
        </span>
        {dirty && (
          <span className="text-amber-700 text-xs dark:text-amber-400">
            {t("studio.editor.unsaved")}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {actions}
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => setDraft(value)}
          >
            {t("studio.editor.revert")}
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving || disabled || saveDisabled}
            onClick={() => void save()}
          >
            {saving && <Spinner />}
            {t("studio.editor.save")}
          </Button>
        </div>
      </div>
      {children}
      <UnsavedGuard dirty={dirty} />
    </div>
  );
}
