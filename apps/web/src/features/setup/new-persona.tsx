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
import { addAvatar } from "./avatar";
import { AvatarPicker } from "./avatar-picker";
import { MandarinNote, PersonaFields } from "./persona-fields";
import { activatePersona, createPersona, refreshPersonas } from "./personas";
import { EMPTY_PERSONA, type PersonaDraft, personaErrors } from "./wizard";

/** Creates a persona, with the fields and the voice she needs and an avatar, outside the wizard. */
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
  const [avatar, setAvatar] = useState<File | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [activate, setActivate] = useState(true);
  const [showErrors, setShowErrors] = useState(false);
  const taken = personas.data?.personas.map((persona) => persona.id) ?? [];

  const create = useMutation({
    mutationFn: ({ voiceId }: { voiceId: string }) => createPersona(draft, voiceId),
    onSuccess: async (created) => {
      toast.success(t("setup.newPersona.created", { name: created.name }));
      if (avatar) await addAvatar(created, avatar);
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
      setAvatar(null);
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
      {/* The grid's track and the voice fieldset would each grow to fit the voice list's rows,
          past a phone's screen: both are held to the dialog's width. */}
      <DialogContent className="max-h-[90svh] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-6">
          <DialogTitle className="font-semibold text-xl tracking-tight">
            {t("setup.newPersona.title")}
          </DialogTitle>
          <DialogDescription>{t("setup.newPersona.body")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6 p-6">
          <MandarinNote />
          <AvatarPicker
            file={avatar}
            onFile={setAvatar}
            name={draft.shortName || draft.name}
            disabled={create.isPending}
          />
          <PersonaFields
            draft={draft}
            onDraft={setDraft}
            taken={taken}
            showErrors={showErrors}
            disabled={create.isPending}
          />
          <div className="border-t pt-6">
            <FieldSet className="min-w-0">
              <FieldLegend>{t("setup.newPersona.voice")}</FieldLegend>
              <VoicePicker
                value={voice?.id ?? null}
                onChange={setVoice}
                disabled={create.isPending}
              />
              {showErrors && !voice && (
                <FieldError>{t("setup.newPersona.voiceRequired")}</FieldError>
              )}
            </FieldSet>
          </div>
          {create.isError && <ErrorAlert error={create.error} />}
        </div>
        <DialogFooter className="sticky bottom-0 z-10 m-0 flex-row flex-wrap items-center justify-between gap-3 px-6 py-3 backdrop-blur-md">
          <Field orientation="horizontal" className="w-auto">
            <Switch
              id={switchId}
              checked={activate}
              onCheckedChange={setActivate}
              disabled={create.isPending}
            />
            <FieldLabel htmlFor={switchId} className="font-normal">
              {t("setup.newPersona.activate")}
            </FieldLabel>
          </Field>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => close(false)} disabled={create.isPending}>
              {t("setup.cancel")}
            </Button>
            <Button onClick={submit} disabled={create.isPending}>
              {create.isPending && <Spinner />}
              {t("setup.newPersona.create")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
