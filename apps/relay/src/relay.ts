import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { errorText, logger, newId } from "@eidolon/config";
import {
  base64ToBytes,
  bytesToBase64,
  computeRelayControlProof,
  constantTimeEqual,
  deriveRelayHostId,
  generateEphemeralX25519,
  randomBytes,
  sha256Hex,
  utf8Encode,
} from "@eidolon/subspace";
import {
  ClientAuthSchema,
  HostChallengeAckSchema,
  HostDataAuthSchema,
  HostHelloSchema,
  RELAY_CLOSE_CODE,
  RELAY_PATHS,
  RelayHostControlInboundSchema,
} from "@eidolon/subspace/relay-contract";
import WebSocket, { WebSocketServer } from "ws";
import {
  RelayJwksUnavailableError,
  type RelayTokenVerifier,
  type VerifiedRelayCaller,
} from "./jwks-verifier.ts";
import type { RelayStore } from "./relay-db.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_PENDING_SESSIONS_PER_HOST = 32;
const MAX_PREAUTH_QUEUE_BYTES = 64 * 1024;
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;

export interface RelayHubOptions {
  readonly heartbeatMs?: number;
}

interface OnlineHost {
  readonly relayHostId: string;
  readonly userId: string;
  readonly ws: WebSocket;
  alive: boolean;
}

interface BufferedFrame {
  readonly data: WebSocket.RawData;
  readonly isBinary: boolean;
}

interface AttachedMessageQueue {
  nextText(timeoutMs: number): Promise<string>;
  drainRaw(): BufferedFrame[];
}

interface PendingSession {
  readonly sessionId: string;
  readonly relayHostId: string;
  readonly expectedUserId: string;
  readonly clientWs: WebSocket;
  readonly clientQueue: AttachedMessageQueue;
  readonly timer: ReturnType<typeof setTimeout>;
}

function rawDataToText(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

function rawDataByteLength(data: WebSocket.RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return data.byteLength;
}

/**
 * Attaches message/close/error listeners synchronously on upgrade so pipelined frames sent while
 * async JWT/JWKS verification runs are queued rather than dropped.
 */
function attachMessageQueue(ws: WebSocket): AttachedMessageQueue {
  const buffer: BufferedFrame[] = [];
  let queuedBytes = 0;
  let closed: Error | null = null;
  let waiter: {
    readonly resolve: (frame: BufferedFrame) => void;
    readonly reject: (err: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const failWaiter = (err: Error) => {
    if (waiter === null) return;
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    current.reject(err);
  };

  const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    if (closed !== null) return;
    const frameBytes = rawDataByteLength(data);
    if (queuedBytes + frameBytes > MAX_PREAUTH_QUEUE_BYTES) {
      const err = new Error("Handshake frame limit exceeded");
      closed = err;
      buffer.length = 0;
      failWaiter(err);
      ws.off("message", onMessage);
      safeClose(ws, RELAY_CLOSE_CODE.UNAUTHORIZED, "Handshake frame limit exceeded");
      ws.terminate();
      return;
    }
    queuedBytes += frameBytes;
    if (waiter !== null) {
      const current = waiter;
      waiter = null;
      clearTimeout(current.timer);
      current.resolve({ data, isBinary });
      return;
    }
    buffer.push({ data, isBinary });
  };

  const onClose = () => {
    closed = new Error("Socket closed");
    failWaiter(closed);
  };

  const onError = (err: Error) => {
    closed = err;
    failWaiter(err);
  };

  ws.on("message", onMessage);
  ws.on("close", onClose);
  ws.on("error", onError);

  return {
    async nextText(timeoutMs) {
      if (buffer.length > 0) {
        return rawDataToText(buffer.shift()!.data);
      }
      if (closed !== null) throw closed;
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error("Timed out waiting for message"));
        }, timeoutMs);
        waiter = {
          resolve: (frame) => resolve(rawDataToText(frame.data)),
          reject,
          timer,
        };
      });
    },
    drainRaw() {
      failWaiter(new Error("Queue detached"));
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      return buffer.splice(0);
    },
  };
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }
}

