import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { LargeDialogContent } from "@/components/large-dialog";
import { Dialog } from "@/components/ui/dialog";
import { VoicePicker } from "@/components/voice-picker";
import { refreshPersonas, saveVoice } from "@/features/setup/personas";
import { VoiceById } from "@/features/studio/voice-by-id";
import type { Voice } from "@/lib/api";
import { changeVoiceDialog } from "./voice";

/** Picks one of the account's own Fish voices or a public one, and saves it in her persona.yaml. */
export function VoiceDialog({
  persona,
  current,
  account,
  open,
  onOpenChange,
}: {
  readonly persona: { readonly id: string; readonly name: string };
  readonly current: string | null;
  readonly account: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (voice: Voice) => saveVoice(persona.id, voice.id),
    onSuccess: async (_, voice) => {
      await refreshPersonas(queryClient);
      toast.success(t`Voice set to ${ph({ voice: voice.title })}.`);
      onOpenChange(false);
    },
  });
  const byId = useMutation({
    mutationFn: (id: string) => saveVoice(persona.id, id),
    onSuccess: async (_, id) => {
      await refreshPersonas(queryClient);
      toast.success(t`Voice set to ${id}.`);
      onOpenChange(false);
    },
  });
  const busy = save.isPending || byId.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) =>
        changeVoiceDialog(next, busy, onOpenChange, () => {
          save.reset();
          byId.reset();
        })
      }
    >
      <LargeDialogContent
        title={t`Pick a Voice`}
        description={t`How ${ph({ name: persona.name })} sounds. Choose from your own Fish Audio voices or the public library, play a sample, or enter a voice ID.`}
      >
        <VoicePicker
          value={save.variables?.id ?? byId.variables ?? current}
          onChange={(voice) => save.mutate(voice)}
          account={account}
          disabled={busy}
        />
        <VoiceById disabled={busy} onUse={(id) => byId.mutate(id)} />
        {save.isError && <ErrorAlert error={save.error} />}
        {byId.isError && <ErrorAlert error={byId.error} />}
      </LargeDialogContent>
    </Dialog>
  );
}
