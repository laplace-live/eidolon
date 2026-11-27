import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { errorText, logger, newId, withoutTrailingSlashes } from "@eidolon/config";
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
  isAllowedRelayUrl,
  isValidDirectHost,
  MuxEndpoint,
  type RelayEndpoint,
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
import { httpToWsUrl, resolveEffectiveRelayUrl } from "./settings.ts";
import type {
  SubspaceGrantRecord,
  SubspaceHostIdentity,
  SubspaceRelayAuthRecord,
  SubspaceShareMode,
  SubspaceStore,
} from "./store.ts";
import { extractHostUdpCandidates, openHostUdpBridge } from "./webrtc-bridge.ts";
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

type RelayHostErrorCode =
  | "bad-request"
  | "relay-auth-required"
  | "relay-auth-expired"
  | "relay-auth-rejected"
  | "pairing-failed"
  | "upstream-failed"
  | "relay-unreachable"
  | "subspace-unreachable";

function relayHostError(code: RelayHostErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function grantSupportsRelay(
  grant: Pick<SubspaceGrantRecord, "mode" | "relayTokenSha256">,
): boolean {
  return grant.mode === "relay" || grant.relayTokenSha256 !== undefined;
}

export function hostTransportNeeds(
  shareMode: SubspaceShareMode,
  grants: readonly Pick<SubspaceGrantRecord, "mode" | "relayTokenSha256">[],
): { readonly needsDirect: boolean; readonly needsRelay: boolean } {
  const hasDirectOrDualGrant = grants.some(
    (g) => g.mode === "direct" || g.relayTokenSha256 !== undefined,
  );
  return {
    needsDirect: shareMode === "direct" || (shareMode !== "relay" && hasDirectOrDualGrant),
    needsRelay: shareMode !== "off" || grants.some(grantSupportsRelay),
  };
}

export function readRelayAuthSafe(store: SubspaceStore): {
  readonly auth: SubspaceRelayAuthRecord | null;
  readonly error: string | null;
} {
  try {
    return { auth: store.readRelayAuth(), error: null };
  } catch (error) {
    return {
      auth: null,
      error:
        error instanceof Error ? error.message : "Corrupted Subspace Relay credentials on disk",
    };
  }
}

interface ActiveInvite {
  readonly id: string;
  readonly allowDirect: boolean;
  readonly allowRelay: boolean;
  readonly ticket: string;
  readonly relayTicketSha256: string;
  readonly expiresAt: number;
  readonly offer: SubspacePairingOffer;
}

interface HostSessionHandle {
  grantId: string | null;
  close(code?: number, reason?: string): void;
}

export interface SubspaceHostDeps {
  readonly store: SubspaceStore;
  readonly serverVersion: () => string;
  readonly dispatch: (request: Request) => Promise<Response>;
  readonly relayUrl?: () => string;
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

function parseTunnelRequestUrl(rawPath: string): URL | null {
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (path.startsWith("//") || path.includes("\\")) return null;
  const url = URL.parse(path, "http://subspace.local");
  if (url === null || url.origin !== "http://subspace.local") return null;
  return url;
}

function socketHeadToWebRequest(
  head: {
    readonly method: string;
    readonly path: string;
    readonly headers: readonly [string, string][];
  },
  url: URL,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Request {
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
  #relayControlUrl: string | null = null;
  #relayControlToken: string | null = null;
  #relayControlAuthUrl: string | null = null;
  #relayAttemptId = 0;
  #relayConnected = false;
  #relayError: string | null = null;
  #relayErrorCode: RelayHostErrorCode | null = null;
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

  get activeRelayUrl(): string | null {
    return this.#relayControlUrl;
  }

  activeOffer(mode?: "direct" | "relay"): SubspacePairingOffer | null {
    const now = Date.now();
    for (const [key, invite] of this.#invites) {
      if (invite.expiresAt <= now) this.#invites.delete(key);
    }
    const candidates = [...this.#invites.values()].filter((inv) =>
      mode === undefined ? true : mode === "direct" ? inv.allowDirect : inv.allowRelay,
    );
    return candidates.at(-1)?.offer ?? null;
  }

  async ensureStartedFromDisk(): Promise<void> {
    if (this.#stopped) return;
    const identity = await this.#ensureIdentity();
    const { needsDirect, needsRelay } = hostTransportNeeds(
      identity.shareMode,
      this.#deps.store.readGrants(),
    );
    if (needsDirect && !this.listening) {
      await this.startDirect(identity.directPort);
    }
    if (needsRelay && this.#readRelayAuthSafe().auth !== null) {
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
    const { auth, error: authErr } = this.#readRelayAuthSafe();
    const desiredUrl = authErr === null ? this.#tryResolveRelayUrl(auth) : null;
    const hasActive =
      this.#relayConnectTask !== null ||
      (this.#relayWs !== null &&
        (this.#relayWs.readyState === WebSocket.OPEN ||
          this.#relayWs.readyState === WebSocket.CONNECTING));
    if (hasActive) {
      const sameTarget =
        authErr === null &&
        auth !== null &&
        desiredUrl !== null &&
        this.#relayControlUrl === desiredUrl &&
        this.#relayControlToken === auth.token &&
        this.#relayControlAuthUrl === auth.authUrl;
      if (sameTarget) return;
      this.#relayAttemptId += 1;
      this.clearRelayInvites();
      this.#cachedRelayJwt = null;
      this.#relayBackoffMs = 1_000;
      this.#relayConnectTask = null;
      const ws = this.#relayWs;
      this.#relayWs = null;
      this.#relayControlUrl = null;
      this.#relayControlToken = null;
      this.#relayControlAuthUrl = null;
      this.#setRelayState(false, null);
      if (ws !== null) safeCloseWs(ws, 1000, "Relay changed");
    }
    if (this.#relayTimer !== null) {
      clearTimeout(this.#relayTimer);
      this.#relayTimer = null;
    }
    const attemptId = ++this.#relayAttemptId;
    const task = this.#connectRelayControl(attemptId).finally(() => {
      if (this.#relayConnectTask === task) this.#relayConnectTask = null;
    });
    this.#relayConnectTask = task;
  }

  clearInvites(mode?: "direct" | "relay"): void {
    this.#shareEpoch += 1;
    this.#deleteInvites(mode);
  }

  #revokeRelayInvites(inviteIds: readonly string[]): void {
    if (inviteIds.length === 0) return;
    const ws = this.#relayWs;
    if (ws === null || ws.readyState !== WebSocket.OPEN || !this.#relayConnected) return;
    for (const inviteId of inviteIds) {
      void sendWs(ws, JSON.stringify({ type: "invite_revoke", inviteId })).catch(() => {});
    }
  }

  #resolveInviteAck(inviteId: string): void {
    const notify = this.#inviteAckWaiters.get(inviteId);
    if (notify === undefined) return;
    this.#inviteAckWaiters.delete(inviteId);
    notify();
  }

  #deleteInvites(mode?: "direct" | "relay"): void {
    const revokedRelayIds: string[] = [];
    for (const [key, invite] of this.#invites) {
      const matches =
        mode === undefined ? true : mode === "direct" ? invite.allowDirect : invite.allowRelay;
      if (matches) {
        if (invite.allowRelay) revokedRelayIds.push(key);
        this.#invites.delete(key);
        this.#resolveInviteAck(key);
      }
    }
    this.#revokeRelayInvites(revokedRelayIds);
  }

  clearRelayInvites(): void {
    this.#shareEpoch += 1;
    const revokedRelayIds: string[] = [];
    for (const [key, invite] of this.#invites) {
      if (!invite.allowRelay) continue;
      revokedRelayIds.push(key);
      if (!invite.allowDirect) {
        this.#invites.delete(key);
        this.#resolveInviteAck(key);
      } else {
        const { relay: _relay, ...offerWithoutRelay } = invite.offer;
        this.#invites.set(key, {
          ...invite,
          allowRelay: false,
          offer: { ...offerWithoutRelay, mode: "direct" },
        });
      }
    }
    this.#revokeRelayInvites(revokedRelayIds);
  }

  stopRelay(): void {
    this.#shareEpoch += 1;
    this.#relayAttemptId += 1;
    this.#relayWanted = false;
    this.#relayConnectTask = null;
    this.#relayControlUrl = null;
    this.#relayControlToken = null;
    this.#relayControlAuthUrl = null;
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

  #hasRejectedRelayAuth(): boolean {
    return (
      this.#relayErrorCode === "relay-auth-expired" ||
      this.#relayErrorCode === "relay-auth-rejected" ||
      this.#relayErrorCode === "bad-request"
    );
  }

  #tryResolveRelayUrl(auth?: SubspaceRelayAuthRecord | null): string | null {
    try {
      return withoutTrailingSlashes(this.#resolveRelayUrl(auth));
    } catch {
      return null;
    }
  }

  #requireRelayAuth(): SubspaceRelayAuthRecord {
    const auth = this.#readRelayAuthOrBadRequest();
    if (auth === null) {
      throw relayHostError(
        "relay-auth-required",
        "Sign in to the Subspace Relay before creating a relay pairing link",
      );
    }
    return auth;
  }

  async #currentRelayEndpoint(publicKeyB64: string): Promise<RelayEndpoint | undefined> {
    const { auth, error } = this.#readRelayAuthSafe();
    if (error !== null || auth === null) return undefined;
    const relayUrl = this.#tryResolveRelayUrl(auth);
    if (relayUrl === null || !isAllowedRelayUrl(relayUrl)) return undefined;
    const relayHostId = await deriveRelayHostId(base64ToBytes(publicKeyB64));
    return { url: relayUrl, relayHostId };
  }

  async #activeRelayEndpoint(publicKeyB64: string): Promise<RelayEndpoint | undefined> {
    if (this.#hasRejectedRelayAuth()) return undefined;
    const endpoint = await this.#currentRelayEndpoint(publicKeyB64);
    return endpoint !== undefined && !this.#hasRejectedRelayAuth() ? endpoint : undefined;
  }

  async createPairingOffer(
    options: {
      readonly mode?: "auto" | "direct" | "relay";
      readonly address?: string;
      readonly port?: number;
      readonly rotate?: boolean;
    } = {},
  ): Promise<SubspacePairingOffer> {
    const requestedMode = options.mode ?? "auto";
    if (options.address !== undefined && !isValidDirectHost(options.address.trim())) {
      throw relayHostError("bad-request", "Invalid direct endpoint host");
    }
    let hasRelayAuth = false;
    if (requestedMode === "relay") {
      this.#requireRelayAuth();
      hasRelayAuth = true;
      // Reconnect before capturing offerEpoch so switching relays doesn't self-cancel the new offer.
      this.startRelay();
    } else if (requestedMode === "auto") {
      const { auth, error } = this.#readRelayAuthSafe();
      if (error !== null) {
        this.#setRelayState(false, error, "bad-request");
      } else if (auth !== null) {
        hasRelayAuth = true;
        this.startRelay();
      }
    }
    const offerEpoch = this.#shareEpoch;
    const identity = await this.#ensureIdentity();
    if (!options.rotate) {
      const lookupMode = requestedMode === "relay" ? "relay" : "direct";
      const existing = this.activeOffer(lookupMode);
      const expectedShareMode = requestedMode === "relay" ? "relay" : "direct";
      if (
        existing !== null &&
        existing.hostName === identity.hostName &&
        identity.shareMode === expectedShareMode
      ) {
        if (
          requestedMode !== "relay" &&
          options.address === undefined &&
          options.port === undefined &&
          (identity.directAddress === null || existing.endpoint?.host === identity.directAddress) &&
          (this.#directPort === null || existing.endpoint?.port === this.#directPort)
        ) {
          const expectedRelay =
            requestedMode === "auto" && hasRelayAuth
              ? await this.#activeRelayEndpoint(identity.publicKeyB64)
              : undefined;
          if (
            expectedRelay === undefined
              ? existing.relay === undefined
              : existing.relay?.url === expectedRelay.url &&
                existing.relay?.relayHostId === expectedRelay.relayHostId
          ) {
            return existing;
          }
        }
        if (requestedMode === "relay") {
          const { auth: existingAuth, error: existingErr } = this.#readRelayAuthSafe();
          const currentRelayUrl =
            existingErr === null && existingAuth !== null
              ? this.#tryResolveRelayUrl(existingAuth)
              : null;
          if (
            currentRelayUrl !== null &&
            existing.relay?.url === currentRelayUrl &&
            this.#relayControlUrl === currentRelayUrl &&
            this.#relayConnected &&
            this.#relayWs?.readyState === WebSocket.OPEN
          ) {
            return existing;
          }
        }
      }
    }

    const ticket = bytesToBase64Url(randomBytes(24));
    const relayTicketSha256 = await sha256Hex(utf8Encode(await deriveRelayInviteToken(ticket)));
    const expiresAt = Date.now() + OFFER_TTL_MS;
    const inviteId = newId();

    let offer: SubspacePairingOffer;
    if (requestedMode === "direct" || requestedMode === "auto") {
      const hostAddress = (options.address ?? identity.directAddress ?? "127.0.0.1").trim();
      const port = await this.startDirect(options.port);
      const refreshed = await this.#ensureIdentity();
      let attachedRelay: RelayEndpoint | undefined;
      if (requestedMode === "auto" && hasRelayAuth) {
        const candidateRelay = await this.#currentRelayEndpoint(refreshed.publicKeyB64);
        if (candidateRelay !== undefined) {
          if (!this.#relayConnected && !this.#hasRejectedRelayAuth()) {
            await this.#ensureRelayConnected(2_500).catch(() => {});
          }
          if (!this.#hasRejectedRelayAuth()) {
            attachedRelay = candidateRelay;
          }
        }
      }
      offer = {
        v: 1,
        mode: "direct",
        hostName: refreshed.hostName,
        hostPublicKeyB64: refreshed.publicKeyB64,
        ticket,
        expiresAt,
        endpoint: { host: hostAddress, port },
        ...(attachedRelay !== undefined ? { relay: attachedRelay } : {}),
      };
    } else {
      const relayHostId = await deriveRelayHostId(base64ToBytes(identity.publicKeyB64));
      await this.#ensureRelayConnected();
      const currentAuth = this.#requireRelayAuth();
      const relayUrl =
        this.#relayControlUrl ?? withoutTrailingSlashes(this.#resolveRelayUrl(currentAuth));
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

    const targetShareMode = requestedMode === "relay" ? "relay" : "direct";
    this.#assertOfferActive(offerEpoch, targetShareMode);

    const currentIdentity = await this.#ensureIdentity();
    if (currentIdentity.shareMode !== targetShareMode) {
      this.#identity = { ...currentIdentity, shareMode: targetShareMode };
      this.#deps.store.saveIdentity(this.#identity);
    }

    const allowDirect = requestedMode !== "relay";
    const allowRelay = requestedMode === "relay" || offer.relay !== undefined;
    this.#deleteInvites();
    this.#invites.set(inviteId, {
      id: inviteId,
      allowDirect,
      allowRelay,
      ticket,
      relayTicketSha256,
      expiresAt,
      offer,
    });
    if (allowRelay) {
      const ws = this.#relayWs;
      if (ws !== null && ws.readyState === WebSocket.OPEN && this.#relayConnected) {
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
              ticketHash: relayTicketSha256,
              expiresAt,
            }),
          ).catch(() => {
            this.#resolveInviteAck(inviteId);
          });
        });
      }
    }
    this.#assertOfferActive(offerEpoch, targetShareMode, inviteId);
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
      if (session.grantId === grantId) {
        session.close(RELAY_CLOSE_CODE.UNAUTHORIZED, "Device revoked");
      }
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
      waiter.reject(relayHostError("subspace-unreachable", "Subspace host stopped"));
    }
    this.#relayReadyWaiters.clear();
    for (const resolve of this.#inviteAckWaiters.values()) resolve();
    this.#inviteAckWaiters.clear();
    this.stopRelay();
    for (const session of [...this.#sessions]) session.close(1000, "Host stopped");
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
    this.startRelay();
    if (this.#relayConnected && this.#relayWs?.readyState === WebSocket.OPEN) return;
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
          waiter.reject(
            relayHostError(
              this.#relayErrorCode ?? "relay-unreachable",
              this.#relayError || "Timed out connecting to Subspace Relay",
            ),
          ),
        timeoutMs,
      );
      this.#relayReadyWaiters.add(waiter);
    });
  }

  #setRelayState(
    connected: boolean,
    error: string | null,
    errorCode: RelayHostErrorCode | null = null,
  ): void {
    const nextCode = connected || error === null ? null : (errorCode ?? "relay-unreachable");
    if (connected) {
      for (const waiter of [...this.#relayReadyWaiters]) waiter.resolve();
    } else if (error !== null && !this.#relayTimer) {
      for (const waiter of [...this.#relayReadyWaiters]) {
        waiter.reject(relayHostError(nextCode!, error));
      }
    }
    if (
      this.#relayConnected === connected &&
      this.#relayError === error &&
      this.#relayErrorCode === nextCode
    ) {
      return;
    }
    this.#relayConnected = connected;
    this.#relayError = error;
    this.#relayErrorCode = nextCode;
    this.#deps.onEvent?.({ type: "relay-state", connected, error });
  }

  #scheduleRelayReconnect(delayMs?: number): void {
    if (this.#stopped || !this.#relayWanted) return;
    if (this.#relayTimer !== null) return;
    const delay = delayMs ?? this.#relayBackoffMs;
    if (delayMs === undefined) {
      this.#relayBackoffMs = Math.min(15_000, Math.round(this.#relayBackoffMs * 1.8));
    }
    this.#relayTimer = setTimeout(() => {
      this.#relayTimer = null;
      if (!this.#stopped && this.#relayWanted && this.#relayConnectTask === null) {
        const attemptId = ++this.#relayAttemptId;
        const task = this.#connectRelayControl(attemptId).finally(() => {
          if (this.#relayConnectTask === task) this.#relayConnectTask = null;
        });
        this.#relayConnectTask = task;
      }
    }, delay);
    this.#relayTimer.unref?.();
  }

  async #resolveRelayJwt(
    auth: SubspaceRelayAuthRecord,
  ): Promise<{ readonly jwt: string; readonly fromCache: boolean }> {
    if (
      this.#cachedRelayJwt !== null &&
      this.#cachedRelayJwt.authUrl === auth.authUrl &&
      this.#cachedRelayJwt.sessionToken === auth.token &&
      Date.now() < this.#cachedRelayJwt.expiresAt - 60_000
    ) {
      return { jwt: this.#cachedRelayJwt.jwt, fromCache: true };
    }
    const minted = await mintRelayJwt(auth.authUrl, auth.token);
    this.#cachedRelayJwt = {
      authUrl: auth.authUrl,
      sessionToken: auth.token,
      jwt: minted.token,
      expiresAt: minted.expiresAt,
    };
    return { jwt: minted.token, fromCache: false };
  }

  #readRelayAuthSafe(): {
    readonly auth: SubspaceRelayAuthRecord | null;
    readonly error: string | null;
  } {
    return readRelayAuthSafe(this.#deps.store);
  }

  #readRelayAuthOrBadRequest(): SubspaceRelayAuthRecord | null {
    const { auth, error } = this.#readRelayAuthSafe();
    if (error !== null) throw relayHostError("bad-request", error);
    return auth;
  }

  #resolveRelayUrl(auth?: SubspaceRelayAuthRecord | null): string {
    if (this.#deps.relayUrl !== undefined) return this.#deps.relayUrl();
    return resolveEffectiveRelayUrl(
      auth !== undefined ? auth?.relayUrl : () => this.#deps.store.readSavedRelayUrl(),
    );
  }

  async #connectRelayControl(attemptId: number): Promise<void> {
    if (this.#stopped || !this.#relayWanted || attemptId !== this.#relayAttemptId) return;
    const { auth, error: authErr } = this.#readRelayAuthSafe();
    if (authErr !== null) {
      this.#setRelayState(false, authErr, "bad-request");
      return;
    }
    if (auth === null) {
      this.#setRelayState(false, "Sign in required", "relay-auth-required");
      return;
    }
    let relayUrl: string;
    try {
      relayUrl = withoutTrailingSlashes(this.#resolveRelayUrl(auth));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Relay URL";
      logger.warning(`[subspace] Relay control URL error: ${message}`);
      this.#setRelayState(false, message, "bad-request");
      return;
    }
    this.#relayControlUrl = relayUrl;
    this.#relayControlToken = auth.token;
    this.#relayControlAuthUrl = auth.authUrl;

    let jwt: string;
    let usedCachedJwt: boolean;
    try {
      ({ jwt, fromCache: usedCachedJwt } = await this.#resolveRelayJwt(auth));
    } catch (error) {
      if (attemptId !== this.#relayAttemptId) return;
      if (error instanceof RelayAuthExpiredError) {
        this.#cachedRelayJwt = null;
        this.#setRelayState(
          false,
          "Relay sign-in expired — sign out and sign in again",
          "relay-auth-expired",
        );
        return;
      }
      logger.warning(`[subspace] Could not mint Relay JWT: ${errorText(error)}`);
      this.#scheduleRelayReconnect();
      this.#setRelayState(
        false,
        `Could not reach Relay auth server (${auth.authUrl})`,
        "upstream-failed",
      );
      return;
    }
    if (this.#stopped || !this.#relayWanted || attemptId !== this.#relayAttemptId) return;
    const identity = await this.#ensureIdentity();
    if (this.#stopped || !this.#relayWanted || attemptId !== this.#relayAttemptId) return;
    const privateKey = this.#privateKey!;
    const relayHostId = await deriveRelayHostId(base64ToBytes(identity.publicKeyB64));
    if (this.#stopped || !this.#relayWanted || attemptId !== this.#relayAttemptId) return;
    let url: string;
    let ws: WebSocket;
    try {
      url = httpToWsUrl(relayUrl, RELAY_PATHS.HOST_CONTROL);
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${jwt}` } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Relay URL";
      logger.warning(`[subspace] Relay control URL error: ${message}`);
      this.#setRelayState(false, message, "bad-request");
      return;
    }
    guardWsErrors(ws);
    this.#relayWs = ws;
    const controlBinding = { ws, relayUrl, auth } as const;
    let wsFailed = false;

    ws.on("open", () => {
      if (this.#relayWs !== ws || attemptId !== this.#relayAttemptId) return;
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
      if (this.#relayWs !== ws || attemptId !== this.#relayAttemptId) return;
      void this.#handleRelayControlMessage(ws, raw, relayHostId, privateKey, controlBinding).catch(
        (error) => {
          logger.warning(`[subspace] Relay control handler error: ${errorText(error)}`);
        },
      );
    });

    ws.on("close", (code, reason) => {
      if (this.#relayWs !== ws) return;
      this.#relayWs = null;
      this.#relayControlUrl = null;
      this.#relayControlToken = null;
      this.#relayControlAuthUrl = null;
      const text = reason.toString("utf8");
      if (code === RELAY_CLOSE_CODE.UNAUTHORIZED) {
        this.#cachedRelayJwt = null;
        if (usedCachedJwt && this.#relayWanted && !this.#stopped) {
          this.#scheduleRelayReconnect(0);
          this.#setRelayState(false, null);
          return;
        }
        logger.warning(
          `[subspace] Relay rejected freshly minted JWT (${relayUrl}): ${text || "4401"}`,
        );
        const detail = text ? `: ${text}` : "";
        this.#setRelayState(
          false,
          `Relay rejected authentication (${relayUrl})${detail}`,
          "relay-auth-rejected",
        );
        return;
      }
      if (code === RELAY_CLOSE_CODE.HOST_OWNED_BY_OTHER) {
        this.#setRelayState(
          false,
          text || "Host identity belongs to another Relay account",
          "pairing-failed",
        );
        return;
      }
      if (this.#relayWanted && !this.#stopped) this.#scheduleRelayReconnect();
      const closeError =
        text ||
        (wsFailed ? this.#relayError : null) ||
        (code === 1000 ? null : `Disconnected (${code})`);
      this.#setRelayState(false, closeError, closeError === null ? null : "relay-unreachable");
    });

    ws.on("error", (err) => {
      if (this.#relayWs !== ws) return;
      wsFailed = true;
      logger.warning(`[subspace] Relay control connection error: ${errorText(err)}`);
      this.#setRelayState(false, `Relay connection failed (${relayUrl})`, "relay-unreachable");
    });
  }

  async #handleRelayControlMessage(
    ws: WebSocket,
    raw: WebSocket.RawData,
    relayHostId: string,
    privateKey: CryptoKey,
    binding: {
      readonly ws: WebSocket;
      readonly relayUrl: string;
      readonly auth: SubspaceRelayAuthRecord;
    },
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
        const installedGrantIds = new Set<string>();
        let restoredInvites = false;
        while (
          this.#relayWs === ws &&
          ws.readyState === WebSocket.OPEN &&
          !this.#stopped &&
          this.#relayWanted
        ) {
          const pendingGrants = this.#deps.store
            .readGrants()
            .filter((grant) => grantSupportsRelay(grant) && !installedGrantIds.has(grant.id));
          const now = Date.now();
          const pendingInvites = restoredInvites
            ? []
            : [...this.#invites.values()].filter(
                (invite) => invite.allowRelay && invite.expiresAt > now,
              );
          restoredInvites = true;
          if (pendingGrants.length === 0 && pendingInvites.length === 0) break;
          await Promise.all([
            ...pendingGrants.map((grant) => {
              installedGrantIds.add(grant.id);
              return sendWs(
                ws,
                JSON.stringify({
                  type: "device_install",
                  grantId: grant.id,
                  tokenHash: grant.relayTokenSha256 ?? grant.tokenSha256,
                  clientName: grant.clientName,
                }),
              ).catch(() => {});
            }),
            ...pendingInvites.map(async (invite) => {
              if (!this.#invites.has(invite.id) || this.#relayWs !== ws) return;
              await sendWs(
                ws,
                JSON.stringify({
                  type: "invite_create",
                  inviteId: invite.id,
                  ticketHash: invite.relayTicketSha256,
                  expiresAt: invite.expiresAt,
                }),
              ).catch(() => {});
            }),
          ]);
        }
        if (
          this.#relayWs !== ws ||
          ws.readyState !== WebSocket.OPEN ||
          this.#stopped ||
          !this.#relayWanted
        ) {
          return;
        }
        this.#relayBackoffMs = 1_000;
        this.#setRelayState(true, null);
        return;
      }
      case "connection_open": {
        void this.#openRelayDataChannel(relayHostId, parsed.sessionId, binding);
        return;
      }
      case "invite_created": {
        this.#resolveInviteAck(parsed.inviteId);
        return;
      }
      case "invite_revoked":
      case "device_installed":
      case "device_revoked":
        return;
    }
  }

  async #openRelayDataChannel(
    relayHostId: string,
    sessionId: string,
    binding: {
      readonly ws: WebSocket;
      readonly relayUrl: string;
      readonly auth: SubspaceRelayAuthRecord;
    },
  ): Promise<void> {
    if (this.#stopped || this.#relayWs !== binding.ws) return;
    const resolved = await this.#resolveRelayJwt(binding.auth).catch(() => null);
    if (resolved === null || this.#stopped || this.#relayWs !== binding.ws) return;
    let ws: WebSocket;
    try {
      const url = httpToWsUrl(binding.relayUrl, RELAY_PATHS.HOST_DATA);
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${resolved.jwt}` } });
    } catch {
      return;
    }
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
      const allowed = mode === "direct" ? invite.allowDirect : invite.allowRelay;
      if (allowed && constantTimeEqual(utf8Encode(invite.ticket), ticketBytes)) {
        this.#invites.delete(id);
        if (mode === "direct" && invite.allowRelay) {
          this.#revokeRelayInvites([id]);
        }
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
    const allowedCallTargets: {
      readonly address: string;
      readonly port: number;
      readonly expiresAt: number;
    }[] = [];
    const pruneCallTargets = (now: number) => {
      for (let i = allowedCallTargets.length - 1; i >= 0; i -= 1) {
        if (allowedCallTargets[i]!.expiresAt <= now) allowedCallTargets.splice(i, 1);
      }
    };
    const sessionHandle: HostSessionHandle = {
      grantId: null,
      close: (code = 1000, reason = "Closed") => closeSocket(code, reason),
    };

    const closeSocket = (code = 1000, reason = "Closed") => {
      if (closed) return;
      closed = true;
      this.#sessions.delete(sessionHandle);
      allowedCallTargets.length = 0;
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
      const relayInfo = await this.#activeRelayEndpoint(identity.publicKeyB64);
      if (auth.kind === "pair") {
        const currentIdentity = await this.#ensureIdentity();
        const modeAllowed =
          mode === "direct"
            ? currentIdentity.shareMode === "direct"
            : currentIdentity.shareMode !== "off";
        const invite = modeAllowed ? this.#consumeTicket(auth.ticket, mode) : null;
        if (invite === null) {
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
            ...(relayInfo !== undefined ? { relay: relayInfo } : {}),
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
            ...(relayInfo !== undefined ? { relay: relayInfo } : {}),
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
            const url = parseTunnelRequestUrl(head.path);
            if (url === null) {
              if (body !== null && !body.locked) void body.cancel().catch(() => {});
              return {
                status: 400,
                statusText: "Bad Request",
                headers: [["content-type", "application/json"]],
                body: new Response(
                  JSON.stringify({
                    error: { code: "bad-request", message: "Invalid request path" },
                  }),
                ).body,
              };
            }
            const response = await this.#deps.dispatch(
              socketHeadToWebRequest(head, url, body, signal),
            );
            const headers: [string, string][] = [];
            response.headers.forEach((value, name) => {
              if (!HOST_HOP_BY_HOP.has(name.toLowerCase())) headers.push([name, value]);
            });
            const { pathname } = url;
            if (
              head.method.toUpperCase() === "POST" &&
              pathname === "/api/offer" &&
              response.status === 200
            ) {
              const rawBody = new Uint8Array(await response.arrayBuffer());
              try {
                const parsed = JSON.parse(utf8Decode(rawBody)) as { sdp?: unknown } | null;
                if (typeof parsed?.sdp === "string") {
                  const candidates = extractHostUdpCandidates(parsed.sdp);
                  if (candidates.length > 0) {
                    const now = Date.now();
                    pruneCallTargets(now);
                    for (const candidate of candidates) {
                      const entry = {
                        address: candidate.address,
                        port: candidate.port,
                        expiresAt: now + ALLOWED_CALL_PORT_TTL_MS,
                      };
                      const idx = allowedCallTargets.findIndex(
                        (t) => t.address === candidate.address && t.port === candidate.port,
                      );
                      if (idx >= 0) allowedCallTargets[idx] = entry;
                      else allowedCallTargets.push(entry);
                    }
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
          onCallOpen: (_channelId, hostPort, bridge, hostAddress) => {
            const now = Date.now();
            pruneCallTargets(now);
            const wantedAddress = hostAddress?.trim().replace(/^\[|\]$/g, "");
            const target = allowedCallTargets.find((entry) => {
              if (entry.port !== hostPort) return false;
              if (wantedAddress === undefined) return true;
              return entry.address.toLowerCase() === wantedAddress.toLowerCase();
            });
            if (target === undefined) {
              return null;
            }
            return openHostUdpBridge(target.port, bridge, target.address);
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
