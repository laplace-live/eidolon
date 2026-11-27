import { hostname } from "node:os";
import { errorText, logger } from "@eidolon/config";
import WebSocket from "ws";
import {
  deriveRelayDeviceToken,
  deriveRelayInviteToken,
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
import {
  guardWsErrors,
  nextWsMessage,
  rawDataToText,
  rawDataToUint8Array,
  safeCloseWs,
  sendWs,
} from "./ws.ts";

export type SubspaceConnectionState = "disconnected" | "connecting" | "connected" | "error";

const CONNECT_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 15_000;
const STRIPPED_PROXY_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-eidolon-proof",
  "x-eidolon-expected-host",
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

function closeCodeToError(
  code: number,
  msg: string,
  fallbackPrefix: string,
  credentialKind?: "invite" | "device",
): SubspaceConnectError {
  if (code === RELAY_CLOSE_CODE.UNAUTHORIZED) {
    return new SubspaceConnectError(
      "pairing-failed",
      credentialKind === "device" ? "Device access was revoked" : msg || "Unauthorized",
    );
  }
  if (code === RELAY_CLOSE_CODE.HOST_NOT_FOUND) {
    return new SubspaceConnectError(
      "subspace-unreachable",
      msg || "Remote Eidolon server is offline",
    );
  }
  return new SubspaceConnectError("subspace-unreachable", msg || `${fallbackPrefix} (${code})`);
}

function waitForOpen(
  ws: WebSocket,
  timeoutMs: number,
  credentialKind?: "invite" | "device",
): Promise<void> {
  guardWsErrors(ws);
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
      finish(() =>
        reject(closeCodeToError(code, reason.toString("utf8"), "Closed", credentialKind)),
      );
    };
    const onError = (err: Error) =>
      finish(() => {
        logger.warning(`[subspace] Client WebSocket connect error: ${errorText(err)}`);
        reject(
          new SubspaceConnectError("subspace-unreachable", "Could not connect to remote server"),
        );
      });
    ws.on("open", onOpen);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

function nextMessage(
  ws: WebSocket,
  timeoutMs: number,
  credentialKind?: "invite" | "device",
): Promise<WebSocket.RawData> {
  return nextWsMessage(ws, timeoutMs, {
    onTimeout: () => new SubspaceConnectError("subspace-unreachable", "Handshake timed out"),
    onClose: (code, msg) => closeCodeToError(code, msg, "Connection closed", credentialKind),
    onError: (err) => {
      logger.warning(`[subspace] Client WebSocket handshake error: ${errorText(err)}`);
      return new SubspaceConnectError("subspace-unreachable", "Could not connect to remote server");
    },
  });
}

function targetWsUrl(server: Pick<SubspaceSavedServer, "mode" | "endpoint" | "relay">): string {
  if (server.mode === "direct") {
    if (!server.endpoint) throw new Error("Direct Subspace server lacks endpoint");
    const proto = server.endpoint.tls ? "wss" : "ws";
    const host =
      server.endpoint.host.includes(":") && !server.endpoint.host.startsWith("[")
        ? `[${server.endpoint.host}]`
        : server.endpoint.host;
    return `${proto}://${host}:${server.endpoint.port}/v1/subspace`;
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
    | { readonly kind: "invite"; readonly relayTicket: string }
    | { readonly kind: "device"; readonly grantId: string; readonly relayToken: string };
  readonly relayUnexpectedErrorCode: SubspaceConnectError["code"];
  readonly buildE2eeAuth: (authBinding: string) => E2eeAuthRequest;
  readonly signal?: AbortSignal;
}): Promise<{ readonly tunnel: ActiveTunnel; readonly authRes: E2eeAuthResponse }> {
  if (input.signal?.aborted) {
    throw new SubspaceConnectError("subspace-unreachable", "Disconnected");
  }
  const ws = new WebSocket(targetWsUrl(input.target));
  guardWsErrors(ws);
  const onAbort = () => ws.terminate();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await waitForOpen(ws, CONNECT_TIMEOUT_MS, input.relayCredential.kind);
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
      const readyRaw = rawDataToText(
        await nextMessage(ws, CONNECT_TIMEOUT_MS, input.relayCredential.kind),
      );
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
    const e2eeReady = rawDataToText(
      await nextMessage(ws, CONNECT_TIMEOUT_MS, input.relayCredential.kind),
    );
    const session = await hs.finish(e2eeReady);
    await session.sendJson(input.buildE2eeAuth(session.authBinding), (sealed) =>
      sendWs(ws, sealed),
    );
    const authRes = await session.openJson<E2eeAuthResponse>(
      rawDataToUint8Array(await nextMessage(ws, CONNECT_TIMEOUT_MS, input.relayCredential.kind)),
    );
    const mux = new MuxEndpoint({
      sendFrame: (frame) => session.send(frame, (sealed) => sendWs(ws, sealed)),
    });
    return { tunnel: { ws, session, mux }, authRes };
  } catch (error) {
    ws.terminate();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
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
    const relayTicket = await deriveRelayInviteToken(offer.ticket);
    const { tunnel, authRes } = await dialAuthenticatedTunnel({
      target: { mode: offer.mode, endpoint: offer.endpoint, relay: offer.relay },
      hostPublicKeyB64: offer.hostPublicKeyB64,
      relayCredential: { kind: "invite", relayTicket },
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
    logger.warning(`[subspace] Pairing handshake failed: ${errorText(error)}`);
    throw new SubspaceConnectError("pairing-failed", "Could not connect to remote server");
  }
}

export interface SubspaceClientEvents {
  readonly onConnected?: (version: string) => void;
  readonly onStateChange?: () => void;
}

export interface SubspaceClientOptions {
  readonly callBridgeIdleMs?: number;
  readonly callProbeIntervalMs?: number;
}

/** Persistent E2EE WebSocket + Mux client for a paired remote Eidolon instance. */
export class SubspaceClient {
  #server: SubspaceSavedServer;
  readonly #events: SubspaceClientEvents;
  readonly #callProbeIntervalMs: number;
  readonly #bridges: ClientCallBridgePool;
  readonly #activePcIds = new Set<string>();

  #tunnel: ActiveTunnel | null = null;
  #connecting: Promise<ActiveTunnel> | null = null;
  #connectAbort: AbortController | null = null;
  #connectEpoch = 0;
  #state: SubspaceConnectionState = "disconnected";
  #lastError: string | null = null;
  #latencyMs: number | null = null;
  #wanted = false;
  #revoked = false;
  #manuallyDisconnected = false;
  #pendingOffers = 0;
  #backoffMs = 500;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #callProbeTimer: ReturnType<typeof setInterval> | null = null;
  #callProbeTask: Promise<void> | null = null;

  constructor(
    server: SubspaceSavedServer,
    events: SubspaceClientEvents = {},
    initialTunnel?: ActiveTunnel,
    options: SubspaceClientOptions = {},
  ) {
    this.#server = server;
    this.#events = events;
    this.#callProbeIntervalMs = options.callProbeIntervalMs ?? 5_000;
    this.#bridges = new ClientCallBridgePool({
      idleTimeoutMs: options.callBridgeIdleMs,
      onCallOpened: (pcId) => {
        this.#activePcIds.add(pcId);
        if (this.#server.mode === "direct") this.#ensureCallProbeTimer();
      },
      onBridgeClosed: (pcId, closedByAlert) => {
        if (closedByAlert || this.#server.mode === "relay") {
          this.#activePcIds.delete(pcId);
          if (this.#activePcIds.size === 0) this.#stopCallProbeTimer();
        } else if (this.#activePcIds.has(pcId)) {
          void this.refreshActiveCallCount();
        }
      },
    });
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

  get manuallyDisconnected(): boolean {
    return this.#manuallyDisconnected;
  }

  get activeCallCount(): number {
    let calls = this.#activePcIds.size;
    for (const pcId of this.#bridges.activePcIds()) {
      if (!this.#activePcIds.has(pcId)) calls += 1;
    }
    return this.#pendingOffers + calls;
  }

  async refreshActiveCallCount(): Promise<number> {
    if (this.#activePcIds.size === 0 || this.#server.mode === "relay") {
      return this.activeCallCount;
    }
    if (!this.#wanted || this.#revoked) {
      this.#activePcIds.clear();
      this.#bridges.closeAll();
      this.#stopCallProbeTimer();
      return this.activeCallCount;
    }
    if (this.#tunnel === null || this.#tunnel.mux.closed) {
      // Direct LAN WebRTC calls outlive temporary tunnel drops; wait until reconnect
      // can probe PATCH /api/offer rather than clearing active calls while offline.
      return this.activeCallCount;
    }
    if (this.#callProbeTask !== null) {
      await this.#callProbeTask;
      return this.activeCallCount;
    }
    const tunnel = this.#tunnel;
    const task = (async () => {
      for (const pcId of [...this.#activePcIds]) {
        if (!this.#wanted || this.#revoked) {
          this.#activePcIds.clear();
          this.#bridges.closeAll();
          break;
        }
        if (this.#tunnel !== tunnel || tunnel.mux.closed) {
          break;
        }
        try {
          const res = await tunnel.mux.request({
            method: "PATCH",
            path: "/api/offer",
            headers: [["content-type", "application/json"]],
            body: new Response(JSON.stringify({ pc_id: pcId, candidates: [] })).body,
          });
          if (res.body !== null && !res.body.locked) void res.body.cancel().catch(() => {});
          if (res.status === 404 || res.status === 400 || res.status === 410) {
            this.#activePcIds.delete(pcId);
            this.#bridges.closeBridge(pcId);
          }
        } catch {
          if (!this.#wanted || this.#revoked) {
            this.#activePcIds.clear();
            this.#bridges.closeAll();
            break;
          }
          if (this.#tunnel !== tunnel || tunnel.mux.closed) {
            break;
          }
        }
      }
    })().finally(() => {
      if (this.#callProbeTask === task) this.#callProbeTask = null;
      if (this.#activePcIds.size === 0) this.#stopCallProbeTimer();
    });
    this.#callProbeTask = task;
    await task;
    return this.activeCallCount;
  }

  updateServer(server: SubspaceSavedServer): void {
    const endpointChanged =
      server.mode !== this.#server.mode ||
      server.endpoint?.host !== this.#server.endpoint?.host ||
      server.endpoint?.port !== this.#server.endpoint?.port ||
      server.relay?.url !== this.#server.relay?.url;
    this.#server = server;
    if (endpointChanged && this.#wanted) {
      this.#cancelConnecting();
      this.#dropTunnel("Server settings updated");
      void this.connect().catch(() => {});
    }
  }

  start(): void {
    this.#wanted = true;
    this.#revoked = false;
    this.#manuallyDisconnected = false;
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
    this.#cancelConnecting();
    this.#dropTunnel("Disconnected");
    this.#setState("disconnected", null);
  }

  disconnectManually(): void {
    this.#manuallyDisconnected = true;
    this.stop();
  }

  async connect(): Promise<ActiveTunnel> {
    if (this.#tunnel !== null && !this.#tunnel.mux.closed) return this.#tunnel;
    if (this.#connecting !== null) return this.#connecting;
    this.#wanted = true;
    this.#revoked = false;
    this.#manuallyDisconnected = false;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const epoch = ++this.#connectEpoch;
    const abort = new AbortController();
    this.#connectAbort = abort;
    const task = this.#openTunnel(epoch, abort.signal).finally(() => {
      if (this.#connecting === task) this.#connecting = null;
      if (this.#connectAbort === abort) this.#connectAbort = null;
    });
    this.#connecting = task;
    return task;
  }

  async proxyFetch(request: Request, targetPathWithSearch: string): Promise<Response> {
    const isOfferRequest =
      request.method === "POST" &&
      new URL(targetPathWithSearch, "http://subspace.local").pathname === "/api/offer";
    if (isOfferRequest) this.#pendingOffers += 1;
    try {
      let renegotiatedPcId: string | null = null;
      let offerReqBuf: ArrayBuffer | null = null;
      if (isOfferRequest && request.body !== null) {
        offerReqBuf = await request.arrayBuffer();
        try {
          const parsedReq = JSON.parse(new TextDecoder().decode(offerReqBuf)) as {
            pc_id?: unknown;
          } | null;
          if (typeof parsedReq?.pc_id === "string" && parsedReq.pc_id.length > 0) {
            renegotiatedPcId = parsedReq.pc_id;
          }
        } catch {
          // Ignore non-JSON /api/offer payloads.
        }
      }
      let tunnel: ActiveTunnel;
      try {
        tunnel = await this.connect();
      } catch (error) {
        if (error instanceof SubspaceConnectError) throw error;
        logger.warning(
          `[subspace] Proxy connect failed for ${this.#server.id}: ${errorText(error)}`,
        );
        throw new SubspaceConnectError(
          "subspace-unreachable",
          "Could not connect to remote server",
        );
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
        body: isOfferRequest
          ? offerReqBuf === null
            ? null
            : new Response(offerReqBuf).body
          : bodiless
            ? null
            : request.body,
        signal: request.signal,
      });
      const outHeaders = new Headers();
      for (const [name, value] of res.headers) outHeaders.append(name, value);
      const response = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: outHeaders,
      });
      if (isOfferRequest) {
        const adapted = await this.#bridges.adaptOfferResponse(response, tunnel.mux, {
          mode: this.#server.mode,
          directHost: this.#server.endpoint?.host,
        });
        if (adapted.ok && renegotiatedPcId !== null) {
          try {
            const parsedRes = (await adapted.clone().json()) as { pc_id?: unknown } | null;
            if (typeof parsedRes?.pc_id === "string" && parsedRes.pc_id !== renegotiatedPcId) {
              this.#activePcIds.delete(renegotiatedPcId);
              this.#bridges.closeBridge(renegotiatedPcId);
            }
          } catch {
            // Ignore non-JSON /api/offer answers.
          }
        }
        return adapted;
      }
      return response;
    } finally {
      if (isOfferRequest) this.#pendingOffers -= 1;
    }
  }

  #cancelConnecting(): void {
    this.#connectEpoch += 1;
    this.#connectAbort?.abort();
    this.#connectAbort = null;
    this.#connecting = null;
  }

  async #openTunnel(epoch: number, signal: AbortSignal): Promise<ActiveTunnel> {
    this.#setState("connecting", null);
    try {
      const relayToken = await deriveRelayDeviceToken(this.#server.deviceToken);
      const { tunnel, authRes } = await dialAuthenticatedTunnel({
        target: this.#server,
        hostPublicKeyB64: this.#server.hostPublicKeyB64,
        relayCredential: {
          kind: "device",
          grantId: this.#server.grantId,
          relayToken,
        },
        relayUnexpectedErrorCode: "subspace-unreachable",
        buildE2eeAuth: (authBinding) => ({
          type: "e2ee_auth",
          kind: "token",
          grantId: this.#server.grantId,
          deviceToken: this.#server.deviceToken,
          authBinding,
        }),
        signal,
      });
      if (signal.aborted || !this.#wanted || epoch !== this.#connectEpoch) {
        tunnel.mux.close("Disconnected");
        tunnel.ws.terminate();
        throw new SubspaceConnectError("subspace-unreachable", "Disconnected");
      }
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
      if (signal.aborted || !this.#wanted || epoch !== this.#connectEpoch) throw error;
      if (error instanceof SubspaceConnectError && error.code === "pairing-failed") {
        this.#revoked = true;
      } else if (!(error instanceof SubspaceConnectError)) {
        logger.warning(
          `[subspace] Client connection error for ${this.#server.id}: ${errorText(error)}`,
        );
      }
      const message =
        error instanceof SubspaceConnectError
          ? error.message
          : "Could not connect to remote server";
      this.#setState("error", message);
      if (this.#wanted && !this.#revoked) this.#scheduleReconnect();
      throw error;
    }
  }

  #failActiveTunnel(
    tunnel: ActiveTunnel,
    dropReason: string,
    errorReason: string | null = dropReason,
  ): void {
    if (this.#tunnel !== tunnel) return;
    this.#dropTunnel(dropReason);
    this.#setState(this.#wanted ? "error" : "disconnected", this.#wanted ? errorReason : null);
    if (this.#wanted && !this.#revoked) this.#scheduleReconnect();
  }

  #attachTunnel(tunnel: ActiveTunnel): void {
    this.#dropTunnel("Replaced by new connection");
    this.#tunnel = tunnel;
    this.#setState("connected", null);
    this.#pingTimer = setInterval(() => {
      void tunnel.mux
        .ping()
        .then((ms) => {
          if (this.#tunnel === tunnel) this.#latencyMs = ms;
        })
        .catch(() => {
          this.#failActiveTunnel(tunnel, "Keepalive timeout");
        });
    }, PING_INTERVAL_MS);
    this.#pingTimer.unref?.();

    tunnel.ws.on("message", (raw) => {
      void (async () => {
        try {
          const plain = await tunnel.session.open(rawDataToUint8Array(raw));
          await tunnel.mux.handleFrame(plain);
        } catch (error) {
          logger.warning(
            `[subspace] Client tunnel frame error for ${this.#server.id}: ${errorText(error)}`,
          );
          this.#failActiveTunnel(tunnel, "Tunnel error", "Could not connect to remote server");
        }
      })();
    });
    tunnel.ws.on("close", (code, reason) => {
      if (code === RELAY_CLOSE_CODE.UNAUTHORIZED) {
        this.#revoked = true;
        this.#failActiveTunnel(tunnel, "Device access was revoked", "Device access was revoked");
        return;
      }
      const msg = reason.toString("utf8") || null;
      this.#failActiveTunnel(tunnel, msg ?? "Disconnected", msg);
    });
    tunnel.ws.on("error", (err) => {
      logger.warning(`[subspace] Client socket error for ${this.#server.id}: ${errorText(err)}`);
      this.#failActiveTunnel(tunnel, "Socket error", "Could not connect to remote server");
    });

    if (this.#activePcIds.size > 0 && this.#server.mode === "direct") {
      this.#ensureCallProbeTimer();
      void this.refreshActiveCallCount();
    }
  }

  #dropTunnel(reason: string): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    this.#stopCallProbeTimer();
    this.#callProbeTask = null;
    const current = this.#tunnel;
    this.#tunnel = null;
    this.#latencyMs = null;
    if (this.#server.mode === "relay" || !this.#wanted || this.#revoked) {
      this.#activePcIds.clear();
    }
    this.#bridges.closeAll();
    if (current !== null) {
      current.mux.close(reason);
      safeCloseWs(current.ws, 1000, reason);
    }
  }

  #ensureCallProbeTimer(): void {
    if (this.#callProbeTimer !== null) return;
    this.#callProbeTimer = setInterval(() => {
      void this.refreshActiveCallCount();
    }, this.#callProbeIntervalMs);
    this.#callProbeTimer.unref?.();
  }

  #stopCallProbeTimer(): void {
    if (this.#callProbeTimer === null) return;
    clearInterval(this.#callProbeTimer);
    this.#callProbeTimer = null;
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
