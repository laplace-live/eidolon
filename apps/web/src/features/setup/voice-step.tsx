import { useQuery, useQueryClient } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { personasQuery, settingsQuery } from "@/components/settings-form/queries";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { VoicePicker } from "@/components/voice-picker";
import { type ApiError, asApiError, type Voice } from "@/lib/api";
import { rich, useT } from "@/lib/i18n";
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
import { inheritedValue, ownValue } from "./wizard";

const VOICE = "voice.voiceId";

/**
 * Picks a public Fish voice, then commits the persona step: saves an existing persona's voice and
 * makes her active, or creates the new one with it, and her avatar.
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
  const t = useT();
  const queryClient = useQueryClient();
  const existing = target.kind === "existing" ? target.persona : null;
  const settings = useQuery({ ...settingsQuery(existing?.id), enabled: existing !== null });
  const personas = useQuery(personasQuery);
  const [chosen, setChosen] = useState<Voice | null>(null);
  // Kept so a retry after a refused switch doesn't create her twice.
  const [created, setCreated] = useState<PersonaRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const row = settings.data?.settings.find((candidate) => candidate.path === VOICE);
  const current = ownValue(row);
  // The environment's voice, which she keeps unless one is picked for her.
  const inherited = existing ? inheritedValue(row) : null;
  const name = existing ? existing.name : target.kind === "create" ? target.draft.name : "";
  const ready = chosen !== null || (existing !== null && (current ?? inherited) !== null);

  async function next() {
    setBusy(true);
    setFailure(null);
    try {
      let persona: PersonaRef;
      if (target.kind === "create") {
        if (!chosen) return;
        persona = created ?? (await createPersona(target.draft, chosen.id));
        if (created === null && target.avatar) persona = await addAvatar(persona, target.avatar);
        setCreated(persona);
      } else {
        persona = target.persona;
        if (chosen && chosen.id !== current) await saveVoice(persona.id, chosen.id);
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
      title={t("setup.voice.title")}
      description={t("setup.voice.stepBody", { name })}
      onBack={onBack}
      busy={busy}
      footer={
        <Button onClick={() => void next()} disabled={busy || !ready}>
          {busy && <Spinner />}
          {t(target.kind === "create" ? "setup.voice.create" : "setup.next")}
        </Button>
      }
    >
      {inherited !== null && row && (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            {rich(t("setup.voice.inherited", { name }), {
              env: <code className="font-mono text-foreground">{row.env}</code>,
            })}
          </AlertDescription>
        </Alert>
      )}
      <VoicePicker
        value={chosen?.id ?? current ?? inherited}
        onChange={setChosen}
        disabled={busy}
      />
      {failure && <ErrorAlert error={failure} />}
    </StepCard>
  );
}
