// Mind: the models she thinks and hears with, and what she remembers of you.
import { useQuery } from "@tanstack/react-query";
import { DatabaseIcon } from "lucide-react";
import { Link } from "react-router";
import { SettingsCard } from "@/components/settings-form/settings-card";
import type { PersonaSummary } from "@/lib/api";
import { rich, useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { Hint } from "./parts";
import { CARD_PATHS } from "./sections";

export function ModelsSection({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const { data: status } = useQuery(statusQuery);
  return (
    <>
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.models}
        title={t("studio.models.title")}
        description={t("studio.models.description")}
      />
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.memory}
        title={t("studio.memory.title")}
        description={t("studio.memory.description")}
      >
        {status?.memory.configured === false && (
          <Hint icon={<DatabaseIcon />}>
            {rich(t("studio.memory.off"), {
              settings: <Link to="/settings?tab=memory">{t("common.nav.settings")}</Link>,
            })}
          </Hint>
        )}
      </SettingsCard>
    </>
  );
}
