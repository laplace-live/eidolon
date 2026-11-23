// Her voice from the provider she speaks through: her Fish account's voices or Fish Audio's public
// library, one of a provider's fixed set, or the id of a voice in its library.
import { ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VoicePicker } from "@/components/voice-picker";
import { providerById, providerName } from "@/lib/providers";

export function VoiceChoice({
  provider,
  account,
  value,
  fallback,
  onChange,
  disabled = false,
}: {
  /** The voice provider's catalog id. */
  readonly provider: string;
  readonly account: string | null;
  /** The voice chosen here, or null before one is. */
  readonly value: string | null;
  /** What she speaks with while none is chosen: hers, the environment's, or the provider's own. */
  readonly fallback: string | null;
  readonly onChange: (voice: string) => void;
  readonly disabled?: boolean;
}) {
  const { t } = useLingui();
  const id = useId();
  const voices = providerById(provider)?.offers.tts?.voices;
  const name = providerName(provider);

  if (voices === undefined || voices.kind === "fish-library") {
    return (
      <VoicePicker
        value={value ?? fallback}
        onChange={(voice) => onChange(voice.id)}
        account={account}
        disabled={disabled}
      />
    );
  }
  if (voices.kind === "preset") {
    return (
      <Field className="max-w-xs">
        <FieldLabel htmlFor={id}>{t`Voice`}</FieldLabel>
        <Select value={value ?? fallback ?? ""} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder={t`Pick a voice`} />
          </SelectTrigger>
          <SelectContent>
            {voices.voices.map((voice) => (
              <SelectItem key={voice} value={voice}>
                {voice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{t`One of ${ph({ provider: name })}'s voices.`}</FieldDescription>
      </Field>
    );
  }
  return (
    <Field className="max-w-xl">
      <FieldLabel htmlFor={id}>{t`Voice ID`}</FieldLabel>
      <Input
        id={id}
        className="font-mono md:text-[0.8125rem]"
        autoComplete="off"
        spellCheck={false}
        value={value ?? ""}
        placeholder={fallback ?? ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
      <FieldDescription className="inline-links">
        <Trans>
          Find a voice in {ph({ provider: name })}'s{" "}
          <a href={voices.libraryUrl} target="_blank" rel="noreferrer noopener">
            voice library
          </a>
          , then paste its ID here.
        </Trans>
      </FieldDescription>
    </Field>
  );
}
