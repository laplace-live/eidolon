// Settings → Permissions: reads macOS/Windows OS privacy status via the desktop bridge, lets the
// owner trigger OS prompts or jump to System Settings, and runs Local Network connectivity checks
// through Electron's Node runtime.
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AccessibilityIcon,
  BellIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ExternalLinkIcon,
  MicIcon,
  MonitorUpIcon,
  NetworkIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode, type SubmitEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { SectionCard } from "@/components/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { subspaceQuery } from "@/features/subspace/queries";
import {
  desktop,
  type LocalNetworkTestFailure,
  type PermissionId,
  type PermissionItem,
} from "@/lib/desktop";
import { toastError } from "@/lib/feedback";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import type { Note } from "./desktop-notes";
import {
  CONNECTION_FAILURE_TEXT,
  isValidPort,
  loadVerifiedLocalNetwork,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_TITLES,
  permissionActionKind,
  permissionNote,
  permissionStatusClass,
  permissionStatusText,
  requestResultNotice,
  saveVerifiedLocalNetwork,
  type VerifiedLocalNetwork,
} from "./permissions-notes";
import { offersPermissions, type PermissionsOptions } from "./sections";

const PERMISSIONS_QUERY_KEY = ["desktop", "permissions"] as const;

export function permissionsQuery(app: PermissionsOptions) {
  return queryOptions({
    queryKey: PERMISSIONS_QUERY_KEY,
    queryFn: () => app.permissions(),
  });
}

const ICONS: Readonly<Record<PermissionId, ReactNode>> = {
  microphone: <MicIcon className="size-4" aria-hidden="true" />,
  notifications: <BellIcon className="size-4" aria-hidden="true" />,
  "local-network": <NetworkIcon className="size-4" aria-hidden="true" />,
  screen: <MonitorUpIcon className="size-4" aria-hidden="true" />,
  accessibility: <AccessibilityIcon className="size-4" aria-hidden="true" />,
};

const CORE_IDS = new Set<PermissionId>(["microphone", "notifications", "local-network"]);
const ASSISTANT_IDS = new Set<PermissionId>(["screen", "accessibility"]);
const ROW = "py-5 first:pt-0 last:pb-0";

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

