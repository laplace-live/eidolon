import { hostname } from "node:os";
import { errorText } from "@eidolon/config";
import WebSocket from "ws";
import {
  type E2eeAuthRequest,
  type E2eeAuthResponse,
  E2eeError,
  type E2eeSession,
  isPairingExpired,
  MuxEndpoint,
  type SubspacePairingOffer,
  startClientHandshake,
} from "./protocol/index.ts";
import { RELAY_CLOSE_CODE, RELAY_PATHS, type RelayReadyMessage } from "./relay-contract.ts";
import { httpToWsUrl } from "./settings.ts";
import type { SubspaceSavedServer } from "./store.ts";
import { ClientCallBridgePool } from "./webrtc-bridge.ts";
import { nextWsMessage, rawDataToText, rawDataToUint8Array, safeCloseWs, sendWs } from "./ws.ts";

export type SubspaceConnectionState = "disconnected" | "connecting" | "connected" | "error";

const CONNECT_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 15_000;
const STRIPPED_PROXY_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-eidolon-proof",
  "host",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
]);

export class SubspaceConnectError extends Error {
  readonly code:
    | "invalid-pairing-code"
    | "pairing-expired"
    | "pairing-failed"
    | "subspace-unreachable";

  constructor(code: SubspaceConnectError["code"], message: string) {
    super(message);
    this.name = "SubspaceConnectError";
    this.code = code;
  }
}

function closeCodeToError(code: number, msg: string, fallbackPrefix: string): SubspaceConnectError {
  if (code === RELAY_CLOSE_CODE.UNAUTHORIZED) {
    return new SubspaceConnectError("pairing-failed", msg || "Unauthorized");
  }
  if (code === RELAY_CLOSE_CODE.HOST_NOT_FOUND) {
    return new SubspaceConnectError(
      "subspace-unreachable",
      msg || "Remote Eidolon server is offline",
    );
  }
  return new SubspaceConnectError("subspace-unreachable", msg || `${fallbackPrefix} (${code})`);
}

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("close", onClose);
      ws.off("error", onError);
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new SubspaceConnectError("subspace-unreachable", "Connection timed out")),
        ),
      timeoutMs,
    );
    const onOpen = () => finish(resolve);
    const onClose = (code: number, reason: Buffer) => {
      finish(() => reject(closeCodeToError(code, reason.toString("utf8"), "Closed")));
    };
    const onError = (err: Error) =>
      finish(() => reject(new SubspaceConnectError("subspace-unreachable", errorText(err))));
    ws.on("open", onOpen);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

function nextMessage(ws: WebSocket, timeoutMs: number): Promise<WebSocket.RawData> {
  return nextWsMessage(ws, timeoutMs, {
    onTimeout: () => new SubspaceConnectError("subspace-unreachable", "Handshake timed out"),
    onClose: (code, msg) => closeCodeToError(code, msg, "Connection closed"),
    onError: (err) => new SubspaceConnectError("subspace-unreachable", errorText(err)),
  });
}

function targetWsUrl(server: Pick<SubspaceSavedServer, "mode" | "endpoint" | "relay">): string {
  if (server.mode === "direct") {
    if (!server.endpoint) throw new Error("Direct Subspace server lacks endpoint");
    const proto = server.endpoint.tls ? "wss" : "ws";
    return `${proto}://${server.endpoint.host}:${server.endpoint.port}/v1/subspace`;
  }
  if (!server.relay) throw new Error("Relay Subspace server lacks relay details");
  return httpToWsUrl(server.relay.url, RELAY_PATHS.CLIENT_CONNECT);
}

interface ActiveTunnel {
  readonly ws: WebSocket;
  readonly session: E2eeSession;
  readonly mux: MuxEndpoint;
}

