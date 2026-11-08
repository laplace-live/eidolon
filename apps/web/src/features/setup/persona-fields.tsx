// The fields a new persona starts with: who she is, in her own language, plus a one-sentence
// English summary for the retrieval gate and the time zone her clock runs in.

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { LanguagesIcon } from "lucide-react";
import { useId, useState } from "react";
import { TimeZoneList } from "@/components/settings-form/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type PersonaDraft, personaErrors, suggestPersonaId } from "./wizard";

const FIELD_LABELS = {
  name: {
    label: msg`Her Name`,
    help: msg`In her own language; prompts use it as written.`,
  },
  id: {
    label: msg`ID`,
    help: msg`Names her folder: lowercase letters, digits, - and _. It can't change later.`,
  },
  shortName: {
    label: msg`Short Name`,
    help: msg`What prompts shorten her name to, and her avatar's letters. Empty uses her name.`,
  },
  fans: {
    label: msg`What She Calls Viewers`,
    help: msg`Empty uses 观众.`,
  },
  summary: {
    label: msg`Summary`,
    help: msg`Who she is, in one English sentence. It tells the knowledge search which questions are about her.`,
  },
  timezone: {
    label: msg`Time Zone`,
    help: msg`Her clock, for the date and time she knows. Starts as yours.`,
  },
} satisfies Record<keyof PersonaDraft, unknown>;

/** What each code personaErrors gives says. */
const ERRORS: Readonly<Record<string, MessageDescriptor>> = {
  "errors.invalid-persona-id": msg`A persona id uses lowercase letters, digits, - and _, and starts with a letter or digit.`,
  "errors.persona-exists": msg`A persona with that id already exists.`,
  "setup.persona.id.reserved": msg`Eidolon uses that word itself. Pick another id.`,
  "setup.persona.required": msg`Required.`,
  "settings.form.invalid.timezone": msg`Use a time zone name such as Asia/Shanghai.`,
};

export interface PersonaFieldsProps {
  readonly draft: PersonaDraft;
  readonly onDraft: (draft: PersonaDraft) => void;
  /** Ids already in use. */
  readonly taken: readonly string[];
  /** Show every field's error, as after a submit; before it, each shows once its field is left. */
  readonly showErrors: boolean;
  readonly disabled?: boolean;
}

export function MandarinNote() {
  const { t } = useLingui();
  return (
    <Alert>
      <LanguagesIcon />
      <AlertDescription>{t`Personas speak Mandarin, and the videos you build one from should be Mandarin streams.`}</AlertDescription>
    </Alert>
  );
}

export function PersonaFields({
  draft,
  onDraft,
  taken,
  showErrors,
  disabled = false,
}: PersonaFieldsProps) {
  const { t } = useLingui();
  const id = useId();
  const zones = useId();
  // The id follows the name until it is typed in itself.
  const [idTyped, setIdTyped] = useState(draft.id !== "");
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const errors = personaErrors(draft, taken);

  function set(key: keyof PersonaDraft, value: string) {
    const follow = key === "name" && !idTyped;
    if (key === "id") setIdTyped(value !== "");
    onDraft({ ...draft, [key]: value, ...(follow ? { id: suggestPersonaId(value, taken) } : {}) });
  }

  function errorOf(key: keyof PersonaDraft): string | null {
    const error = errors[key];
    return error && (showErrors || left.has(key)) ? error : null;
  }

  function field(
    key: keyof PersonaDraft,
    options: {
      multiline?: boolean;
      mono?: boolean;
      list?: string;
      placeholder?: string;
      wide?: boolean;
    } = {},
  ) {
    const error = errorOf(key);
    const props = {
      id: `${id}-${key}`,
      value: draft[key],
      disabled,
      placeholder: options.placeholder,
      "aria-invalid": error !== null,
      onBlur: () => setLeft((seen) => new Set(seen).add(key)),
    };
    return (
      <Field data-invalid={error !== null} className={cn(options.wide && "sm:col-span-2")}>
        <FieldLabel htmlFor={props.id}>{t(FIELD_LABELS[key].label)}</FieldLabel>
        {options.multiline ? (
          <Textarea {...props} rows={2} onChange={(event) => set(key, event.target.value)} />
        ) : (
          <Input
            {...props}
            className={options.mono ? "font-mono" : undefined}
            list={options.list}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => set(key, event.target.value)}
          />
        )}
        <FieldDescription>{t(FIELD_LABELS[key].help)}</FieldDescription>
        {error && <FieldError>{ERRORS[error] ? t(ERRORS[error]) : error}</FieldError>}
      </Field>
    );
  }

  return (
    <div className="grid items-start gap-x-5 gap-y-6 sm:grid-cols-2">
      {field("name", { placeholder: t`e.g. 明前奶绿` })}
      {field("id", { mono: true, placeholder: "my-persona" })}
      {field("shortName")}
      {field("fans", { placeholder: "观众" })}
      {field("summary", {
        multiline: true,
        wide: true,
        placeholder: t`e.g. A Chinese VTuber who streams on Bilibili and loves cats`,
      })}
      {field("timezone", { list: zones })}
      <TimeZoneList id={zones} />
    </div>
  );
}
