// Models: how she hears, thinks and speaks in a call (three models, or one realtime model), and
// what she remembers of you.

import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { AudioWaveformIcon, DatabaseIcon, FlaskConicalIcon } from "lucide-react";
import { Link } from "react-router";
import { effectiveProviderType } from "@/components/settings-form/controls";
import { settingsQuery } from "@/components/settings-form/queries";
import { SettingsCard } from "@/components/settings-form/settings-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { accountsQuery } from "@/lib/accounts";
import type { PersonaSummary } from "@/lib/api";
import { studioPath } from "@/lib/paths";
import { providerById, providerName, roleById } from "@/lib/providers";
import { statusQuery } from "@/lib/query";
import { Hint } from "./parts";
import { CARD_PATHS } from "./sections";

const TRADEOFFS = [
  msg`She speaks in one of the realtime model's own voices, not the voice picked for her.`,
  msg`The delivery cues in her prompt aren't performed: she's told to put them in her voice instead.`,
  msg`She can't switch voice styles during a call.`,
  msg`Her knowledge, archive and memories reach the model from the transcript of what you said, so they can trail a quick reply.`,
];

/** What a realtime model changes about her calls, as a list under its card. */
function RealtimeTradeoffs({ provider }: { readonly provider: string }) {
  const { t } = useLingui();
  const experimental = providerById(provider)?.offers.realtime?.experimental === true;
  return (
    <Alert>
      <AudioWaveformIcon />
      <AlertTitle>{t`What changes with ${ph({ provider: providerName(provider) })}`}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          {TRADEOFFS.map((item) => (
            <li key={item.id}>{t(item)}</li>
          ))}
        </ul>
        {experimental && (
          <p className="mt-2 flex items-center gap-1.5">
            <FlaskConicalIcon className="size-3.5 shrink-0" aria-hidden />
            {t`Experimental, and not yet tried in a real call.`}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function ModelsSection({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  const { data: status } = useQuery(statusQuery);
  const settings = useQuery(settingsQuery(persona.id));
  const accounts = useQuery(accountsQuery).data?.accounts;
  const rows = settings.data?.settings ?? [];
  const realtime = effectiveProviderType(roleById("realtime"), rows, {}, accounts);
  const name = persona.shortName || persona.name;
  return (
    <>
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.realtime}
        title={t`How She Talks`}
        description={t`Three models take turns to hear you, think and speak for ${name}. A realtime model does all three in one session, and can answer sooner.`}
      />
      {realtime === null ? (
        <SettingsCard
          scope="persona"
          persona={persona.id}
          paths={CARD_PATHS.models}
          title={t`Models`}
          description={
            <Trans>
              Who hears you and who thinks for her: a provider and a model each. She speaks with the
              voice set under <Link to={studioPath(persona.id, "voice")}>Voice</Link>.
            </Trans>
          }
        />
      ) : (
        <SettingsCard
          scope="persona"
          persona={persona.id}
          paths={CARD_PATHS.realtimeModel}
          title={t`${ph({ provider: providerName(realtime) })} Realtime Model`}
          description={t`The model and voice ${name} talks with. Her speech recognition, chat and voice settings don't apply while it's on.`}
        >
          <RealtimeTradeoffs provider={realtime} />
        </SettingsCard>
      )}
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.memory}
        title={t`Memory`}
        description={t`What she remembers about you from one call to the next: the model that writes memories down, and how many she recalls each turn.`}
      >
        {status?.memory.configured === false && (
          <Hint icon={<DatabaseIcon />}>
            <Trans>
              Memory is off: it needs a Qdrant host, which you set in{" "}
              <Link to="/settings?tab=memory">Settings</Link>.
            </Trans>
          </Hint>
        )}
      </SettingsCard>
    </>
  );
}
