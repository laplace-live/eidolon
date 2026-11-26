import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { errorText, logger, newId } from "@eidolon/config";
import WebSocket, { WebSocketServer } from "ws";
import { mintRelayJwt, RelayAuthExpiredError } from "./auth-client.ts";
import { SubspaceConnectError } from "./client.ts";
import {
  acceptHostHandshake,
  base64ToBytes,
  bytesToBase64Url,
  computeRelayControlProof,
  constantTimeEqual,
  deriveRelayDeviceToken,
  deriveRelayHostId,
  deriveRelayInviteToken,
  type E2eeAuthRequest,
  type E2eeAuthResponse,
  type E2eeSession,
  importX25519PrivateKey,
  isValidDirectHost,
  MuxEndpoint,
  randomBytes,
  type SubspacePairingOffer,
  sha256Hex,
  utf8Decode,
  utf8Encode,
} from "./protocol/index.ts";
import {
  RELAY_CLOSE_CODE,
  RELAY_PATHS,
  type RelayHostControlOutbound,
  RelayHostControlOutboundSchema,
} from "./relay-contract.ts";
import { httpToWsUrl } from "./settings.ts";
import type { SubspaceHostIdentity, SubspaceRelayAuthRecord, SubspaceStore } from "./store.ts";
import { extractHostUdpPort, openHostUdpBridge } from "./webrtc-bridge.ts";
import {
  guardWsErrors,
  nextWsMessage,
  rawDataToText,
  rawDataToUint8Array,
  safeCloseWs,
  sendWs,
} from "./ws.ts";

export const DIRECT_WS_PATH = "/v1/subspace";
const OFFER_TTL_MS = 10 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const ALLOWED_CALL_PORT_TTL_MS = 5 * 60 * 1000;
const HOST_HOP_BY_HOP = new Set(["transfer-encoding", "connection", "keep-alive"]);

interface ActiveInvite {
  readonly id: string;
  readonly mode: "direct" | "relay";
  readonly ticket: string;
  readonly ticketSha256: string;
  readonly expiresAt: number;
  readonly offer: SubspacePairingOffer;
}

interface HostSessionHandle {
  grantId: string | null;
  close(): void;
}

export interface SubspaceHostDeps {
  readonly store: SubspaceStore;
  readonly serverVersion: () => string;
  readonly dispatch: (request: Request) => Promise<Response>;
  readonly relayUrl: () => string;
  readonly onEvent?: (event: SubspaceHostEvent) => void;
}

export type SubspaceHostEvent =
  | { readonly type: "direct-listening"; readonly port: number }
  | { readonly type: "relay-state"; readonly connected: boolean; readonly error: string | null }
  | {
      readonly type: "device-paired";
      readonly grantId: string;
      readonly clientName: string;
      readonly mode: "direct" | "relay";
    }
  | {
      readonly type: "device-connected";
      readonly grantId: string;
      readonly mode: "direct" | "relay";
    }
  | { readonly type: "device-revoked"; readonly grantId: string };

