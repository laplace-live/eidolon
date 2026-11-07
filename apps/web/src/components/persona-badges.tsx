import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";

/** Whether she is the persona calls reach, and whether she ships with Eidolon. */
export function PersonaBadges({
  active,
  builtIn = false,
}: {
  readonly active: boolean;
  readonly builtIn?: boolean;
}) {
  const t = useT();
  return (
    <>
      {active && <Badge>{t("common.persona.active")}</Badge>}
      {builtIn && <Badge variant="outline">{t("common.persona.builtIn")}</Badge>}
    </>
  );
}
