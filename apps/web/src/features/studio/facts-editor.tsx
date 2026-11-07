// One fact file open in a sheet, or a new one being named. Both live in the persona's sources in
// the data home; none ships with a template. The sheet is modal: while it is open, the page's other
// Save buttons leave the accessibility tree, so a role query finds only the sheet's.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2Icon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { SectionCardFooter } from "@/components/section-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { call } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { FACT_EXTENSIONS, factFileName, nameProblem } from "./files";
import { LoadError } from "./parts";
import { factQuery, personaQueries } from "./queries";
import { type EditorParts, TextEditor } from "./text-editor";

/** What the editor has open: a file by name, or a new one. */
export type FactTarget =
  | { readonly kind: "file"; readonly name: string }
  | { readonly kind: "new" };

function useSaveFact(persona: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, text }: { name: string; text: string }) =>
      call("PUT /api/local/personas/:id/facts/:file", {
        params: { id: persona, file: name },
        body: { text },
      }),
    onSuccess: async (_file, { name, text }) => {
      queryClient.setQueryData(factQuery(persona, name).queryKey, { text });
      await queryClient.invalidateQueries({
        queryKey: personaQueries(persona).facts.queryKey,
        exact: true,
      });
    },
    onError: toastError,
  });
}

/** The sheet's body, which scrolls, over a card's footer: status left, buttons right. */
function SheetLayout({
  parts,
  children,
}: {
  readonly parts: EditorParts;
  readonly children?: ReactNode;
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
        {children}
        <div className="flex min-h-64 flex-1 flex-col">{parts.area}</div>
      </div>
      <SectionCardFooter note={parts.status} actions={parts.buttons} />
    </>
  );
}

function DeleteFact({
  persona,
  name,
  onDeleted,
}: {
  readonly persona: string;
  readonly name: string;
  readonly onDeleted: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      call("DELETE /api/local/personas/:id/facts/:file", { params: { id: persona, file: name } }),
    onSuccess: async () => {
      toast.success(t("studio.facts.deleted", { name }));
      onDeleted();
      queryClient.removeQueries({ queryKey: factQuery(persona, name).queryKey });
      await queryClient.invalidateQueries({
        queryKey: personaQueries(persona).facts.queryKey,
        exact: true,
      });
    },
    onError: toastError,
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={remove.isPending}
        >
          <Trash2Icon />
          {t("studio.facts.delete")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("studio.facts.deleteTitle", { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("studio.facts.deleteBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("studio.facts.keep")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
            {t("studio.facts.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ExistingFact({
  persona,
  name,
  onDeleted,
  onDirtyChange,
}: {
  readonly persona: string;
  readonly name: string;
  readonly onDeleted: (name: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const file = useQuery(factQuery(persona, name));
  const save = useSaveFact(persona);
  if (file.isPending) {
    return (
      <div className="flex flex-1 p-6">
        <Skeleton className="flex-1" />
      </div>
    );
  }
  if (file.isError) {
    return (
      <div className="p-6">
        <LoadError error={file.error} />
      </div>
    );
  }
  return (
    <TextEditor
      value={file.data.text}
      label={name}
      placeholder={t("studio.facts.placeholder")}
      saving={save.isPending}
      onDirtyChange={onDirtyChange}
      onSave={async (text) => {
        await save.mutateAsync({ name, text });
        toast.success(t("studio.facts.saved", { name }));
        return text;
      }}
      actions={<DeleteFact persona={persona} name={name} onDeleted={() => onDeleted(name)} />}
      fill
    >
      {(parts) => <SheetLayout parts={parts} />}
    </TextEditor>
  );
}

function NewFact({
  persona,
  existing,
  onCreated,
  onDirtyChange,
}: {
  readonly persona: string;
  readonly existing: readonly string[];
  readonly onCreated: (name: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const id = useId();
  const [typed, setTyped] = useState("");
  const save = useSaveFact(persona);
  const name = factFileName(typed);
  const problem =
    typed.trim() === ""
      ? null
      : existing.includes(name)
        ? t("studio.facts.exists", { name })
        : nameProblem(name, FACT_EXTENSIONS) === null
          ? null
          : t("studio.facts.badName");

  return (
    <TextEditor
      value=""
      label={t("studio.facts.contents")}
      placeholder={t("studio.facts.placeholder")}
      saving={save.isPending}
      saveDisabled={typed.trim() === "" || problem !== null}
      onDirtyChange={onDirtyChange}
      onSave={async (text) => {
        await save.mutateAsync({ name, text });
        toast.success(t("studio.facts.saved", { name }));
        onCreated(name);
        return text;
      }}
      fill
    >
      {(parts) => (
        <SheetLayout parts={parts}>
          <Field data-invalid={problem !== null}>
            <FieldLabel htmlFor={id}>{t("studio.facts.newName")}</FieldLabel>
            <Input
              id={id}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={t("studio.facts.newNamePlaceholder")}
              aria-invalid={problem !== null}
              autoComplete="off"
              className="max-w-md"
              autoFocus
            />
            {problem ? (
              <FieldError>{problem}</FieldError>
            ) : (
              <FieldDescription>
                {typed.trim() === "" ? t("studio.facts.newNameHelp") : name}
              </FieldDescription>
            )}
          </Field>
        </SheetLayout>
      )}
    </TextEditor>
  );
}

export function FactSheet({
  persona,
  target,
  existing,
  onClose,
  onCreated,
  onDeleted,
  onDirtyChange,
}: {
  readonly persona: string;
  /** The file open, or null while the sheet is closed. */
  readonly target: FactTarget | null;
  readonly existing: readonly string[];
  /** Asks to close: the caller confirms first if there are unsaved edits. */
  readonly onClose: () => void;
  readonly onCreated: (name: string) => void;
  /** The open file is gone, unsaved edits and all. */
  readonly onDeleted: (name: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  // The sheet keeps its last file through the closing slide.
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) setShown(target);
  return (
    <Sheet open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        showCloseButton={false}
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="relative gap-1.5 border-b p-6 pr-14">
          <SheetTitle className="break-all font-semibold text-xl tracking-tight">
            {shown?.kind === "file" ? shown.name : t("studio.facts.newTitle")}
          </SheetTitle>
          <SheetDescription>{t("studio.facts.sheetHelp")}</SheetDescription>
          <SheetClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-5 right-5"
              aria-label={t("common.close")}
            >
              <XIcon />
            </Button>
          </SheetClose>
        </SheetHeader>
        {shown?.kind === "new" && (
          <NewFact
            persona={persona}
            existing={existing}
            onDirtyChange={onDirtyChange}
            onCreated={onCreated}
          />
        )}
        {shown?.kind === "file" && (
          <ExistingFact
            key={shown.name}
            persona={persona}
            name={shown.name}
            onDeleted={onDeleted}
            onDirtyChange={onDirtyChange}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
