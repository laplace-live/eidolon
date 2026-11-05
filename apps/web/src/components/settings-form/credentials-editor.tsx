// The settings page's key list: credentials.json's keys, never shown back once saved.
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, errorKey } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { CHECK_OF, OPTIONAL, REQUIRED } from "./credentials";
import { KeyField } from "./key-field";
import { useKeys } from "./use-keys";

export function CredentialsEditor() {
  const t = useT();
  const keys = useKeys();
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  if (keys.credentials.isPending) return <Skeleton className="h-40 w-full" />;
  if (keys.credentials.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t(errorKey(keys.credentials.error))}</AlertTitle>
        <AlertDescription>{keys.credentials.error.message}</AlertDescription>
      </Alert>
    );
  }

  const dirty = Object.values(keys.typed).some((value) => value.trim() !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    try {
      const { saved } = await keys.save();
      toast.success(t("settings.credentials.saved"));
      await Promise.all(saved.filter((name) => CHECK_OF[name]).map((name) => keys.check(name)));
    } catch (error) {
      setFailure(error instanceof ApiError ? error : new ApiError(0, "unreachable", String(error)));
    }
  }

  async function remove(name: string) {
    setFailure(null);
    try {
      await keys.remove(name);
      toast.success(t("settings.credentials.removed"));
    } catch (error) {
      setFailure(error instanceof ApiError ? error : new ApiError(0, "unreachable", String(error)));
    }
  }

  const field = (name: string, pages: boolean) => (
    <KeyField
      key={name}
      name={name}
      keys={keys}
      pages={pages}
      removable
      onRemove={() => setRemoving(name)}
    />
  );

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} autoComplete="off">
      <p className="text-muted-foreground text-sm">{t("settings.credentials.intro")}</p>
      <FieldSet>
        <FieldLegend>{t("settings.credentials.required")}</FieldLegend>
        <FieldGroup>{REQUIRED.map((name) => field(name, true))}</FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend>{t("settings.credentials.optional")}</FieldLegend>
        <p className="-mt-2 text-muted-foreground text-sm">
          {t("settings.credentials.optionalBody")}
        </p>
        <FieldGroup>{OPTIONAL.map((name) => field(name, false))}</FieldGroup>
      </FieldSet>
      {failure && (
        <Alert variant="destructive">
          <AlertTitle>{t(errorKey(failure))}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button type="submit" disabled={!dirty || keys.saving}>
          {keys.saving && <Spinner />}
          {t("settings.credentials.save")}
        </Button>
      </div>

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
