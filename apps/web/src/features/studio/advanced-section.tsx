import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "@/components/settings-form/queries";
import { SettingsCard } from "@/components/settings-form/settings-card";
import { FileWarnings } from "@/features/settings/notices";
import type { PersonaSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { SHOWN_PATHS } from "./sections";

/**
 * Every setting of hers the other sections don't show, and what the files her settings come from
 * hold that is ignored.
 */
export function AdvancedSection({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const warnings = useQuery(settingsQuery(persona.id)).data?.warnings ?? [];
  return (
    <>
      {warnings.length > 0 && <FileWarnings warnings={warnings} />}
      <SettingsCard
        scope="persona"
        persona={persona.id}
        exclude={SHOWN_PATHS}
        title={t("studio.advanced.title")}
        description={t("studio.advanced.description")}
      />
    </>
  );
}
