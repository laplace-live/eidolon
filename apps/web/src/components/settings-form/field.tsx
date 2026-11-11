import { ph, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useMemo } from "react";
import { QuietBadge } from "@/components/quiet-badge";
import { Button } from "@/components/ui/button";
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
import { accountsQuery } from "@/lib/accounts";
import type { SettingRow } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/labels";
import { defaultVoice, providerById, providerName, providerOfAccount } from "@/lib/providers";
import { cn } from "@/lib/utils";
import {
  type Control,
  controlFor,
  envDraft,
  type Origin,
  optionsOf,
  originOf,
  type Slider,
  sliderValue,
  timeZones,
} from "./controls";
import {
  FLAG_LABELS,
  INVALID_MESSAGES,
  PROVIDER_OFF_LABELS,
  SETTING_HELP,
  SETTING_OPTION_LABELS,
  SETTING_TITLES,
} from "./labels";
import { ModelPicker } from "./model-picker";

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
  flag: "",
  provider: "sm:max-w-xs",
  model: "max-w-md",
  voice: "max-w-md",
};

function optionLabel(path: string, option: string): string {
  const label = SETTING_OPTION_LABELS[path]?.[option];
  return label === undefined ? option : t(label);
}

/** A variable's name or value inside a line of text. */
export function Code({ children }: { readonly children: ReactNode }) {
  return (
    <code className="wrap-anywhere rounded-sm bg-muted px-1 py-px font-mono text-[0.8125rem] text-foreground/80">
      {children}
    </code>
  );
}

/** Marks a value that comes from the environment. */
export function EnvBadge() {
  const { t } = useLingui();
  return <QuietBadge>{t`environment`}</QuietBadge>;
}

/** A help line on where a row's value comes from; none when only the files set it. */
export function OriginNote({
  row,
  origin,
  personaName,
}: {
  readonly row: SettingRow;
  readonly origin: Origin;
  readonly personaName: string;
}) {
  const env = row.envName ?? row.env;
  const name = personaName;
  const value = row.envValue;
  switch (origin) {
    case "inherited":
      return (
        <FieldDescription>
          <Trans>
            Inherited from <Code>{env}</Code> in the environment. A value set here overrides it for{" "}
            <span className="whitespace-nowrap">{name}</span> alone.
          </Trans>
        </FieldDescription>
      );
    case "overrides":
      return (
        <FieldDescription>
          <Trans>
            Overrides <Code>{env}</Code> in the environment, which sets <Code>{value}</Code>.
          </Trans>
        </FieldDescription>
      );
    case "locked":
      return (
        <FieldDescription>
          <Trans>
            Set by <Code>{env}</Code> in the environment, which wins over the value saved here.
            Change it there.
          </Trans>
        </FieldDescription>
      );
    case "readOnly":
      return (
        <FieldDescription>
          <Trans>
            Shown only: set it in settings.yaml or with <Code>{env}</Code>.
          </Trans>
        </FieldDescription>
      );
    case "own":
      return null;
  }
}

interface InputProps {
  readonly id: string;
  readonly row: SettingRow;
  readonly control: Control;
  /** The provider filling the row's role as the drafts stand, for a model or voice row. */
  readonly provider: string | null;
  /** A model row's model while it is empty; null when the provider needs one named. */
  readonly fallbackModel: string | null;
  readonly draft: string;
  /** What applies while the draft is empty, as the control shows it: the environment's value. */
  readonly inherited: string | null;
  readonly invalid: boolean;
  readonly locked: boolean;
  readonly fill: boolean;
  readonly onDraft: (draft: string) => void;
}