function LocalNetworkConnectionTest({
  app,
  disabled,
}: {
  readonly app: PermissionsOptions;
  readonly disabled: boolean;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const hostId = useId();
  const portId = useId();
  const statusId = useId();
  const hostRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);

  const [lastVerified, setLastVerified] = useState<VerifiedLocalNetwork | null>(
    loadVerifiedLocalNetwork,
  );
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(lastVerified?.host ?? "");
  const [port, setPort] = useState(lastVerified !== null ? String(lastVerified.port) : "");
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<LocalNetworkTestFailure | null>(null);
  const [invalidField, setInvalidField] = useState<"host" | "port" | null>(null);
  const [succeededNow, setSucceededNow] = useState(false);

  const subspace = useQuery({
    ...subspaceQuery,
    enabled: !disabled && app.platform === "darwin",
  });
  const directServers = (subspace.data?.servers ?? []).flatMap((server) =>
    server.mode === "direct" && server.endpoint !== null
      ? [{ id: server.id, name: server.name, endpoint: server.endpoint }]
      : [],
  );

  const resetProbeStatus = () => {
    setFailure(null);
    setInvalidField(null);
    setSucceededNow(false);
  };

  const failInvalid = (field: "host" | "port") => {
    setFailure("invalid-target");
    setInvalidField(field);
    (field === "host" ? hostRef : portRef).current?.focus();
  };

  const onInputChange = (
    field: "host" | "port",
    setValue: (next: string) => void,
    value: string,
  ) => {
    setValue(value);
    if (failure !== null) setFailure(null);
    if (invalidField === field) setInvalidField(null);
  };

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled || running) return;
    resetProbeStatus();

    const trimmedHost = host.trim();
    const parsedPort = port.trim() === "" ? Number.NaN : Number(port.trim());
    if (!trimmedHost) {
      failInvalid("host");
      return;
    }
    if (!isValidPort(parsedPort)) {
      failInvalid("port");
      return;
    }

    setRunning(true);
    try {
      const result = await app.testLocalNetwork({ host: trimmedHost, port: parsedPort });
      if (result.ok) {
        const verified: VerifiedLocalNetwork = {
          host: result.host,
          port: result.port,
          testedAt: result.testedAt,
        };
        saveVerifiedLocalNetwork(verified);
        setLastVerified(verified);
        setSucceededNow(true);
      } else {
        setFailure(result.failure);
        if (result.failure === "invalid-target") failInvalid("host");
      }
    } catch {
      setFailure("failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3 pl-7">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          className={cn(
            "flex items-center gap-1.5 text-xs",
            lastVerified !== null
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-muted-foreground",
          )}
        >
          {lastVerified !== null && <CheckCircle2Icon className="size-3.5" aria-hidden="true" />}
          {lastVerified !== null
            ? t`Last verified ${ph({
                when: formatDateTime(new Date(lastVerified.testedAt).toISOString(), lang),
              })} · ${ph({ target: `${lastVerified.host}:${lastVerified.port}` })}.`
            : t`No successful test saved.`}
        </p>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={disabled}>
            {t`Test Connection`}
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
            />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mt-3 rounded-lg border border-border/60 bg-muted/25 p-4">
          <p className="text-muted-foreground text-xs">
            {t`Enter a remote Eidolon server on your local network. LAPLACE Eidolon tests the same TCP path used for Direct Subspace connections.`}
          </p>
          {directServers.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground text-xs">{t`Paired LAN servers:`}</span>
              {directServers.map((server) => (
                <Button
                  key={server.id}
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={disabled || running}
                  onClick={() => {
                    setHost(server.endpoint.host);
                    setPort(String(server.endpoint.port));
                    resetProbeStatus();
                  }}
                >
                  {`${server.name} · ${server.endpoint.host}:${server.endpoint.port}`}
                </Button>
              ))}
            </div>
          )}
          <form
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={(event) => void submit(event)}
            noValidate
          >
            <Field className="w-48">
              <FieldLabel htmlFor={hostId}>{t`Host`}</FieldLabel>
              <Input
                ref={hostRef}
                id={hostId}
                name="host"
                value={host}
                onChange={(event) => onInputChange("host", setHost, event.target.value)}
                placeholder="10.0.1.5"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-xs md:text-xs"
                aria-invalid={invalidField === "host" || undefined}
                aria-describedby={failure !== null ? statusId : undefined}
                disabled={disabled || running}
              />
            </Field>
            <Field className="w-28">
              <FieldLabel htmlFor={portId}>{t`Port`}</FieldLabel>
              <Input
                ref={portRef}
                id={portId}
                name="port"
                type="text"
                inputMode="numeric"
                value={port}
                onChange={(event) => onInputChange("port", setPort, event.target.value)}
                placeholder="63427"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono text-xs md:text-xs"
                aria-invalid={invalidField === "port" || undefined}
                aria-describedby={failure !== null ? statusId : undefined}
                disabled={disabled || running}
              />
            </Field>
            <Button type="submit" variant="outline" size="sm" disabled={disabled || running}>
              {running ? (
                <>
                  <Spinner />
                  {t`Testing…`}
                </>
              ) : (
                t`Test Connection`
              )}
            </Button>
          </form>
          {failure !== null && (
            <p id={statusId} role="status" className="mt-2.5 text-destructive text-xs">
              {t(CONNECTION_FAILURE_TEXT[failure])}
            </p>
          )}
          {succeededNow && failure === null && (
            <p
              id={statusId}
              role="status"
              className="mt-2.5 text-emerald-700 text-xs dark:text-emerald-300"
            >
              {t`Connection succeeded over your local network.`}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PermissionRow({
  item,
  app,
  pendingId,
  onRequest,
  onOpenSettings,
}: {
  readonly item: PermissionItem;
  readonly app: PermissionsOptions;
  readonly pendingId: PermissionId | null;
  readonly onRequest: (id: PermissionId) => void;
  readonly onOpenSettings: (id: PermissionId) => void;
}) {
  const { t } = useLingui();
  const titleId = useId();
  const requestBtnId = useId();
  const settingsBtnId = useId();

  const note = permissionNote(item, app.platform);
  const actionKind = permissionActionKind(item, app.platform);
  const pending = pendingId === item.id;
  const busy = pendingId !== null;
  const unavailable = item.unavailable !== undefined;
  const statusText = t(permissionStatusText(item.id, item.status, app.platform));
  const openSettingsLabel = app.platform === "darwin" ? t`Open System Settings` : t`Open Settings`;

  return (
    <div data-permission={item.id} data-disabled={unavailable} className={ROW}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
          <div className="mt-0.5 text-muted-foreground">{ICONS[item.id]}</div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span id={titleId} className="font-medium text-sm">
                {t(PERMISSION_TITLES[item.id])}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "px-2 py-0.5 font-medium text-[11px]",
                  permissionStatusClass(item.status),
                )}
              >
                {statusText}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm">{t(PERMISSION_DESCRIPTIONS[item.id])}</p>
            {note !== null && <NoteLine note={note} />}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actionKind !== "open-settings" && (
            <Button
              id={requestBtnId}
              type="button"
              variant={actionKind === "request-access" ? "default" : "outline"}
              size="sm"
              aria-labelledby={`${requestBtnId} ${titleId}`}
              disabled={unavailable || busy}
              onClick={() => onRequest(item.id)}
            >
              {pending && <Spinner />}
              {pending
                ? t`Working…`
                : actionKind === "request-access"
                  ? t`Request Access`
                  : t`Request`}
            </Button>
          )}
          <Button
            id={settingsBtnId}
            type="button"
            variant="outline"
            size="sm"
            aria-labelledby={`${settingsBtnId} ${titleId}`}
            disabled={unavailable || busy}
            onClick={() => onOpenSettings(item.id)}
          >
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            {openSettingsLabel}
          </Button>
        </div>
      </div>
      {item.id === "local-network" && (
        <LocalNetworkConnectionTest app={app} disabled={unavailable} />
      )}
    </div>
  );
}

