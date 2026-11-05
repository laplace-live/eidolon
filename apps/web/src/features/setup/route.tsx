import { useQuery } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { DoneStep } from "./done-step";
import { KeysStep } from "./keys-step";
import { MemoryStep } from "./memory-step";
import { PersonaStep, type VoiceTarget } from "./persona-step";
import type { PersonaRef } from "./personas";
import { VoiceStep } from "./voice-step";
import { firstStep, nextStep, previousStep, STEPS, type Step } from "./wizard";

function Steps({ step }: { readonly step: Step }) {
  const t = useT();
  const at = STEPS.indexOf(step);
  return (
    <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {STEPS.map((name, index) => (
        <li
          key={name}
          aria-current={index === at ? "step" : undefined}
          className={cn(
            "flex items-center gap-1.5 text-muted-foreground",
            index === at && "font-medium text-foreground",
          )}
        >
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border text-xs",
              index < at && "border-primary bg-primary text-primary-foreground",
              index === at && "border-foreground",
            )}
          >
            {index < at ? <CheckIcon className="size-3" /> : index + 1}
          </span>
          {t(`setup.step.${name}`)}
        </li>
      ))}
    </ol>
  );
}

/** The first-run wizard: keys, persona, voice, memory, then the call. `?step=` opens a later one. */
export function Component() {
  const t = useT();
  const [params] = useSearchParams();
  const status = useQuery(statusQuery);
  const [step, setStep] = useState<Step>(() =>
    status.data ? firstStep(status.data, params.get("step")) : "keys",
  );
  const [target, setTarget] = useState<VoiceTarget | null>(null);
  const [persona, setPersona] = useState<PersonaRef | null>(null);
  const [created, setCreated] = useState(false);
  const keysReady = status.data ? !Object.values(status.data.keys).includes(false) : false;

  const back = () => setStep((current) => previousStep(current) ?? current);
  const forward = () => setStep(nextStep);
  const activeTarget: VoiceTarget | null = status.data
    ? { kind: "existing", persona: status.data.persona }
    : null;
  const voiceTarget = target ?? activeTarget;

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-2">
        <span className="font-heading font-semibold">{t("common.app.name")}</span>
        <div className="flex items-center gap-1">
          {keysReady && (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/">{t("setup.leave")}</Link>
            </Button>
          )}
          <LanguageSwitch />
          <ThemeMenu />
        </div>
      </header>
      <div className="flex flex-col gap-3">
        <h1 className="font-heading font-semibold text-2xl">{t("setup.title")}</h1>
        <Steps step={step} />
      </div>
      {step === "keys" && <KeysStep onDone={forward} />}
      {step === "persona" && (
        <PersonaStep
          initial={target}
          onBack={back}
          onDone={(next) => {
            setTarget(next);
            forward();
          }}
        />
      )}
      {step === "voice" && voiceTarget && (
        <VoiceStep
          target={voiceTarget}
          onBack={back}
          onDone={(done) => {
            // She exists now: going back to this step must not create her a second time.
            if (voiceTarget.kind === "create") {
              setCreated(true);
              setTarget({ kind: "existing", persona: done });
            }
            setPersona(done);
            forward();
          }}
        />
      )}
      {step === "memory" && <MemoryStep onBack={back} onDone={forward} />}
      {step === "done" && <DoneStep persona={persona} created={created} onBack={back} />}
    </div>
  );
}
