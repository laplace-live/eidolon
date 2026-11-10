// Chats: whether she answers in text or with her voice, and what the director weighs her by when
// it decides who answers a group's line.

import { isReplyMode, REPLY_MODES } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { SectionCard, SectionCardSkeleton } from "@/components/section-card";
import { changes, controlFor, draftOf, originOf } from "@/components/settings-form/controls";
import { OriginNote } from "@/components/settings-form/field";
import { INVALID_MESSAGES, SETTING_HELP, SETTING_TITLES } from "@/components/settings-form/labels";
import { refreshSettings, settingsQuery } from "@/components/settings-form/queries";
import { SaveActions } from "@/components/settings-form/settings-card";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { REPLY_MODE_LABELS } from "@/features/chats/labels";
import { call, type PersonaSummary, type SettingRow } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { TALKATIVENESS_STEP, talkativenessOf } from "./chat";
import { LoadError } from "./parts";
import { CARD_PATHS } from "./sections";

const [REPLY_MODE, [INTERESTS, TALKATIVENESS]] = CARD_PATHS.chat;

/** The select's item for setting none in her file: the environment's mode applies, else auto. */
const DEFAULT = "default";

function draftsOf(rows: readonly SettingRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.path, draftOf(row.value, controlFor(row))]));
}

