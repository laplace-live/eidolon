// Settings' Desktop App: what the desktop app can add to this computer, Open at Login and the
// `eidolon` command for terminals, each changing it only on the owner's click here, and the desktop
// companion. Each acts at once through the app's bridge, never the server.

import { Trans, useLingui } from "@lingui/react/macro";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { SectionCard } from "@/components/section-card";
import { Code } from "@/components/settings-form/field";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { type CompanionChange, desktop } from "@/lib/desktop";
import { toastError } from "@/lib/feedback";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import {
  changeFailed,
  commandNote,
  companionNotes,
  loginItemNote,
  type Note,
} from "./desktop-notes";
import {
  type CompanionOptions,
  offersCompanion,
  offersSystemOptions,
  type SystemOptions,
} from "./sections";

/** How often Open at Login is read again while it waits for the owner's OK in System Settings. */
const APPROVAL_POLL_MS = 3000;
/** How often her state is read again while the card shows, since she is switched elsewhere too. */
const COMPANION_POLL_MS = 2000;

export function loginItemQuery(app: SystemOptions) {
  return queryOptions({
    queryKey: ["desktop", "login-item"],
    queryFn: () => app.loginItem(),
    // The OK is given in System Settings, outside the app.
    refetchInterval: (query) =>
      query.state.data?.state === "needs-approval" ? APPROVAL_POLL_MS : false,
  });
}

export function terminalCommandQuery(app: SystemOptions) {
  return queryOptions({
    queryKey: ["desktop", "terminal-command"],
    queryFn: () => app.terminalCommand(),
  });
}

export function companionQuery(app: CompanionOptions) {
  return queryOptions({
    queryKey: ["desktop", "companion"],
    queryFn: () => app.companion(),
    refetchInterval: COMPANION_POLL_MS,
  });
}

const ROW = "gap-6 py-5 first:pt-0 last:pb-0";

function NoteLine({ note }: { readonly note: Note }) {
  const { t } = useLingui();
  return (
    <p
      className={cn(
        "wrap-anywhere text-sm",
        note.tone === "warning" ? "text-warning" : "text-muted-foreground",
      )}
    >
      {t(note.text)}
    </p>
  );
}

function LoginItemRow({ app }: { readonly app: SystemOptions }) {
  const { t } = useLingui();
  const id = useId();
  const queryClient = useQueryClient();
  const options = loginItemQuery(app);
  const item = useQuery(options);
  const change = useMutation({
    mutationFn: (on: boolean) => app.setLoginItem(on),
    onSuccess: (state) => queryClient.setQueryData(options.queryKey, state),
    onError: (error) => {
      toastError(error);
      void queryClient.invalidateQueries({ queryKey: options.queryKey });
    },
  });
  const state = item.data?.state;
  // Registered, so on as the owner asked, though macOS waits for their OK to open it.
  const on = state === "on" || state === "needs-approval";
  const note = item.data === undefined ? null : loginItemNote(item.data);
  return (
    <Field
      orientation="horizontal"
      data-desktop-option="login-item"
      data-disabled={state === "unavailable"}
      className={ROW}
    >
      <FieldContent>
        <FieldLabel htmlFor={id}>{t`Open at Login`}</FieldLabel>
        <FieldDescription>
          {t`Start Eidolon in the background when you log in to this computer.`}
        </FieldDescription>
        {note !== null && <NoteLine note={note} />}
        {item.isError && <ErrorAlert error={item.error} />}
      </FieldContent>
      <Switch
        id={id}
        checked={change.isPending ? change.variables === true : on}
        disabled={state === undefined || state === "unavailable" || change.isPending}
        onCheckedChange={(next) => change.mutate(next)}
      />
    </Field>
  );
}

