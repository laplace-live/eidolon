import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { LargeDialogContent } from "@/components/large-dialog";
import { browserTimeZone } from "@/components/settings-form/controls";
import { personasQuery } from "@/components/settings-form/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { VoicePicker } from "@/components/voice-picker";
import type { PersonaSummary, Voice } from "@/lib/api";
import { toastError } from "@/lib/feedback";
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
  const { t } = useLingui();
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
    onSuccess: async (made) => {
      toast.success(t`${ph({ name: made.name })} created.`);
      const created = avatar ? await addAvatar(made, avatar) : made;
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
      <LargeDialogContent
        title={t`New Persona`}
        description={t`She starts with a Chinese prompt skeleton in her name; build her up in the studio.`}
        footer={
          <DialogFooter className="sticky bottom-0 z-10 m-0 flex-row flex-wrap items-center justify-between gap-3 px-6 py-3 backdrop-blur-md">
            <Field orientation="horizontal" className="w-auto">
              <Switch
                id={switchId}
                checked={activate}
                onCheckedChange={setActivate}
                disabled={create.isPending}
              />
              <FieldLabel htmlFor={switchId} className="font-normal">
                {t`Switch to Her Now`}
              </FieldLabel>
            </Field>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={() => close(false)} disabled={create.isPending}>
                {t`Cancel`}
              </Button>
              <Button onClick={submit} disabled={create.isPending}>
                {create.isPending && <Spinner />}
                {t`Create`}
              </Button>
            </div>
          </DialogFooter>
        }
      >
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
          {/* A fieldset grows to fit the voice list's rows unless held to the dialog's width. */}
          <FieldSet className="min-w-0">
            <FieldLegend>{t`Her Voice`}</FieldLegend>
            <VoicePicker
              value={voice?.id ?? null}
              onChange={setVoice}
              disabled={create.isPending}
            />
            {showErrors && !voice && <FieldError>{t`Pick a voice for her.`}</FieldError>}
          </FieldSet>
        </div>
        {create.isError && <ErrorAlert error={create.error} />}
      </LargeDialogContent>
    </Dialog>
  );
}
