import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { EllipsisIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDeleteChat, useRenameChat } from "./queries";

/** The server's limit, in code points; an input's maxLength counts UTF-16 units, which is stricter. */
const TITLE_MAX = 80;

/** The dialog's body, which mounts each time it opens and so starts from the current name. */
function RenameForm({
  name,
  pending,
  onRename,
  onCancel,
}: {
  readonly name: string;
  readonly pending: boolean;
  readonly onRename: (title: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [title, setTitle] = useState(name);
  const trimmed = title.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed !== "" && !pending) onRename(trimmed);
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t`Rename Chat`}</DialogTitle>
        <DialogDescription>{t`The title shows in the chat list.`}</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={fieldId}>{t`Title`}</FieldLabel>
        <Input
          id={fieldId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={TITLE_MAX}
          autoComplete="off"
          autoFocus
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          {t`Cancel`}
        </Button>
        <Button type="submit" disabled={trimmed === "" || pending}>
          {pending && <Spinner />}
          {t`Save`}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RenameDialog({
  id,
  name,
  open,
  onOpenChange,
}: {
  readonly id: string;
  readonly name: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const rename = useRenameChat(() => onOpenChange(false));
  return (
    <Dialog open={open} onOpenChange={(next) => !rename.isPending && onOpenChange(next)}>
      <DialogContent>
        <RenameForm
          name={name}
          pending={rename.isPending}
          onRename={(title) => rename.mutate({ id, title })}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  id,
  name,
  open,
  onOpenChange,
  onDeleted,
}: {
  readonly id: string;
  readonly name: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDeleted: (id: string) => void;
}) {
  const { t } = useLingui();
  const remove = useDeleteChat((deleted) => {
    onOpenChange(false);
    onDeleted(deleted);
  });
  return (
    <AlertDialog open={open} onOpenChange={(next) => !remove.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Delete ${ph({ name })}?`}</AlertDialogTitle>
          <AlertDialogDescription>{t`Its messages and photos are deleted from this computer. What she remembers about you stays.`}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>{t`Cancel`}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={(event) => {
              // Stays open until the chat is gone, so a failure is seen where it was asked for.
              event.preventDefault();
              remove.mutate(id);
            }}
          >
            {remove.isPending && <Spinner />}
            {t`Delete`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A chat's Rename and Delete, behind a button. */
export function ChatMenu({
  id,
  name,
  onDeleted,
  className,
}: {
  readonly id: string;
  /** The chat's title, or what stands in for one. */
  readonly name: string;
  readonly onDeleted: (id: string) => void;
  readonly className?: string;
}) {
  const { t } = useLingui();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  // A dialog opens once the menu has closed: open together, the two focus traps fight.
  const opening = useRef<"rename" | "delete" | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className={className} aria-label={t`Chat Options`}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (opening.current === null) return;
            event.preventDefault();
            setDialog(opening.current);
            opening.current = null;
          }}
        >
          <DropdownMenuItem onSelect={() => (opening.current = "rename")}>
            <PencilIcon />
            {t`Rename`}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => (opening.current = "delete")}>
            <Trash2Icon />
            {t`Delete`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog
        id={id}
        name={name}
        open={dialog === "rename"}
        onOpenChange={(open) => setDialog(open ? "rename" : null)}
      />
      <DeleteDialog
        id={id}
        name={name}
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        onDeleted={onDeleted}
      />
    </>
  );
}