/** A closed list of choices with the default first, as the select of a SETTINGS row. */
function ChoiceSelect({
  id,
  draft,
  defaultLabel,
  options,
  invalid,
  locked,
  width,
  onDraft,
}: {
  readonly id: string;
  readonly draft: string;
  readonly defaultLabel: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly invalid: boolean;
  readonly locked: boolean;
  readonly width: string | undefined;
  readonly onDraft: (draft: string) => void;
}) {
  // A file's value none of the options names stays choosable, so a save doesn't drop it.
  const all =
    draft !== "" && !options.some((option) => option.value === draft)
      ? [...options, { value: draft, label: draft }]
      : options;
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
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
        {all.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A number on a slider, its value beside it, and a Reset back to what applies while it is unset. */
function SliderInput({
  id,
  slider,
  draft,
  inherited,
  invalid,
  locked,
  width,
  onDraft,
}: {
  readonly id: string;
  readonly slider: Slider;
  readonly draft: string;
  readonly inherited: string | null;
  readonly invalid: boolean;
  readonly locked: boolean;
  readonly width: string | undefined;
  readonly onDraft: (draft: string) => void;
}) {
  const { t } = useLingui();
  const value = sliderValue(slider, draft, inherited);
  return (
    <div className={cn("flex items-center gap-3", width)}>
      <input
        id={id}
        type="range"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={value}
        onChange={(event) => onDraft(event.target.value)}
        disabled={locked}
        aria-invalid={invalid}
        className="h-2 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
      />
      <output htmlFor={id} className="w-10 shrink-0 text-right text-sm tabular-nums">
        {value.toFixed(2)}
      </output>
      {draft.trim() !== "" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked}
          onClick={() => onDraft("")}
        >
          {t`Reset`}
        </Button>
      )}
    </div>
  );
}

