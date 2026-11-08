// Profile: her avatar, who she is, and her clock.

import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CameraIcon, LocateFixedIcon } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { PersonaAvatar } from "@/components/avatar";
import { SectionCard, SectionCardSkeleton } from "@/components/section-card";
import {
  browserTimeZone,
  changes,
  controlFor,
  draftOf,
  isTimeZone,
  originOf,
  strip,
} from "@/components/settings-form/controls";
import { OriginNote, TimeZoneList } from "@/components/settings-form/field";
import { INVALID_MESSAGES } from "@/components/settings-form/labels";
import { refreshSettings, settingsQuery } from "@/components/settings-form/queries";
import { SaveActions } from "@/components/settings-form/settings-card";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  call,
  type IdentityUpdate,
  type PersonaIdentityFields,
  type PersonaSummary,
  type SettingRow,
} from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { statusQuery } from "@/lib/query";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { LoadError } from "./parts";
import { draggingFiles, uploadProblem, useFilePicker, useRemove, useUpload } from "./pictures";
import { personaQueries } from "./queries";
import { CARD_PATHS } from "./sections";

const FIELDS = ["name", "shortName", "fans", "summary"] as const;

const FIELD_LABELS = {
  name: {
    label: msg({ message: "Name", context: "persona's name" }),
    help: msg`Her full name, as the prompts say it.`,
  },
  shortName: {
    label: msg`Short Name`,
    help: msg`What she's called for short. Her initials come from it.`,
  },
  fans: {
    label: msg`Fans`,
    help: msg`What she calls her viewers.`,
  },
  summary: {
    label: msg`Summary`,
    help: msg`One English sentence about her. The retrieval gate reads it to tell when a question is about her.`,
  },
} satisfies Record<(typeof FIELDS)[number], unknown>;
type Fields = Readonly<Record<(typeof FIELDS)[number], string>>;

function fieldsOf(identity: PersonaIdentityFields): Fields {
  return {
    name: identity.name,
    shortName: identity.shortName,
    fans: identity.fans,
    summary: identity.summary,
  };
}

