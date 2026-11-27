import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import {
  EllipsisIcon,
  MonitorIcon,
  OrbitIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UnplugIcon,
} from "lucide-react";
import { type SubmitEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { ListCard, ListRow } from "@/components/list";
import { QuietBadge } from "@/components/quiet-badge";
import { SectionCard } from "@/components/section-card";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useCallPresence } from "@/features/call/call-context";
import { offersPermissions } from "@/features/settings/sections";
import type { SubspaceConnectionState, SubspaceServerView } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { AddSubspaceServerDialog } from "./add-server-dialog";
import {
  SUBSPACE_CONNECTION_DOT,
  subspaceQuery,
  useConnectSubspaceServer,
  useDisconnectSubspaceServer,
  useRemoveSubspaceServer,
  useSwitchSubspaceHost,
  useUpdateSubspaceServer,
} from "./queries";

const MODE_LABELS: Readonly<Record<SubspaceServerView["mode"], MessageDescriptor>> = {
  direct: msg`Direct`,
  relay: msg`Relay`,
};
const HYBRID_MODE_LABEL = msg`Direct · Relay`;

const CONNECTION_LABELS: Readonly<
  Record<SubspaceConnectionState, { readonly label: MessageDescriptor; readonly dot: string }>
> = {
  connected: { label: msg`Connected`, dot: SUBSPACE_CONNECTION_DOT.connected },
  connecting: { label: msg`Connecting…`, dot: SUBSPACE_CONNECTION_DOT.connecting },
  disconnected: { label: msg`Offline`, dot: SUBSPACE_CONNECTION_DOT.disconnected },
  error: { label: msg`Connection Error`, dot: SUBSPACE_CONNECTION_DOT.error },
};

