// Her voice styles: the voices she switches to when you ask, each with the words that ask for it.
// Hers are edited here and saved whole; the environment's are shown, and one of hers by the same
// name replaces one.
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { LargeDialogContent } from "@/components/large-dialog";
import { ListCard, ListRow } from "@/components/list";
import { SectionCard } from "@/components/section-card";
import { Code, EnvBadge } from "@/components/settings-form/field";
import { refreshSettings, settingsQuery } from "@/components/settings-form/queries";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { VoicePicker } from "@/components/voice-picker";
import {
  call,
  type EnvironmentVoiceStyle,
  type PersonaSummary,
  type SettingsResponse,
  type VoiceStyle,
  type VoiceStyles,
} from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { providerById, providerName } from "@/lib/providers";
import { Hint, LoadError } from "./parts";
import { VoiceById } from "./voice-by-id";
import {
  builtInHint,
  type NameProblem,
  nameProblem,
  withoutStyle,
  withStyle,
} from "./voice-styles";

const NAME_PROBLEMS = {
  empty: msg`Give the style a name.`,
  default: msg`“default” is her own voice: pick another name.`,
  pattern: msg`Start with a lowercase letter, then use lowercase letters, digits or _.`,
  taken: msg`She has a style by that name already.`,
} satisfies Record<NameProblem, unknown>;

function saveStyles(persona: string, styles: readonly VoiceStyle[]): Promise<SettingsResponse> {
  return call("PUT /api/local/personas/:id/voice-styles", {
    params: { id: persona },
    body: { styles },
  });
}

/** The environment's style a style of hers by `name` takes the place of, if any. */
function replaced(styles: VoiceStyles, name: string): EnvironmentVoiceStyle | null {
  return (
    styles.environment.find((style) => style.name === name && style.state !== "ignored") ?? null
  );
}

/** What the model knows a style by: its own words, the built-in ones, or its name alone. */
function TriggerWords({
  style,
  builtInHints,
}: {
  readonly style: VoiceStyle;
  readonly builtInHints: VoiceStyles["builtInHints"];
}) {
  const { t } = useLingui();
  if (style.hint !== "") return t`Trigger words: ${ph({ words: style.hint })}`;
  const builtIn = builtInHint(style.name, builtInHints);
  if (builtIn !== null) return t`Built-in trigger words: ${ph({ words: builtIn })}`;
  return t`No trigger words: the model goes by the name.`;
}

function StyleRow({
  style,
  builtInHints,
  env,
  trailing,
}: {
  readonly style: VoiceStyle;
  readonly builtInHints: VoiceStyles["builtInHints"];
  /** The variable that sets it, for one of the environment's, or that it replaces, for hers. */
  readonly env: EnvironmentVoiceStyle | null;
  readonly trailing: ReactNode;
}) {
  const inherited = env?.state === "inherited";
  const variable = env?.env;
  return (
    <ListRow
      leading={
        <span className="flex size-10 items-center justify-center rounded-full bg-muted">
          <AudioLinesIcon className="size-5" />
        </span>
      }
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{style.name}</span>
          {inherited && <EnvBadge />}
        </span>
      }
      description={
        <span className="flex flex-col gap-1">
          <span>
            <TriggerWords style={style} builtInHints={builtInHints} />
          </span>
          <span className="break-all font-mono text-foreground/80 text-xs">{style.voiceId}</span>
          {variable !== undefined && (
            <span>
              {inherited ? (
                <Trans>
                  From <Code>{variable}</Code> in the environment.
                </Trans>
              ) : (
                <Trans>
                  Replaces <Code>{variable}</Code> in the environment.
                </Trans>
              )}
            </span>
          )}
        </span>
      }
      trailing={trailing}
    />
  );
}