function RemoveAvatar({
  disabled,
  onRemove,
}: {
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const { t } = useLingui();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          {t`Remove`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Remove her avatar?`}</AlertDialogTitle>
          <AlertDialogDescription>{t`The picture is deleted from her folder, and her initials show in its place.`}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Keep It`}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onRemove}>
            {t`Remove`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AvatarCard({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  const lang = useLang();
  const references = useQuery(personaQueries(persona.id).references);
  const avatar = references.data?.avatar ?? null;
  const upload = useUpload(persona.id);
  const remove = useRemove(persona.id);
  const busy = upload.isPending || remove.isPending;
  const [over, setOver] = useState(false);
  const picker = useFilePicker((files) => send(files[0]));

  function send(file: File | undefined) {
    if (file === undefined || busy) return;
    // The server names the avatar, so only its type and size matter.
    const problem = uploadProblem(file, "avatar.png", lang);
    if (problem !== null) {
      toast.error(problem);
      return;
    }
    upload.mutate(
      { kind: "avatar", name: file.name, file },
      { onSuccess: () => toast.success(t`Avatar saved.`) },
    );
  }

  return (
    <SectionCard
      title={t`Avatar`}
      description={t`This is her avatar, on the call page and in the persona switcher. Click it to upload one from your files, or drop a picture on it.`}
      action={
        <>
          {picker.input}
          <button
            type="button"
            onClick={picker.open}
            disabled={busy}
            aria-label={avatar ? t`Replace Her Avatar` : t`Upload an Avatar`}
            onDragOver={(event) => {
              if (!draggingFiles(event)) return;
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              send(event.dataTransfer.files[0]);
            }}
            className="group relative rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-progress"
          >
            <PersonaAvatar persona={persona} size="xl" />
            <span
              className={cn(
                "absolute inset-0 flex items-center justify-center rounded-full text-transparent transition-colors group-hover:bg-black/45 group-hover:text-white group-focus-visible:bg-black/45 group-focus-visible:text-white",
                (over || busy) && "bg-black/45 text-white",
              )}
            >
              {upload.isPending ? (
                <Spinner className="size-5" />
              ) : (
                <CameraIcon aria-hidden className="size-5" />
              )}
            </span>
          </button>
        </>
      }
      note={
        avatar?.source === "template"
          ? t`Her avatar is built in. Upload one to use your own instead.`
          : t`An avatar is optional but recommended.`
      }
      actions={
        avatar?.source === "own" ? (
          <RemoveAvatar
            disabled={busy}
            onRemove={() =>
              remove.mutate(
                { kind: "avatar", name: avatar.name },
                { onSuccess: () => toast.success(t`Avatar removed.`) },
              )
            }
          />
        ) : undefined
      }
    />
  );
}

function IdentityCard({
  persona,
  identity,
}: {
  readonly persona: PersonaSummary;
  readonly identity: PersonaIdentityFields;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const formId = useId();
  const saved = fieldsOf(identity);
  const [draft, setDraft] = useState<Fields>(saved);
  const dirty = FIELDS.some((key) => draft[key] !== saved[key]);
  const missing = draft.name.trim() === "" || draft.shortName.trim() === "";

  const save = useMutation({
    mutationFn: (fields: IdentityUpdate) =>
      call("PUT /api/local/personas/:id/identity", { params: { id: persona.id }, body: fields }),
    onSuccess: async (next) => {
      queryClient.setQueryData(personaQueries(persona.id).identity.queryKey, next);
      setDraft(fieldsOf(next));
      toast.success(t`Identity saved.`);
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
    if (!dirty || missing) return;
    save.mutate({
      name: draft.name.trim(),
      shortName: draft.shortName.trim(),
      fans: draft.fans.trim(),
      summary: draft.summary.trim(),
    });
  }

  function field(key: (typeof FIELDS)[number]) {
    const id = `${formId}-${key}`;
    const required = key === "name" || key === "shortName";
    const empty = required && draft[key].trim() === "";
    const onChange = (value: string) => setDraft((current) => ({ ...current, [key]: value }));
    return (
      <Field key={key} data-invalid={empty}>
        <FieldLabel htmlFor={id}>{t(FIELD_LABELS[key].label)}</FieldLabel>
        {key === "summary" ? (
          <Textarea
            id={id}
            value={draft.summary}
            onChange={(event) => onChange(event.target.value)}
            rows={3}
            lang="en"
            disabled={save.isPending}
          />
        ) : (
          <Input
            id={id}
            value={draft[key]}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={empty}
            aria-required={required}
            autoComplete="off"
            disabled={save.isPending}
          />
        )}
        <FieldDescription>{t(FIELD_LABELS[key].help)}</FieldDescription>
      </Field>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <SectionCard
        title={t`Identity`}
        description={t`Who she is, as the built-in prompts and the call page name her. Write the names in her language.`}
        note={
          missing ? (
            <span className="text-destructive">{t`She needs a name and a short name.`}</span>
          ) : (
            t`Saved for ${ph({ name: persona.shortName || persona.name })}`
          )
        }
        actions={
          <SaveActions
            dirty={dirty}
            pending={save.isPending}
            blocked={missing}
            onDiscard={() => setDraft(saved)}
          />
        }
      >
        <div className="grid gap-6 sm:grid-cols-2">
          {field("name")}
          {field("shortName")}
          {field("fans")}
        </div>
        {field("summary")}
      </SectionCard>
    </form>
  );
}

/** What time it is for her, ticking, in a zone the browser knows. */
function ZoneClock({ zone }: { readonly zone: string }) {
  const { t } = useLingui();
  const lang = useLang();
  const now = useNow(true);
  const format = useMemo(
    () =>
      new Intl.DateTimeFormat(lang, {
        timeZone: zone,
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    [lang, zone],
  );
  return (
    <FieldDescription className="tabular-nums">
      {t`It's ${ph({ time: format.format(now) })} for her now.`}
    </FieldDescription>
  );
}

function TimeZoneForm({
  persona,
  row,
}: {
  readonly persona: PersonaSummary;
  readonly row: SettingRow;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const id = useId();
  const listId = useId();
  const name = persona.shortName || persona.name;
  const [draft, setDraft] = useState(() => draftOf(row.value, controlFor(row)));
  const [touched, setTouched] = useState(false);
  const { values, errors } = changes([row], { [row.path]: draft });
  const error = errors[row.path] ?? null;
  const shownError = touched ? error : null;
  const changed = error !== null || row.path in values;
  const origin = originOf(row, draft);
  // The zone the draft gives her: her own, else the one she inherits.
  const zone = strip(draft) || row.envValue;
  const browser = browserTimeZone();

  const save = useMutation({
    mutationFn: (value: unknown) =>
      call("PUT /api/local/settings", {
        body: { scope: "persona", persona: persona.id, values: { [row.path]: value } },
      }),
    onSuccess: async (response, value) => {
      // Her cached identity holds the zone too; keep it in step.
      queryClient.setQueryData(personaQueries(persona.id).identity.queryKey, (identity) =>
        identity === undefined
          ? identity
          : { ...identity, timezone: typeof value === "string" ? value : "" },
      );
      toast.success(
        response.restartRequired ? t`Saved. Restart Eidolon to apply it.` : t`Settings saved.`,
      );
      await refreshSettings(queryClient, persona.id, response);
    },
    onError: toastError,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (error === null && row.path in values) save.mutate(values[row.path]);
  }

  return (
    <form onSubmit={submit} noValidate>
      <SectionCard
        title={t`Time Zone`}
        description={t`Her clock: the date and time she knows during a call.`}
        note={
          touched && error !== null ? (
            <span className="text-destructive">{t`Fix the highlighted values first.`}</span>
          ) : (
            t`Saved for ${name}`
          )
        }
        actions={
          <SaveActions
            dirty={changed}
            pending={save.isPending}
            onDiscard={() => {
              setDraft(draftOf(row.value, controlFor(row)));
              setTouched(false);
            }}
          />
        }
      >
        <Field data-invalid={shownError !== null} onBlur={() => setTouched(true)}>
          {/* The card's title names the field. */}
          <FieldLabel htmlFor={id} className="sr-only">
            {t`Time Zone`}
          </FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={id}
              list={listId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={row.envValue ?? t`Default`}
              aria-invalid={shownError !== null}
              autoComplete="off"
              spellCheck={false}
              disabled={save.isPending}
              className="max-w-xs flex-1 basis-56"
            />
            <TimeZoneList id={listId} />
            {zone !== browser && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                // The field's invalid state reddens its text; this button isn't what's wrong.
                className="text-foreground"
                disabled={save.isPending}
                onClick={() => setDraft(browser)}
              >
                <LocateFixedIcon />
                {t`Use ${ph({ zone: browser })}`}
              </Button>
            )}
          </div>
          {shownError !== null ? (
            <FieldError>
              {INVALID_MESSAGES[shownError] ? t(INVALID_MESSAGES[shownError]) : shownError}
            </FieldError>
          ) : (
            zone !== null && isTimeZone(zone) && <ZoneClock zone={zone} />
          )}
          <OriginNote row={row} origin={origin} personaName={name} />
        </Field>
      </SectionCard>
    </form>
  );
}

function TimeZoneCard({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  const settings = useQuery(settingsQuery(persona.id));
  const [path] = CARD_PATHS.timezone;
  const row = settings.data?.settings.find((entry) => entry.path === path);
  if (settings.isPending) return <SectionCardSkeleton rows={1} />;
  if (settings.isError || row === undefined) {
    return (
      <SectionCard title={t`Time Zone`}>
        <LoadError error={settings.error} />
      </SectionCard>
    );
  }
  // A saved zone starts a fresh draft.
  return <TimeZoneForm key={String(row.value)} persona={persona} row={row} />;
}

export function IdentitySection({ persona }: { readonly persona: PersonaSummary }) {
  const identity = useQuery(personaQueries(persona.id).identity);
  return (
    <>
      <AvatarCard persona={persona} />
      {identity.isPending && <SectionCardSkeleton rows={4} />}
      {identity.isError && <LoadError error={identity.error} />}
      {identity.data && (
        // Fields saved elsewhere start a fresh draft; the zone, which its own card saves, doesn't.
        <IdentityCard
          key={FIELDS.map((key) => identity.data[key]).join("\u0000")}
          persona={persona}
          identity={identity.data}
        />
      )}
      <TimeZoneCard persona={persona} />
    </>
  );
}
