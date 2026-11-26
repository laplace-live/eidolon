import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { type SubmitEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useCallPresence } from "@/features/call/call-context";
import { usePairSubspaceServer } from "./queries";

export function AddSubspaceServerDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const codeId = useId();
  const nameId = useId();
  const activateId = useId();
  const { up } = useCallPresence();

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [activate, setActivate] = useState(true);

  const resetForm = () => {
    setCode("");
    setName("");
    setActivate(true);
  };

  const pair = usePairSubspaceServer((state) => {
    const paired = state.servers.find((s) => s.id === state.pairedServerId);
    const pairedName = name.trim() || paired?.name || "";
    toast.success(
      pairedName ? t`Paired with ${ph({ name: pairedName })}.` : t`Paired with the remote server.`,
    );
    resetForm();
    onOpenChange(false);
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || pair.isPending) return;
    pair.mutate({
      code: trimmed,
      name: name.trim() || undefined,
      activate: activate && !up,
    });
  }

  function handleOpenChange(next: boolean) {
    if (!next && pair.isPending) return;
    if (!next) resetForm();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t`Pair a Server`}</DialogTitle>
            <DialogDescription>
              {t`Paste a Subspace pairing link or code from another LAPLACE Eidolon computer or CLI.`}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={codeId}>{t`Pairing Link or Code`}</FieldLabel>
            <Input
              id={codeId}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="eidolon://pair?code=…"
              className="font-mono text-xs md:text-xs"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={nameId}>{t`Server Name`}</FieldLabel>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t`Optional`}
              autoComplete="off"
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={activateId}>{t`Switch to Server Now`}</FieldLabel>
              <FieldDescription>
                {up
                  ? t`A call is in progress: switch servers after it ends.`
                  : t`Switch the app to use this server as soon as pairing finishes.`}
              </FieldDescription>
            </FieldContent>
            <Switch
              id={activateId}
              checked={activate && !up}
              disabled={up || pair.isPending}
              onCheckedChange={setActivate}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pair.isPending}
              onClick={() => handleOpenChange(false)}
            >
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={!code.trim() || pair.isPending}>
              {pair.isPending && <Spinner />}
              {t`Pair Server`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
