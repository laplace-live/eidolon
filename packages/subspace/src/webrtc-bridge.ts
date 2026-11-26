import { createSocket, type Socket } from "node:dgram";
import type { MuxCallChannelHandle, MuxEndpoint } from "./protocol/index.ts";

const UDP_BRIDGE_IDLE_MS = 120_000;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

interface BridgeEntry {
  readonly socket: Socket;
  readonly localPort: number;
  readonly close: () => void;
}

/** Extracts the first UDP host candidate's port from a bundled SmallWebRTC SDP answer. */
export function extractHostUdpPort(sdp: string): number | null {
  for (const line of sdp.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("a=candidate:")) continue;
    const parts = trimmed.slice("a=candidate:".length).split(/\s+/);
    if (parts.length < 8) continue;
    const protocol = parts[2]?.toLowerCase();
    const port = Number(parts[5]);
    const type = parts[7]?.toLowerCase();
    if (
      protocol === "udp" &&
      type === "host" &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
    ) {
      return port;
    }
  }
  return null;
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
): { readonly touch: () => void; readonly stop: () => void } {
  let closed = false;
  let lastActiveAt = Date.now();
  const check = setInterval(() => {
    if (!closed && Date.now() - lastActiveAt >= UDP_BRIDGE_IDLE_MS) onClose();
  }, 10_000);
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

/** Host-side UDP bridge forwarding tunnel CALL_UDP_* frames to 127.0.0.1:<weriftPort>. */
export function openHostUdpBridge(
  hostPort: number,
  tunnel: { sendDatagram(data: Uint8Array): void; close(): void },
): { sendToHost(data: Uint8Array): void; close(): void } | null {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) return null;
  const socket = createSocket("udp4");
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    idle.stop();
    tunnel.close();
  };
  const idle = attachIdleUdpSocket(socket, close);

  socket.on("message", (msg) => {
    if (closed) return;
    idle.touch();
    tunnel.sendDatagram(msg);
  });
  socket.bind(0, "127.0.0.1");

  return {
    sendToHost(data) {
      if (closed) return;
      idle.touch();
      socket.send(data, hostPort, "127.0.0.1");
    },
    close,
  };
}

/** Client-side UDP bridge pool rewriting `/api/offer` answers to loopback ports over the mux. */
export class ClientCallBridgePool {
  readonly #bridges = new Map<string, BridgeEntry>();

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
    const hostPort = extractHostUdpPort(payload.sdp);
    if (hostPort === null) {
      return new Response(text, response);
    }
    this.#bridges.get(payload.pc_id)?.close();
    const bridge = await this.#openBridge(payload.pc_id, hostPort, mux);
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

  closeAll(): void {
    for (const bridge of this.#bridges.values()) bridge.close();
    this.#bridges.clear();
  }

  async #openBridge(pcId: string, hostPort: number, mux: MuxEndpoint): Promise<BridgeEntry> {
    const socket = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => {
        socket.removeListener("error", reject);
        resolve();
      });
    });
    const addr = socket.address();
    const localPort = addr.port;
    const channel: MuxCallChannelHandle = mux.openCallChannel(hostPort);
    let browserPeer: { address: string; port: number } | null = null;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      idle.stop();
      this.#bridges.delete(pcId);
      channel.close();
    };
    const idle = attachIdleUdpSocket(socket, close);

    socket.on("message", (msg, rinfo) => {
      if (closed) return;
      idle.touch();
      browserPeer = { address: rinfo.address, port: rinfo.port };
      channel.sendDatagram(msg);
    });
    channel.onDatagram((data) => {
      if (closed || browserPeer === null) return;
      idle.touch();
      socket.send(data, browserPeer.port, browserPeer.address);
    });
    channel.onClose(() => close());

    const entry: BridgeEntry = { socket, localPort, close };
    this.#bridges.set(pcId, entry);
    return entry;
  }
}
