import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { browserTimeZone } from "@/components/settings-form/controls";
import { personasQuery } from "@/components/settings-form/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { VoicePicker } from "@/components/voice-picker";
import type { PersonaSummary, Voice } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { MandarinNote, PersonaFields } from "./persona-fields";
import { activatePersona, createPersona, refreshPersonas } from "./personas";
import { EMPTY_PERSONA, type PersonaDraft, personaErrors } from "./wizard";

/** Creates a persona, with the fields and the voice she needs, outside the wizard. */
export function NewPersonaDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated?: (persona: PersonaSummary) => void;
}) {
  const t = useT();
  const switchId = useId();
  const queryClient = useQueryClient();
  const personas = useQuery(personasQuery);
  const blank = () => ({ ...EMPTY_PERSONA, timezone: browserTimeZone() });
  const [draft, setDraft] = useState<PersonaDraft>(blank);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [activate, setActivate] = useState(true);
  const [showErrors, setShowErrors] = useState(false);
  const taken = personas.data?.personas.map((persona) => persona.id) ?? [];

  const create = useMutation({
    mutationFn: ({ voiceId }: { voiceId: string }) => createPersona(draft, voiceId),
    onSuccess: async (created) => {
      toast.success(t("setup.newPersona.created", { name: created.name }));
      if (activate) {
        // She exists either way; a refused switch (a call is live) only leaves her inactive.
        await activatePersona(created.id).catch(toastError);
      }
      await refreshPersonas(queryClient);
      onCreated?.(created);
      close(false);
    },
  });

  function close(next: boolean) {
    if (!next) {
      setDraft(blank());
      setVoice(null);
      setShowErrors(false);
      create.reset();
    }
    onOpenChange(next);
  }

  function submit() {
    setShowErrors(true);
    if (Object.keys(personaErrors(draft, taken)).length > 0 || !voice) return;
    create.mutate({ voiceId: voice.id });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && close(next)}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("setup.newPersona.title")}</DialogTitle>
          <DialogDescription>{t("setup.newPersona.body")}</DialogDescription>
        </DialogHeader>
        <MandarinNote />
        <PersonaFields
          draft={draft}
          onDraft={setDraft}
          taken={taken}
          showErrors={showErrors}
          disabled={create.isPending}
        />
        <FieldSet>
          <FieldLegend>{t("setup.newPersona.voice")}</FieldLegend>
          <VoicePicker value={voice?.id ?? null} onChange={setVoice} disabled={create.isPending} />
          {showErrors && !voice && <FieldError>{t("setup.newPersona.voiceRequired")}</FieldError>}
        </FieldSet>
        <Field orientation="horizontal">
          <Switch
            id={switchId}
            checked={activate}
            onCheckedChange={setActivate}
            disabled={create.isPending}
          />
          <FieldLabel htmlFor={switchId}>{t("setup.newPersona.activate")}</FieldLabel>
        </Field>
        {create.isError && <ErrorAlert error={create.error} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={create.isPending}>
            {t("setup.cancel")}
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending && <Spinner />}
            {t("setup.newPersona.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
