import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ListCard, ListRow } from "@/components/list";
import { SectionCard } from "@/components/section-card";
import { effectiveProviderType } from "@/components/settings-form/controls";
import { Code, EnvBadge } from "@/components/settings-form/field";
import { refreshSettings, settingsQuery } from "@/components/settings-form/queries";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { VoicePicker } from "@/components/voice-picker";
import { saveVoice } from "@/features/setup/personas";
import { ownValue } from "@/features/setup/wizard";
import { accountsQuery } from "@/lib/accounts";
import type { PersonaSummary, SettingRow, Voice } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { studioPath } from "@/lib/paths";
import { providerById, providerName, roleById } from "@/lib/providers";
import { statusQuery } from "@/lib/query";
import { CUE_MODEL, type CueClash, cueClash } from "./files";
import { LoadError } from "./parts";
import { personaQueries } from "./queries";
import { CARD_PATHS } from "./sections";

const [VOICE_PATH] = CARD_PATHS.voice;

/** A Fish voice's id, as its page on fish.audio shows it. */
const VOICE_ID = /^[0-9a-f]{32}$/;

/** A voice the public search can't find, such as a private one of her own account, by its id. */
function VoiceById({
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

/** Whether Fish knows the voice: the server checks only the active persona's. */
function useVoiceCheck(persona: string, voiceId: string | null): boolean | null {
  const { data: status } = useQuery(statusQuery);
  const voice = status?.persona.id === persona ? status.persona.voice : null;
  return voice === null || voiceId === null || voice.id !== voiceId ? null : voice.ok;
}

const SOURCE_TITLE = {
  own: msg`Her own voice`,
  inherited: msg`The environment's voice`,
  none: msg`No voice yet`,
} as const;

/** Her voice as it stands: her own, the one she inherits, or none. */
function CurrentVoice({
  persona,
  row,
}: {
  readonly persona: PersonaSummary;
  readonly row: SettingRow;
}) {
  const { t } = useLingui();
  const own = ownValue(row);
  const inherited = row.envValue;
  const voiceId = own ?? inherited;
  const source = own !== null ? "own" : inherited !== null ? "inherited" : "none";
  const known = useVoiceCheck(persona.id, voiceId);
  // An inherited voice Fish refuses: the explanation says so, and what to do.
  const broken = source === "inherited" && known === false;
  const env = row.env;
  const name = persona.shortName || persona.name;
  const value = inherited;

  const title = t(SOURCE_TITLE[source]);
  const explanation =
    source === "none" ? (
      t`A call needs one: pick her voice below.`
    ) : source === "inherited" ? (
      broken ? (
        <Trans>
          Fish Audio can't use the voice she inherits from <Code>{env}</Code>. Pick her own below.
        </Trans>
      ) : (
        <Trans>
          Inherited from <Code>{env}</Code> in the environment. Picking a voice here overrides it
          for {name} alone.
        </Trans>
      )
    ) : value !== null ? (
      <Trans>
        Overrides <Code>{env}</Code> in the environment, which sets <Code>{value}</Code>.
      </Trans>
    ) : null;

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
            {source === "inherited" && <EnvBadge />}
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
              {t`Fish has this voice`}
            </span>
          ) : known === false && !broken ? (
            <span className="flex items-center gap-1.5 text-destructive">
              <CircleXIcon className="size-4" />
              {t`Fish doesn't know this voice`}
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
  const { t } = useLingui();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          {t`Use the Environment's Voice`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t`Use the environment's voice for ${ph({ name: persona.shortName || persona.name })}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t`Her own voice is removed from her settings, and she speaks with the one ${ph({ env: row.env })} sets: ${ph({ value: row.envValue ?? "" })}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Keep Hers`}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t`Use It`}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function VoiceCard({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const query = settingsQuery(persona.id);
  const settings = useQuery(query);
  const row = settings.data?.settings.find((entry) => entry.path === VOICE_PATH);
  const own = ownValue(row);

  const pick = useMutation({
    mutationFn: (voice: Voice) => saveVoice(persona.id, voice.id),
    onSuccess: async (response, voice) => {
      toast.success(t`Voice set to ${ph({ title: voice.title })}.`);
      await refreshSettings(queryClient, persona.id, response);
    },
    onError: toastError,
  });
  const byId = useMutation({
    mutationFn: (id: string) => saveVoice(persona.id, id),
    onSuccess: async (response, id) => {
      toast.success(t`Voice set to ${id}.`);
      await refreshSettings(queryClient, persona.id, response);
    },
    onError: toastError,
  });
  const clear = useMutation({
    mutationFn: () => saveVoice(persona.id, null),
    onSuccess: async (response) => {
      toast.success(
        t`${ph({ name: persona.shortName || persona.name })} now speaks with the environment's voice.`,
      );
      await refreshSettings(queryClient, persona.id, response);
    },
    onError: toastError,
  });
  const busy = pick.isPending || byId.isPending || clear.isPending;

  return (
    <SectionCard
      title={t`Voice`}
      description={t`The Fish Audio voice she speaks with. Search the public voices, listen to a sample, and pick one.`}
      note={t`Choosing a voice saves it for ${ph({ name: persona.shortName || persona.name })}.`}
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
        hideCurrent
      />
      <VoiceById disabled={busy || settings.data === undefined} onUse={(id) => byId.mutate(id)} />
    </SectionCard>
  );
}