async function dialAuthenticatedTunnel(input: {
  readonly target: Pick<SubspaceSavedServer, "mode" | "endpoint" | "relay">;
  readonly hostPublicKeyB64: string;
  readonly relayCredential:
    | { readonly kind: "invite"; readonly ticket: string }
    | { readonly kind: "device"; readonly grantId: string; readonly deviceToken: string };
  readonly relayUnexpectedErrorCode: SubspaceConnectError["code"];
  readonly buildE2eeAuth: (authBinding: string) => E2eeAuthRequest;
}): Promise<{ readonly tunnel: ActiveTunnel; readonly authRes: E2eeAuthResponse }> {
  const ws = new WebSocket(targetWsUrl(input.target));
  try {
    await waitForOpen(ws, CONNECT_TIMEOUT_MS);
    if (input.target.mode === "relay") {
      await sendWs(
        ws,
        JSON.stringify({
          type: "client_auth",
          v: 1,
          relayHostId: input.target.relay!.relayHostId,
          credential: input.relayCredential,
        }),
      );
      const readyRaw = rawDataToText(await nextMessage(ws, CONNECT_TIMEOUT_MS));
      const relayReady = JSON.parse(readyRaw) as RelayReadyMessage;
      if (relayReady.type !== "relay_ready") {
        throw new SubspaceConnectError(
          input.relayUnexpectedErrorCode,
          "Unexpected Relay handshake response",
        );
      }
    }
    const hs = await startClientHandshake(input.hostPublicKeyB64);
    await sendWs(ws, hs.helloRaw);
    const e2eeReady = rawDataToText(await nextMessage(ws, CONNECT_TIMEOUT_MS));
    const session = await hs.finish(e2eeReady);
    await session.sendJson(input.buildE2eeAuth(session.authBinding), (sealed) =>
      sendWs(ws, sealed),
    );
    const authRes = await session.openJson<E2eeAuthResponse>(
      rawDataToUint8Array(await nextMessage(ws, CONNECT_TIMEOUT_MS)),
    );
    const mux = new MuxEndpoint({
      sendFrame: (frame) => session.send(frame, (sealed) => sendWs(ws, sealed)),
    });
    return { tunnel: { ws, session, mux }, authRes };
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

export async function performPairingHandshake(
  offer: SubspacePairingOffer,
  options: { readonly clientName?: string } = {},
): Promise<{
  readonly grantId: string;
  readonly hostName: string;
  readonly serverVersion: string;
  readonly deviceToken: string;
  readonly tunnel: ActiveTunnel;
}> {
  if (isPairingExpired(offer)) {
    throw new SubspaceConnectError("pairing-expired", "This pairing link has expired");
  }
  const clientName = (
    options.clientName?.trim() ||
    hostname().replace(/\.local$/i, "") ||
    "Eidolon Client"
  ).slice(0, 120);
  try {
    const { tunnel, authRes } = await dialAuthenticatedTunnel({
      target: { mode: offer.mode, endpoint: offer.endpoint, relay: offer.relay },
      hostPublicKeyB64: offer.hostPublicKeyB64,
      relayCredential: { kind: "invite", ticket: offer.ticket },
      relayUnexpectedErrorCode: "pairing-failed",
      buildE2eeAuth: (authBinding) => ({
        type: "e2ee_auth",
        kind: "pair",
        ticket: offer.ticket,
        clientName,
        authBinding,
      }),
    });
    if (!authRes.ok || typeof authRes.deviceToken !== "string") {
      tunnel.ws.terminate();
      throw new SubspaceConnectError(
        "pairing-failed",
        authRes.ok ? "Missing device token" : authRes.message,
      );
    }
    return {
      grantId: authRes.grantId,
      hostName: authRes.hostName,
      serverVersion: authRes.serverVersion,
      deviceToken: authRes.deviceToken,
      tunnel,
    };
  } catch (error) {
    if (error instanceof SubspaceConnectError) throw error;
    if (error instanceof E2eeError) {
      throw new SubspaceConnectError("pairing-failed", error.message);
    }
    throw new SubspaceConnectError("pairing-failed", errorText(error));
  }
}

export interface SubspaceClientEvents {
  readonly onConnected?: (version: string) => void;
  readonly onStateChange?: () => void;
}

/** Persistent E2EE WebSocket + Mux client for a paired remote Eidolon instance. */
export class SubspaceClient {
  #server: SubspaceSavedServer;
  readonly #events: SubspaceClientEvents;
  readonly #bridges = new ClientCallBridgePool();

  #tunnel: ActiveTunnel | null = null;
  #connecting: Promise<ActiveTunnel> | null = null;
  #state: SubspaceConnectionState = "disconnected";
  #lastError: string | null = null;
  #latencyMs: number | null = null;
  #wanted = false;
  #revoked = false;
  #backoffMs = 500;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    server: SubspaceSavedServer,
    events: SubspaceClientEvents = {},
    initialTunnel?: ActiveTunnel,
  ) {
    this.#server = server;
    this.#events = events;
    if (initialTunnel !== undefined) {
      this.#wanted = true;
      this.#attachTunnel(initialTunnel);
    }
  }

  get server(): SubspaceSavedServer {
    return this.#server;
  }

  get state(): SubspaceConnectionState {
    return this.#state;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  get latencyMs(): number | null {
    return this.#latencyMs;
  }

  updateServer(server: SubspaceSavedServer): void {
    const endpointChanged =
      server.mode !== this.#server.mode ||
      server.endpoint?.host !== this.#server.endpoint?.host ||
      server.endpoint?.port !== this.#server.endpoint?.port ||
      server.relay?.url !== this.#server.relay?.url;
    this.#server = server;
    if (endpointChanged && this.#wanted) {
      this.#dropTunnel("Server settings updated");
      void this.connect().catch(() => {});
    }
  }

  start(): void {
    this.#wanted = true;
    this.#revoked = false;
    if (this.#tunnel === null && this.#connecting === null) {
      void this.connect().catch(() => {});
    }
  }

  stop(): void {
    this.#wanted = false;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#dropTunnel("Disconnected");
    this.#setState("disconnected", null);
  }

  async connect(): Promise<ActiveTunnel> {
    if (this.#tunnel !== null && !this.#tunnel.mux.closed) return this.#tunnel;
    if (this.#connecting !== null) return this.#connecting;
    this.#wanted = true;
    this.#revoked = false;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const task = this.#openTunnel().finally(() => {
      if (this.#connecting === task) this.#connecting = null;
    });
    this.#connecting = task;
    return task;
  }

  async proxyFetch(request: Request, targetPathWithSearch: string): Promise<Response> {
    let tunnel: ActiveTunnel;
    try {
      tunnel = await this.connect();
    } catch (error) {
      throw new SubspaceConnectError("subspace-unreachable", errorText(error));
    }
    const headers: [string, string][] = [];
    request.headers.forEach((value, name) => {
      if (!STRIPPED_PROXY_HEADERS.has(name.toLowerCase())) headers.push([name, value]);
    });
    const bodiless = request.method === "GET" || request.method === "HEAD";
    const res = await tunnel.mux.request({
      method: request.method,
      path: targetPathWithSearch,
      headers,
      body: bodiless ? null : request.body,
      signal: request.signal,
    });
    const outHeaders = new Headers();
    for (const [name, value] of res.headers) outHeaders.append(name, value);
    const response = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
    });
    if (
      request.method === "POST" &&
      new URL(targetPathWithSearch, "http://subspace.local").pathname === "/api/offer"
    ) {
      return await this.#bridges.adaptOfferResponse(response, tunnel.mux, {
        mode: this.#server.mode,
        directHost: this.#server.endpoint?.host,
      });
    }
    return response;
  }

  async #openTunnel(): Promise<ActiveTunnel> {
    this.#setState("connecting", null);
    try {
      const { tunnel, authRes } = await dialAuthenticatedTunnel({
        target: this.#server,
        hostPublicKeyB64: this.#server.hostPublicKeyB64,
        relayCredential: {
          kind: "device",
          grantId: this.#server.grantId,
          deviceToken: this.#server.deviceToken,
        },
        relayUnexpectedErrorCode: "subspace-unreachable",
        buildE2eeAuth: (authBinding) => ({
          type: "e2ee_auth",
          kind: "token",
          grantId: this.#server.grantId,
          deviceToken: this.#server.deviceToken,
          authBinding,
        }),
      });
      if (!authRes.ok) {
        tunnel.ws.terminate();
        if (authRes.code === "invalid-token" || authRes.code === "unauthorized") {
          this.#revoked = true;
        }
        throw new SubspaceConnectError("pairing-failed", authRes.message);
      }
      this.#backoffMs = 500;
      this.#attachTunnel(tunnel);
      this.#events.onConnected?.(authRes.serverVersion);
      return tunnel;
    } catch (error) {
      const message = errorText(error);
      this.#setState("error", message);
      if (this.#wanted && !this.#revoked) this.#scheduleReconnect();
      throw error;
    }
  }

  #attachTunnel(tunnel: ActiveTunnel): void {
    this.#dropTunnel("Replaced by new connection");
    this.#tunnel = tunnel;
    this.#setState("connected", null);
    this.#pingTimer = setInterval(() => {
      void tunnel.mux
        .ping()
        .then((ms) => {
          this.#latencyMs = ms;
        })
        .catch(() => {
          this.#dropTunnel("Keepalive timeout");
          if (this.#wanted && !this.#revoked) this.#scheduleReconnect();
        });
    }, PING_INTERVAL_MS);
    this.#pingTimer.unref?.();

    tunnel.ws.on("message", (raw) => {
      void (async () => {
        try {
          const plain = await tunnel.session.open(rawDataToUint8Array(raw));
          await tunnel.mux.handleFrame(plain);
        } catch (error) {
          this.#dropTunnel(errorText(error));
          if (this.#wanted && !this.#revoked) this.#scheduleReconnect();
        }
      })();
    });
    tunnel.ws.on("close", (_code, reason) => {
      if (this.#tunnel !== tunnel) return;
      const msg = reason.toString("utf8") || null;
      this.#dropTunnel(msg ?? "Disconnected");
      this.#setState(this.#wanted ? "error" : "disconnected", msg);
      if (this.#wanted && !this.#revoked) this.#scheduleReconnect();
    });
    tunnel.ws.on("error", (err) => {
      if (this.#tunnel !== tunnel) return;
      const msg = errorText(err);
      this.#dropTunnel(msg);
      this.#setState("error", msg);
      if (this.#wanted && !this.#revoked) this.#scheduleReconnect();
    });
  }

  #dropTunnel(reason: string): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    this.#bridges.closeAll();
    const current = this.#tunnel;
    this.#tunnel = null;
    this.#latencyMs = null;
    if (current !== null) {
      current.mux.close(reason);
      safeCloseWs(current.ws, 1000, reason);
    }
  }

  #scheduleReconnect(): void {
    if (!this.#wanted || this.#revoked || this.#reconnectTimer !== null) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(15_000, Math.round(this.#backoffMs * 1.8));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#wanted && !this.#revoked) void this.connect().catch(() => {});
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #setState(state: SubspaceConnectionState, error: string | null): void {
    if (this.#state === state && this.#lastError === error) return;
    this.#state = state;
    this.#lastError = error;
    this.#events.onStateChange?.();
  }
}
