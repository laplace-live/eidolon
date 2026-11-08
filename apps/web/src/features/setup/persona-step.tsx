import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { PersonaAvatar } from "@/components/avatar";
import { ErrorAlert } from "@/components/error-alert";
import { PersonaBadges } from "@/components/persona-badges";
import { SectionCardSkeleton } from "@/components/section-card";
import { browserTimeZone, parseDraft } from "@/components/settings-form/controls";
import { personasQuery, settingsQuery } from "@/components/settings-form/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type ApiError, asApiError, call } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AvatarPicker } from "./avatar-picker";
import { MandarinNote, PersonaFields } from "./persona-fields";
import type { PersonaRef } from "./personas";
import { StepCard } from "./step-card";
import { DEMO_PERSONA, EMPTY_PERSONA, type PersonaDraft, personaErrors } from "./wizard";

/** Whose voice the next step picks: a persona that exists, or one it will create. */
export type VoiceTarget =
  | { readonly kind: "existing"; readonly persona: PersonaRef }
  | { readonly kind: "create"; readonly draft: PersonaDraft; readonly avatar: File | null };

type Choice = "demo" | "current" | "create";

const VIEWER_NAME = "local.viewerName";

function ChoiceCard({
  selected,
  onSelect,
  leading,
  title,
  badge,
  body,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly leading: ReactNode;
  readonly title: ReactNode;
  readonly badge?: ReactNode;
  readonly body: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-4 rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected && "border-foreground/70 ring-1 ring-foreground/70 hover:bg-card",
      )}
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 font-medium text-sm">
          {title}
          {badge}
        </span>
        <span className="text-muted-foreground text-sm">{body}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected && "border-foreground bg-foreground text-background",
        )}
      >
        {selected && <CheckIcon className="size-3" strokeWidth={3} />}
      </span>
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
  const { t } = useLingui();
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
  const [avatar, setAvatar] = useState<File | null>(() =>
    initial?.kind === "create" ? initial.avatar : null,
  );
  const [viewerName, setViewerName] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  if (personas.isPending || settings.isPending) return <SectionCardSkeleton rows={3} />;
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
      if (chosen === "create") onDone({ kind: "create", draft, avatar });
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
      title={t`Who will you talk to?`}
      description={t`Start with the demo persona, or create your own and build her up later in the studio.`}
      onBack={onBack}
      busy={busy}
      footer={
        <Button onClick={() => void next()} disabled={busy}>
          {busy && <Spinner />}
          {t`Continue`}
        </Button>
      }
    >
      <Field className="max-w-md">
        <FieldLabel htmlFor={nameId}>{t`What should she call you?`}</FieldLabel>
        <Input
          id={nameId}
          value={name}
          placeholder={t`Your name or nickname`}
          disabled={busy || nameRow?.envOverride}
          onChange={(event) => setViewerName(event.target.value)}
        />
        <FieldDescription>
          {nameRow?.envOverride
            ? t`Set by ${ph({ env: nameRow.env })} in the environment, which wins over the value saved here. Change it there.`
            : t`She uses it in calls. Leave it empty and she won't use a name.`}
        </FieldDescription>
      </Field>

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="sr-only">{t`Persona`}</legend>
        {demo && (
          <ChoiceCard
            selected={chosen === "demo"}
            onSelect={() => setChoice("demo")}
            leading={<PersonaAvatar persona={demo} size="md" />}
            title={demo.name}
            badge={<Badge variant="outline">{t`demo`}</Badge>}
            body={t`A Chinese VTuber who runs a little flower shop with her cat. She comes with her prompt and outfits, ready to call.`}
          />
        )}
        {current && (
          <ChoiceCard
            selected={chosen === "current"}
            onSelect={() => setChoice("current")}
            leading={<PersonaAvatar persona={current} size="md" />}
            title={current.name}
            badge={<PersonaBadges active />}
            body={t`Keep talking to her.`}
          />
        )}
        <ChoiceCard
          selected={chosen === "create"}
          onSelect={() => setChoice("create")}
          leading={
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground">
              <PlusIcon className="size-4" />
            </span>
          }
          title={t`Create Your Own`}
          body={t`Starts with a Chinese prompt skeleton in her name. Add facts, videos and outfits in the studio.`}
        />
      </fieldset>

      <MandarinNote />

      {chosen === "create" && (
        <div className="flex flex-col gap-6 border-t pt-6">
          <AvatarPicker
            file={avatar}
            onFile={setAvatar}
            name={draft.shortName || draft.name}
            disabled={busy}
          />
          <PersonaFields
            draft={draft}
            onDraft={setDraft}
            taken={taken}
            showErrors={showErrors}
            disabled={busy}
          />
        </div>
      )}

      {failure && <ErrorAlert error={failure} />}
    </StepCard>
  );
}
