import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { SettingsForm } from "@/components/settings-form";
import { browserTimeZone, timeZones } from "@/components/settings-form/controls";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { call, type PersonaIdentityFields, type PersonaSummary } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { LoadError, Section } from "./parts";
import { personaQueries } from "./queries";

/** The persona's own settings this tab shows; the voice, knowledge, videos and selfie ones have tabs. */
const SETTINGS_PATHS = [
  "mind.model",
  "hearing.model",
  "memory.model",
  "memory.searchLimit",
  "memory.searchThreshold",
] as const;

const FIELDS = ["name", "shortName", "fans", "summary"] as const;

function TimeZoneSelect({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (zone: string) => void;
}) {
  const zones = useMemo(() => {
    const known = timeZones();
    return value === "" || known.includes(value) ? known : [value, ...known];
  }, [value]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full sm:w-80">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
        {zones.map((zone) => (
          <SelectItem key={zone} value={zone}>
            {zone}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function IdentityForm({
  persona,
  saved,
}: {
  readonly persona: PersonaSummary;
  readonly saved: PersonaIdentityFields;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const formId = useId();
  const [draft, setDraft] = useState<PersonaIdentityFields>(saved);
  const dirty = (Object.keys(saved) as (keyof PersonaIdentityFields)[]).some(
    (key) => draft[key] !== saved[key],
  );
  const missing = draft.name.trim() === "" || draft.shortName.trim() === "";

  const save = useMutation({
    mutationFn: (fields: PersonaIdentityFields) =>
      call("PUT /api/local/personas/:id/identity", { params: { id: persona.id }, body: fields }),
    onSuccess: async (next) => {
      queryClient.setQueryData(personaQueries(persona.id).identity.queryKey, next);
      toast.success(t("studio.identity.saved"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["personas"], exact: true }),
        queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
    onError: toastError,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty && !missing) {
      save.mutate({
        name: draft.name.trim(),
        shortName: draft.shortName.trim(),
        fans: draft.fans.trim(),
        summary: draft.summary.trim(),
        timezone: draft.timezone,
      });
    }
  }

  const set = (key: keyof PersonaIdentityFields) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <FieldGroup>
        {FIELDS.map((key) => {
          const id = `${formId}-${key}`;
          const required = key === "name" || key === "shortName";
          return (
            <Field key={key} data-invalid={required && draft[key].trim() === ""}>
              <FieldLabel htmlFor={id}>{t(`studio.identity.${key}`)}</FieldLabel>
              {key === "summary" ? (
                <Textarea
                  id={id}
                  value={draft.summary}
                  onChange={(event) => set("summary")(event.target.value)}
                  rows={3}
                  lang="en"
                />
              ) : (
                <Input
                  id={id}
                  value={draft[key]}
                  onChange={(event) => set(key)(event.target.value)}
                  required={required}
                  aria-invalid={required && draft[key].trim() === ""}
                />
              )}
              <FieldDescription>{t(`studio.identity.${key}Help`)}</FieldDescription>
            </Field>
          );
        })}
        <Field>
          <FieldLabel htmlFor={`${formId}-timezone`}>{t("studio.identity.timezone")}</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <TimeZoneSelect
              id={`${formId}-timezone`}
              value={draft.timezone}
              onChange={set("timezone")}
            />
            {draft.timezone !== browserTimeZone() && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => set("timezone")(browserTimeZone())}
              >
                {t("studio.identity.useBrowserZone", { zone: browserTimeZone() })}
              </Button>
            )}
          </div>
          <FieldDescription>{t("studio.identity.timezoneHelp")}</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex gap-2">
        <Button type="submit" disabled={!dirty || missing || save.isPending}>
          {save.isPending && <Spinner />}
          {t("studio.identity.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => setDraft(saved)}
        >
          {t("studio.editor.revert")}
        </Button>
      </div>
    </form>
  );
}

export function IdentityTab({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const identity = useQuery(personaQueries(persona.id).identity);
  return (
    <div className="flex flex-col gap-6">
      <Section title={t("studio.identity.title")} description={t("studio.identity.description")}>
        {identity.isPending && <Skeleton className="h-80" />}
        {identity.isError && <LoadError error={identity.error} />}
        {identity.data && (
          // Saved fields start a fresh draft, so the form never shows what the server didn't keep.
          <IdentityForm
            key={JSON.stringify(identity.data)}
            persona={persona}
            saved={identity.data}
          />
        )}
      </Section>
      <Section
        title={t("studio.identity.settings")}
        description={t("studio.identity.settingsHelp")}
      >
        <SettingsForm scope="persona" persona={persona.id} paths={SETTINGS_PATHS} />
      </Section>
    </div>
  );
}
