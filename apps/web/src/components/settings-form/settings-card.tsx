// A card of SETTINGS rows with a Save of its own: the fields in the body, and in the footer where
// they are saved, Discard and Save. It drafts and sends only its own rows, so cards on one page save
// apart.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { FieldSkeletons, SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { call, type SettingRow, type SettingScope } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  type CardPath,
  cardSections,
  changes,
  controlFor,
  draftOf,
  REINDEX_PATHS,
} from "./controls";
import { SettingField } from "./field";
import { personasQuery, refreshSettings, settingsQuery } from "./queries";
import { ReindexDialog } from "./reindex-dialog";

export interface SettingsCardProps {
  /** settings.yaml (`app`) or the persona's persona.yaml (`persona`). */
  readonly scope: SettingScope;
  /** Whose values to show and save; the active persona when absent. */
  readonly persona?: string;
  /**
   * These rows, in this order; an entry that is an array puts its rows side by side, as Qdrant's
   * host and port. Every row of the scope when absent, under a legend per group.
   */
  readonly paths?: readonly CardPath[];
  /** Rows left out, as an Advanced card leaves out what the other cards show. */
  readonly exclude?: readonly string[];
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** At the right of the title. */
  readonly action?: ReactNode;
  /** Under the fields, such as an alert about their values. */
  readonly children?: ReactNode;
  /** After a save the server accepted, with the values it saved. */
  readonly onSaved?: (values: Readonly<Record<string, unknown>>) => void;
}

export function SettingsCard({
  scope,
  persona,
  paths,
  exclude,
  title,
  description,
  action,
  children,
  onSaved,
}: SettingsCardProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery(persona));
  // Only a persona's rows name her.
  const personas = useQuery({ ...personasQuery, enabled: scope === "persona" });
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<Record<string, unknown> | null>(null);

  const owner = persona ?? settings.data?.persona;
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      call("PUT /api/local/settings", {
        body: { scope, persona: scope === "persona" ? owner : undefined, values },
      }),
    onSuccess: async (response, values) => {
      setDrafts({});
      setTouched(new Set());
      toast.success(
        t(response.restartRequired ? "settings.form.savedRestart" : "settings.form.saved"),
      );
      onSaved?.(values);
      await refreshSettings(queryClient, persona, response);
    },
  });

  const her = personas.data?.personas.find((entry) => entry.id === owner);
  const name = her ? her.shortName || her.name : (owner ?? "");
  const savedWhere =
    scope === "persona" ? t("settings.form.savedFor", { name }) : t("settings.form.savedForAll");
  const card = { title, description, action };

  if (settings.isPending) {
    return (
      <SectionCard {...card} note={savedWhere}>
        <div className="flex flex-col gap-6" role="status" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <FieldSkeletons rows={Math.min(paths?.length ?? 3, 4)} />
        </div>
      </SectionCard>
    );
  }
  if (settings.isError) {
    return (
      <SectionCard {...card}>
        <ErrorAlert error={settings.error} />
      </SectionCard>
    );
  }

  const sections = cardSections(settings.data.settings, scope, paths, exclude);
  const rows = sections.flatMap((section) => section.lines.flat());
  const { values, errors } = changes(rows, drafts);
  const invalid = Object.keys(errors).length > 0;
  const changed = invalid || Object.keys(values).length > 0;
  // A draft shows its error once the field was left or a save was tried, not on every keystroke.
  const shownErrors = Object.keys(errors).filter((path) => touched.has(path));

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(new Set(Object.keys(drafts)));
    if (invalid || !changed) return;
    if (REINDEX_PATHS.some((path) => path in values)) setConfirming(values);
    else save.mutate(values);
  }

  function discard() {
    setDrafts({});
    setTouched(new Set());
    save.reset();
  }

  function field(row: SettingRow, fill: boolean) {
    return (
      <SettingField
        key={row.path}
        row={row}
        draft={drafts[row.path] ?? draftOf(row.value, controlFor(row))}
        error={touched.has(row.path) ? (errors[row.path] ?? null) : null}
        onDraft={(draft) => setDrafts((current) => ({ ...current, [row.path]: draft }))}
        onBlur={() =>
          setTouched((seen) => (seen.has(row.path) ? seen : new Set(seen).add(row.path)))
        }
        disabled={save.isPending}
        personaName={name}
        fill={fill}
      />
    );
  }

  function line(entries: readonly SettingRow[]) {
    const [only] = entries;
    if (entries.length === 1 && only) return field(only, false);
    return (
      <div key={entries.map((row) => row.path).join()} className="grid gap-6 sm:grid-cols-2">
        {entries.map((row) => field(row, true))}
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <SectionCard
        {...card}
        note={
          shownErrors.length > 0 ? (
            <span className="text-destructive">{t("settings.form.fixErrors")}</span>
          ) : (
            savedWhere
          )
        }
        actions={
          rows.length > 0 ? (
            <SaveActions dirty={changed} pending={save.isPending} onDiscard={discard} />
          ) : undefined
        }
      >
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("settings.form.empty")}</p>
        ) : (
          sections.map((section, index) =>
            section.group === null ? (
              <div key="rows" className="flex flex-col gap-6">
                {section.lines.map(line)}
              </div>
            ) : (
              // A fieldset draws its legend over its own top border, so the divider is outside it.
              <div key={section.group} className={cn(index > 0 && "border-t pt-6")}>
                <FieldSet className="gap-6">
                  <FieldLegend className="mb-4">{t(`settings.group.${section.group}`)}</FieldLegend>
                  {section.lines.map(line)}
                </FieldSet>
              </div>
            ),
          )
        )}
        {children}
        {save.isError && <ErrorAlert error={save.error} />}
      </SectionCard>
      <ReindexDialog
        open={confirming !== null}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) save.mutate(confirming);
          setConfirming(null);
        }}
      />
    </form>
  );
}

/**
 * A form card's footer actions: Discard while there are changes, then Save, which submits the form
 * around the card. Save's name is `settings.form.save` unless `label` names it.
 */
export function SaveActions({
  dirty,
  pending,
  blocked = false,
  label,
  onDiscard,
}: {
  readonly dirty: boolean;
  readonly pending: boolean;
  /** Save stays off even with changes, such as while a required field is empty. */
  readonly blocked?: boolean;
  readonly label?: string;
  readonly onDiscard: () => void;
}) {
  const t = useT();
  return (
    <>
      {dirty && (
        <Button type="button" variant="ghost" disabled={pending} onClick={onDiscard}>
          {t("settings.form.discard")}
        </Button>
      )}
      <Button type="submit" disabled={!dirty || blocked || pending}>
        {pending && <Spinner />}
        {label ?? t("settings.form.save")}
      </Button>
    </>
  );
}
