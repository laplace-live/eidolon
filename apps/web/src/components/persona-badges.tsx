import { useLingui } from "@lingui/react/macro";
import { Badge } from "@/components/ui/badge";

/** Whether she is the persona calls reach, and whether she ships with Eidolon. */
export function PersonaBadges({
  active,
  builtIn = false,
}: {
  readonly active: boolean;
  readonly builtIn?: boolean;
}) {
  const { t } = useLingui();
  return (
    <>
      {active && <Badge>{t`Active`}</Badge>}
      {builtIn && <Badge variant="outline">{t`Built in`}</Badge>}
    </>
  );
}