function CueAlert({ clash }: { readonly clash: CueClash }) {
  const { t } = useLingui();
  const title =
    clash.kind === "env"
      ? t`${ph({ model: clash.model })}, which she inherits from ${ph({ env: clash.env })}, doesn't perform every delivery cue`
      : t`${ph({ model: clash.model })} doesn't perform every delivery cue`;
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{t`This prompt teaches delivery cues, such as [whispering] or paired tags, which only ${ph({ model: CUE_MODEL })} performs in full. Eidolon takes out the ones this model can't read, so it never speaks them, but her delivery is plainer. Pick ${ph({ model: CUE_MODEL })} for the whole performance.`}</AlertDescription>
    </Alert>
  );
}

/** A provider other than Fish: its voice by id, or from its fixed set. */
function ProviderVoiceCard({
  persona,
  provider,
}: {
  readonly persona: PersonaSummary;
  readonly provider: string;
}) {
  const { t } = useLingui();
  const voices = providerById(provider)?.offers.tts?.voices;
  const library = voices?.kind === "id" ? voices.libraryUrl : null;
  return (
    <SettingsCard
      scope="persona"
      persona={persona.id}
      paths={CARD_PATHS.voice}
      title={t`Voice`}
      description={
        library ? (
          <Trans>
            The {ph({ provider: providerName(provider) })} voice she speaks with, by its id. Find
            one in {ph({ provider: providerName(provider) })}'s{" "}
            <a href={library} target="_blank" rel="noreferrer noopener">
              voice library
            </a>
            .
          </Trans>
        ) : (
          t`One of ${ph({ provider: providerName(provider) })}'s voices.`
        )
      }
    />
  );
}

export function VoiceSection({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  const settings = useQuery(settingsQuery(persona.id));
  const prompt = useQuery(personaQueries(persona.id).prompt);
  const accounts = useQuery(accountsQuery).data?.accounts;
  const rows = settings.data?.settings;
  const clash = cueClash(rows, prompt.data?.text, accounts);
  const provider = rows ? effectiveProviderType(roleById("voice"), rows, {}, accounts) : "fish";
  const realtime = rows ? effectiveProviderType(roleById("realtime"), rows, {}, accounts) : null;
  return (
    <>
      {realtime !== null && (
        <Alert>
          <AudioLinesIcon />
          <AlertTitle>
            {t`${ph({ provider: providerName(realtime) })}'s realtime model speaks for her`}
          </AlertTitle>
          <AlertDescription>
            <Trans>
              The voice below applies only when she talks with three models. Her realtime voice is
              set under <Link to={studioPath(persona.id, "models")}>Mind</Link>.
            </Trans>
          </AlertDescription>
        </Alert>
      )}
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.voiceProvider}
        title={t`Voice Provider`}
        description={t`Which provider and model read her lines.`}
      >
        {clash && <CueAlert clash={clash} />}
      </SettingsCard>
      {provider === "fish" || provider === null ? (
        <VoiceCard persona={persona} />
      ) : (
        <ProviderVoiceCard persona={persona} provider={provider} />
      )}
    </>
  );
}
