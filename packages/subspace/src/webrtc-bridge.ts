import { createSocket, type Socket } from "node:dgram";
import { isIP } from "node:net";
import type { MuxCallChannelHandle, MuxEndpoint } from "./protocol/index.ts";

const UDP_BRIDGE_IDLE_MS = 20_000;
const DTLS_ALERT_CLOSE_DELAY_MS = 200;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface HostUdpCandidate {
  readonly address: string;
  readonly port: number;
}

function stripIpZone(ip: string): string {
  const pct = ip.indexOf("%");
  return pct >= 0 ? ip.slice(0, pct) : ip;
}

function normalizeCandidateIp(raw: string): string {
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (isIP(bare) !== 6) return bare;
  const pct = bare.indexOf("%");
  return pct >= 0 ? `${bare.slice(0, pct).toLowerCase()}${bare.slice(pct)}` : bare.toLowerCase();
}

function isDtlsAlert(packet: Uint8Array): boolean {
  if (packet.length < 15 || packet[0] !== 21) return false;
  if (packet[3] === 0 && packet[4] === 0) {
    // Epoch-0 alerts are plaintext: [level, description]. Ignore warnings unless close_notify.
    return packet[13] === 2 || packet[14] === 0;
  }
  return true;
}

interface BridgeEntry {
  readonly socket: Socket;
  readonly localPort: number;
  readonly close: (notify?: boolean) => void;
}

/** Extracts all UDP host candidates' addresses and ports from a bundled SmallWebRTC SDP answer. */
export function extractHostUdpCandidates(sdp: string): HostUdpCandidate[] {
  const out: HostUdpCandidate[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("a=candidate:")) continue;
    const parts = trimmed.slice("a=candidate:".length).split(/\s+/);
    if (parts.length < 8) continue;
    const protocol = parts[2]?.toLowerCase();
    const rawAddress = parts[4];
    const port = Number(parts[5]);
    const type = parts[7]?.toLowerCase();
    if (protocol !== "udp" || type !== "host" || rawAddress === undefined) continue;
    const address = normalizeCandidateIp(rawAddress);
    if (isIP(address) !== 0 && Number.isInteger(port) && port >= 1 && port <= 65535) {
      out.push({ address, port });
    }
  }
  return out;
}

/** Picks the primary UDP host candidate from a SmallWebRTC SDP answer, preferring non-loopback IPv4. */
export function extractHostUdpCandidate(sdp: string): HostUdpCandidate | null {
  const candidates = extractHostUdpCandidates(sdp);
  return (
    candidates.find((c) => isIP(c.address) === 4 && !c.address.startsWith("127.")) ??
    candidates.find((c) => isIP(c.address) === 4) ??
    candidates[0] ??
    null
  );
}

/** Extracts the primary UDP host candidate's port from a bundled SmallWebRTC SDP answer. */
export function extractHostUdpPort(sdp: string): number | null {
  return extractHostUdpCandidate(sdp)?.port ?? null;
}

/**
 * Rewrites an SDP answer from a remote Eidolon host so SmallWebRTC flows through Subspace:
 * - In `"relay"` mode, replaces unreachable remote host/srflx candidates with the local UDP bridge.
 * - In `"direct"` mode, keeps LAN/Tailscale host candidates primary and adds the bridge as fallback.
 */
