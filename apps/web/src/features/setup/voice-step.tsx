import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { personasQuery, settingsQuery } from "@/components/settings-form/queries";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { accountsQuery } from "@/lib/accounts";
import { type ApiError, asApiError } from "@/lib/api";
import { defaultVoice, providerById } from "@/lib/providers";
import { addAvatar } from "./avatar";
import type { VoiceTarget } from "./persona-step";
import {
  activatePersona,
  createPersona,
  type PersonaRef,
  refreshPersonas,
  saveVoice,
} from "./personas";
import { StepCard } from "./step-card";
import { VoiceChoice } from "./voice-choice";
import { inheritedValue, ownValue, pickedVoice, type VoicePick, voiceProvider } from "./wizard";

const VOICE = "voice.voiceId";

/**
 * Picks her voice from the provider she speaks through, then commits the persona step: saves an
 * existing persona's voice and makes her active, or creates the new one with it, and her avatar.
 * A new persona starts on the active one's providers, so her voice is that provider's.
 */
export function VoiceStep({
  target,
  onBack,
  onDone,
}: {
  readonly target: VoiceTarget;
  readonly onBack: () => void;
  readonly onDone: (persona: PersonaRef) => void;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const existing = target.kind === "existing" ? target.persona : null;
  // Hers, or for a new persona the active one's, whose providers she starts on.
  const settings = useQuery(settingsQuery(existing?.id));
  const personas = useQuery(personasQuery);
  const accounts = useQuery(accountsQuery);
  const [pick, setPick] = useState<VoicePick | null>(null);
  // Kept so a retry after a refused switch doesn't create her twice.
  const [created, setCreated] = useState<PersonaRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const row = existing
    ? settings.data?.settings.find((candidate) => candidate.path === VOICE)
    : undefined;
  const current = ownValue(row);
  // The environment's voice, which she keeps unless one is picked for her.
  const inherited = existing ? inheritedValue(row) : null;
  const name = existing ? existing.name : target.kind === "create" ? target.draft.name : "";
  const env = row?.env ?? "";
  const provider =
    settings.data === undefined
      ? null
      : voiceProvider(settings.data.settings, accounts.data?.accounts);
  const chosen = pickedVoice(pick, provider);
  const fallback =
    provider === null
      ? null
      : (current ?? inherited ?? defaultVoice(providerById(provider)?.offers.tts) ?? null);
  const picked = chosen?.trim() ?? "";
  const voiceId = picked === "" ? fallback : picked;

  async function next() {
    if (voiceId === null) return;
    setBusy(true);
    setFailure(null);
    try {
      let persona: PersonaRef;
      if (target.kind === "create") {
        persona = created ?? (await createPersona(target.draft, voiceId));
        if (created === null && target.avatar) persona = await addAvatar(persona, target.avatar);
        setCreated(persona);
      } else {
        persona = target.persona;
        if (picked !== "" && picked !== current) await saveVoice(persona.id, picked);
      }
      if (personas.data?.active !== persona.id) await activatePersona(persona.id);
      await refreshPersonas(queryClient);
      onDone(persona);
    } catch (error) {
      setFailure(asApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      title={t`Pick a Voice`}
      description={
        provider === "fish"
          ? t`How ${name} sounds. Search Fish Audio's public voices and play a sample before you pick one.`
          : t`How ${name} sounds.`
      }
      onBack={onBack}
      busy={busy}
      footer={
        <Button onClick={() => void next()} disabled={busy || voiceId === null}>
          {busy && <Spinner />}
          {target.kind === "create" ? t`Create Her` : t`Continue`}
        </Button>
      }
    >
      {inherited !== null && row && (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            <Trans>
              {name} inherits <code className="font-mono text-foreground">{env}</code> from the
              environment. Continue to keep it, or pick a voice of her own: it applies to her alone.
            </Trans>
          </AlertDescription>
        </Alert>
      )}
      {provider !== null && (
        <VoiceChoice
          provider={provider}
          value={chosen}
          fallback={fallback}
          onChange={(voice) => setPick({ provider, voice })}
          disabled={busy}
        />
      )}
      {failure && <ErrorAlert error={failure} />}
    </StepCard>
  );
}
