import type { ParticipantId } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { type ReplyReason, scoreTable } from "./group";
import { SOURCE_LABELS } from "./labels";
import { type ChatPersona, shortNameOf } from "./persona";

function score(value: number | null): string {
  return value === null ? "–" : value.toFixed(2);
}

/**
 * A quiet button on her message that shows the decision behind it: how the director chose, and its
 * scores, for calibrating it.
 */
export function WhyAnswered({
  persona,
  reason,
  personaOf,
}: {
  readonly persona: ChatPersona;
  readonly reason: ReplyReason;
  readonly personaOf: (id: ParticipantId) => ChatPersona;
}) {
  const { t } = useLingui();
  const name = shortNameOf(persona);
  const { rows, invites } = scoreTable(reason.scores);
  const to =
    reason.to === null
      ? null
      : reason.to.kind === "user"
        ? t`She answered your line.`
        : t`She answered ${ph({ name: shortNameOf(personaOf(reason.to.id)) })}'s line.`;
  const title = t`Why ${name} Answered`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground/50 hover:text-muted-foreground"
          aria-label={title}
        >
          <InfoIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3">
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
          <PopoverDescription>{t(SOURCE_LABELS[reason.source])}</PopoverDescription>
          {to !== null && <PopoverDescription>{to}</PopoverDescription>}
        </PopoverHeader>
        {rows.length > 0 && (
          <div className="flex flex-col gap-2">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 text-left font-normal">
                    {t`Persona`}
                  </th>
                  <th scope="col" className="py-1 text-right font-normal">
                    {t`Addressed`}
                  </th>
                  <th scope="col" className="py-1 text-right font-normal">
                    {t`Interested`}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.persona}
                    className={cn("border-t", row.persona === persona.id && "font-medium")}
                  >
                    <th scope="row" className="max-w-32 truncate py-1 text-left font-[inherit]">
                      {shortNameOf(personaOf(row.persona))}
                    </th>
                    <td className="py-1 text-right">{score(row.addressed)}</td>
                    <td className="py-1 text-right">{score(row.interested)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {invites !== null && (
              <p className="text-xs tabular-nums">
                {t`Invites a reply: ${ph({ score: score(invites) })}`}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              {t`Each score runs from 0 to 1. Addressed: the line was for her. Interested: it touches what she cares about.`}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
