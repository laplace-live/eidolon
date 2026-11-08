import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { LargeDialogContent } from "@/components/large-dialog";
import { Dialog } from "@/components/ui/dialog";
import { VoicePicker } from "@/components/voice-picker";
import { refreshPersonas, saveVoice } from "@/features/setup/personas";
import type { Voice } from "@/lib/api";
import { changeVoiceDialog } from "./voice";

/** Picks a public Fish voice for a persona and saves it in her persona.yaml. */
export function VoiceDialog({
  persona,
  current,
  open,
  onOpenChange,
}: {
  readonly persona: { readonly id: string; readonly name: string };
  readonly current: string | null;
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
  return (
    <Dialog
      open={open}
      onOpenChange={(next) =>
        changeVoiceDialog(next, save.isPending, onOpenChange, () => save.reset())
      }
    >
      <LargeDialogContent
        title={t`Pick a Voice`}
        description={t`How ${ph({ name: persona.name })} sounds. Search Fish Audio's public voices and play a sample before you pick one.`}
      >
        <VoicePicker
          value={save.variables?.id ?? current}
          onChange={(voice) => save.mutate(voice)}
          disabled={save.isPending}
        />
        {save.isError && <ErrorAlert error={save.error} />}
      </LargeDialogContent>
    </Dialog>
  );
}