function spliceSockets(
  clientWs: WebSocket,
  hostWs: WebSocket,
  earlyClientFrames: readonly BufferedFrame[] = [],
  earlyHostFrames: readonly BufferedFrame[] = [],
): void {
  let closed = false;
  const timers = new Set<ReturnType<typeof setInterval>>();
  const finish = (fromCode: number, reason: string) => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    safeClose(clientWs, fromCode >= 1000 && fromCode < 5000 ? fromCode : 1000, reason);
    safeClose(hostWs, fromCode >= 1000 && fromCode < 5000 ? fromCode : 1000, reason);
  };

  const pipeOne = (src: WebSocket, dst: WebSocket, earlyFrames: readonly BufferedFrame[]) => {
    let backpressureTimer: ReturnType<typeof setInterval> | null = null;
    const forward = (data: WebSocket.RawData, isBinary: boolean) => {
      if (closed || dst.readyState !== WebSocket.OPEN) return;
      dst.send(data, { binary: isBinary }, (err) => {
        if (err) finish(1011, "Relay send error");
      });
      if (backpressureTimer === null && dst.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
        src.pause();
        const timer = setInterval(() => {
          if (closed || dst.readyState !== WebSocket.OPEN) {
            clearInterval(timer);
            timers.delete(timer);
            if (backpressureTimer === timer) backpressureTimer = null;
            return;
          }
          if (dst.bufferedAmount <= BACKPRESSURE_HIGH_WATER / 2) {
            clearInterval(timer);
            timers.delete(timer);
            backpressureTimer = null;
            src.resume();
          }
        }, 25);
        timer.unref?.();
        timers.add(timer);
        backpressureTimer = timer;
      }
    };

    for (const frame of earlyFrames) forward(frame.data, frame.isBinary);
    src.on("message", forward);
    src.on("close", (code, reason) => finish(code, reason.toString("utf8")));
    src.on("error", () => finish(1011, "Relay socket error"));
  };

  pipeOne(clientWs, hostWs, earlyClientFrames);
  pipeOne(hostWs, clientWs, earlyHostFrames);
}

/**
 * Coordinates Subspace Relay WebSocket upgrades (`/v1/host/control`, `/v1/host/data`,
 * `/v1/client/connect`), verifying bearer JWTs against JWKS and splicing paired E2EE tunnels.
 */
export class RelayHub {
  readonly #verifyToken: RelayTokenVerifier;
  readonly #store: RelayStore;
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  readonly #hosts = new Map<string, OnlineHost>();
  readonly #pending = new Map<string, PendingSession>();
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;

