// A skill of the owner's own, written into Eidolon's skills folder: its name, what it is for, which
// tasks choose it by, and its instructions.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { type SubmitEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { call, type SkillsResponse, type SkillView } from "@/lib/api";
import { isSkillName } from "./skills";

/** agentskills.io's longest description. */
const MAX_DESCRIPTION = 1024;

export interface NewSkillDialogProps {
  readonly open: boolean;
  /** Eidolon's skills folder, where it is written. */
  readonly folder: string;
  /** The owner's skills as Settings lists them, to say what a name would clash with. */
  readonly skills: readonly SkillView[];
  readonly onClose: () => void;
  /** The skills as the POST answers them, the new one among them. */
  readonly onAdded: (skills: SkillsResponse) => void;
}

export function NewSkillDialog({ open, folder, skills, onClose, onAdded }: NewSkillDialogProps) {
  const { t } = useLingui();
  const ids = { name: useId(), description: useId(), instructions: useId() };
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [tried, setTried] = useState(false);

  const trimmed = name.trim();
  const save = useMutation({
    mutationFn: () =>
      call("POST /api/local/skills", { body: { name: trimmed, description, instructions } }),
    onSuccess: (data) => {
      onAdded(data);
      toast.success(t`${ph({ name: trimmed })} added.`);
      onClose();
    },
  });
  const { reset } = save;

  // Every opening starts from an empty form, a failed save's error gone with it.
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setInstructions("");
    setTried(false);
    reset();
  }, [open, reset]);

  const same = skills.filter((skill) => skill.name === trimmed);
  const nameProblem =
    trimmed === ""
      ? t`A skill needs a name.`
      : !isSkillName(trimmed)
        ? t`Use lowercase letters, digits and single hyphens, 64 at most.`
        : same.some((skill) => skill.source === "eidolon")
          ? t`Eidolon's skills folder already has a skill by this name.`
          : null;
  const descriptionProblem =
    description.trim() === "" ? t`Say what it does and when to use it.` : null;
  const instructionsProblem = instructions.trim() === "" ? t`A skill needs instructions.` : null;
  const busy = save.isPending;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setTried(true);
    if (nameProblem === null && descriptionProblem === null && instructionsProblem === null) {
      save.mutate();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t`Add Skill`}</DialogTitle>
          <DialogDescription>{t`Written as a SKILL.md in Eidolon's skills folder, where you can edit it later. Tasks see its name and description, and read the rest when the work calls for it.`}</DialogDescription>
        </DialogHeader>
        <form id="new-skill-form" onSubmit={submit} noValidate>
          <FieldGroup className="gap-5">
            <Field data-invalid={tried && nameProblem !== null}>
              <FieldLabel htmlFor={ids.name}>{t`Name`}</FieldLabel>
              <Input
                id={ids.name}
                value={name}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                className="font-mono md:text-[0.8125rem]"
                placeholder="house-style"
                aria-invalid={tried && nameProblem !== null}
                onChange={(event) => setName(event.target.value.toLowerCase())}
                disabled={busy}
              />
              {tried && nameProblem !== null ? (
                <FieldError>{nameProblem}</FieldError>
              ) : (
                <FieldDescription className="wrap-anywhere">
                  {same.some((skill) => skill.source === "shared")
                    ? t`It will be used instead of the shared skill of the same name.`
                    : same.some((skill) => skill.source === "builtin")
                      ? t`It will be used instead of the built-in skill of the same name.`
                      : t`Lowercase letters, digits and hyphens. Saved as ${ph({ path: `${folder}/${trimmed || "…"}/SKILL.md` })}.`}
                </FieldDescription>
              )}
            </Field>
            <Field data-invalid={tried && descriptionProblem !== null}>
              <FieldLabel htmlFor={ids.description}>{t`Description`}</FieldLabel>
              <Textarea
                id={ids.description}
                value={description}
                rows={2}
                maxLength={MAX_DESCRIPTION}
                placeholder={t`Our house style for web pages. Use when making or editing any HTML page.`}
                aria-invalid={tried && descriptionProblem !== null}
                onChange={(event) => setDescription(event.target.value)}
                disabled={busy}
              />
              {tried && descriptionProblem !== null ? (
                <FieldError>{descriptionProblem}</FieldError>
              ) : (
                <FieldDescription>{t`What it does and when to use it: a task picks a skill by this alone.`}</FieldDescription>
              )}
            </Field>
            <Field data-invalid={tried && instructionsProblem !== null}>
              <FieldLabel htmlFor={ids.instructions}>{t`Instructions`}</FieldLabel>
              <Textarea
                id={ids.instructions}
                value={instructions}
                className="max-h-80 min-h-40 font-mono md:text-[0.8125rem]"
                placeholder={t`Steps, rules and examples, in Markdown`}
                aria-invalid={tried && instructionsProblem !== null}
                onChange={(event) => setInstructions(event.target.value)}
                disabled={busy}
              />
              {tried && instructionsProblem !== null ? (
                <FieldError>{instructionsProblem}</FieldError>
              ) : (
                <FieldDescription>{t`A task reads them once it chooses the skill, or from its start when you name the skill to her.`}</FieldDescription>
              )}
            </Field>
            {save.isError && <ErrorAlert error={save.error} />}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button type="submit" form="new-skill-form" disabled={busy}>
            {busy && <Spinner />}
            {t`Add Skill`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
