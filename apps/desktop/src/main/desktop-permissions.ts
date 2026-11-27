// OS permissions on the desktop computer and a LAN TCP connectivity check through Electron's
// Node runtime. Electron-free: main/index.ts provides the Electron OS hooks, and background mode
// keeps every check, prompt, and Settings URL off-screen and untouched.
import { type ExecFileException, type ExecFileOptions, execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import {
  isPermissionStatus,
  type LocalNetworkTestFailure,
  type LocalNetworkTestRequest,
  type LocalNetworkTestResult,
  type PermissionId,
  type PermissionItem,
  type PermissionRequestResult,
  type PermissionStatus,
  type PermissionsState,
  type Unavailable,
} from "../shared/bridge.ts";
import { isPort } from "./attach.ts";
import { BACKEND_RUNTIME_ARGS } from "./controller.ts";

export type MediaPermissionType = "microphone" | "screen";

export interface DesktopPermissionsLog {
  info(message: string): void;
  warn(message: string): void;
}

export type LocalNetworkChildRunner = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown;

export interface DesktopPermissionsHost {
  readonly platform: NodeJS.Platform;
  readonly background: boolean;
  readonly packaged: boolean;
  readonly installedCopy: boolean;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log: DesktopPermissionsLog;
  readonly getMediaStatus: (mediaType: MediaPermissionType) => string;
  readonly askMicrophone: () => Promise<boolean>;
  readonly isAccessibilityTrusted: (prompt: boolean) => boolean;
  readonly getMacNotificationStatus: () => Promise<PermissionStatus>;
  readonly requestMacNotification: () => Promise<PermissionStatus>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly now?: () => number;
  readonly runChild?: LocalNetworkChildRunner;
  readonly triggerLocalNetworkPrompt?: () => Promise<void>;
}

export interface DesktopPermissions {
  readonly permissions: () => Promise<PermissionsState>;
  readonly requestPermission: (id: PermissionId) => Promise<PermissionRequestResult>;
  readonly openPermissionSettings: (id: PermissionId) => Promise<boolean>;
  readonly testLocalNetwork: (target: LocalNetworkTestRequest) => Promise<LocalNetworkTestResult>;
}

const DARWIN_PERMISSIONS: readonly PermissionId[] = [
  "microphone",
  "notifications",
  "local-network",
  "screen",
  "accessibility",
];
const WIN32_PERMISSIONS: readonly PermissionId[] = ["microphone", "notifications"];

const DARWIN_SETTINGS_URLS: Readonly<Record<PermissionId, string>> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
  "local-network":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

const WIN32_SETTINGS_URLS: Partial<Record<PermissionId, string>> = {
  microphone: "ms-settings:privacy-microphone",
  notifications: "ms-settings:notifications",
};

const CONNECT_TIMEOUT_MS = 4_000;
const CHILD_TIMEOUT_MS = CONNECT_TIMEOUT_MS + 1_000;
const MDNS_PROMPT_TIMEOUT_MS = 1_000;

export const LOCAL_NETWORK_CONNECT_SCRIPT = `
const dns = require("node:dns");
const net = require("node:net");
const host = process.argv[1];
const port = Number(process.argv[2]);
let socket = null;
let settled = false;
function finish(code) {
  if (settled) return;
  settled = true;
  if (code) {
    process.stderr.write(code);
    process.exitCode = 1;
  }
  if (socket) socket.destroy();
}
function errorCodeOf(error) {
  if (error && Array.isArray(error.errors) && error.errors.length > 0) {
    const codes = error.errors.map(errorCodeOf);
    if (codes.includes("INVALID_TARGET")) return "INVALID_TARGET";
    if (codes.includes("ECONNREFUSED")) return "ECONNREFUSED";
    if (codes.includes("ETIMEDOUT")) return "ETIMEDOUT";
    return error.code || codes.find(Boolean) || "FAILED";
  }
  return (error && error.code) || "FAILED";
}
function isLanAddress(address) {
  const normalized = (address || "").toLowerCase().split("%", 1)[0];
  const mapped = normalized.match(/^::ffff:(\\d{1,3}(?:\\.\\d{1,3}){3})$/)?.[1];
  const ipv4 = mapped || (net.isIP(normalized) === 4 ? normalized : null);
  if (ipv4) {
    const octets = ipv4.split(".").map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
    );
  }
  if (net.isIP(normalized) === 6) {
    const head = normalized.split(":", 1)[0];
    if (!head) return false;
    const first = Number.parseInt(head, 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}
if (net.isIP(host) !== 0 && !isLanAddress(host)) {
  finish("INVALID_TARGET");
} else {
  const lanLookup = (hostname, options, callback) => {
    dns.lookup(hostname, options, (error, address, family) => {
      if (error) {
        callback(error);
        return;
      }
      if (Array.isArray(address)) {
        if (address.length === 0) {
          callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
          return;
        }
        if (!address.every((entry) => isLanAddress(entry && entry.address))) {
          callback(Object.assign(new Error("INVALID_TARGET"), { code: "INVALID_TARGET" }));
          return;
        }
        callback(null, address);
        return;
      }
      if (!isLanAddress(address)) {
        callback(Object.assign(new Error("INVALID_TARGET"), { code: "INVALID_TARGET" }));
        return;
      }
      callback(null, address, family);
    });
  };
  socket = net.createConnection({ host, port, lookup: lanLookup });
  socket.setTimeout(${CONNECT_TIMEOUT_MS});
  socket.once("connect", () => finish(isLanAddress(socket.remoteAddress) ? undefined : "INVALID_TARGET"));
  socket.once("timeout", () => finish("ETIMEDOUT"));
  socket.once("error", (error) => finish(errorCodeOf(error)));
}
`;

export function permissionIdsForPlatform(platform: NodeJS.Platform): readonly PermissionId[] {
  if (platform === "darwin") return DARWIN_PERMISSIONS;
  if (platform === "win32") return WIN32_PERMISSIONS;
  return [];
}

function settingsUrlFor(platform: NodeJS.Platform, id: PermissionId): string | null {
  if (platform === "darwin") return DARWIN_SETTINGS_URLS[id];
  if (platform === "win32") return WIN32_SETTINGS_URLS[id] ?? null;
  return null;
}

function normalizeMediaStatus(raw: string): PermissionStatus {
  return isPermissionStatus(raw) ? raw : "unknown";
}

function notificationUnavailable(host: DesktopPermissionsHost): Unavailable | undefined {
  if (!host.packaged) return "unpackaged";
  if (host.platform === "win32" && !host.installedCopy) return "not-installed";
  return undefined;
}

function isIpv4Lan(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) return false;
  const [a = -1, b = -1] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isIpv6Lan(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)?.[1];
  if (mapped !== undefined) return isIpv4Lan(mapped);
  const head = lower.split(":", 1)[0];
  if (!head) return false;
  const first = Number.parseInt(head, 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function isLoopbackHost(withoutZone: string): boolean {
  const lower = withoutZone.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "0.0.0.0" || lower === "::1" || lower === "::") return true;
  return /^127\./.test(lower);
}

/** Accepts RFC 1918 / link-local IPs and non-loopback LAN hostnames; rejects loopback and public WAN IPs. */
export function normalizeLocalNetworkHost(rawHost: string): string | null {
  const trimmed = rawHost.trim();
  const bracketed = trimmed.startsWith("[") || trimmed.endsWith("]");
  if (bracketed && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return null;
  const host = bracketed ? trimmed.slice(1, -1) : trimmed;
  if (
    !host ||
    host.startsWith("-") ||
    host.length > 253 ||
    /[\s/\\]/.test(host) ||
    host.includes("://") ||
    !/^[a-z0-9.:%_-]+$/i.test(host)
  ) {
    return null;
  }
  const zoneIndex = host.indexOf("%");
  const withoutZone = zoneIndex === -1 ? host : host.slice(0, zoneIndex);
  const zone = zoneIndex === -1 ? null : host.slice(zoneIndex + 1);
  if (zone !== null && (zone.length === 0 || zone.includes("%"))) return null;
  if (isLoopbackHost(withoutZone)) return null;
  const ipVersion = isIP(withoutZone);
  if (bracketed && ipVersion !== 6) return null;
  if (ipVersion === 4) return zone === null && isIpv4Lan(withoutZone) ? host : null;
  if (ipVersion === 6) return isIpv6Lan(withoutZone) ? host : null;
  if (zone !== null || host.includes(":")) return null;
  return host;
}

function failureFromChild(error: ExecFileException, stderr: string): LocalNetworkTestFailure {
  if (error.killed || error.signal) return "timeout";
  const code = stderr.trim().split(/\s/, 1)[0];
  switch (code) {
    case "INVALID_TARGET":
      return "invalid-target";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EACCES":
    case "EPERM":
      return "blocked";
    case "ECONNREFUSED":
      return "refused";
    case "ETIMEDOUT":
      return "timeout";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "unresolved";
    default:
      return "failed";
  }
}

/** Sends a single mDNS multicast probe so macOS surfaces its Local Network prompt if undecided. */
function defaultTriggerLocalNetworkPrompt(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let socket: ReturnType<typeof createSocket> | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (socket !== null) {
        socket.removeListener("error", finish);
        try {
          socket.close();
        } catch {
          // Ignore sockets already closed before settling.
        }
      }
      resolve();
    };
    try {
      socket = createSocket({ type: "udp4", reuseAddr: true });
      socket.once("error", finish);
      socket.bind(() => {
        try {
          socket?.send(Buffer.from([0]), 0, 1, 5353, "224.0.0.251", finish);
        } catch {
          finish();
        }
      });
      timeout = setTimeout(finish, MDNS_PROMPT_TIMEOUT_MS);
      timeout.unref?.();
    } catch {
      finish();
    }
  });
}