function socketHeadToWebRequest(
  head: {
    readonly method: string;
    readonly path: string;
    readonly headers: readonly [string, string][];
  },
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Request {
  const url = new URL(
    head.path.startsWith("/") ? head.path : `/${head.path}`,
    "http://subspace.local",
  );
  const headers = new Headers();
  for (const [name, value] of head.headers) headers.append(name, value);
  return new Request(url, {
    method: head.method,
    headers,
    ...(body !== null ? { body, duplex: "half" as const } : {}),
    signal,
  });
}

/**
 * Exposes this local Eidolon server over Direct WebSockets (`ws://<ip>:<port>/v1/subspace`) and/or
 * an outbound E2EE Subspace Relay connection, authenticating every peer with X25519 + AES-GCM.
 */
export class SubspaceHost {
  readonly #deps: SubspaceHostDeps;
  readonly #invites = new Map<string, ActiveInvite>();
  readonly #sessions = new Set<HostSessionHandle>();

  #identity: SubspaceHostIdentity | null = null;
  #privateKey: CryptoKey | null = null;
  #directServer: Server | null = null;
  #directWss: WebSocketServer | null = null;
  #directPort: number | null = null;
  #directChain: Promise<unknown> = Promise.resolve();

  #relayWanted = false;
  #relayWs: WebSocket | null = null;
  #relayConnectTask: Promise<void> | null = null;
  #relayConnected = false;
  #relayError: string | null = null;
  #relayTimer: ReturnType<typeof setTimeout> | null = null;
  #cachedRelayJwt: {
    readonly authUrl: string;
    readonly sessionToken: string;
    readonly jwt: string;
    readonly expiresAt: number;
  } | null = null;
  #relayBackoffMs = 1_000;
  readonly #relayReadyWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (err: Error) => void;
  }>();
  readonly #inviteAckWaiters = new Map<string, () => void>();
  #shareEpoch = 0;
  #stopped = false;

  constructor(deps: SubspaceHostDeps) {
    this.#deps = deps;
  }

  get directPort(): number | null {
    return this.#directPort;
  }

  get listening(): boolean {
    return this.#directServer !== null && this.#directPort !== null;
  }

  get relayConnected(): boolean {
    return this.#relayConnected;
  }

  get relayError(): string | null {
    return this.#relayError;
  }

  activeOffer(mode?: "direct" | "relay"): SubspacePairingOffer | null {
    const now = Date.now();
    for (const [key, invite] of this.#invites) {
      if (invite.expiresAt <= now) this.#invites.delete(key);
    }
    const candidates = [...this.#invites.values()].filter((inv) =>
      mode === undefined ? true : inv.mode === mode,
    );
    return candidates.at(-1)?.offer ?? null;
  }

  async ensureStartedFromDisk(): Promise<void> {
    if (this.#stopped) return;
    const identity = await this.#ensureIdentity();
    const grants = this.#deps.store.readGrants();
    const needsDirect = identity.shareMode === "direct" || grants.some((g) => g.mode === "direct");
    const needsRelay =
      (identity.shareMode === "relay" || grants.some((g) => g.mode === "relay")) &&
      this.#deps.store.readRelayAuth() !== null;
    if (needsDirect && !this.listening) {
      await this.startDirect(identity.directPort);
    }
    if (needsRelay) {
      this.startRelay();
    }
  }

  startDirect(requestedPort?: number): Promise<number> {
    const task = this.#directChain.then(() => this.#startDirectImpl(requestedPort));
    this.#directChain = task.catch(() => {});
    return task;
  }

  stopDirect(): Promise<void> {
    const task = this.#directChain.then(() => this.#stopDirectImpl());
    this.#directChain = task.catch(() => {});
    return task;
  }

  async #startDirectImpl(requestedPort?: number): Promise<number> {
    if (this.#stopped) throw new Error("Subspace host is stopped");
    const identity = await this.#ensureIdentity();
    const targetPort = requestedPort ?? identity.directPort;
    if (this.#directServer !== null && this.#directPort !== null) {
      if (
        requestedPort === undefined ||
        requestedPort === 0 ||
        requestedPort === this.#directPort
      ) {
        return this.#directPort;
      }
      await this.#stopDirectImpl();
    }

    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    const server = createServer((_req, res) => {
      res.writeHead(426, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "upgrade-required", message: "Use WebSocket upgrade at /v1/subspace" },
        }),
      );
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = URL.parse(req.url ?? "/", "http://subspace.local");
      if (url?.pathname !== DIRECT_WS_PATH) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.#serveTunnelSocket(ws, "direct");
      });
    });

    const listen = (host: string, ipv6Only?: boolean): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        const onListening = () => {
          server.removeListener("error", onError);
          const addr = server.address();
          if (addr === null || typeof addr === "string") {
            reject(new Error("Direct server failed to bind a numeric port"));
            return;
          }
          resolve(addr.port);
        };
        if (ipv6Only === undefined) {
          server.listen(targetPort, host, onListening);
        } else {
          server.listen({ host, port: targetPort, ipv6Only }, onListening);
        }
      });

    let listenHost = "::";
    let boundPort: number;
    try {
      boundPort = await listen("::", false);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
        listenHost = "0.0.0.0";
        boundPort = await listen("0.0.0.0");
      } else {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
    }

    this.#directServer = server;
    this.#directWss = wss;
    this.#directPort = boundPort;
    if (identity.directPort !== boundPort) {
      this.#identity = { ...identity, directPort: boundPort };
      this.#deps.store.saveIdentity(this.#identity);
    }
    logger.info(
      `[subspace] Direct listener ready on ${listenHost === "::" ? "[::]" : listenHost}:${boundPort}${DIRECT_WS_PATH}`,
    );
    this.#deps.onEvent?.({ type: "direct-listening", port: boundPort });
    return boundPort;
  }

  async #stopDirectImpl(): Promise<void> {
    const wss = this.#directWss;
    const server = this.#directServer;
    this.#directWss = null;
    this.#directServer = null;
    this.#directPort = null;
    if (wss !== null) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  startRelay(): void {
    if (this.#stopped) return;
    this.#relayWanted = true;
    if (
      this.#relayConnectTask !== null ||
      (this.#relayWs !== null &&
        (this.#relayWs.readyState === WebSocket.OPEN ||
          this.#relayWs.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }
    if (this.#relayTimer !== null) {
      clearTimeout(this.#relayTimer);
      this.#relayTimer = null;
    }
    const task = this.#connectRelayControl().finally(() => {
      if (this.#relayConnectTask === task) this.#relayConnectTask = null;
    });
    this.#relayConnectTask = task;
  }

  clearInvites(mode?: "direct" | "relay"): void {
    this.#shareEpoch += 1;
    this.#deleteInvites(mode);
  }

  #deleteInvites(mode?: "direct" | "relay"): void {
    for (const [key, invite] of this.#invites) {
      if (mode === undefined || invite.mode === mode) {
        this.#invites.delete(key);
        const notify = this.#inviteAckWaiters.get(key);
        this.#inviteAckWaiters.delete(key);
        if (typeof notify === "function") notify();
      }
    }
  }

  clearRelayInvites(): void {
    this.clearInvites("relay");
  }

  stopRelay(): void {
    this.#shareEpoch += 1;
    this.#relayWanted = false;
    this.#cachedRelayJwt = null;
    if (this.#relayTimer !== null) {
      clearTimeout(this.#relayTimer);
      this.#relayTimer = null;
    }
    const ws = this.#relayWs;
    this.#relayWs = null;
    this.#setRelayState(false, null);
    if (ws !== null) safeCloseWs(ws, 1000, "Relay stopped");
  }

  async createPairingOffer(options: {
    readonly mode: "direct" | "relay";
    readonly address?: string;
    readonly port?: number;
    readonly rotate?: boolean;
  }): Promise<SubspacePairingOffer> {
    if (options.address !== undefined && !isValidDirectHost(options.address.trim())) {
      throw Object.assign(new Error("Invalid direct endpoint host"), { code: "bad-request" });
    }
    const offerEpoch = this.#shareEpoch;
    const identity = await this.#ensureIdentity();
    if (!options.rotate) {
      const existing = this.activeOffer(options.mode);
      if (
        existing !== null &&
        existing.hostName === identity.hostName &&
        identity.shareMode === options.mode
      ) {
        if (
          options.mode === "direct" &&
          options.address === undefined &&
          options.port === undefined &&
          (identity.directAddress === null || existing.endpoint?.host === identity.directAddress) &&
          (this.#directPort === null || existing.endpoint?.port === this.#directPort)
        ) {
          return existing;
        }
        if (options.mode === "relay") return existing;
      }
    }

    const ticket = bytesToBase64Url(randomBytes(24));
    const ticketSha256 =
      options.mode === "relay"
        ? await sha256Hex(utf8Encode(await deriveRelayInviteToken(ticket)))
        : await sha256Hex(utf8Encode(ticket));
    const expiresAt = Date.now() + OFFER_TTL_MS;
    const inviteId = newId();

    let offer: SubspacePairingOffer;
    if (options.mode === "direct") {
      const hostAddress = (options.address ?? identity.directAddress ?? "127.0.0.1").trim();
      const port = await this.startDirect(options.port);
      const refreshed = await this.#ensureIdentity();
      offer = {
        v: 1,
        mode: "direct",
        hostName: refreshed.hostName,
        hostPublicKeyB64: refreshed.publicKeyB64,
        ticket,
        expiresAt,
        endpoint: { host: hostAddress, port },
      };
    } else {
      const auth = this.#deps.store.readRelayAuth();
      if (auth === null) {
        throw Object.assign(
          new Error("Sign in to the Subspace Relay before creating a relay pairing link"),
          { code: "relay-auth-required" },
        );
      }
      const relayUrl = this.#deps.relayUrl();
      const relayHostId = await deriveRelayHostId(base64ToBytes(identity.publicKeyB64));
      await this.#ensureRelayConnected();
      offer = {
        v: 1,
        mode: "relay",
        hostName: identity.hostName,
        hostPublicKeyB64: identity.publicKeyB64,
        ticket,
        expiresAt,
        relay: { url: relayUrl, relayHostId },
      };
    }

    this.#assertOfferActive(offerEpoch, options.mode);

    const currentIdentity = await this.#ensureIdentity();
    if (currentIdentity.shareMode !== options.mode) {
      this.#identity = { ...currentIdentity, shareMode: options.mode };
      this.#deps.store.saveIdentity(this.#identity);
    }

    this.#deleteInvites(options.mode);
    this.#invites.set(inviteId, {
      id: inviteId,
      mode: options.mode,
      ticket,
      ticketSha256,
      expiresAt,
      offer,
    });
    if (options.mode === "relay") {
      const ws = this.#relayWs;
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.#inviteAckWaiters.delete(inviteId);
            resolve();
          }, 3_000);
          this.#inviteAckWaiters.set(inviteId, () => {
            clearTimeout(timer);
            resolve();
          });
          void sendWs(
            ws,
            JSON.stringify({
              type: "invite_create",
              inviteId,
              ticketHash: ticketSha256,
              expiresAt,
            }),
          ).catch(() => {
            clearTimeout(timer);
            this.#inviteAckWaiters.delete(inviteId);
            resolve();
          });
        });
      }
    }
    this.#assertOfferActive(offerEpoch, options.mode, inviteId);
    return offer;
  }

  #assertOfferActive(offerEpoch: number, mode: "direct" | "relay", inviteId?: string): void {
    if (
      this.#stopped ||
      offerEpoch !== this.#shareEpoch ||
      (mode === "relay" && !this.#relayWanted)
    ) {
      if (inviteId !== undefined) {
        this.#invites.delete(inviteId);
        this.#inviteAckWaiters.delete(inviteId);
      }
      throw new SubspaceConnectError(
        "pairing-failed",
        "Share settings changed while creating pairing offer",
      );
    }
  }

  revokeGrant(grantId: string): boolean {
    const removed = this.#deps.store.removeGrant(grantId);
    for (const session of [...this.#sessions]) {
      if (session.grantId === grantId) session.close();
    }
    if (
      this.#relayWs !== null &&
      this.#relayWs.readyState === WebSocket.OPEN &&
      this.#relayConnected
    ) {
      void sendWs(this.#relayWs, JSON.stringify({ type: "device_revoke", grantId })).catch(
        () => {},
      );
    }
    if (removed) this.#deps.onEvent?.({ type: "device-revoked", grantId });
    return removed;
  }

  async reloadIdentity(): Promise<void> {
    this.#shareEpoch += 1;
    this.#cachedRelayJwt = null;
    this.#identity = await this.#deps.store.loadOrCreateIdentity();
    this.#privateKey = await importX25519PrivateKey(this.#identity.privateKeyPkcs8B64);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const waiter of [...this.#relayReadyWaiters]) {
      waiter.reject(new Error("Subspace host stopped"));
    }
    this.#relayReadyWaiters.clear();
    for (const resolve of this.#inviteAckWaiters.values()) resolve();
    this.#inviteAckWaiters.clear();
    this.stopRelay();
    for (const session of [...this.#sessions]) session.close();
    this.#sessions.clear();
    await this.stopDirect();
  }

  async #ensureIdentity(): Promise<SubspaceHostIdentity> {
    if (this.#identity !== null && this.#privateKey !== null) return this.#identity;
    const identity = await this.#deps.store.loadOrCreateIdentity();
    this.#privateKey = await importX25519PrivateKey(identity.privateKeyPkcs8B64);
    this.#identity = identity;
    return identity;
  }

  async #ensureRelayConnected(timeoutMs = 10_000): Promise<void> {
    if (this.#relayConnected && this.#relayWs?.readyState === WebSocket.OPEN) return;
    this.startRelay();
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          this.#relayReadyWaiters.delete(waiter);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.#relayReadyWaiters.delete(waiter);
          reject(err);
        },
      };
      const timer = setTimeout(
        () =>
          waiter.reject(new Error(this.#relayError || "Timed out connecting to Subspace Relay")),
        timeoutMs,
      );
      this.#relayReadyWaiters.add(waiter);
    });
  }

  #setRelayState(connected: boolean, error: string | null): void {
    if (connected) {
      for (const waiter of [...this.#relayReadyWaiters]) waiter.resolve();
    } else if (error !== null && !this.#relayTimer) {
      for (const waiter of [...this.#relayReadyWaiters]) waiter.reject(new Error(error));
    }
    if (this.#relayConnected === connected && this.#relayError === error) return;
    this.#relayConnected = connected;
    this.#relayError = error;
    this.#deps.onEvent?.({ type: "relay-state", connected, error });
  }

  #scheduleRelayReconnect(): void {
    if (this.#stopped || !this.#relayWanted) return;
    if (this.#relayTimer !== null) return;
    const delay = this.#relayBackoffMs;
    this.#relayBackoffMs = Math.min(15_000, Math.round(this.#relayBackoffMs * 1.8));
    this.#relayTimer = setTimeout(() => {
      this.#relayTimer = null;
      if (!this.#stopped && this.#relayWanted && this.#relayConnectTask === null) {
        const task = this.#connectRelayControl().finally(() => {
          if (this.#relayConnectTask === task) this.#relayConnectTask = null;
        });
        this.#relayConnectTask = task;
      }
    }, delay);
    this.#relayTimer.unref?.();
  }

  async #resolveRelayJwt(auth: SubspaceRelayAuthRecord): Promise<string> {
    if (
      this.#cachedRelayJwt !== null &&
      this.#cachedRelayJwt.authUrl === auth.authUrl &&
      this.#cachedRelayJwt.sessionToken === auth.token &&
      Date.now() < this.#cachedRelayJwt.expiresAt - 60_000
    ) {
      return this.#cachedRelayJwt.jwt;
    }
    const minted = await mintRelayJwt(auth.authUrl, auth.token);
    this.#cachedRelayJwt = {
      authUrl: auth.authUrl,
      sessionToken: auth.token,
      jwt: minted.token,
      expiresAt: minted.expiresAt,
    };
    return minted.token;
  }

  async #connectRelayControl(): Promise<void> {
    if (this.#stopped || !this.#relayWanted) return;
    const auth = this.#deps.store.readRelayAuth();
    if (auth === null) {
      this.#setRelayState(false, "Sign in required");
      return;
    }
    let jwt: string;
    try {
      jwt = await this.#resolveRelayJwt(auth);
    } catch (error) {
      if (error instanceof RelayAuthExpiredError) {
        this.#cachedRelayJwt = null;
        this.#setRelayState(false, "Relay sign-in expired");
        return;
      }
      logger.warning(`[subspace] Could not mint Relay JWT: ${errorText(error)}`);
      this.#setRelayState(false, "Could not reach Relay auth server");
      this.#scheduleRelayReconnect();
      return;
    }
    if (this.#stopped || !this.#relayWanted) return;
    const identity = await this.#ensureIdentity();
    const privateKey = this.#privateKey!;
    const relayHostId = await deriveRelayHostId(base64ToBytes(identity.publicKeyB64));
    let url: string;
    let ws: WebSocket;
    try {
      url = httpToWsUrl(this.#deps.relayUrl(), RELAY_PATHS.HOST_CONTROL);
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${jwt}` } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Relay URL";
      logger.warning(`[subspace] Relay control URL error: ${message}`);
      this.#setRelayState(false, message);
      this.#scheduleRelayReconnect();
      return;
    }
    guardWsErrors(ws);
    this.#relayWs = ws;

    ws.on("open", () => {
      void sendWs(
        ws,
        JSON.stringify({
          type: "host_hello",
          v: 1,
          relayHostId,
          hostPublicKeyB64: identity.publicKeyB64,
          hostName: identity.hostName,
        }),
      ).catch(() => {});
    });

    ws.on("message", (raw) => {
      void this.#handleRelayControlMessage(ws, raw, relayHostId, privateKey).catch((error) => {
        logger.warning(`[subspace] Relay control handler error: ${errorText(error)}`);
      });
    });

    ws.on("close", (code, reason) => {
      if (this.#relayWs !== ws) return;
      this.#relayWs = null;
      const text = reason.toString("utf8");
      if (code === RELAY_CLOSE_CODE.UNAUTHORIZED) {
        this.#cachedRelayJwt = null;
        this.#setRelayState(false, "Relay sign-in expired");
        return;
      }
      if (code === RELAY_CLOSE_CODE.HOST_OWNED_BY_OTHER) {
        this.#setRelayState(false, text || "Host identity belongs to another Relay account");
        return;
      }
      this.#setRelayState(false, text || (code === 1000 ? null : `Disconnected (${code})`));
      if (this.#relayWanted && !this.#stopped) this.#scheduleRelayReconnect();
    });

    ws.on("error", (err) => {
      if (this.#relayWs !== ws) return;
      logger.warning(`[subspace] Relay control connection error: ${errorText(err)}`);
      this.#setRelayState(false, "Relay connection failed");
    });
  }

  async #handleRelayControlMessage(
    ws: WebSocket,
    raw: WebSocket.RawData,
    relayHostId: string,
    privateKey: CryptoKey,
  ): Promise<void> {
    let parsed: RelayHostControlOutbound;
    try {
      parsed = RelayHostControlOutboundSchema.parse(JSON.parse(rawDataToText(raw)));
    } catch {
      return;
    }
    switch (parsed.type) {
      case "host_challenge": {
        const proofB64 = await computeRelayControlProof(
          privateKey,
          parsed.relayEphPubB64,
          parsed.challengeB64,
          parsed.userId,
        );
        await sendWs(ws, JSON.stringify({ type: "host_challenge_ack", proofB64 })).catch(() => {});
        return;
      }
      case "host_hello_ack": {
        this.#relayBackoffMs = 1_000;
        this.#setRelayState(true, null);
        const now = Date.now();
        await Promise.all([
          ...this.#deps.store
            .readGrants()
            .filter((grant) => grant.mode === "relay")
            .map((grant) =>
              sendWs(
                ws,
                JSON.stringify({
                  type: "device_install",
                  grantId: grant.id,
                  tokenHash: grant.relayTokenSha256 ?? grant.tokenSha256,
                  clientName: grant.clientName,
                }),
              ).catch(() => {}),
            ),
          ...[...this.#invites.values()]
            .filter((invite) => invite.mode === "relay" && invite.expiresAt > now)
            .map(async (invite) => {
              const ticketHash = await sha256Hex(
                utf8Encode(await deriveRelayInviteToken(invite.ticket)),
              );
              await sendWs(
                ws,
                JSON.stringify({
                  type: "invite_create",
                  inviteId: invite.id,
                  ticketHash,
                  expiresAt: invite.expiresAt,
                }),
              ).catch(() => {});
            }),
        ]);
        return;
      }
      case "connection_open": {
        void this.#openRelayDataChannel(relayHostId, parsed.sessionId);
        return;
      }
      case "invite_created": {
        const notify = this.#inviteAckWaiters.get(parsed.inviteId);
        this.#inviteAckWaiters.delete(parsed.inviteId);
        if (typeof notify === "function") notify();
        return;
      }
      case "device_installed":
      case "device_revoked":
        return;
    }
  }

  async #openRelayDataChannel(relayHostId: string, sessionId: string): Promise<void> {
    const auth = this.#deps.store.readRelayAuth();
    if (auth === null || this.#stopped) return;
    const jwt = await this.#resolveRelayJwt(auth).catch(() => null);
    if (jwt === null || this.#stopped) return;
    const url = httpToWsUrl(this.#deps.relayUrl(), RELAY_PATHS.HOST_DATA);
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${jwt}` } });
    ws.once("open", () => {
      void sendWs(ws, JSON.stringify({ type: "host_data_auth", v: 1, relayHostId, sessionId }))
        .then(() => this.#serveTunnelSocket(ws, "relay"))
        .catch(() => ws.terminate());
    });
    ws.on("error", () => {
      ws.terminate();
    });
  }

  #consumeTicket(ticket: string, mode: "direct" | "relay"): ActiveInvite | null {
    const now = Date.now();
    const ticketBytes = utf8Encode(ticket);
    for (const [id, invite] of this.#invites) {
      if (invite.expiresAt <= now) {
        this.#invites.delete(id);
        continue;
      }
      if (invite.mode === mode && constantTimeEqual(utf8Encode(invite.ticket), ticketBytes)) {
        this.#invites.delete(id);
        return invite;
      }
    }
    return null;
  }

  async #serveTunnelSocket(ws: WebSocket, mode: "direct" | "relay"): Promise<void> {
    guardWsErrors(ws);
    let session: E2eeSession;
    let mux: MuxEndpoint | null = null;
    let closed = false;
    const allowedCallPorts = new Map<number, number>();
    const sessionHandle: HostSessionHandle = {
      grantId: null,
      close: () => closeSocket(RELAY_CLOSE_CODE.UNAUTHORIZED, "Device revoked"),
    };

    const closeSocket = (code = 1000, reason = "Closed") => {
      if (closed) return;
      closed = true;
      this.#sessions.delete(sessionHandle);
      allowedCallPorts.clear();
      mux?.close(reason);
      safeCloseWs(ws, code, reason);
    };

    this.#sessions.add(sessionHandle);
    ws.on("close", () => closeSocket(1000, "Peer disconnected"));
    ws.on("error", () => closeSocket(1011, "Socket error"));

    try {
      const identity = await this.#ensureIdentity();
      const privateKey = this.#privateKey!;
      const helloMsg = await nextWsMessage(ws, HANDSHAKE_TIMEOUT_MS);
      const { readyRaw, session: e2ee } = await acceptHostHandshake(
        { publicKeyB64: identity.publicKeyB64, privateKey },
        rawDataToText(helloMsg),
      );
      session = e2ee;
      await sendWs(ws, readyRaw);

      const authFrame = await nextWsMessage(ws, HANDSHAKE_TIMEOUT_MS);
      const auth = await session.openJson<E2eeAuthRequest>(rawDataToUint8Array(authFrame));
      const rejectAuth = async (
        code: Extract<E2eeAuthResponse, { readonly ok: false }>["code"],
        message: string,
        closeReason: string,
      ) => {
        await session.sendJson(
          { type: "e2ee_authenticated", ok: false, code, message } satisfies E2eeAuthResponse,
          (sealed) => sendWs(ws, sealed),
        );
        closeSocket(RELAY_CLOSE_CODE.UNAUTHORIZED, closeReason);
      };

      if (auth.type !== "e2ee_auth" || auth.authBinding !== session.authBinding) {
        await rejectAuth(
          "invalid-binding",
          "Handshake channel binding mismatch",
          "Invalid binding",
        );
        return;
      }

      let grantId: string;
      if (auth.kind === "pair") {
        const currentIdentity = await this.#ensureIdentity();
        const invite =
          currentIdentity.shareMode === mode ? this.#consumeTicket(auth.ticket, mode) : null;
        if (invite === null || currentIdentity.shareMode !== mode || invite.mode !== mode) {
          await rejectAuth(
            "invalid-ticket",
            "Pairing ticket is invalid or expired",
            "Invalid pairing ticket",
          );
          return;
        }
        grantId = newId();
        sessionHandle.grantId = grantId;
        const deviceToken = bytesToBase64Url(randomBytes(32));
        const tokenSha256 = await sha256Hex(utf8Encode(deviceToken));
        const relayTokenSha256 = await sha256Hex(
          utf8Encode(await deriveRelayDeviceToken(deviceToken)),
        );
        const clientName = auth.clientName.trim().slice(0, 120) || "Eidolon Client";
        this.#deps.store.addGrant({
          id: grantId,
          clientName,
          tokenSha256,
          relayTokenSha256,
          mode,
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
        });
        if (
          mode === "relay" &&
          this.#relayWs !== null &&
          this.#relayWs.readyState === WebSocket.OPEN &&
          this.#relayConnected
        ) {
          await sendWs(
            this.#relayWs,
            JSON.stringify({
              type: "device_install",
              grantId,
              tokenHash: relayTokenSha256,
              clientName,
            }),
          ).catch(() => {});
        }
        await session.sendJson(
          {
            type: "e2ee_authenticated",
            ok: true,
            grantId,
            hostName: currentIdentity.hostName,
            serverVersion: this.#deps.serverVersion(),
            deviceToken,
          } satisfies E2eeAuthResponse,
          (sealed) => sendWs(ws, sealed),
        );
        if (
          closed ||
          this.#stopped ||
          !this.#deps.store.readGrants().some((g) => g.id === grantId)
        ) {
          closeSocket(RELAY_CLOSE_CODE.UNAUTHORIZED, "Device revoked");
          return;
        }
        this.#deps.onEvent?.({ type: "device-paired", grantId, clientName, mode });
      } else {
        grantId = auth.grantId;
        sessionHandle.grantId = grantId;
        const grant = await this.#deps.store.verifyGrantToken(auth.grantId, auth.deviceToken);
        if (grant === null || closed || this.#stopped) {
          await rejectAuth("invalid-token", "Device token revoked or invalid", "Revoked");
          return;
        }
        this.#deps.store.touchGrant(grantId);
        await session.sendJson(
          {
            type: "e2ee_authenticated",
            ok: true,
            grantId,
            hostName: identity.hostName,
            serverVersion: this.#deps.serverVersion(),
          } satisfies E2eeAuthResponse,
          (sealed) => sendWs(ws, sealed),
        );
        if (
          closed ||
          this.#stopped ||
          !this.#deps.store.readGrants().some((g) => g.id === grantId)
        ) {
          closeSocket(RELAY_CLOSE_CODE.UNAUTHORIZED, "Device revoked");
          return;
        }
        this.#deps.onEvent?.({ type: "device-connected", grantId, mode });
      }

      mux = new MuxEndpoint({
        sendFrame: (frame) => session.send(frame, (sealed) => sendWs(ws, sealed)),
        host: {
          onHttpRequest: async (head, body, signal) => {
            const response = await this.#deps.dispatch(socketHeadToWebRequest(head, body, signal));
            const headers: [string, string][] = [];
            response.headers.forEach((value, name) => {
              if (!HOST_HOP_BY_HOP.has(name.toLowerCase())) headers.push([name, value]);
            });
            const pathname = URL.parse(
              head.path.startsWith("/") ? head.path : `/${head.path}`,
              "http://subspace.local",
            )?.pathname;
            if (
              head.method.toUpperCase() === "POST" &&
              pathname === "/api/offer" &&
              response.status === 200
            ) {
              const rawBody = new Uint8Array(await response.arrayBuffer());
              try {
                const parsed = JSON.parse(utf8Decode(rawBody)) as { sdp?: unknown } | null;
                if (typeof parsed?.sdp === "string") {
                  const hostPort = extractHostUdpPort(parsed.sdp);
                  if (hostPort !== null) {
                    const now = Date.now();
                    for (const [port, exp] of allowedCallPorts) {
                      if (exp <= now) allowedCallPorts.delete(port);
                    }
                    allowedCallPorts.set(hostPort, now + ALLOWED_CALL_PORT_TTL_MS);
                  }
                }
              } catch {
                // Ignore non-JSON or malformed /api/offer payloads.
              }
              return {
                status: response.status,
                statusText: response.statusText,
                headers,
                body: rawBody.byteLength === 0 ? null : new Response(rawBody).body,
              };
            }
            return {
              status: response.status,
              statusText: response.statusText,
              headers,
              body: response.body,
            };
          },
          onCallOpen: (_channelId, hostPort, bridge) => {
            const now = Date.now();
            for (const [port, exp] of allowedCallPorts) {
              if (exp <= now) allowedCallPorts.delete(port);
            }
            const expiresAt = allowedCallPorts.get(hostPort);
            if (expiresAt === undefined || expiresAt <= now) {
              return null;
            }
            return openHostUdpBridge(hostPort, bridge);
          },
        },
      });
      if (closed || this.#stopped) {
        closeSocket(1001, "Server stopping");
        return;
      }

      ws.on("message", (raw) => {
        void (async () => {
          try {
            const plain = await session.open(rawDataToUint8Array(raw));
            await mux?.handleFrame(plain);
          } catch (error) {
            logger.warning(`[subspace] Host session error for ${grantId}: ${errorText(error)}`);
            closeSocket(RELAY_CLOSE_CODE.UNAUTHORIZED, "Decryption error");
          }
        })();
      });
    } catch {
      closeSocket(1011, "Handshake failed");
    }
  }
}