export function rewriteSdpAnswer(
  sdp: string,
  options: {
    readonly localPort: number;
    readonly mode: "direct" | "relay";
    readonly directHost?: string;
  },
): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  let inMedia = false;
  let injectedInSection = false;
  const candidateLine = `a=candidate:subspace 1 udp ${
    options.mode === "relay" ? 2130706431 : 2113929215
  } 127.0.0.1 ${options.localPort} typ host generation 0`;

  const injectIfNeeded = () => {
    if (inMedia && !injectedInSection) {
      out.push(candidateLine);
      injectedInSection = true;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("m=")) {
      injectIfNeeded();
      inMedia = true;
      injectedInSection = false;
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("c=IN IP4 ") && options.mode === "relay") {
      out.push("c=IN IP4 127.0.0.1");
      continue;
    }
    if (trimmed.startsWith("a=candidate:")) {
      const parts = trimmed.slice("a=candidate:".length).split(/\s+/);
      const protocol = parts[2]?.toLowerCase();
      const addr = parts[4];
      const candType = parts[7]?.toLowerCase();
      if (options.mode === "relay") {
        // Relay mode routes all WebRTC UDP packets over the encrypted tunnel, avoiding NAT failures.
        injectIfNeeded();
        if (candType === "relay") out.push(line);
        continue;
      }
      if (
        protocol === "udp" &&
        candType === "host" &&
        addr === "127.0.0.1" &&
        options.directHost !== undefined &&
        IPV4_LITERAL.test(options.directHost)
      ) {
        parts[4] = options.directHost;
        out.push(`a=candidate:${parts.join(" ")}`);
        continue;
      }
      out.push(line);
      continue;
    }
    if (trimmed === "a=end-of-candidates") {
      injectIfNeeded();
      out.push(line);
      continue;
    }
    out.push(line);
  }
  injectIfNeeded();
  return out.join(eol);
}

function attachIdleUdpSocket(
  socket: Socket,
  onClose: () => void,
  idleMs = UDP_BRIDGE_IDLE_MS,
): { readonly touch: () => void; readonly stop: () => void } {
  let closed = false;
  let lastActiveAt = Date.now();
  const checkMs = Math.min(5_000, Math.max(25, Math.floor(idleMs / 2)));
  const check = setInterval(() => {
    if (!closed && Date.now() - lastActiveAt >= idleMs) onClose();
  }, checkMs);
  check.unref?.();

  socket.on("error", () => onClose());
  return {
    touch: () => {
      lastActiveAt = Date.now();
    },
    stop: () => {
      if (closed) return;
      closed = true;
      clearInterval(check);
      try {
        socket.close();
      } catch {
        // Ignore already closed socket.
      }
    },
  };
}

/** Host-side UDP bridge forwarding tunnel CALL_UDP_* frames to `<hostAddress>:<hostPort>`. */
export function openHostUdpBridge(
  hostPort: number,
  tunnel: { sendDatagram(data: Uint8Array): void; close(): void },
  hostAddress = "127.0.0.1",
): { sendToHost(data: Uint8Array): void; close(): void } | null {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) return null;
  const targetAddress = normalizeCandidateIp(hostAddress);
  const unzonedTarget = stripIpZone(targetAddress);
  const ipFamily = isIP(targetAddress);
  if (ipFamily !== 4 && ipFamily !== 6) return null;
  const socket = createSocket(ipFamily === 6 ? "udp6" : "udp4");
  const bindAddress =
    ipFamily === 6
      ? unzonedTarget === "::1"
        ? "::1"
        : "::"
      : unzonedTarget === "127.0.0.1"
        ? "127.0.0.1"
        : "0.0.0.0";
  let closed = false;
  let alertTimer: ReturnType<typeof setTimeout> | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    if (alertTimer !== null) {
      clearTimeout(alertTimer);
      alertTimer = null;
    }
    idle.stop();
    tunnel.close();
  };
  const scheduleAlertClose = () => {
    if (closed || alertTimer !== null) return;
    alertTimer = setTimeout(close, DTLS_ALERT_CLOSE_DELAY_MS);
    alertTimer.unref?.();
  };
  const idle = attachIdleUdpSocket(socket, close);

  socket.on("message", (msg, rinfo) => {
    if (closed) return;
    if (
      rinfo.port !== hostPort ||
      stripIpZone(normalizeCandidateIp(rinfo.address)) !== unzonedTarget
    ) {
      return;
    }
    idle.touch();
    tunnel.sendDatagram(msg);
    if (isDtlsAlert(msg)) scheduleAlertClose();
  });
  socket.bind(0, bindAddress);

  return {
    sendToHost(data) {
      if (closed) return;
      idle.touch();
      socket.send(data, hostPort, targetAddress);
      if (isDtlsAlert(data)) scheduleAlertClose();
    },
    close,
  };
}

export interface ClientCallBridgePoolOptions {
  readonly idleTimeoutMs?: number;
  readonly onCallOpened?: (pcId: string) => void;
  readonly onBridgeClosed?: (pcId: string, closedByAlert: boolean) => void;
}