  constructor(verifyToken: RelayTokenVerifier, store: RelayStore, options: RelayHubOptions = {}) {
    this.#verifyToken = verifyToken;
    this.#store = store;
    this.#heartbeatTimer = setInterval(() => {
      for (const [relayHostId, host] of this.#hosts) {
        if (!host.alive) {
          this.#hosts.delete(relayHostId);
          host.ws.terminate();
          continue;
        }
        host.alive = false;
        if (host.ws.readyState === WebSocket.OPEN) host.ws.ping();
      }
    }, options.heartbeatMs ?? HEARTBEAT_MS);
    this.#heartbeatTimer.unref?.();
  }

  get onlineHostCount(): number {
    return this.#hosts.size;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = URL.parse(req.url ?? "/", "http://relay.local")?.pathname;
    if (
      pathname !== RELAY_PATHS.HOST_CONTROL &&
      pathname !== RELAY_PATHS.HOST_DATA &&
      pathname !== RELAY_PATHS.CLIENT_CONNECT
    ) {
      return false;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", (err) => {
        logger.warning(`[relay] WebSocket error (${pathname}): ${errorText(err)}`);
        ws.terminate();
      });
      const queue = attachMessageQueue(ws);
      if (pathname === RELAY_PATHS.HOST_CONTROL) {
        void this.#onHostControl(ws, req, queue);
      } else if (pathname === RELAY_PATHS.HOST_DATA) {
        void this.#onHostData(ws, req, queue);
      } else {
        void this.#onClientConnect(ws, queue);
      }
    });
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeatTimer);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.clientQueue.drainRaw();
      pending.clientWs.terminate();
    }
    this.#pending.clear();
    for (const client of this.#wss.clients) client.terminate();
    this.#hosts.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  async #authenticateHostSocket(
    ws: WebSocket,
    req: IncomingMessage,
    queue: AttachedMessageQueue,
  ): Promise<VerifiedRelayCaller | null> {
    let caller: VerifiedRelayCaller | null;
    try {
      caller = await this.#verifyToken(req.headers.authorization);
    } catch (error) {
      queue.drainRaw();
      if (error instanceof RelayJwksUnavailableError) {
        safeClose(
          ws,
          RELAY_CLOSE_CODE.AUTH_UNAVAILABLE,
          "Authentication service temporarily unavailable",
        );
      } else {
        safeClose(ws, RELAY_CLOSE_CODE.UNAUTHORIZED, "Unauthorized");
      }
      return null;
    }
    if (caller === null) {
      queue.drainRaw();
      safeClose(ws, RELAY_CLOSE_CODE.UNAUTHORIZED, "Unauthorized");
      return null;
    }
    return caller;
  }

  async #onHostControl(
    ws: WebSocket,
    req: IncomingMessage,
    queue: AttachedMessageQueue,
  ): Promise<void> {
    const caller = await this.#authenticateHostSocket(ws, req, queue);
    if (caller === null) return;
    const { userId } = caller;
    let relayHostId = "";

    try {
      const helloRaw = await queue.nextText(HANDSHAKE_TIMEOUT_MS);
      const hello = HostHelloSchema.parse(JSON.parse(helloRaw));
      const pubBytes = base64ToBytes(hello.hostPublicKeyB64);
      const derivedId = await deriveRelayHostId(pubBytes);
      if (derivedId !== hello.relayHostId) {
        queue.drainRaw();
        safeClose(ws, RELAY_CLOSE_CODE.UNAUTHORIZED, "Host ID does not match public key");
        return;
      }

      const relayKp = await generateEphemeralX25519();
      const challengeB64 = bytesToBase64(randomBytes(32));

      ws.send(
        JSON.stringify({
          type: "host_challenge",
          challengeB64,
          relayEphPubB64: relayKp.publicKeyB64,
          userId,
        }),
      );

      const ackRaw = await queue.nextText(HANDSHAKE_TIMEOUT_MS);
      const ack = HostChallengeAckSchema.parse(JSON.parse(ackRaw));
      const expectedProof = await computeRelayControlProof(
        relayKp.privateKey,
        hello.hostPublicKeyB64,
        challengeB64,
        userId,
      );
      if (!constantTimeEqual(base64ToBytes(ack.proofB64), base64ToBytes(expectedProof))) {
        queue.drainRaw();
        safeClose(ws, RELAY_CLOSE_CODE.UNAUTHORIZED, "Invalid host proof");
        return;
      }

      const claimed = this.#store.claimOrVerifyHost({
        relayHostId: hello.relayHostId,
        userId,
        publicKeyB64: hello.hostPublicKeyB64,
        hostName: hello.hostName,
      });
      if (claimed !== "ok") {
        queue.drainRaw();
        safeClose(ws, RELAY_CLOSE_CODE.HOST_OWNED_BY_OTHER, "Host ID belongs to another account");
        return;
      }

      if (ws.readyState !== WebSocket.OPEN) {
        queue.drainRaw();
        return;
      }

      relayHostId = hello.relayHostId;
      for (const grantId of hello.revokedGrantIds ?? []) {
        this.#store.revokeDevice(relayHostId, grantId);
      }
      for (const device of hello.devices ?? []) {
        this.#store.installDevice({
          relayHostId,
          grantId: device.grantId,
          tokenSha256: device.tokenHash,
          clientName: device.clientName,
        });
      }
      const previous = this.#hosts.get(relayHostId);
      if (previous !== undefined && previous.ws !== ws) {
        safeClose(previous.ws, 1000, "Replaced by newer host connection");
      }
      const entry: OnlineHost = { relayHostId, userId, ws, alive: true };
      this.#hosts.set(relayHostId, entry);
      const dropHost = () => {
        if (this.#hosts.get(relayHostId) === entry) {
          this.#hosts.delete(relayHostId);
        }
      };

      const handleControl = (raw: WebSocket.RawData) => {
        try {
          const msg = RelayHostControlInboundSchema.parse(JSON.parse(rawDataToText(raw)));
          switch (msg.type) {
            case "invite_create":
              this.#store.putInvite({
                inviteId: msg.inviteId,
                relayHostId,
                ticketSha256: msg.ticketHash,
                expiresAt: msg.expiresAt,
              });
              ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
              return;
            case "invite_revoke":
              this.#store.revokeInvite(relayHostId, msg.inviteId);
              ws.send(JSON.stringify({ type: "invite_revoked", inviteId: msg.inviteId }));
              return;
            case "device_install":
              this.#store.installDevice({
                relayHostId,
                grantId: msg.grantId,
                tokenSha256: msg.tokenHash,
                clientName: msg.clientName,
              });
              ws.send(JSON.stringify({ type: "device_installed", grantId: msg.grantId }));
              return;
            case "device_revoke":
              this.#store.revokeDevice(relayHostId, msg.grantId);
              ws.send(JSON.stringify({ type: "device_revoked", grantId: msg.grantId }));
              return;
            default:
              return;
          }
        } catch (error) {
          logger.warning(`[relay] Ignoring invalid host control frame: ${errorText(error)}`);
        }
      };

      const buffered = queue.drainRaw();
      ws.on("message", handleControl);
      ws.on("pong", () => {
        entry.alive = true;
      });
      ws.on("close", dropHost);
      ws.on("error", () => {
        dropHost();
        safeClose(ws, 1011, "Host control socket error");
        ws.terminate();
      });

      ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId }));
      for (const frame of buffered) handleControl(frame.data);
    } catch {
      queue.drainRaw();
      safeClose(ws, RELAY_CLOSE_CODE.UNAUTHORIZED, "Host handshake failed");
    }
  }

  async #onClientConnect(clientWs: WebSocket, queue: AttachedMessageQueue): Promise<void> {
    try {
      const raw = await queue.nextText(HANDSHAKE_TIMEOUT_MS);
      const authMsg = ClientAuthSchema.parse(JSON.parse(raw));
      const host = this.#hosts.get(authMsg.relayHostId);
      if (host === undefined || host.ws.readyState !== WebSocket.OPEN) {
        queue.drainRaw();
        safeClose(clientWs, RELAY_CLOSE_CODE.HOST_NOT_FOUND, "Remote Eidolon server is offline");
        return;
      }

      const pendingForHost = [...this.#pending.values()].filter(
        (p) => p.relayHostId === authMsg.relayHostId,
      ).length;
      if (pendingForHost >= MAX_PENDING_SESSIONS_PER_HOST) {
        queue.drainRaw();
        safeClose(clientWs, RELAY_CLOSE_CODE.RATE_LIMITED, "Too many pending sessions");
        return;
      }

      let grantId: string | null = null;
      if (authMsg.credential.kind === "invite") {
        const ticketHash = await sha256Hex(utf8Encode(authMsg.credential.relayTicket));
        if (host.ws.readyState !== WebSocket.OPEN) {
          queue.drainRaw();
          safeClose(clientWs, RELAY_CLOSE_CODE.HOST_NOT_FOUND, "Remote Eidolon server is offline");
          return;
        }
        if (!this.#store.consumeInvite(authMsg.relayHostId, ticketHash)) {
          queue.drainRaw();
          safeClose(clientWs, RELAY_CLOSE_CODE.UNAUTHORIZED, "Invalid or expired pairing ticket");
          return;
        }
      } else {
        const tokenHash = await sha256Hex(utf8Encode(authMsg.credential.relayToken));
        if (host.ws.readyState !== WebSocket.OPEN) {
          queue.drainRaw();
          safeClose(clientWs, RELAY_CLOSE_CODE.HOST_NOT_FOUND, "Remote Eidolon server is offline");
          return;
        }
        if (!this.#store.verifyDevice(authMsg.relayHostId, authMsg.credential.grantId, tokenHash)) {
          queue.drainRaw();
          safeClose(clientWs, RELAY_CLOSE_CODE.UNAUTHORIZED, "Revoked or invalid device token");
          return;
        }
        grantId = authMsg.credential.grantId;
      }

      const sessionId = newId();
      const dropPending = () => {
        const entry = this.#pending.get(sessionId);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        entry.clientQueue.drainRaw();
        this.#pending.delete(sessionId);
      };
      const timer = setTimeout(() => {
        const dropped = this.#pending.get(sessionId);
        if (dropped !== undefined) {
          dropPending();
          safeClose(dropped.clientWs, RELAY_CLOSE_CODE.TIMEOUT, "Host did not open data channel");
        }
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();

      const pending: PendingSession = {
        sessionId,
        relayHostId: authMsg.relayHostId,
        expectedUserId: host.userId,
        clientWs,
        clientQueue: queue,
        timer,
      };
      this.#pending.set(sessionId, pending);

      clientWs.once("close", dropPending);

      host.ws.send(JSON.stringify({ type: "connection_open", sessionId, grantId }), (err) => {
        if (!err) return;
        dropPending();
        safeClose(clientWs, RELAY_CLOSE_CODE.HOST_NOT_FOUND, "Remote Eidolon server is offline");
      });
    } catch {
      queue.drainRaw();
      safeClose(clientWs, RELAY_CLOSE_CODE.UNAUTHORIZED, "Client auth failed");
    }
  }

  async #onHostData(
    hostWs: WebSocket,
    req: IncomingMessage,
    hostQueue: AttachedMessageQueue,
  ): Promise<void> {
    const caller = await this.#authenticateHostSocket(hostWs, req, hostQueue);
    if (caller === null) return;
    try {
      const raw = await hostQueue.nextText(HANDSHAKE_TIMEOUT_MS);
      const dataAuth = HostDataAuthSchema.parse(JSON.parse(raw));
      const pending = this.#pending.get(dataAuth.sessionId);
      if (
        pending === undefined ||
        pending.relayHostId !== dataAuth.relayHostId ||
        pending.expectedUserId !== caller.userId
      ) {
        hostQueue.drainRaw();
        safeClose(hostWs, RELAY_CLOSE_CODE.TIMEOUT, "Unknown or mismatched session");
        return;
      }
      this.#pending.delete(dataAuth.sessionId);
      clearTimeout(pending.timer);
      const earlyClientFrames = pending.clientQueue.drainRaw();
      const earlyHostFrames = hostQueue.drainRaw();
      if (pending.clientWs.readyState !== WebSocket.OPEN) {
        safeClose(hostWs, RELAY_CLOSE_CODE.TIMEOUT, "Client disconnected");
        return;
      }
      pending.clientWs.send(JSON.stringify({ type: "relay_ready", sessionId: pending.sessionId }));
      spliceSockets(pending.clientWs, hostWs, earlyClientFrames, earlyHostFrames);
    } catch {
      hostQueue.drainRaw();
      safeClose(hostWs, RELAY_CLOSE_CODE.UNAUTHORIZED, "Host data auth failed");
    }
  }
}
