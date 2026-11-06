// One fact file open for editing, or a new one being named. Both live in the persona's sources in
// the data home; none ships with a template.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2Icon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
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
import { Skeleton } from "@/components/ui/skeleton";
import { toastError } from "@/features/jobs/feedback";
import { call } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { FACT_EXTENSIONS, factFileName, nameProblem } from "./files";
import { LoadError } from "./parts";
import { factQuery, personaQueries } from "./queries";
import { TextEditor } from "./text-editor";

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
        <Button variant="ghost" size="sm" disabled={remove.isPending}>
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
  if (file.isPending) return <Skeleton className="h-[60vh]" />;
  if (file.isError) return <LoadError error={file.error} />;
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
    />
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
    <div className="flex flex-col gap-4">
      <Field data-invalid={problem !== null}>
        <FieldLabel htmlFor={id}>{t("studio.facts.newName")}</FieldLabel>
        <Input
          id={id}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={t("studio.facts.newNamePlaceholder")}
          className="sm:w-80"
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
      <TextEditor
        value=""
        label={t("studio.facts.newName")}
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
      />
    </div>
  );
}

export function FactEditor({
  persona,
  target,
  existing,
  onSelect,
  onClose,
  onDeleted,
  onDirtyChange,
}: {
  readonly persona: string;
  readonly target: FactTarget;
  readonly existing: readonly string[];
  readonly onSelect: (target: FactTarget) => void;
  readonly onClose: () => void;
  /** The open file is gone, unsaved edits and all. */
  readonly onDeleted: (name: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-medium">
          {target.kind === "new" ? t("studio.facts.newTitle") : target.name}
        </h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("studio.facts.close")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {target.kind === "new" ? (
        <NewFact
          persona={persona}
          existing={existing}
          onDirtyChange={onDirtyChange}
          onCreated={(name) => onSelect({ kind: "file", name })}
        />
      ) : (
        <ExistingFact
          key={target.name}
          persona={persona}
          name={target.name}
          onDeleted={onDeleted}
          onDirtyChange={onDirtyChange}
        />
      )}
    </div>
  );
}