/** Client-side UDP bridge pool rewriting `/api/offer` answers to loopback ports over the mux. */
export class ClientCallBridgePool {
  readonly #bridges = new Map<string, BridgeEntry>();
  readonly #options: ClientCallBridgePoolOptions;

  constructor(options: ClientCallBridgePoolOptions = {}) {
    this.#options = options;
  }

  get activeCount(): number {
    return this.#bridges.size;
  }

  hasBridge(pcId: string): boolean {
    return this.#bridges.has(pcId);
  }

  activePcIds(): IterableIterator<string> {
    return this.#bridges.keys();
  }

  async adaptOfferResponse(
    response: Response,
    mux: MuxEndpoint,
    options: { readonly mode: "direct" | "relay"; readonly directHost?: string },
  ): Promise<Response> {
    if (!response.ok) return response;
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        return new Response(text, response);
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return new Response(text, response);
    }
    if (typeof payload.sdp !== "string" || typeof payload.pc_id !== "string") {
      return new Response(text, response);
    }
    const candidate = extractHostUdpCandidate(payload.sdp);
    if (candidate === null) {
      return new Response(text, response);
    }
    const bridge = await this.#openBridge(payload.pc_id, candidate, mux);
    this.#options.onCallOpened?.(payload.pc_id);
    const rewrittenSdp = rewriteSdpAnswer(payload.sdp, {
      localPort: bridge.localPort,
      mode: options.mode,
      directHost: options.directHost,
    });
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify({ ...payload, sdp: rewrittenSdp }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  closeBridge(pcId: string): void {
    this.#bridges.get(pcId)?.close(false);
  }

  closeAll(): void {
    for (const bridge of this.#bridges.values()) bridge.close();
    this.#bridges.clear();
  }

  async #openBridge(
    pcId: string,
    target: HostUdpCandidate,
    mux: MuxEndpoint,
  ): Promise<BridgeEntry> {
    const socket = createSocket("udp4");
    let alertTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, "127.0.0.1", () => {
          socket.removeListener("error", reject);
          resolve();
        });
      });
      const addr = socket.address();
      const localPort = addr.port;
      const channel: MuxCallChannelHandle = mux.openCallChannel(target.port, target.address);
      let browserPeer: { address: string; port: number } | null = null;
      let closed = false;
      let closedByAlert = false;
      let entry: BridgeEntry | null = null;

      const close = (notify = true) => {
        if (closed) return;
        closed = true;
        if (alertTimer !== null) {
          clearTimeout(alertTimer);
          alertTimer = null;
        }
        idle.stop();
        if (entry !== null && this.#bridges.get(pcId) === entry) {
          this.#bridges.delete(pcId);
        }
        if (notify) this.#options.onBridgeClosed?.(pcId, closedByAlert);
        channel.close();
      };
      const scheduleAlertClose = () => {
        if (closed || alertTimer !== null) return;
        closedByAlert = true;
        alertTimer = setTimeout(() => close(), DTLS_ALERT_CLOSE_DELAY_MS);
        alertTimer.unref?.();
      };
      const idle = attachIdleUdpSocket(socket, () => close(), this.#options.idleTimeoutMs);

      socket.on("message", (msg, rinfo) => {
        if (closed) return;
        idle.touch();
        browserPeer = { address: rinfo.address, port: rinfo.port };
        channel.sendDatagram(msg);
        if (isDtlsAlert(msg)) scheduleAlertClose();
      });
      channel.onDatagram((data) => {
        if (closed || browserPeer === null) return;
        idle.touch();
        socket.send(data, browserPeer.port, browserPeer.address);
        if (isDtlsAlert(data)) scheduleAlertClose();
      });
      channel.onClose(() => close());

      entry = { socket, localPort, close };
      this.#bridges.get(pcId)?.close(false);
      this.#bridges.set(pcId, entry);
      return entry;
    } catch (error) {
      if (alertTimer !== null) clearTimeout(alertTimer);
      try {
        socket.close();
      } catch {
        // Ignore already closed socket.
      }
      throw error;
    }
  }
}
