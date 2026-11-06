import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { PersonaAvatar } from "@/components/avatar";
import { ErrorAlert } from "@/components/error-alert";
import { browserTimeZone, parseDraft } from "@/components/settings-form/controls";
import { personasQuery, settingsQuery } from "@/components/settings-form/queries";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { type ApiError, asApiError, call } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { MandarinNote, PersonaFields } from "./persona-fields";
import type { PersonaRef } from "./personas";
import { StepCard } from "./step-card";
import { DEMO_PERSONA, EMPTY_PERSONA, type PersonaDraft, personaErrors } from "./wizard";

/** Whose voice the next step picks: a persona that exists, or one it will create. */
export type VoiceTarget =
  | { readonly kind: "existing"; readonly persona: PersonaRef }
  | { readonly kind: "create"; readonly draft: PersonaDraft };

type Choice = "demo" | "current" | "create";

const VIEWER_NAME = "local.viewerName";

function ChoiceCard({
  selected,
  onSelect,
  children,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
        selected && "border-primary bg-primary/5 hover:bg-primary/5",
      )}
    >
      {children}
    </button>
  );
}

export function PersonaStep({
  initial,
  onBack,
  onDone,
}: {
  readonly initial: VoiceTarget | null;
  readonly onBack: () => void;
  readonly onDone: (target: VoiceTarget) => void;
}) {
  const t = useT();
  const nameId = useId();
  const queryClient = useQueryClient();
  const personas = useQuery(personasQuery);
  const settings = useQuery(settingsQuery());
  const [choice, setChoice] = useState<Choice | null>(() => {
    if (initial?.kind === "create") return "create";
    if (initial?.kind === "existing") {
      return initial.persona.id === DEMO_PERSONA ? "demo" : "current";
    }
    return null;
  });
  const [draft, setDraft] = useState<PersonaDraft>(() =>
    initial?.kind === "create" ? initial.draft : { ...EMPTY_PERSONA, timezone: browserTimeZone() },
  );
  const [viewerName, setViewerName] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  if (personas.isPending || settings.isPending) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (personas.isError || settings.isError) {
    const error = personas.error ?? settings.error;
    return <ErrorAlert error={error} />;
  }

  const list = personas.data.personas;
  const demo = list.find((persona) => persona.id === DEMO_PERSONA);
  const active = list.find((persona) => persona.id === personas.data.active);
  const current = active && active.id !== DEMO_PERSONA ? active : undefined;
  // A rerun keeps the active persona instead of switching to the demo.
  const chosen: Choice = choice ?? (current ? "current" : demo ? "demo" : "create");
  const nameRow = settings.data.settings.find((row) => row.path === VIEWER_NAME);
  const savedName = typeof nameRow?.value === "string" ? nameRow.value : "";
  const name = viewerName ?? savedName;
  const taken = list.map((persona) => persona.id);

  async function next() {
    if (chosen === "create" && Object.keys(personaErrors(draft, taken)).length > 0) {
      setShowErrors(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const parsed = parseDraft(name, { type: "text" });
      const value = parsed.ok ? parsed.value : null;
      if ((value ?? "") !== savedName && !nameRow?.envOverride) {
        await call("PUT /api/local/settings", {
          body: { scope: "app", values: { [VIEWER_NAME]: value } },
        });
        await queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
      if (chosen === "create") onDone({ kind: "create", draft });
      else {
        const persona = chosen === "demo" ? demo : current;
        if (persona) onDone({ kind: "existing", persona });
      }
    } catch (error) {
      setFailure(asApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      title={t("setup.persona.title")}
      description={t("setup.persona.body")}
      onBack={onBack}
      busy={busy}
      footer={
        <Button onClick={() => void next()} disabled={busy}>
          {busy && <Spinner />}
          {t("setup.next")}
        </Button>
      }
    >
      <Field>
        <FieldLabel htmlFor={nameId}>{t("setup.persona.viewerName")}</FieldLabel>
        <Input
          id={nameId}
          value={name}
          placeholder={t("setup.persona.viewerNamePlaceholder")}
          disabled={busy || nameRow?.envOverride}
          onChange={(event) => setViewerName(event.target.value)}
        />
        <FieldDescription>
          {nameRow?.envOverride
            ? t("settings.form.envOverride", { env: nameRow.env })
            : t("setup.persona.viewerNameHelp")}
        </FieldDescription>
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t("setup.persona.choose")}</legend>
        {demo && (
          <ChoiceCard selected={chosen === "demo"} onSelect={() => setChoice("demo")}>
            <PersonaAvatar persona={demo} size="md" />
            <span className="flex flex-col gap-1">
              <span className="font-medium">
                {demo.name}{" "}
                <span className="text-muted-foreground">· {t("setup.persona.demo")}</span>
              </span>
              <span className="text-muted-foreground text-sm">{t("setup.persona.demoBody")}</span>
            </span>
          </ChoiceCard>
        )}
        {current && (
          <ChoiceCard selected={chosen === "current"} onSelect={() => setChoice("current")}>
            <PersonaAvatar persona={current} size="md" />
            <span className="flex flex-col gap-1">
              <span className="font-medium">{current.name}</span>
              <span className="text-muted-foreground text-sm">{t("setup.persona.keepBody")}</span>
            </span>
          </ChoiceCard>
        )}
        <ChoiceCard selected={chosen === "create"} onSelect={() => setChoice("create")}>
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted">
            <SparklesIcon className="size-5 text-muted-foreground" />
          </span>
          <span className="flex flex-col gap-1">
            <span className="font-medium">{t("setup.persona.create")}</span>
            <span className="text-muted-foreground text-sm">{t("setup.persona.createBody")}</span>
          </span>
        </ChoiceCard>
      </fieldset>

      <MandarinNote />

      {chosen === "create" && (
        <PersonaFields
          draft={draft}
          onDraft={setDraft}
          taken={taken}
          showErrors={showErrors}
          disabled={busy}
        />
      )}

      {failure && <ErrorAlert error={failure} />}
    </StepCard>
  );
}
