import { useLingui } from "@lingui/react/macro";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** A Fish voice's id, as its page on fish.audio shows it. */
const VOICE_ID = /^[0-9a-f]{32}$/;

/** A voice the public search can't find, such as a private one of her own account, by its id. */
export function VoiceById({
  disabled,
  onUse,
}: {
  readonly disabled: boolean;
  readonly onUse: (id: string) => void;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const id = draft.trim().toLowerCase();
    if (!VOICE_ID.test(id)) {
      setInvalid(true);
      return;
    }
    onUse(id);
    setDraft("");
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
      <Label htmlFor={inputId}>{t`Or Use a Voice by Its ID`}</Label>
      <div className="flex max-w-xl gap-2">
        <Input
          id={inputId}
          className="font-mono text-xs"
          value={draft}
          placeholder={t`32-character voice ID`}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby={`${inputId}-help`}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
        />
        <Button
          type="submit"
          variant="outline"
          size="lg"
          disabled={disabled || draft.trim() === ""}
        >
          {t`Use This Voice`}
        </Button>
      </div>
      <p
        id={`${inputId}-help`}
        className={invalid ? "text-destructive text-sm" : "text-muted-foreground text-sm"}
      >
        {invalid
          ? t`A Fish voice ID is 32 characters of 0–9 and a–f.`
          : t`For a voice the search can't find, such as a private one of your Fish account: copy its ID from its page on fish.audio.`}
      </p>
    </form>
  );
}