function ControlInput({
  id,
  row,
  control,
  provider,
  fallbackModel,
  draft,
  inherited,
  invalid,
  locked,
  fill,
  onDraft,
}: InputProps) {
  const { t } = useLingui();
  const { data: listed } = useQuery(accountsQuery);
  const accounts = listed?.accounts;
  const width = fill ? undefined : WIDTH[control.type];
  // 16 px on a phone, where iOS zooms into smaller inputs. The generic "Default" is a word, not a
  // value: only an inherited value stays mono.
  const mono = cn("font-mono md:text-[0.8125rem]", !inherited && "placeholder:font-sans");
  const placeholder =
    inherited ||
    (control.type === "text" ? control.placeholder : undefined) ||
    (control.type === "list" ? t`Default (comma-separated)` : t`Default`);
  const common = {
    id,
    disabled: locked,
    "aria-invalid": invalid,
    autoComplete: "off",
    spellCheck: false,
    placeholder,
  } as const;

  if (control.type === "number" && control.slider !== undefined) {
    return (
      <SliderInput
        id={id}
        slider={control.slider}
        draft={draft}
        inherited={inherited}
        invalid={invalid}
        locked={locked}
        width={fill ? undefined : "max-w-md"}
        onDraft={onDraft}
      />
    );
  }
  switch (control.type) {
    case "provider": {
      const { role } = control;
      const name = (account: string) =>
        accounts?.find((entry) => entry.id === account)?.name ?? providerName(account);
      const followed = inherited === null && role.follows !== undefined ? provider : null;
      const fallback = inherited ?? followed ?? role.defaultProvider;
      const off = PROVIDER_OFF_LABELS[role.id];
      const followedRole = role.follows === undefined ? "" : t(ROLE_LABELS[role.follows]);
      const defaultLabel =
        fallback === null
          ? off === undefined
            ? t`Default`
            : t(off)
          : followed !== null && role.follows !== undefined
            ? t`Same as ${ph({ role: followedRole })} (${ph({ value: name(followed) })})`
            : t`Default (${ph({ value: name(fallback) })})`;
      // The accounts Settings has, of the providers that can fill the role.
      const options = (accounts ?? [])
        .filter((account) => providerById(account.provider)?.offers[role.category] !== undefined)
        .map((account) => ({ value: account.id, label: account.name }));
      return (
        <ChoiceSelect
          id={id}
          draft={draft}
          defaultLabel={defaultLabel}
          options={options}
          invalid={invalid}
          locked={locked}
          width={width}
          onDraft={onDraft}
        />
      );
    }
    case "model": {
      const { role } = control;
      const type = providerOfAccount(provider, accounts);
      const offer = type === null ? undefined : providerById(type)?.offers[role.category];
      const fallback = inherited ?? fallbackModel;
      // A closed offer such as Fish's lists nowhere, and an id it doesn't know runs as another model.
      if (offer !== undefined && !offer.openModels) {
        return (
          <ChoiceSelect
            id={id}
            draft={draft}
            defaultLabel={fallback ? t`Default (${ph({ value: fallback })})` : t`Default`}
            options={offer.models.map((model) => ({
              value: model.id,
              label: optionLabel(row.path, model.id),
            }))}
            invalid={invalid}
            locked={locked}
            width={width}
            onDraft={onDraft}
          />
        );
      }
      return (
        <ModelPicker
          id={id}
          account={provider}
          provider={type}
          category={role.category}
          draft={draft}
          fallback={fallback}
          invalid={invalid}
          locked={locked}
          className={width}
          onDraft={onDraft}
        />
      );
    }
    case "voice": {
      const { role } = control;
      const type = providerOfAccount(provider, accounts);
      const offer = type === null ? undefined : providerById(type)?.offers[role.category];
      const voices = offer?.voices;
      const preset = voices?.kind === "preset" ? voices.voices : null;
      const fallback = inherited ?? defaultVoice(offer);
      if (preset !== null) {
        return (
          <ChoiceSelect
            id={id}
            draft={draft}
            defaultLabel={fallback ? t`Default (${ph({ value: fallback })})` : t`Default`}
            options={preset.map((voice) => ({ value: voice, label: voice }))}
            invalid={invalid}
            locked={locked}
            width={width}
            onDraft={onDraft}
          />
        );
      }
      return (
        <Input
          {...common}
          placeholder={fallback ?? t`Default`}
          className={cn(mono, width)}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
        />
      );
    }
    case "flag": {
      const inheritedFlag =
        inherited === "on" || inherited === "off" ? t(FLAG_LABELS[inherited]) : "";
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
              ? t`Default (${ph({ value: inheritedFlag })})`
              : t`Default`}
          </ToggleGroupItem>
          <ToggleGroupItem value="on" className="h-9 px-3">
            {t`On`}
          </ToggleGroupItem>
          <ToggleGroupItem value="off" className="h-9 px-3">
            {t`Off`}
          </ToggleGroupItem>
        </ToggleGroup>
      );
    }
    case "select": {
      const fallback = inherited || control.fallback;
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
              {fallback
                ? t`Default (${ph({ value: optionLabel(row.path, fallback) })})`
                : t`Default`}
            </SelectItem>
            {optionsOf(control, draft).map((option) => (
              <SelectItem key={option} value={option}>
                {optionLabel(row.path, option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
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
  /** The provider filling the row's role as the card's drafts stand, for a model or voice row. */
  readonly provider?: string | null;
  /** A model row's model while it is empty, as the card's drafts stand. */
  readonly fallbackModel?: string | null;
  readonly draft: string;
  /** parseDraft's code for what is wrong with the draft, or null. */
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
  provider = null,
  fallbackModel = null,
  draft,
  error,
  onDraft,
  onBlur,
  disabled = false,
  personaName,
  fill = false,
}: SettingFieldProps) {
  const { t, i18n } = useLingui();
  const id = useId();
  const control = useMemo(() => controlFor(row), [row]);
  const fromEnv = envDraft(row, control);
  const origin = originOf(row, draft);
  const locked = disabled || origin === "locked" || origin === "readOnly";
  const title = SETTING_TITLES[row.path];
  const help = SETTING_HELP[row.path];
  const refusal = error === null ? undefined : INVALID_MESSAGES[error];
  const limits =
    control.type === "integer" ? { min: control.min ?? "", max: control.max ?? "" } : undefined;
  return (
    <Field data-invalid={error !== null} data-disabled={locked} onBlur={onBlur}>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel id={`${id}-label`} htmlFor={id}>
          {title === undefined ? row.path : t(title)}
        </FieldLabel>
        {(origin === "locked" || origin === "inherited") && <EnvBadge />}
      </div>
      <ControlInput
        id={id}
        row={row}
        control={control}
        provider={provider}
        fallbackModel={fallbackModel}
        // A locked row shows what applies: the environment's value, not the file's.
        draft={origin === "locked" && fromEnv !== null ? fromEnv : draft}
        inherited={row.scope === "persona" ? fromEnv : null}
        invalid={error !== null}
        locked={locked}
        fill={fill}
        onDraft={onDraft}
      />
      {help && <FieldDescription>{t(help)}</FieldDescription>}
      <OriginNote row={row} origin={origin} personaName={personaName} />
      {error && <FieldError>{refusal ? i18n._({ ...refusal, values: limits }) : error}</FieldError>}
    </Field>
  );
}
