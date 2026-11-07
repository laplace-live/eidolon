import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { ListCard, ListRow } from "@/components/list";
import { SectionCard } from "@/components/section-card";
import { settingsQuery } from "@/components/settings-form/queries";
import { SettingsCard } from "@/components/settings-form/settings-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { VoicePicker } from "@/components/voice-picker";
import { saveVoice } from "@/features/setup/personas";
import { call, type PersonaSummary, type SettingRow, type Voice } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { rich, useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { CUE_MODEL, type CueClash, cueClash } from "./files";
import { Code, LoadError } from "./parts";
import { personaQueries } from "./queries";
import { CARD_PATHS } from "./sections";

const [VOICE_PATH] = CARD_PATHS.voice;

function fileValue(row: SettingRow | undefined): string | null {
  return typeof row?.value === "string" && row.value !== "" ? row.value : null;
}

/** Whether Fish knows the voice: the server checks only the active persona's. */
function useVoiceCheck(persona: string, voiceId: string | null): boolean | null {
  const { data: status } = useQuery(statusQuery);
  const voice = status?.persona.id === persona ? status.persona.voice : null;
  return voice === null || voiceId === null || voice.id !== voiceId ? null : voice.ok;
}

/** Her voice as it stands: her own, the one she inherits, or none. */
function CurrentVoice({
  persona,
  row,
}: {
  readonly persona: PersonaSummary;
  readonly row: SettingRow;
}) {
  const t = useT();
  const own = fileValue(row);
  const inherited = row.envValue;
  const voiceId = own ?? inherited;
  const known = useVoiceCheck(persona.id, voiceId);
  // An inherited voice Fish refuses: the explanation says so, and what to do.
  const broken = own === null && inherited !== null && known === false;
  const name = persona.shortName || persona.name;
  const env = <Code>{row.env}</Code>;

  const title =
    own !== null
      ? t("studio.voice.own")
      : inherited !== null
        ? t("studio.voice.inheritedTitle")
        : t("studio.voice.none");
  const explanation =
    own !== null && inherited !== null
      ? rich(t("settings.form.overrides"), { env, value: <Code>{inherited}</Code> })
      : broken
        ? rich(t("studio.voice.inheritedBroken"), { env })
        : own === null && inherited !== null
          ? rich(t("studio.voice.inherited"), { env, name })
          : own === null
            ? t("studio.voice.noneHelp")
            : null;

  return (
    <ListCard>
      <ListRow
        leading={
          <span className="flex size-10 items-center justify-center rounded-full bg-muted">
            <AudioLinesIcon className="size-5" />
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title}
            {own === null && inherited !== null && (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {t("settings.form.source.env")}
              </Badge>
            )}
          </span>
        }
        description={
          <span className="flex flex-col gap-1">
            {voiceId !== null && (
              <span className="break-all font-mono text-foreground/80 text-xs">{voiceId}</span>
            )}
            {explanation !== null && (
              <span className={broken ? "text-destructive" : undefined}>{explanation}</span>
            )}
          </span>
        }
        trailing={
          known === true ? (
            <span className="flex items-center gap-1.5 text-success">
              <CircleCheckIcon className="size-4" />
              {t("studio.voice.known")}
            </span>
          ) : known === false && !broken ? (
            <span className="flex items-center gap-1.5 text-destructive">
              <CircleXIcon className="size-4" />
              {t("studio.voice.unknown")}
            </span>
          ) : undefined
        }
      />
    </ListCard>
  );
}

function UseEnvVoice({
  persona,
  row,
  disabled,
  onConfirm,
}: {
  readonly persona: PersonaSummary;
  readonly row: SettingRow;
  readonly disabled: boolean;
  readonly onConfirm: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          {t("studio.voice.useEnv")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("studio.voice.useEnvTitle", { name: persona.shortName || persona.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("studio.voice.useEnvBody", { env: row.env, value: row.envValue ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("studio.voice.useEnvCancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("studio.voice.useEnvConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function VoiceCard({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = settingsQuery(persona.id);
  const settings = useQuery(query);
  const row = settings.data?.settings.find((entry) => entry.path === VOICE_PATH);
  const own = fileValue(row);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["settings"] }),
      queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
    ]);
  }

  const pick = useMutation({
    mutationFn: (voice: Voice) => saveVoice(persona.id, voice.id),
    onSuccess: async (response, voice) => {
      queryClient.setQueryData(query.queryKey, response);
      toast.success(t("studio.voice.saved", { title: voice.title }));
      await refresh();
    },
    onError: toastError,
  });
  const clear = useMutation({
    mutationFn: () =>
      call("PUT /api/local/settings", {
        body: { scope: "persona", persona: persona.id, values: { [VOICE_PATH]: null } },
      }),
    onSuccess: async (response) => {
      queryClient.setQueryData(query.queryKey, response);
      toast.success(t("studio.voice.cleared", { name: persona.shortName || persona.name }));
      await refresh();
    },
    onError: toastError,
  });
  const busy = pick.isPending || clear.isPending;

  return (
    <SectionCard
      title={t("studio.voice.title")}
      description={t("studio.voice.description")}
      note={t("studio.voice.note", { name: persona.shortName || persona.name })}
      actions={
        row !== undefined && own !== null && row.envValue !== null ? (
          <UseEnvVoice
            persona={persona}
            row={row}
            disabled={busy}
            onConfirm={() => clear.mutate()}
          />
        ) : undefined
      }
    >
      {settings.isPending && <Skeleton className="h-[4.5rem] rounded-xl" />}
      {settings.isError && <LoadError error={settings.error} />}
      {row !== undefined && <CurrentVoice persona={persona} row={row} />}
      <VoicePicker
        value={own}
        onChange={(voice) => pick.mutate(voice)}
        disabled={busy || settings.data === undefined}
      />
    </SectionCard>
  );
}

function CueAlert({ clash }: { readonly clash: CueClash }) {
  const t = useT();
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>
        {clash.kind === "model"
          ? t("studio.voice.cueClash.title", { model: clash.model })
          : t("studio.voice.cueEnv.title", { model: clash.model, env: clash.env })}
      </AlertTitle>
      <AlertDescription>
        {t(clash.kind === "model" ? "studio.voice.cueClash.body" : "studio.voice.cueEnv.body", {
          model: CUE_MODEL,
        })}
      </AlertDescription>
    </Alert>
  );
}

export function VoiceSection({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const settings = useQuery(settingsQuery(persona.id));
  const prompt = useQuery(personaQueries(persona.id).prompt);
  const [modelPath] = CARD_PATHS.voiceModel;
  const modelRow = settings.data?.settings.find((row) => row.path === modelPath);
  const clash = cueClash(modelRow, prompt.data?.text);
  return (
    <>
      <VoiceCard persona={persona} />
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.voiceModel}
        title={t("studio.voice.modelTitle")}
        description={t("studio.voice.modelHelp")}
      >
        {clash && <CueAlert clash={clash} />}
      </SettingsCard>
    </>
  );
}
