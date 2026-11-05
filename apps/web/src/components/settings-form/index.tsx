// The form for SETTINGS rows, built from GET settings: the settings page shows each scope grouped,
// with Advanced folded, and the persona studio and the wizard mount chosen rows of it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { call, errorKey, type SettingRow, type SettingScope } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import {
  changes,
  controlFor,
  draftOf,
  REINDEX_PATHS,
  type Section,
  sections,
  visibleRows,
} from "./controls";
import { SettingField } from "./field";
import { settingsQuery } from "./queries";

export interface SettingsFormProps {
  /** settings.yaml (`app`) or the persona's persona.yaml (`persona`). */
  readonly scope: SettingScope;
  /** Whose values to show and save; the active persona when absent. */
  readonly persona?: string;
  /** Only these SETTINGS paths, in this order and unfolded; every row of the scope when absent. */
  readonly paths?: readonly string[];
  /** After a save the server accepted. */
  readonly onSaved?: () => void;
}

export function SettingsForm({ scope, persona, paths, onSaved }: SettingsFormProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery(persona));
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<Record<string, unknown> | null>(null);

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      call("PUT /api/local/settings", {
        body: {
          scope,
          persona: scope === "persona" ? (persona ?? settings.data?.persona) : undefined,
          values,
        },
      }),
    onSuccess: async (response) => {
      queryClient.setQueryData(settingsQuery(persona).queryKey, response);
      setDrafts({});
      setTouched(new Set());
      toast.success(
        t(response.restartRequired ? "settings.form.savedRestart" : "settings.form.saved"),
      );
      onSaved?.();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
      ]);
    },
  });

  if (settings.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((n) => (
          <Skeleton key={n} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  if (settings.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t(errorKey(settings.error))}</AlertTitle>
        <AlertDescription>{settings.error.message}</AlertDescription>
      </Alert>
    );
  }

  const rows = visibleRows(settings.data.settings, scope, paths);
  const { values, errors } = changes(rows, drafts);
  const invalid = Object.keys(errors).length > 0;
  const changed = invalid || Object.keys(values).length > 0;

  function draftFor(row: SettingRow): string {
    return drafts[row.path] ?? draftOf(row.value, controlFor(row));
  }

  // A draft shows its error once the field was left or a save was tried, not on every keystroke.
  function errorFor(row: SettingRow): string | null {
    return touched.has(row.path) ? (errors[row.path] ?? null) : null;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(new Set(Object.keys(drafts)));
    if (invalid || !changed) return;
    if (REINDEX_PATHS.some((path) => path in values)) setConfirming(values);
    else save.mutate(values);
  }

  function field(row: SettingRow) {
    return (
      <SettingField
        key={row.path}
        row={row}
        draft={draftFor(row)}
        error={errorFor(row)}
        onDraft={(draft) => setDrafts((current) => ({ ...current, [row.path]: draft }))}
        onBlur={() =>
          setTouched((seen) => (seen.has(row.path) ? seen : new Set(seen).add(row.path)))
        }
        disabled={save.isPending}
      />
    );
  }

  function section({ group, rows: sectionRows }: Section) {
    return (
      <FieldSet key={group}>
        <FieldLegend>{t(`settings.group.${group}`)}</FieldLegend>
        <FieldGroup>{sectionRows.map(field)}</FieldGroup>
      </FieldSet>
    );
  }

  const layout = paths ? null : sections(rows);

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("settings.form.empty")}</p>
      ) : layout === null ? (
        <FieldGroup>{rows.map(field)}</FieldGroup>
      ) : (
        <>
          {layout.basic.map(section)}
          {layout.advanced.length > 0 && (
            <Collapsible className="flex flex-col gap-6">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="group w-fit px-0 text-muted-foreground hover:bg-transparent"
                >
                  <ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90" />
                  {t("settings.form.advanced")}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-6">
                {layout.advanced.map(section)}
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}

      {save.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t(errorKey(save.error))}</AlertTitle>
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}

      {rows.length > 0 && (
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!changed || save.isPending}>
            {save.isPending && <Spinner />}
            {t("settings.form.save")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={Object.keys(drafts).length === 0 || save.isPending}
            onClick={() => {
              setDrafts({});
              setTouched(new Set());
              save.reset();
            }}
          >
            {t("settings.form.discard")}
          </Button>
          {invalid && touched.size > 0 && (
            <span className="text-destructive text-sm">{t("settings.form.fixErrors")}</span>
          )}
        </div>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.form.reindex.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.form.reindex.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.form.reindex.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming) save.mutate(confirming);
                setConfirming(null);
              }}
            >
              {t("settings.form.reindex.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
