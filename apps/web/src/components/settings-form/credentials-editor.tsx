// The settings page's keys: credentials.json's, never shown back once saved. Each card saves only
// the keys typed into it.
import { LockIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { SectionCard, SectionCardSkeleton } from "@/components/section-card";
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
import { Spinner } from "@/components/ui/spinner";
import { type ApiError, asApiError } from "@/lib/api";
import { rich, useT } from "@/lib/i18n";
import { CHECK_OF, OPTIONAL, REQUIRED } from "./credentials";
import { KeyField } from "./key-field";
import { useKeys } from "./use-keys";

interface KeysCardProps {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly names: readonly string[];
  /** The sign-up link and credit note under each key. */
  readonly pages?: boolean;
}

function KeysCard({ title, description, names, pages = false }: KeysCardProps) {
  const t = useT();
  const keys = useKeys();
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  if (keys.credentials.isPending) return <SectionCardSkeleton rows={names.length} />;
  if (keys.credentials.isError) {
    return (
      <SectionCard title={title} description={description}>
        <ErrorAlert error={keys.credentials.error} />
      </SectionCard>
    );
  }

  const dirty = names.some((name) => (keys.typed[name] ?? "").trim() !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    try {
      const { saved } = await keys.save();
      toast.success(t("settings.credentials.saved"));
      await Promise.all(saved.filter((name) => CHECK_OF[name]).map((name) => keys.check(name)));
    } catch (error) {
      setFailure(asApiError(error));
    }
  }

  async function remove(name: string) {
    setFailure(null);
    try {
      await keys.remove(name);
      toast.success(t("settings.credentials.removed"));
    } catch (error) {
      setFailure(asApiError(error));
    }
  }

  return (
    <form onSubmit={submit} autoComplete="off">
      <SectionCard
        title={title}
        description={description}
        note={
          <span className="flex items-start gap-2">
            <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("settings.credentials.note")}
          </span>
        }
        actions={
          <>
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                disabled={keys.saving}
                onClick={() => {
                  keys.discard();
                  setFailure(null);
                }}
              >
                {t("settings.form.discard")}
              </Button>
            )}
            <Button type="submit" disabled={!dirty || keys.saving}>
              {keys.saving && <Spinner />}
              {t("settings.credentials.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-7">
          {names.map((name) => (
            <KeyField
              key={name}
              name={name}
              keys={keys}
              pages={pages}
              removable
              onRemove={() => setRemoving(name)}
            />
          ))}
        </div>
        {failure && <ErrorAlert error={failure} />}
      </SectionCard>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.credentials.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.credentials.removeBody", { env: removing ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.credentials.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) void remove(removing);
                setRemoving(null);
              }}
            >
              {t("settings.credentials.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

export function CredentialsEditor() {
  const t = useT();
  return (
    <>
      <KeysCard
        title={t("settings.credentials.required")}
        description={t("settings.credentials.requiredBody")}
        names={REQUIRED}
        pages
      />
      <KeysCard
        title={t("settings.credentials.optional")}
        description={rich(t("settings.credentials.optionalBody"), {
          providers: (
            <Link
              to="/settings?tab=providers"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t("settings.nav.providers")}
            </Link>
          ),
        })}
        names={OPTIONAL}
      />
    </>
  );
}
