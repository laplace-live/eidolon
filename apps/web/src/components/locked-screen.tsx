import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { type FormEvent, useId, useState } from "react";
import { useRevalidator } from "react-router";
import { AppMark } from "@/components/app-mark";
import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/labels";
import { exchangeLinkCode, linkCodeIn } from "@/lib/session";

const EXPIRED = msg`That link has expired or isn't valid. A link works for 10 minutes: run the same command again for a fresh one.`;
const INVALID = msg`That isn't an Eidolon link.`;

/** Shown without a session: open the terminal's link, or paste it here. */
export function LockedScreen({ expired }: { readonly expired: boolean }) {
  const { t } = useLingui();
  const id = useId();
  const revalidator = useRevalidator();
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState<MessageDescriptor | null>(expired ? EXPIRED : null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const code = linkCodeIn(link);
    if (!code) {
      setProblem(INVALID);
      return;
    }
    setBusy(true);
    const failure = await exchangeLinkCode(code);
    setBusy(false);
    if (!failure) await revalidator.revalidate();
    else if (failure.code === "link-expired") setProblem(EXPIRED);
    else if (failure.code === "unauthorized") setProblem(INVALID);
    else setProblem(errorMessage(failure));
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-2.5 font-semibold tracking-tight">
        <AppMark />
        Eidolon
      </div>
      <form className="w-full max-w-md" onSubmit={submit}>
        <SectionCard
          title={t`Open Eidolon from Your Terminal`}
          description={t`This page needs the link Eidolon printed in the terminal where it is running. Open that link, or paste it here.`}
          note={t`A link works for 10 minutes.`}
          actions={
            <Button type="submit" disabled={busy || link.trim() === ""}>
              {busy && <Spinner />}
              {t`Open`}
            </Button>
          }
        >
          <Field data-invalid={problem !== null}>
            <FieldLabel htmlFor={id}>{t`Link from the Terminal`}</FieldLabel>
            <Input
              id={id}
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="http://localhost:7860/#…"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problem !== null}
            />
            {problem && <FieldError>{t(problem)}</FieldError>}
          </Field>
        </SectionCard>
      </form>
      <div className="flex gap-1">
        <LanguageSwitch />
        <ThemeMenu />
      </div>
    </div>
  );
}