/** Her style's voice: Fish's search or an id, a provider's fixed set, or an id typed in. */
function StyleVoice({
  provider,
  value,
  onChange,
  disabled,
}: {
  readonly provider: string;
  readonly value: string;
  readonly onChange: (voiceId: string) => void;
  readonly disabled: boolean;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const voices = providerById(provider)?.offers.tts?.voices;
  if (voices?.kind === "preset") {
    // A saved voice the set doesn't name stays choosable, so a save doesn't drop it.
    const choices =
      value !== "" && !voices.voices.includes(value) ? [...voices.voices, value] : voices.voices;
    return (
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full sm:w-64" aria-label={t`Voice`}>
          <SelectValue placeholder={t`Pick a voice`} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((voice) => (
            <SelectItem key={voice} value={voice}>
              {voice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (voices?.kind === "id") {
    const name = providerName(provider);
    const library = voices.libraryUrl;
    return (
      <Field>
        <FieldLabel htmlFor={inputId} className="sr-only">
          {t`Voice ID`}
        </FieldLabel>
        <Input
          id={inputId}
          className="font-mono"
          value={value}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <FieldDescription>
          <Trans>
            One of {name}'s voices, by its ID. Find one in its{" "}
            <a href={library} target="_blank" rel="noreferrer noopener">
              voice library
            </a>
            .
          </Trans>
        </FieldDescription>
      </Field>
    );
  }
  return (
    <>
      <VoicePicker
        value={value === "" ? null : value}
        onChange={(voice) => onChange(voice.id)}
        disabled={disabled}
      />
      <VoiceById disabled={disabled} onUse={onChange} />
    </>
  );
}

/** What the dialog opens on: a style of hers to edit, or a new one, maybe from the environment's. */
interface Draft {
  readonly style: VoiceStyle;
  /** The name of the style of hers it edits; null for a new one. */
  readonly editing: string | null;
}

function StyleForm({
  provider,
  styles,
  draft,
  saving,
  error,
  onSave,
  onCancel,
}: {
  readonly provider: string;
  readonly styles: VoiceStyles;
  readonly draft: Draft;
  readonly saving: boolean;
  readonly error: Error | null;
  readonly onSave: (style: VoiceStyle) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useLingui();
  const ids = { form: useId(), name: useId(), hint: useId() };
  const [name, setName] = useState(draft.style.name);
  const [hint, setHint] = useState(draft.style.hint);
  const [voiceId, setVoiceId] = useState(draft.style.voiceId);
  const [showErrors, setShowErrors] = useState(false);
  const typed = name.trim();
  const problem = nameProblem(typed, styles.own, draft.editing);
  // An empty name waits for Save; anything else wrong with it shows as it is typed.
  const shownProblem = problem === "empty" && !showErrors ? null : problem;
  const noVoice = voiceId.trim() === "";
  const builtIn = builtInHint(typed, styles.builtInHints);
  const replacing = problem === null ? (replaced(styles, typed)?.env ?? null) : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    if (problem !== null || noVoice) return;
    onSave({ name: typed, voiceId: voiceId.trim(), hint: hint.trim() });
  }

  return (
    <LargeDialogContent
      title={
        draft.editing === null
          ? t`Add a Voice Style`
          : t`Edit the ${ph({ name: draft.editing })} Style`
      }
      description={t`A voice she switches to when you ask for it. Name it, say how you'd ask, and pick its voice.`}
      footer={
        <DialogFooter className="sticky bottom-0 z-10 m-0 flex-row flex-wrap items-center justify-end gap-2 px-6 py-3 backdrop-blur-md">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            {t`Cancel`}
          </Button>
          <Button type="submit" form={ids.form} disabled={saving}>
            {saving && <Spinner />}
            {t`Save Style`}
          </Button>
        </DialogFooter>
      }
    >
      <form id={ids.form} onSubmit={submit} noValidate>
        <FieldGroup className="gap-5">
          <Field data-invalid={shownProblem !== null}>
            <FieldLabel htmlFor={ids.name}>{t`Name`}</FieldLabel>
            <Input
              id={ids.name}
              className="font-mono"
              value={name}
              maxLength={32}
              placeholder="gentle"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={shownProblem !== null}
              disabled={saving}
              onChange={(event) => setName(event.target.value.toLowerCase())}
            />
            {shownProblem !== null ? (
              <FieldError>{t(NAME_PROBLEMS[shownProblem])}</FieldError>
            ) : (
              <FieldDescription>{t`What the model calls it, such as gentle or nai_hei.`}</FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.hint}>{t`Trigger Words`}</FieldLabel>
            <Input
              id={ids.hint}
              value={hint}
              maxLength={200}
              placeholder={builtIn ?? t`Such as 温柔/轻柔/柔一点`}
              autoComplete="off"
              disabled={saving}
              onChange={(event) => setHint(event.target.value)}
            />
            <FieldDescription>
              {builtIn !== null
                ? t`What you'd say to ask for it. Left empty, the model goes by the built-in words: ${ph({ words: builtIn })}.`
                : t`What you'd say to ask for it. Left empty, the model goes by the name alone.`}
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>
      {replacing !== null && (
        <Hint>
          <Trans>
            It replaces the environment's style by this name, which <Code>{replacing}</Code> sets.
          </Trans>
        </Hint>
      )}
      <div className="border-t pt-6">
        {/* A fieldset grows to fit the voice list's rows unless held to the dialog's width. */}
        <FieldSet className="min-w-0">
          <FieldLegend>{t`Its Voice`}</FieldLegend>
          <StyleVoice provider={provider} value={voiceId} onChange={setVoiceId} disabled={saving} />
          {showErrors && noVoice && <FieldError>{t`Pick a voice for this style.`}</FieldError>}
        </FieldSet>
      </div>
      {error && <ErrorAlert error={error} />}
    </LargeDialogContent>
  );
}

export function VoiceStylesCard({
  persona,
  provider,
}: {
  readonly persona: PersonaSummary;
  /** Her voice's provider, whose voices her styles are. */
  readonly provider: string;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery(persona.id));
  const styles = settings.data?.voiceStyles;
  const own = styles?.own ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  // Each opening starts the form afresh from its draft.
  const [opened, setOpened] = useState(0);
  const [removing, setRemoving] = useState<VoiceStyle | null>(null);

  const save = useMutation({
    mutationFn: ({ style, editing }: { style: VoiceStyle; editing: string | null }) =>
      saveStyles(persona.id, withStyle(own, editing, style)),
    onSuccess: async (response, { style }) => {
      toast.success(t`The ${ph({ name: style.name })} style is saved.`);
      await refreshSettings(queryClient, persona.id, response);
      setOpen(false);
    },
  });
  const remove = useMutation({
    mutationFn: (style: VoiceStyle) => saveStyles(persona.id, withoutStyle(own, style.name)),
    onSuccess: async (response, style) => {
      toast.success(t`The ${ph({ name: style.name })} style is removed.`);
      await refreshSettings(queryClient, persona.id, response);
    },
    onError: toastError,
  });
  const busy = save.isPending || remove.isPending;

  function edit(next: Draft) {
    save.reset();
    setDraft(next);
    setOpened((count) => count + 1);
    setOpen(true);
  }

  const inherited = styles?.environment.filter((style) => style.state === "inherited") ?? [];
  const ignored = styles?.environment.filter((style) => style.state === "ignored") ?? [];
  const empty = own.length === 0 && inherited.length === 0;
  const add = (variant: "default" | "outline") => (
    <Button
      size="sm"
      variant={variant}
      disabled={busy}
      onClick={() => edit({ style: { name: "", voiceId: "", hint: "" }, editing: null })}
    >
      <PlusIcon data-icon="inline-start" />
      {t`Add Style`}
    </Button>
  );
  const ignoredNames = ignored.map((style) => style.env).join(", ");
  const removingFrom = removing && styles ? replaced(styles, removing.name) : null;

  return (
    <SectionCard
      title={t`Voice Styles`}
      description={t`Voices she switches to when you ask for one, as in “声音温柔一点” or “换回原来的”. Her voice above stays her default.`}
      // One add button at a time: the empty state carries it while there are no styles.
      action={styles !== undefined && !empty ? add("outline") : undefined}
    >
      {settings.isPending && <Skeleton className="h-[4.5rem] rounded-xl" />}
      {settings.isError && <LoadError error={settings.error} />}
      {styles !== undefined &&
        (empty ? (
          <EmptyState
            icon={<AudioLinesIcon />}
            title={t`No voice styles yet`}
            description={t`Add one, then ask her for it in a call.`}
            action={add("default")}
          />
        ) : (
          <ListCard label={t`Voice Styles`}>
            {own.map((style) => (
              <StyleRow
                key={style.name}
                style={style}
                builtInHints={styles.builtInHints}
                env={replaced(styles, style.name)}
                trailing={
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t`Edit ${ph({ name: style.name })}`}
                      disabled={busy}
                      onClick={() => edit({ style, editing: style.name })}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t`Remove ${ph({ name: style.name })}`}
                      disabled={busy}
                      onClick={() => setRemoving(style)}
                    >
                      <Trash2Icon />
                    </Button>
                  </>
                }
              />
            ))}
            {inherited.map((env) => {
              const style = { name: env.name, voiceId: env.voiceId, hint: "" };
              return (
                <StyleRow
                  key={env.env}
                  style={style}
                  builtInHints={styles.builtInHints}
                  env={env}
                  trailing={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => edit({ style, editing: null })}
                    >
                      {t`Customize`}
                    </Button>
                  }
                />
              );
            })}
          </ListCard>
        ))}
      {ignored.length > 0 && (
        <Hint>{t`The environment's voice styles go with its voice, which she doesn't use, so these don't apply to her: ${ph({ names: ignoredNames })}.`}</Hint>
      )}
      <Dialog open={open} onOpenChange={(next) => !save.isPending && setOpen(next)}>
        {draft !== null && styles !== undefined && (
          <StyleForm
            key={opened}
            provider={provider}
            styles={styles}
            draft={draft}
            saving={save.isPending}
            error={save.error}
            onSave={(style) => save.mutate({ style, editing: draft.editing })}
            onCancel={() => setOpen(false)}
          />
        )}
      </Dialog>
      <AlertDialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t`Remove the ${ph({ name: removing?.name ?? "" })} style?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removingFrom !== null
                ? t`The environment's style by this name, which ${ph({ env: removingFrom.env })} sets, takes its place again.`
                : t`She can't switch to it anymore, and its voice is removed from her settings.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) remove.mutate(removing);
                setRemoving(null);
              }}
            >
              {t`Remove`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
