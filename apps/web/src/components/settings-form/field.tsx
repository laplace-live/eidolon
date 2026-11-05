import { LibraryIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
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
import { type Translate, useT } from "@/lib/i18n";
import { catalogs } from "@/locales";
import { type Control, controlFor, optionsOf, timeZones } from "./controls";

/** A string the locale files have, so a row without help text shows none. */
export function hasString(key: string): boolean {
  return key in catalogs.en;
}

const DEFAULT = "default";

function optionLabel(t: Translate, path: string, option: string): string {
  const key = `settings.option.${path}.${option}`;
  return hasString(key) ? t(key) : option;
}

interface InputProps {
  readonly id: string;
  readonly row: SettingRow;
  readonly control: Control;
  readonly draft: string;
  readonly invalid: boolean;
  readonly locked: boolean;
  readonly onDraft: (draft: string) => void;
}

function ControlInput({ id, row, control, draft, invalid, locked, onDraft }: InputProps) {
  const t = useT();
  const listId = useId();
  const [browsing, setBrowsing] = useState(false);
  const placeholder = t("settings.form.default");
  const common = {
    id,
    disabled: locked,
    "aria-invalid": invalid,
    autoComplete: "off",
    spellCheck: false,
  } as const;

  switch (control.type) {
    case "flag":
      return (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={draft || DEFAULT}
          // Clicking the chosen item again deselects it in Radix; keep the choice instead.
          onValueChange={(next) => next && onDraft(next === DEFAULT ? "" : next)}
          disabled={locked}
          aria-labelledby={`${id}-label`}
        >
          <ToggleGroupItem value={DEFAULT}>{t("settings.form.flag.default")}</ToggleGroupItem>
          <ToggleGroupItem value="on">{t("settings.form.flag.on")}</ToggleGroupItem>
          <ToggleGroupItem value="off">{t("settings.form.flag.off")}</ToggleGroupItem>
        </ToggleGroup>
      );
    case "select":
      return (
        <Select
          value={draft || DEFAULT}
          onValueChange={(next) => onDraft(next === DEFAULT ? "" : next)}
          disabled={locked}
        >
          <SelectTrigger id={id} className="w-full sm:w-72" aria-invalid={invalid}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{t("settings.form.default")}</SelectItem>
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
          className="font-mono text-xs"
          rows={3}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => onDraft(event.target.value)}
        />
      );
    case "timezone":
      return (
        <>
          <Input
            {...common}
            list={listId}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => onDraft(event.target.value)}
          />
          <datalist id={listId}>
            {timeZones().map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </>
      );
    case "voice":
      return (
        <div className="flex gap-2">
          <Input
            {...common}
            className="font-mono text-xs"
            value={draft}
            placeholder={placeholder}
            onChange={(event) => onDraft(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
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
    default: {
      const numeric = control.type === "integer" || control.type === "number";
      return (
        <Input
          {...common}
          className={
            numeric ? "sm:w-48" : control.type === "path" ? "font-mono text-xs" : undefined
          }
          inputMode={
            control.type === "integer"
              ? "numeric"
              : control.type === "number"
                ? "decimal"
                : undefined
          }
          value={draft}
          placeholder={control.type === "list" ? t("settings.form.listPlaceholder") : placeholder}
          onChange={(event) => onDraft(event.target.value)}
        />
      );
    }
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
}

/** One SETTINGS row: its translated title, the control its kind maps to, and why it is locked. */
export function SettingField({
  row,
  draft,
  error,
  onDraft,
  onBlur,
  disabled = false,
}: SettingFieldProps) {
  const t = useT();
  const id = useId();
  const control = useMemo(() => controlFor(row), [row]);
  const locked = disabled || row.envOverride || row.readOnly;
  const help = `settings.help.${row.path}`;
  const limits =
    control.type === "integer" ? { min: control.min ?? "", max: control.max ?? "" } : undefined;
  return (
    <Field data-invalid={error !== null} data-disabled={locked} onBlur={onBlur}>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel id={`${id}-label`} htmlFor={id}>
          {t(`settings.${row.path}`)}
        </FieldLabel>
        {row.envOverride ? (
          <Badge variant="outline">{t("settings.form.source.env")}</Badge>
        ) : row.source !== "default" ? (
          <Badge variant="secondary">{t(`settings.form.source.${row.source}`)}</Badge>
        ) : null}
      </div>
      <ControlInput
        id={id}
        row={row}
        control={control}
        draft={draft}
        invalid={error !== null}
        locked={locked}
        onDraft={onDraft}
      />
      {hasString(help) && <FieldDescription>{t(help)}</FieldDescription>}
      {row.envOverride && (
        <FieldDescription>{t("settings.form.envOverride", { env: row.env })}</FieldDescription>
      )}
      {row.readOnly && !row.envOverride && (
        <FieldDescription>{t("settings.form.readOnly", { env: row.env })}</FieldDescription>
      )}
      {error && <FieldError>{t(error, limits)}</FieldError>}
    </Field>
  );
}