function PermissionList({
  items,
  app,
  pendingId,
  onRequest,
  onOpenSettings,
}: {
  readonly items: readonly PermissionItem[];
  readonly app: PermissionsOptions;
  readonly pendingId: PermissionId | null;
  readonly onRequest: (id: PermissionId) => void;
  readonly onOpenSettings: (id: PermissionId) => void;
}) {
  return (
    <div className="flex flex-col divide-y">
      {items.map((item) => (
        <PermissionRow
          key={item.id}
          item={item}
          app={app}
          pendingId={pendingId}
          onRequest={onRequest}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </div>
  );
}

export function PermissionsSection() {
  const app = desktop();
  if (!offersPermissions(app)) return null;

  return <PermissionsCards app={app} />;
}

function PermissionsCards({ app }: { readonly app: PermissionsOptions }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const permissions = useQuery(permissionsQuery(app));

  // Refresh after returning from macOS/Windows settings so badges update without polling.
  useEffect(() => {
    const onFocus = () => {
      void queryClient.invalidateQueries({ queryKey: PERMISSIONS_QUERY_KEY });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [queryClient]);

  const openSettings = useMutation({
    mutationFn: (id: PermissionId) => app.openPermissionSettings(id),
    onError: toastError,
  });

  const request = useMutation({
    mutationFn: (id: PermissionId) => app.requestPermission(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: PERMISSIONS_QUERY_KEY });
      const notice = requestResultNotice(result, app.platform);
      if (notice.kind === "success") {
        toast.success(t(notice.title));
        return;
      }
      toast(t(notice.title), {
        ...(notice.description !== undefined ? { description: t(notice.description) } : {}),
        ...(notice.showSettingsButton
          ? {
              action: {
                label: t`Open System Settings`,
                onClick: () => openSettings.mutate(result.id),
              },
            }
          : {}),
      });
    },
    onError: toastError,
  });

  const items = permissions.data?.items ?? [];
  const coreItems = items.filter((item) => CORE_IDS.has(item.id));
  const assistantItems = items.filter((item) => ASSISTANT_IDS.has(item.id));
  const pendingId = request.isPending ? request.variables : null;
  const onRequest = (id: PermissionId) => request.mutate(id);
  const onOpenSettings = (id: PermissionId) => openSettings.mutate(id);

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        title={t`Permissions`}
        description={t`System permissions for LAPLACE Eidolon on this computer. LAPLACE Eidolon asks only when a feature needs them.`}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={permissions.isFetching}
            onClick={() => void permissions.refetch()}
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn("size-3.5", permissions.isFetching && "animate-spin")}
            />
            {t`Refresh`}
          </Button>
        }
      >
        {permissions.isError && <ErrorAlert error={permissions.error} />}
        {coreItems.length > 0 && (
          <PermissionList
            items={coreItems}
            app={app}
            pendingId={pendingId}
            onRequest={onRequest}
            onOpenSettings={onOpenSettings}
          />
        )}
      </SectionCard>
      {assistantItems.length > 0 && (
        <SectionCard
          title={t`Assistant Tools`}
          description={t`Commands and MCP servers started by Assistant Mode inherit LAPLACE Eidolon's macOS privacy access. Only grant these when a skill or tool uses them.`}
        >
          <PermissionList
            items={assistantItems}
            app={app}
            pendingId={pendingId}
            onRequest={onRequest}
            onOpenSettings={onOpenSettings}
          />
        </SectionCard>
      )}
    </div>
  );
}