/** The desktop companion's switches: whether she shows, and whether a launch at login shows her. */
function CompanionRows({ app }: { readonly app: CompanionOptions }) {
  const { t } = useLingui();
  const onId = useId();
  const atLoginId = useId();
  const queryClient = useQueryClient();
  const options = companionQuery(app);
  const companion = useQuery(options);
  const hasModel = useQuery({
    ...statusQuery,
    select: (status) => status.persona.appearance.model !== null,
  }).data;
  const change = useMutation({
    mutationFn: (asked: CompanionChange) => app.setCompanion(asked),
    onSuccess: (state) => queryClient.setQueryData(options.queryKey, state),
    onError: (error) => {
      toastError(error);
      void queryClient.invalidateQueries({ queryKey: options.queryKey });
    },
  });
  const state = companion.data;
  const pending = change.isPending ? change.variables : undefined;
  const on = pending?.on ?? state?.on ?? false;
  const atLogin = pending?.showAtLogin ?? state?.showAtLogin ?? false;
  const notes = state === undefined ? [] : companionNotes(state, hasModel ?? true);
  return (
    <>
      <Field orientation="horizontal" data-desktop-option="companion" className={ROW}>
        <FieldContent>
          <FieldLabel htmlFor={onId}>{t`Desktop Companion`}</FieldLabel>
          <FieldDescription>
            {t`Keep her on your desktop, above your other windows. Right-click her for her menu.`}
          </FieldDescription>
          {notes.map((note) => (
            <NoteLine key={note.text.id} note={note} />
          ))}
          {companion.isError && <ErrorAlert error={companion.error} />}
        </FieldContent>
        <Switch
          id={onId}
          checked={on}
          disabled={state === undefined || change.isPending}
          onCheckedChange={(next) => change.mutate({ on: next })}
        />
      </Field>
      <Field
        orientation="horizontal"
        data-desktop-option="companion-at-login"
        data-disabled={!on}
        className={ROW}
      >
        <FieldContent>
          <FieldLabel htmlFor={atLoginId}>{t`Show at Login`}</FieldLabel>
          <FieldDescription>
            {t`When Eidolon opens at login, she shows too, before you open its window.`}
          </FieldDescription>
        </FieldContent>
        <Switch
          id={atLoginId}
          checked={atLogin}
          disabled={!on || state === undefined || change.isPending}
          onCheckedChange={(next) => change.mutate({ showAtLogin: next })}
        />
      </Field>
    </>
  );
}

function CommandRow({ app }: { readonly app: SystemOptions }) {
  const { t } = useLingui();
  const titleId = useId();
  const queryClient = useQueryClient();
  const options = terminalCommandQuery(app);
  const command = useQuery(options);
  const change = useMutation({
    mutationFn: (action: "install" | "remove") => app.setTerminalCommand(action),
    onSuccess: (result, action) => {
      queryClient.setQueryData(options.queryKey, result.command);
      const failed = changeFailed(result, action, app.platform);
      if (failed !== null) toast.error(t(failed.title), { description: t(failed.detail) });
    },
    onError: (error) => {
      toastError(error);
      void queryClient.invalidateQueries({ queryKey: options.queryKey });
    },
  });
  const state = command.data?.state;
  const installed = state === "installed";
  const usage = "eidolon <command>";
  const example = "eidolon pipeline";
  return (
    <Field
      orientation="horizontal"
      aria-labelledby={titleId}
      data-desktop-option="terminal-command"
      data-disabled={state === "unavailable"}
      className={ROW}
    >
      <FieldContent>
        <FieldTitle id={titleId}>{t`Terminal Command`}</FieldTitle>
        <FieldDescription>
          <Trans>
            Run <Code>{usage}</Code> in a terminal, such as <Code>{example}</Code>. With no
            arguments, it opens Eidolon.
          </Trans>
        </FieldDescription>
        {command.data !== undefined && <NoteLine note={commandNote(command.data, app.platform)} />}
        {command.isError && <ErrorAlert error={command.error} />}
      </FieldContent>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={change.isPending || !(installed || state === "absent")}
        onClick={() => change.mutate(installed ? "remove" : "install")}
      >
        {change.isPending && <Spinner />}
        {installed ? t`Remove` : t`Install`}
      </Button>
    </Field>
  );
}

export function DesktopCard() {
  const { t } = useLingui();
  const app = desktop();
  const system = offersSystemOptions(app);
  const companion = offersCompanion(app);
  if (!system && !companion) return null;
  return (
    <SectionCard
      title={t`Desktop App`}
      description={t`What Eidolon can add to this computer, each only when you choose it.`}
    >
      <div className="flex flex-col divide-y">
        {system && <LoginItemRow app={app} />}
        {companion && <CompanionRows app={app} />}
        {system && <CommandRow app={app} />}
      </div>
    </SectionCard>
  );
}
