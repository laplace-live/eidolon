import { type FormEvent, useId, useState } from "react";
import { useRevalidator } from "react-router";
import { AppMark } from "@/components/app-mark";
import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorKey } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { exchangeLinkCode, linkCodeIn } from "@/lib/session";

/** Shown without a session: open the terminal's link, or paste it here. */
export function LockedScreen({ expired }: { readonly expired: boolean }) {
  const t = useT();
  const id = useId();
  const revalidator = useRevalidator();
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState(expired ? "common.locked.expired" : null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const code = linkCodeIn(link);
    if (!code) {
      setProblem("common.locked.invalid");
      return;
    }
    setBusy(true);
    const failure = await exchangeLinkCode(code);
    setBusy(false);
    if (!failure) await revalidator.revalidate();
    else if (failure.code === "link-expired") setProblem("common.locked.expired");
    else if (failure.code === "unauthorized") setProblem("common.locked.invalid");
    else setProblem(errorKey(failure));
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-2.5 font-semibold tracking-tight">
        <AppMark />
        {t("common.app.name")}
      </div>
      <form className="w-full max-w-md" onSubmit={submit}>
        <SectionCard
          title={t("common.locked.title")}
          description={t("common.locked.body")}
          note={t("common.locked.note")}
          actions={
            <Button type="submit" disabled={busy || link.trim() === ""}>
              {busy && <Spinner />}
              {t("common.locked.submit")}
            </Button>
          }
        >
          <Field data-invalid={problem !== null}>
            <FieldLabel htmlFor={id}>{t("common.locked.label")}</FieldLabel>
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