function ChatForm({
  persona,
  replyMode,
  interests,
  talkativeness,
}: {
  readonly persona: PersonaSummary;
  readonly replyMode: SettingRow;
  readonly interests: SettingRow;
  readonly talkativeness: SettingRow;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const formId = useId();
  const name = persona.shortName || persona.name;
  const rows = [replyMode, interests, talkativeness];
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>(() => draftsOf(rows));
  const [touched, setTouched] = useState(false);
  const { values, errors } = changes(rows, drafts);
  const invalid = Object.keys(errors).length > 0;
  const dirty = invalid || Object.keys(values).length > 0;
  const modeDraft = drafts[REPLY_MODE] ?? "";
  const inheritedMode = replyMode.envValue?.trim().toLowerCase() ?? "";
  const defaultMode = t(REPLY_MODE_LABELS[isReplyMode(inheritedMode) ? inheritedMode : "auto"]);
  const interestsDraft = drafts[INTERESTS] ?? "";
  const levelDraft = drafts[TALKATIVENESS] ?? "";
  const level = talkativenessOf(levelDraft, talkativeness.envValue);
  const levelError = touched ? (errors[TALKATIVENESS] ?? null) : null;

  const save = useMutation({
    mutationFn: (changed: Record<string, unknown>) =>
      call("PUT /api/local/settings", {
        body: { scope: "persona", persona: persona.id, values: changed },
      }),
    onSuccess: async (response) => {
      toast.success(
        response.restartRequired ? t`Saved. Restart Eidolon to apply it.` : t`Settings saved.`,
      );
      await refreshSettings(queryClient, persona.id, response);
    },
    onError: toastError,
  });

  function draft(path: string, value: string) {
    setDrafts((current) => ({ ...current, [path]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!invalid && dirty) save.mutate(values);
  }

  const help = (path: string) => {
    const line = SETTING_HELP[path];
    return line === undefined ? null : <FieldDescription>{t(line)}</FieldDescription>;
  };
  const title = (path: string) => {
    const label = SETTING_TITLES[path];
    return label === undefined ? path : t(label);
  };

  return (
    <form onSubmit={submit} noValidate>
      <SectionCard
        title={t`Chats`}
        description={t`How she answers in chats. In a chat with several personas, a director decides who answers each line, and weighs her by her interests and talkativeness.`}
        note={
          touched && invalid ? (
            <span className="text-destructive">{t`Fix the highlighted values first.`}</span>
          ) : (
            t`Saved for ${ph({ name })}`
          )
        }
        actions={
          <SaveActions
            dirty={dirty}
            pending={save.isPending}
            onDiscard={() => {
              setDrafts(draftsOf(rows));
              setTouched(false);
            }}
          />
        }
      >
        <Field>
          <FieldLabel htmlFor={`${formId}-reply-mode`}>{title(REPLY_MODE)}</FieldLabel>
          <Select
            value={modeDraft === "" ? DEFAULT : modeDraft}
            onValueChange={(next) => draft(REPLY_MODE, next === DEFAULT ? "" : next)}
            disabled={save.isPending}
          >
            <SelectTrigger id={`${formId}-reply-mode`} className="w-full sm:max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t`Default (${ph({ value: defaultMode })})`}</SelectItem>
              {REPLY_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(REPLY_MODE_LABELS[mode])}
                </SelectItem>
              ))}
              {/* A file's value none of the modes names stays choosable, so a save doesn't drop it. */}
              {modeDraft !== "" && !isReplyMode(modeDraft) && (
                <SelectItem value={modeDraft}>{modeDraft}</SelectItem>
              )}
            </SelectContent>
          </Select>
          {help(REPLY_MODE)}
          <OriginNote row={replyMode} origin={originOf(replyMode, modeDraft)} personaName={name} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-interests`}>{title(INTERESTS)}</FieldLabel>
          <Input
            id={`${formId}-interests`}
            value={interestsDraft}
            onChange={(event) => draft(INTERESTS, event.target.value)}
            placeholder={interests.envValue ?? t`Games, cats, late-night talks`}
            autoComplete="off"
            disabled={save.isPending}
            className="max-w-md"
          />
          {help(INTERESTS)}
          <OriginNote
            row={interests}
            origin={originOf(interests, interestsDraft)}
            personaName={name}
          />
        </Field>
        <Field data-invalid={levelError !== null}>
          <FieldLabel htmlFor={`${formId}-talkativeness`}>{title(TALKATIVENESS)}</FieldLabel>
          <div className="flex max-w-md items-center gap-3">
            <input
              id={`${formId}-talkativeness`}
              type="range"
              min={0}
              max={1}
              step={TALKATIVENESS_STEP}
              value={level}
              onChange={(event) => draft(TALKATIVENESS, event.target.value)}
              disabled={save.isPending}
              className="h-2 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
            <output
              htmlFor={`${formId}-talkativeness`}
              className="w-10 shrink-0 text-right text-sm tabular-nums"
            >
              {level.toFixed(2)}
            </output>
            {levelDraft.trim() !== "" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={save.isPending}
                onClick={() => draft(TALKATIVENESS, "")}
              >
                {t`Reset`}
              </Button>
            )}
          </div>
          {levelError !== null ? (
            <FieldError>
              {INVALID_MESSAGES[levelError] ? t(INVALID_MESSAGES[levelError]) : levelError}
            </FieldError>
          ) : (
            help(TALKATIVENESS)
          )}
          <OriginNote
            row={talkativeness}
            origin={originOf(talkativeness, levelDraft)}
            personaName={name}
          />
        </Field>
      </SectionCard>
    </form>
  );
}

export function ChatSection({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  const settings = useQuery(settingsQuery(persona.id));
  const find = (path: string) => settings.data?.settings.find((row) => row.path === path);
  const replyMode = find(REPLY_MODE);
  const interests = find(INTERESTS);
  const talkativeness = find(TALKATIVENESS);
  if (settings.isPending) return <SectionCardSkeleton rows={3} />;
  if (
    settings.isError ||
    replyMode === undefined ||
    interests === undefined ||
    talkativeness === undefined
  ) {
    return (
      <SectionCard title={t`Chats`}>
        <LoadError error={settings.error} />
      </SectionCard>
    );
  }
  return (
    // Saved values start a fresh draft.
    <ChatForm
      key={JSON.stringify([replyMode.value, interests.value, talkativeness.value])}
      persona={persona}
      replyMode={replyMode}
      interests={interests}
      talkativeness={talkativeness}
    />
  );
}
