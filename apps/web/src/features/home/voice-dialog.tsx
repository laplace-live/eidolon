import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VoicePicker } from "@/components/voice-picker";
import { refreshPersonas, saveVoice } from "@/features/setup/personas";
import type { Voice } from "@/lib/api";
import { useT } from "@/lib/i18n";

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
  const t = useT();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (voice: Voice) => saveVoice(persona.id, voice.id),
    onSuccess: async (_, voice) => {
      await refreshPersonas(queryClient);
      toast.success(t("home.voice.saved", { voice: voice.title }));
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
        if (!next) save.reset();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("setup.voice.title")}</DialogTitle>
          <DialogDescription>{t("setup.voice.stepBody", { name: persona.name })}</DialogDescription>
        </DialogHeader>
        <VoicePicker
          value={save.variables?.id ?? current}
          onChange={(voice) => save.mutate(voice)}
          disabled={save.isPending}
        />
        {save.isError && <ErrorAlert error={save.error} />}
      </DialogContent>
    </Dialog>
  );
}
