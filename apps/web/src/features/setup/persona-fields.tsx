// The fields a new persona starts with: who she is, in her own language, plus a one-sentence
// English summary for the retrieval gate and the time zone her clock runs in.
import { LanguagesIcon } from "lucide-react";
import { useId, useState } from "react";
import { TimeZoneList } from "@/components/settings-form/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";
import { type PersonaDraft, personaErrors, suggestPersonaId } from "./wizard";

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
  const t = useT();
  return (
    <Alert>
      <LanguagesIcon />
      <AlertDescription>{t("setup.persona.mandarin")}</AlertDescription>
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
  const t = useT();
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
    options: { multiline?: boolean; mono?: boolean; list?: string; placeholder?: string } = {},
  ) {
    const error = errorOf(key);
    const help = `setup.persona.${key}.help`;
    const props = {
      id: `${id}-${key}`,
      value: draft[key],
      disabled,
      placeholder: options.placeholder,
      "aria-invalid": error !== null,
      onBlur: () => setLeft((seen) => new Set(seen).add(key)),
    };
    return (
      <Field data-invalid={error !== null}>
        <FieldLabel htmlFor={props.id}>{t(`setup.persona.${key}`)}</FieldLabel>
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
        <FieldDescription>{t(help)}</FieldDescription>
        {error && <FieldError>{t(error)}</FieldError>}
      </Field>
    );
  }

  return (
    <FieldGroup>
      {field("name", { placeholder: t("setup.persona.name.placeholder") })}
      {field("id", { mono: true, placeholder: "my-persona" })}
      {field("shortName")}
      {field("fans", { placeholder: "观众" })}
      {field("summary", { multiline: true, placeholder: t("setup.persona.summary.placeholder") })}
      {field("timezone", { list: zones })}
      <TimeZoneList id={zones} />
    </FieldGroup>
  );
}
