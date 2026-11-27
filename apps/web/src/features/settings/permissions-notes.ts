// Copy, badge tones, toast notices, and verification history for Settings → Permissions.
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type {
  LocalNetworkTestFailure,
  PermissionId,
  PermissionItem,
  PermissionRequestResult,
  PermissionStatus,
} from "@/lib/desktop";
import { type Note, UNAVAILABLE_NOTES } from "./desktop-notes";

export const PERMISSION_TITLES: Readonly<Record<PermissionId, MessageDescriptor>> = {
  microphone: msg`Microphone`,
  notifications: msg`Notifications`,
  "local-network": msg`Local Network`,
  screen: msg`Screen Recording`,
  accessibility: msg`Accessibility`,
};

export const PERMISSION_DESCRIPTIONS: Readonly<Record<PermissionId, MessageDescriptor>> = {
  microphone: msg`Voice calls, voice messages, and trying her lip sync in the studio.`,
  notifications: msg`Alerts when she replies or an assistant task needs you while the window is in the background.`,
  "local-network": msg`Direct Subspace connections to remote servers on your LAN, plus local-network tools and MCP servers.`,
  screen: msg`Screenshots or screen inspection requested by an Assistant Mode skill or MCP server.`,
  accessibility: msg`Window control or input automation requested by an Assistant Mode skill or MCP server.`,
};

export const LOCAL_NETWORK_STORAGE_KEY = "eidolon.permissions.localNetworkVerified";

export interface VerifiedLocalNetwork {
  readonly host: string;
  readonly port: number;
  readonly testedAt: number;
}

export function permissionStatusText(
  id: PermissionId,
  status: PermissionStatus,
  platform: string,
): MessageDescriptor {
  switch (status) {
    case "granted":
      return msg`Granted`;
    case "denied":
      return msg`Denied`;
    case "restricted":
      return msg`Restricted`;
    case "not-determined":
      return msg`Not Requested`;
    case "unavailable":
      return msg`Unavailable`;
    case "unknown":
      if (id === "local-network") return msg`Managed by macOS`;
      if (id === "notifications" && platform === "win32") return msg`Managed by Windows`;
      return msg`Check Manually`;
  }
}

export function permissionStatusClass(status: PermissionStatus): string {
  if (status === "granted") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "denied" || status === "restricted") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted text-muted-foreground";
}

export function permissionNote(item: PermissionItem, platform: string): Note | null {
  if (item.unavailable !== undefined) {
    return { text: UNAVAILABLE_NOTES[item.unavailable], tone: "muted" };
  }
  if ((item.status === "denied" || item.status === "restricted") && platform === "darwin") {
    return {
      text: msg`macOS no longer prompts once turned off. Enable LAPLACE Eidolon in System Settings, then quit and reopen if the OS asks.`,
      tone: "warning",
    };
  }
  if (item.id === "local-network") {
    return {
      text: msg`macOS does not report Local Network status to apps. Use Test Connection below to confirm LAN access works.`,
      tone: "muted",
    };
  }
  return null;
}

export type PermissionActionKind = "request" | "request-access" | "open-settings";

export function permissionActionKind(item: PermissionItem, platform: string): PermissionActionKind {
  if (item.id === "local-network") return "request-access";
  if (item.id === "screen" || platform !== "darwin") return "open-settings";
  if (
    item.status === "not-determined" ||
    (item.id === "accessibility" && item.status === "unknown")
  ) {
    return "request";
  }
  return "open-settings";
}

export function isValidPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65_535;
}

export function requestResultNotice(
  result: PermissionRequestResult,
  platform: string,
):
  | { readonly kind: "success"; readonly title: MessageDescriptor }
  | {
      readonly kind: "info";
      readonly title: MessageDescriptor;
      readonly description?: MessageDescriptor;
      readonly showSettingsButton?: boolean;
    } {
  if (result.status === "granted") {
    return { kind: "success", title: msg`Permission granted.` };
  }
  if (result.openedSettings) {
    return {
      kind: "info",
      title:
        platform === "darwin" ? msg`Opened macOS System Settings.` : msg`Opened Windows Settings.`,
    };
  }
  if (result.id === "local-network") {
    return {
      kind: "info",
      title: msg`Check for a macOS prompt.`,
      description: msg`If prompted, choose Allow. Otherwise open System Settings and turn on LAPLACE Eidolon under Privacy & Security → Local Network.`,
      showSettingsButton: true,
    };
  }
  return { kind: "info", title: msg`Permission request sent.` };
}

export const CONNECTION_FAILURE_TEXT: Readonly<Record<LocalNetworkTestFailure, MessageDescriptor>> =
  {
    "invalid-target": msg`Enter a private LAN IP address or hostname and a port between 1 and 65535.`,
    blocked: msg`Could not reach that host on your local network. Check that it is online, or allow LAPLACE Eidolon in System Settings under Privacy & Security → Local Network.`,
    refused: msg`The host responded on your local network, though nothing is listening on that port.`,
    timeout: msg`Connection timed out. Check the host, port, and macOS Local Network settings.`,
    unresolved: msg`The hostname could not be resolved on this network.`,
    unsupported: msg`Local network connection tests run only in the macOS desktop app.`,
    background: msg`Background mode leaves network testing disabled.`,
    failed: msg`The connection test could not be completed.`,
  };

const MAX_DATE_MS = 8_640_000_000_000_000;

export function loadVerifiedLocalNetwork(): VerifiedLocalNetwork | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LOCAL_NETWORK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VerifiedLocalNetwork>;
    if (
      typeof parsed.host === "string" &&
      parsed.host.length > 0 &&
      isValidPort(parsed.port) &&
      typeof parsed.testedAt === "number" &&
      Number.isFinite(parsed.testedAt) &&
      parsed.testedAt >= 0 &&
      parsed.testedAt <= MAX_DATE_MS
    ) {
      return { host: parsed.host, port: parsed.port, testedAt: parsed.testedAt };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveVerifiedLocalNetwork(value: VerifiedLocalNetwork): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LOCAL_NETWORK_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage quota / private mode failures.
  }
}
