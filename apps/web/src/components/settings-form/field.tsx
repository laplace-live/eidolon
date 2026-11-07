import { LibraryIcon } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { VoicePicker } from "@/components/voice-picker";
import type { SettingRow } from "@/lib/api";
import { rich, type Translate, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { catalogs } from "@/locales";
import { type Control, controlFor, envDraft, optionsOf, originOf, timeZones } from "./controls";

/** Every IANA time zone, as the suggestions of the input whose `list` is `id`. */
export function TimeZoneList({ id }: { readonly id: string }) {
  return (
    <datalist id={id}>
      {timeZones().map((zone) => (
        <option key={zone} value={zone} />
      ))}
    </datalist>
  );
}

/** A string the locale files have, so a row without help text shows none. */
export function hasString(key: string): boolean {
  return key in catalogs.en;
}

const DEFAULT = "default";

/** About as wide as what each control holds, unless it fills a column beside another. */
const WIDTH: Readonly<Record<Control["type"], string>> = {
  text: "max-w-md",
  list: "max-w-md",
  integer: "max-w-48",
  number: "max-w-48",
  language: "max-w-48",
  timezone: "max-w-xs",
  select: "sm:max-w-xs",
  path: "max-w-xl",
  paths: "max-w-xl",
  voice: "max-w-xl",
  flag: "",
};

function optionLabel(t: Translate, path: string, option: string): string {
  const key = `settings.option.${path}.${option}`;
  return hasString(key) ? t(key) : option;
}

/** A variable's name or value inside a help line. */
function Code({ children }: { readonly children: ReactNode }) {
  return (
    <code className="wrap-anywhere rounded-sm bg-muted px-1 py-px font-mono text-[0.8125rem] text-foreground/80">
      {children}
    </code>
  );
}

interface InputProps {
  readonly id: string;
  readonly row: SettingRow;
  readonly control: Control;
  readonly draft: string;
  /** What applies while the draft is empty, as the control shows it: the environment's value. */
  readonly inherited: string | null;
  readonly invalid: boolean;
  readonly locked: boolean;
  readonly fill: boolean;
  readonly onDraft: (draft: string) => void;
}

function ControlInput({
  id,
  row,
  control,
  draft,
  inherited,
  invalid,
  locked,
  fill,
  onDraft,
}: InputProps) {
  const t = useT();
  const listId = useId();
  const [browsing, setBrowsing] = useState(false);
  const width = fill ? undefined : WIDTH[control.type];
  // 16 px on a phone, where iOS zooms into smaller inputs. The generic "Default" is a word, not a
  // value: only an inherited value stays mono.
  const mono = cn("font-mono md:text-[0.8125rem]", !inherited && "placeholder:font-sans");
  const placeholder =
    inherited ||
    t(control.type === "list" ? "settings.form.listPlaceholder" : "settings.form.default");
  const common = {
    id,
    disabled: locked,
    "aria-invalid": invalid,
    autoComplete: "off",
    spellCheck: false,
    placeholder,
  } as const;

  switch (control.type) {
    case "flag":
      return (
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={draft || DEFAULT}
          // Clicking the chosen item again deselects it in Radix; keep the choice instead.
          onValueChange={(next) => next && onDraft(next === DEFAULT ? "" : next)}
          disabled={locked}
          aria-labelledby={`${id}-label`}
        >
          <ToggleGroupItem value={DEFAULT} className="h-9 px-3">
            {inherited === "on" || inherited === "off"
              ? t("settings.form.defaultInherited", { value: t(`settings.form.flag.${inherited}`) })
              : t("settings.form.flag.default")}
          </ToggleGroupItem>
          <ToggleGroupItem value="on" className="h-9 px-3">
            {t("settings.form.flag.on")}
          </ToggleGroupItem>
          <ToggleGroupItem value="off" className="h-9 px-3">
            {t("settings.form.flag.off")}
          </ToggleGroupItem>
        </ToggleGroup>
      );
    case "select":
      return (
        <Select
          value={draft || DEFAULT}
          onValueChange={(next) => onDraft(next === DEFAULT ? "" : next)}
          disabled={locked}
        >
          <SelectTrigger id={id} className={cn("w-full", width)} aria-invalid={invalid}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>
              {inherited
                ? t("settings.form.defaultInherited", {
                    value: optionLabel(t, row.path, inherited),
                  })
                : t("settings.form.default")}
            </SelectItem>
            {optionsOf(control, draft).map((option) => (
              <SelectItem key={option} value={option}>
                {optionLabel(t, row.path, option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "paths":
      return (
        <Textarea
          {...common}
          className={cn(mono, width)}
          rows={3}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
        />
      );
    case "timezone":
      return (
        <>
          <Input
            {...common}
            className={width}
            list={listId}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
          />
          <TimeZoneList id={listId} />
        </>
      );
    case "voice":
      return (
        <div className={cn("flex gap-2", width)}>
          <Input
            {...common}
            className={mono}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={locked}
            onClick={() => setBrowsing(true)}
          >
            <LibraryIcon />
            {t("settings.form.browseVoices")}
          </Button>
          <Dialog open={browsing} onOpenChange={setBrowsing}>
            <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t("setup.voice.title")}</DialogTitle>
                <DialogDescription>{t("setup.voice.body")}</DialogDescription>
              </DialogHeader>
              <VoicePicker
                value={draft || null}
                onChange={(voice) => {
                  onDraft(voice.id);
                  setBrowsing(false);
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      );
    default:
      return (
        <Input
          {...common}
          className={cn(control.type === "path" && mono, width)}
          inputMode={
            control.type === "integer"
              ? "numeric"
              : control.type === "number"
                ? "decimal"
                : undefined
          }
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
        />
      );
  }
}

export interface SettingFieldProps {
  readonly row: SettingRow;
  readonly draft: string;
  /** A locale key from parseDraft, or null. */
  readonly error: string | null;
  readonly onDraft: (draft: string) => void;
  /** Focus left the field: its error may show from now on. */
  readonly onBlur?: () => void;
  readonly disabled?: boolean;
  /** Whose row a persona row is, for the line that says her own value applies to her alone. */
  readonly personaName: string;
  /** Fill the column, as beside another field, rather than fit the value. */
  readonly fill?: boolean;
}

/**
 * One SETTINGS row: its translated title, the control its kind maps to, and where its value comes
 * from. Only the environment's app values and read-only rows are locked: a persona's own value
 * wins over the environment's, which she inherits while she leaves the row unset.
 */
export function SettingField({
  row,
  draft,
  error,
  onDraft,
  onBlur,
  disabled = false,
  personaName,
  fill = false,
}: SettingFieldProps) {
  const t = useT();
  const id = useId();
  const control = useMemo(() => controlFor(row), [row]);
  const fromEnv = envDraft(row, control);
  const origin = originOf(row, draft);
  const locked = disabled || origin === "locked" || origin === "readOnly";
  const help = `settings.help.${row.path}`;
  const env = <Code>{row.env}</Code>;
  const limits =
    control.type === "integer" ? { min: control.min ?? "", max: control.max ?? "" } : undefined;
  return (
    <Field data-invalid={error !== null} data-disabled={locked} onBlur={onBlur}>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel id={`${id}-label`} htmlFor={id}>
          {t(`settings.${row.path}`)}
        </FieldLabel>
        {(origin === "locked" || origin === "inherited") && (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {t("settings.form.source.env")}
          </Badge>
        )}
      </div>
      <ControlInput
        id={id}
        row={row}
        control={control}
        // A locked row shows what applies: the environment's value, not the file's.
        draft={origin === "locked" && fromEnv !== null ? fromEnv : draft}
        inherited={row.scope === "persona" ? fromEnv : null}
        invalid={error !== null}
        locked={locked}
        fill={fill}
        onDraft={onDraft}
      />
      {hasString(help) && <FieldDescription>{t(help)}</FieldDescription>}
      {origin === "inherited" && (
        <FieldDescription>
          {rich(t("settings.form.inherited"), {
            env,
            name: <span className="whitespace-nowrap">{personaName}</span>,
          })}
        </FieldDescription>
      )}
      {origin === "overrides" && (
        <FieldDescription>
          {rich(t("settings.form.overrides"), { env, value: <Code>{row.envValue}</Code> })}
        </FieldDescription>
      )}
      {origin === "locked" && (
        <FieldDescription>{rich(t("settings.form.envOverride"), { env })}</FieldDescription>
      )}
      {origin === "readOnly" && (
        <FieldDescription>{rich(t("settings.form.readOnly"), { env })}</FieldDescription>
      )}
      {error && <FieldError>{t(error, limits)}</FieldError>}
    </Field>
  );
}