function ServerMenu({
  server,
  busy,
  onReconnect,
  onDisconnect,
  onEdit,
  onRemove,
}: {
  readonly server: SubspaceServerView;
  readonly busy: boolean;
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const { t } = useLingui();
  // Open dialogs only after DropdownMenu finishes closing so focus traps don't fight.
  const opening = useRef<(() => void) | null>(null);
  const canDisconnect = server.connectionState !== "disconnected";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t`Server Options`}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-auto min-w-40"
        onCloseAutoFocus={(event) => {
          const next = opening.current;
          if (next === null) return;
          event.preventDefault();
          opening.current = null;
          next();
        }}
      >
        <DropdownMenuItem onSelect={onReconnect}>
          <RefreshCwIcon />
          {t`Reconnect`}
        </DropdownMenuItem>
        {canDisconnect && (
          <DropdownMenuItem onSelect={onDisconnect}>
            <UnplugIcon />
            {t`Disconnect`}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => (opening.current = onEdit)}>
          <PencilIcon />
          {t`Edit Server`}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => (opening.current = onRemove)}>
          <Trash2Icon />
          {t`Remove`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditServerForm({
  server,
  pending,
  onSave,
  onCancel,
}: {
  readonly server: SubspaceServerView;
  readonly pending: boolean;
  readonly onSave: (patch: {
    readonly name: string;
    readonly host?: string;
    readonly port?: number;
  }) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const hostId = useId();
  const portId = useId();
  const [name, setName] = useState(server.name);
  const [host, setHost] = useState(server.endpoint?.host ?? "");
  const [port, setPort] = useState(server.endpoint ? String(server.endpoint.port) : "");

  const hasEndpoint = server.endpoint !== null;
  const parsedPort = port.trim() === "" ? undefined : Number(port.trim());
  const portValid =
    !hasEndpoint ||
    (parsedPort !== undefined &&
      Number.isInteger(parsedPort) &&
      parsedPort >= 1 &&
      parsedPort <= 65535);
  const valid = name.trim().length > 0 && (!hasEndpoint || (host.trim().length > 0 && portValid));

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid || pending) return;
    onSave({
      name: name.trim(),
      ...(hasEndpoint ? { host: host.trim(), port: parsedPort } : {}),
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t`Edit Subspace Server`}</DialogTitle>
        <DialogDescription>
          {hasEndpoint
            ? t`Update the display name or direct network endpoint for this server.`
            : t`Update the display name for this Relay server.`}
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={nameId}>{t`Server Name`}</FieldLabel>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          autoFocus
        />
      </Field>
      {hasEndpoint && (
        <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
          <Field>
            <FieldLabel htmlFor={hostId}>{t`Host`}</FieldLabel>
            <Input
              id={hostId}
              value={host}
              onChange={(event) => setHost(event.target.value)}
              className="font-mono text-xs md:text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={portId}>{t`Port`}</FieldLabel>
            <Input
              id={portId}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              inputMode="numeric"
              className="font-mono text-xs md:text-xs"
              autoComplete="off"
            />
          </Field>
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          {t`Cancel`}
        </Button>
        <Button type="submit" disabled={!valid || pending}>
          {pending && <Spinner />}
          {t`Save`}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ServersCard() {
  const { t } = useLingui();
  const { data: state } = useQuery(subspaceQuery);
  const { up } = useCallPresence();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SubspaceServerView | null>(null);
  const [removing, setRemoving] = useState<SubspaceServerView | null>(null);

  const switching = useSwitchSubspaceHost();
  const update = useUpdateSubspaceServer();
  const remove = useRemoveSubspaceServer();
  const connect = useConnectSubspaceServer();
  const disconnect = useDisconnectSubspaceServer();

  if (!state) return null;

  const busy =
    switching.isPending ||
    update.isPending ||
    remove.isPending ||
    connect.isPending ||
    disconnect.isPending;

  const app = desktop();
  const macDesktop = app?.platform === "darwin" && offersPermissions(app);

  return (
    <SectionCard
      title={t`Subspace Servers`}
      description={t`Switch between this computer and remote Eidolon servers you've paired with.`}
      action={
        <Button type="button" variant="outline" onClick={() => setAdding(true)}>
          <PlusIcon />
          {t`Pair a Server`}
        </Button>
      }
    >
      <ListCard label={t`Subspace Servers`}>
        <ListRow
          current={state.activeHostId === null}
          leading={
            <span className="flex size-10 items-center justify-center rounded-full bg-muted">
              <MonitorIcon className="size-5" />
            </span>
          }
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span>{t`This Computer`}</span>
              {state.activeHostId === null && <Badge>{t`Active`}</Badge>}
              <QuietBadge>{t`Local`}</QuietBadge>
            </span>
          }
          description={t`Local LAPLACE Eidolon server on this computer.`}
          trailing={
            state.activeHostId !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={up || busy}
                onClick={() => switching.mutate(null)}
              >
                {t`Switch Here`}
              </Button>
            ) : undefined
          }
        />
        {state.servers.map((server) => {
          const active = server.id === state.activeHostId;
          const conn = CONNECTION_LABELS[server.connectionState];
          const modeLabel =
            server.connectionState === "connected" && server.activeTransport
              ? MODE_LABELS[server.activeTransport]
              : server.endpoint && server.relay
                ? HYBRID_MODE_LABEL
                : MODE_LABELS[server.mode];
          const address =
            server.activeTransport === "relay" || !server.endpoint
              ? (server.relay?.url ?? t`Subspace Relay`)
              : `${server.endpoint.host}:${server.endpoint.port}`;
          const details = [
            address,
            server.connectionState === "connected" && server.latencyMs !== null
              ? `${server.latencyMs} ms`
              : null,
            server.lastError,
          ]
            .filter((part): part is string => Boolean(part))
            .join(" · ");
          const showPermissionsLink =
            macDesktop &&
            server.endpoint !== null &&
            server.connectionState === "error" &&
            server.lastErrorCode === "local-network-blocked";

          return (
            <ListRow
              key={server.id}
              current={active}
              leading={
                <span className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <OrbitIcon className="size-5" />
                </span>
              }
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="wrap-anywhere">{server.name}</span>
                  {active && <Badge>{t`Active`}</Badge>}
                  <QuietBadge>{t(modeLabel)}</QuietBadge>
                  <QuietBadge dot={conn.dot}>{t(conn.label)}</QuietBadge>
                </span>
              }
              description={
                showPermissionsLink ? (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {details && <span>{details}</span>}
                    <Link
                      to="/settings?tab=permissions"
                      className="underline underline-offset-4 hover:text-foreground"
                    >
                      {t`Check Permissions`}
                    </Link>
                  </span>
                ) : (
                  details
                )
              }
              trailing={
                <>
                  {!active && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={up || busy}
                      onClick={() => switching.mutate(server.id)}
                    >
                      {t`Switch Here`}
                    </Button>
                  )}
                  <ServerMenu
                    server={server}
                    busy={busy}
                    onReconnect={() => connect.mutate(server.id)}
                    onDisconnect={() => disconnect.mutate(server.id)}
                    onEdit={() => setEditing(server)}
                    onRemove={() => setRemoving(server)}
                  />
                </>
              }
            />
          );
        })}
      </ListCard>

      <AddSubspaceServerDialog open={adding} onOpenChange={setAdding} />

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !update.isPending) setEditing(null);
        }}
      >
        <DialogContent>
          {editing !== null && (
            <EditServerForm
              server={editing}
              pending={update.isPending}
              onCancel={() => setEditing(null)}
              onSave={(patch) =>
                update.mutate(
                  { id: editing.id, ...patch },
                  {
                    onSuccess: () => {
                      setEditing(null);
                      toast.success(t`Saved changes to ${ph({ name: patch.name })}.`);
                    },
                  },
                )
              }
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Remove ${ph({ name: removing?.name ?? "" })}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.id === state.activeHostId
                ? t`Removing the active server switches this app back to This Computer. You will need a new pairing link to connect again.`
                : t`The saved pairing key and device token will be removed from this computer.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t`Keep Server`}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (removing === null) return;
                const { id, name } = removing;
                remove.mutate(id, {
                  onSuccess: () => {
                    setRemoving(null);
                    toast.success(t`${ph({ name })} removed.`);
                  },
                });
              }}
            >
              {remove.isPending && <Spinner />}
              {t`Remove`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
