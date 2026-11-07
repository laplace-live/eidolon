import { SettingsCard } from "@/components/settings-form/settings-card";
import type { PersonaSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { SHOWN_PATHS } from "./sections";

/** Every setting of hers the other sections don't show. */
export function AdvancedSection({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  return (
    <SettingsCard
      scope="persona"
      persona={persona.id}
      exclude={SHOWN_PATHS}
      title={t("studio.advanced.title")}
      description={t("studio.advanced.description")}
    />
  );
}
