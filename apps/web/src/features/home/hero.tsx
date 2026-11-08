import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { BookOpenIcon, PhoneIcon } from "lucide-react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { Status } from "@/lib/api";
import { studioPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import type { Verdict } from "./readiness";

const DOT: Readonly<Record<Verdict, string>> = {
  ready: "bg-success",
  attention: "bg-warning",
  blocked: "bg-destructive",
};

const VERDICT_TEXT = {
  ready: msg`Ready for calls`,
  attention: msg`Needs attention`,
  blocked: msg`Calls can't start yet`,
} satisfies Record<Verdict, unknown>;

/** The readiness list in a word, after a dot of its color. */
export function VerdictLabel({ verdict }: { readonly verdict: Verdict }) {
  const { t } = useLingui();
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[verdict])} />
      {t(VERDICT_TEXT[verdict])}
    </span>
  );
}

/** The persona calls reach: who she is, whether a call can start, and the way in. */
export function Hero({
  persona,
  verdict,
}: {
  readonly persona: Status["persona"];
  readonly verdict: Verdict;
}) {
  const { t } = useLingui();
  return (
    <PageHeader
      leading={<PersonaAvatar persona={persona} size="xl" />}
      title={
        <>
          <span className="mb-1 block font-medium text-muted-foreground text-sm tracking-normal">
            {t`Talking to`}
          </span>
          {persona.name}
        </>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-mono">{persona.id}</span>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <VerdictLabel verdict={verdict} />
        </span>
      }
      actions={
        <>
          <Button size="lg" variant="outline" asChild>
            <Link to={studioPath(persona.id)}>
              <BookOpenIcon />
              {t`Open the Studio`}
            </Link>
          </Button>
          <Button size="lg" asChild>
            <Link to="/call">
              <PhoneIcon />
              {t`Call ${ph({ name: persona.shortName || persona.name })}`}
            </Link>
          </Button>
        </>
      }
    />
  );
}
