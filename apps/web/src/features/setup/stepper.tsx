import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { STEPS, type Step } from "./wizard";

const STEP_LABELS = {
  keys: {
    label: msg`Keys`,
    hint: msg`Your providers`,
  },
  persona: {
    label: msg`Persona`,
    hint: msg`Who you'll talk to`,
  },
  voice: {
    label: msg`Voice`,
    hint: msg`How she sounds`,
  },
  memory: {
    label: msg`Memory`,
    hint: msg`Optional`,
  },
  done: {
    label: msg`Done`,
    hint: msg`Call her`,
  },
} satisfies Record<Step, unknown>;

/** Where the wizard is: a column of steps beside the card, a row of them above it on a phone. */
export function Stepper({ step }: { readonly step: Step }) {
  const { t } = useLingui();
  const at = STEPS.indexOf(step);
  return (
    <ol
      aria-label={t`Setup Steps`}
      className="flex items-center gap-2 md:sticky md:top-24 md:flex-col md:items-stretch md:gap-0"
    >
      {STEPS.map((name, index) => {
        const done = index < at;
        const current = index === at;
        const last = index === STEPS.length - 1;
        return (
          <li
            key={name}
            aria-current={current ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 md:relative md:items-start md:gap-3 md:pb-7",
              current ? "shrink-0" : "min-w-0",
              !last && "flex-1 md:flex-none",
            )}
          >
            <span
              className={cn(
                "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-card font-medium text-muted-foreground text-xs transition-colors",
                done && "border-foreground bg-foreground text-background",
                current && "border-foreground text-foreground ring-4 ring-foreground/10",
              )}
            >
              {done ? <CheckIcon className="size-3.5" strokeWidth={3} /> : index + 1}
            </span>
            <span
              className={cn(
                "flex min-w-0 flex-col md:gap-0.5 md:pt-0.5",
                current ? "" : "sr-only md:not-sr-only",
              )}
            >
              <span
                className={cn(
                  "truncate text-sm",
                  current ? "font-medium text-foreground" : "text-muted-foreground",
                  done && "md:text-foreground",
                )}
              >
                {t(STEP_LABELS[name].label)}
              </span>
              <span className="hidden text-muted-foreground text-xs md:block">
                {t(STEP_LABELS[name].hint)}
              </span>
            </span>
            {!last && (
              <span
                aria-hidden
                className={cn(
                  "h-px min-w-3 flex-1 bg-border md:absolute md:top-6 md:bottom-0 md:left-3 md:h-auto md:w-px md:min-w-0 md:-translate-x-1/2",
                  done && "bg-foreground/60",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
