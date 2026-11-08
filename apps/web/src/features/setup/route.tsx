import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AppMark } from "@/components/app-mark";
import { PageHeader } from "@/components/page-header";
import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { Button } from "@/components/ui/button";
import { statusQuery } from "@/lib/query";
import { DoneStep } from "./done-step";
import { KeysStep } from "./keys-step";
import { MemoryStep } from "./memory-step";
import { PersonaStep, type VoiceTarget } from "./persona-step";
import type { PersonaRef } from "./personas";
import { Stepper } from "./stepper";
import { VoiceStep } from "./voice-step";
import { firstStep, nextStep, previousStep, type Step } from "./wizard";

/** The first-run wizard: keys, persona, voice, memory, then the call. `?step=` opens a later one. */
export function Component() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const status = useQuery(statusQuery);
  const [step, setStep] = useState<Step>(() =>
    status.data ? firstStep(status.data, params.get("step")) : "keys",
  );
  const [target, setTarget] = useState<VoiceTarget | null>(null);
  const [persona, setPersona] = useState<PersonaRef | null>(null);
  const [created, setCreated] = useState(false);
  const keysReady = status.data ? status.data.keys.every((key) => key.set) : false;

  const back = () => setStep((current) => previousStep(current) ?? current);
  const forward = () => setStep(nextStep);
  const activeTarget: VoiceTarget | null = status.data
    ? { kind: "existing", persona: status.data.persona }
    : null;
  const voiceTarget = target ?? activeTarget;

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2.5 px-4 sm:px-6">
          <span className="flex shrink-0 items-center gap-2.5 font-semibold">
            <AppMark />
            <span className="tracking-tight">Eidolon</span>
          </span>
          <span aria-hidden className="hidden text-lg text-muted-foreground/40 sm:inline">
            /
          </span>
          <span className="hidden truncate text-muted-foreground text-sm sm:inline">
            {t`Setup`}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {keysReady && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/">{t`Leave Setup`}</Link>
              </Button>
            )}
            <LanguageSwitch />
            <ThemeMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
        <PageHeader
          title={t`Set Up Eidolon`}
          description={t`Four short steps: your keys, who you'll talk to, her voice, and memory.`}
        />
        <div className="grid items-start gap-8 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-10">
          <Stepper step={step} />
          <div className="min-w-0">
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
        </div>
      </main>
    </div>
  );
}
