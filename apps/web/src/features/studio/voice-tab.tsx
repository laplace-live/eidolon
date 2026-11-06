import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { SettingsForm } from "@/components/settings-form";
import { settingsQuery } from "@/components/settings-form/queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { VoicePicker } from "@/components/voice-picker";
import { saveVoice } from "@/features/setup/personas";
import type { PersonaSummary, SettingRow, Voice } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { CUE_MODEL, cueClash } from "./files";
import { LoadError, Section } from "./parts";
import { personaQueries } from "./queries";

function fileValue(row: SettingRow | undefined): string | null {
  return typeof row?.value === "string" && row.value !== "" ? row.value : null;
}

/** Whether Fish knows the voice: the server checks only the active persona's. */
function VoiceState({ persona, voiceId }: { readonly persona: string; readonly voiceId: string }) {
  const t = useT();
  const { data: status } = useQuery(statusQuery);
  const voice = status?.persona.id === persona ? status.persona.voice : null;
  if (voice === null || voice.id !== voiceId || voice.ok === null) return null;
  return voice.ok ? (
    <Badge variant="secondary">{t("studio.voice.known")}</Badge>
  ) : (
    <Badge variant="destructive">{t("studio.voice.unknown")}</Badge>
  );
}

export function VoiceTab({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery(persona.id));
  const prompt = useQuery(personaQueries(persona.id).prompt);
  const rows = settings.data?.settings ?? [];
  const voiceRow = rows.find((row) => row.path === "voice.voiceId");
  const modelRow = rows.find((row) => row.path === "voice.model");
  const voiceId = fileValue(voiceRow);
  const clash = cueClash(modelRow, prompt.data?.text);

  const pick = useMutation({
    mutationFn: (voice: Voice) => saveVoice(persona.id, voice.id),
    onSuccess: async (response, voice) => {
      queryClient.setQueryData(settingsQuery(persona.id).queryKey, response);
      toast.success(t("studio.voice.saved", { title: voice.title }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
      ]);
    },
    onError: toastError,
  });

  return (
    <div className="flex flex-col gap-6">
      <Section title={t("studio.voice.title")} description={t("studio.voice.description")}>
        {settings.isPending && <Skeleton className="h-10" />}
        {settings.isError && <LoadError error={settings.error} />}
        {settings.data && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("studio.voice.current")}</span>
            {voiceId === null ? (
              <Badge variant="outline">{t("studio.voice.none")}</Badge>
            ) : (
              <>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{voiceId}</code>
                <VoiceState persona={persona.id} voiceId={voiceId} />
              </>
            )}
          </div>
        )}
        {voiceRow?.envOverride && (
          <Alert>
            <TriangleAlertIcon />
            <AlertDescription>
              {t("studio.voice.envOverride", { name: voiceRow.env })}
            </AlertDescription>
          </Alert>
        )}
        <VoicePicker
          value={voiceId}
          onChange={(voice) => pick.mutate(voice)}
          disabled={pick.isPending || settings.data === undefined}
        />
      </Section>
      <Section title={t("studio.voice.modelTitle")} description={t("studio.voice.modelHelp")}>
        {clash?.kind === "model" && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{t("studio.voice.cueClash.title", { model: clash.model })}</AlertTitle>
            <AlertDescription>
              {t("studio.voice.cueClash.body", { model: CUE_MODEL })}
            </AlertDescription>
          </Alert>
        )}
        {clash?.kind === "env" && (
          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>{t("studio.voice.cueEnv.title", { env: clash.env })}</AlertTitle>
            <AlertDescription>
              {t("studio.voice.cueEnv.body", { env: clash.env, model: CUE_MODEL })}
            </AlertDescription>
          </Alert>
        )}
        <SettingsForm scope="persona" persona={persona.id} paths={["voice.model"]} />
      </Section>
    </div>
  );
}