async function readItem(host: DesktopPermissionsHost, id: PermissionId): Promise<PermissionItem> {
  switch (id) {
    case "microphone":
      return { id, status: normalizeMediaStatus(host.getMediaStatus("microphone")) };
    case "notifications": {
      const unavailable = notificationUnavailable(host);
      if (unavailable !== undefined) return { id, status: "unavailable", unavailable };
      if (host.platform === "darwin") {
        return { id, status: await host.getMacNotificationStatus() };
      }
      return { id, status: "unknown" };
    }
    case "local-network":
      return { id, status: "unknown" };
    case "screen":
      return { id, status: normalizeMediaStatus(host.getMediaStatus("screen")) };
    case "accessibility":
      return { id, status: host.isAccessibilityTrusted(false) ? "granted" : "unknown" };
  }
}

export function createDesktopPermissions(host: DesktopPermissionsHost): DesktopPermissions {
  const ids = permissionIdsForPlatform(host.platform);
  const now = host.now ?? Date.now;
  const runChild: LocalNetworkChildRunner =
    host.runChild ??
    ((file, args, options, callback) =>
      execFile(file, args, { ...options, encoding: "utf8" }, callback));
  const triggerLocalNetworkPrompt =
    host.triggerLocalNetworkPrompt ?? defaultTriggerLocalNetworkPrompt;

  const openPermissionSettings = async (id: PermissionId): Promise<boolean> => {
    if (host.background) {
      host.log.info(`Eidolon: background mode didn't open ${id} settings`);
      return false;
    }
    const url = settingsUrlFor(host.platform, id);
    if (url === null) return false;
    await host.openExternal(url);
    return true;
  };

  const permissions = async (): Promise<PermissionsState> => {
    if (host.background) {
      return {
        background: true,
        items: ids.map((id) => ({ id, status: "unavailable", unavailable: "background" })),
      };
    }
    const items = await Promise.all(ids.map((id) => readItem(host, id)));
    return { background: false, items };
  };

  const mediaStatus = (type: MediaPermissionType): PermissionStatus =>
    normalizeMediaStatus(host.getMediaStatus(type));

  const openWithStatus = async (
    id: PermissionId,
    status: PermissionStatus,
  ): Promise<PermissionRequestResult> => ({
    id,
    status,
    openedSettings: await openPermissionSettings(id),
  });

  const requestPermission = async (id: PermissionId): Promise<PermissionRequestResult> => {
    if (host.background) {
      host.log.info(`Eidolon: background mode didn't request ${id} permission`);
      return { id, status: "unavailable", openedSettings: false, unavailable: "background" };
    }
    if (!ids.includes(id)) {
      return { id, status: "unavailable", openedSettings: false };
    }
    switch (id) {
      case "notifications": {
        const unavailable = notificationUnavailable(host);
        if (unavailable !== undefined) {
          return { id, status: "unavailable", openedSettings: false, unavailable };
        }
        if (host.platform === "win32") return openWithStatus(id, "unknown");
        const status =
          (await host.getMacNotificationStatus()) === "denied"
            ? "denied"
            : await host.requestMacNotification();
        return status === "denied"
          ? openWithStatus(id, status)
          : { id, status, openedSettings: false };
      }
      case "microphone": {
        if (host.platform === "win32") return openWithStatus(id, mediaStatus("microphone"));
        const before = mediaStatus("microphone");
        if (before === "denied" || before === "restricted") return openWithStatus(id, before);
        if (await host.askMicrophone()) return { id, status: "granted", openedSettings: false };
        const after = mediaStatus("microphone");
        if (after === "denied" || after === "restricted" || after === "unknown") {
          return openWithStatus(id, after);
        }
        return { id, status: after, openedSettings: false };
      }
      case "local-network":
        await triggerLocalNetworkPrompt();
        return { id, status: "unknown", openedSettings: false };
      case "accessibility":
        if (host.isAccessibilityTrusted(true)) {
          return { id, status: "granted", openedSettings: false };
        }
        return openWithStatus(id, host.isAccessibilityTrusted(false) ? "granted" : "unknown");
      case "screen":
        return openWithStatus(id, mediaStatus("screen"));
    }
  };

  const testLocalNetwork = async (
    target: LocalNetworkTestRequest,
  ): Promise<LocalNetworkTestResult> => {
    const testedAt = now();
    const rawHost = target.host.trim();
    const port = isPort(target.port) ? target.port : null;
    if (host.background) {
      host.log.info("Eidolon: background mode didn't test local network connection");
      return {
        ok: false,
        host: rawHost,
        port: port ?? 0,
        testedAt,
        failure: "background",
      };
    }
    const normalizedHost = normalizeLocalNetworkHost(target.host);
    if (normalizedHost === null || port === null) {
      return {
        ok: false,
        host: rawHost,
        port: port ?? 0,
        testedAt,
        failure: "invalid-target",
      };
    }
    if (host.platform !== "darwin") {
      return { ok: false, host: normalizedHost, port, testedAt, failure: "unsupported" };
    }
    return new Promise((resolve) => {
      runChild(
        host.execPath,
        [...BACKEND_RUNTIME_ARGS, "-e", LOCAL_NETWORK_CONNECT_SCRIPT, normalizedHost, String(port)],
        {
          env: { ...host.env, ELECTRON_RUN_AS_NODE: "1" },
          timeout: CHILD_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 1024,
        },
        (error, _stdout, stderr) => {
          if (error === null) {
            resolve({ ok: true, host: normalizedHost, port, testedAt });
            return;
          }
          resolve({
            ok: false,
            host: normalizedHost,
            port,
            testedAt,
            failure: failureFromChild(error, stderr),
          });
        },
      );
    });
  };

  return { permissions, requestPermission, openPermissionSettings, testLocalNetwork };
}
