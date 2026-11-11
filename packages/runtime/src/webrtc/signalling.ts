import type { AllowedOffer } from "@eidolon/access";
import { logger } from "@eidolon/config";
import type { IceService } from "@eidolon/turn";
import { createTask, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { getOpusCodec, type OpusCodec } from "@pipedog/transport-smallwebrtc/opus";
import {
  HTTPException,
  SmallWebRTCPatchRequest,
  SmallWebRTCRequest,
} from "@pipedog/transport-smallwebrtc/request_handler";
import type { AnyCallBinding } from "../native/binding.ts";
import { type CandidateRules, connectionPlan, EidolonRequestHandler } from "./handler.ts";

/** An HTTP answer for apps/bot to serialize as JSON (it adds CORS). */
export interface SignallingResult {
  readonly status: number;
  readonly body: unknown;
}

export interface SignallingServer {
  /**
   * POST /api/offer after the guard admitted it. New connections start a session in the background,
   * bound to `binding` when there is one.
   */
  offer(admission: AllowedOffer, binding?: AnyCallBinding): Promise<SignallingResult>;
  /**
   * PATCH /api/offer: trickled ICE candidates, the only way the browser's candidates arrive (the
   * client offers before gathering). `bodyText` is `await request.text()`; runtime parses it and
   * answers as pipedog's PATCH branch: invalid JSON or a non-object → 400
   * `{detail: "Invalid WebRTC request: …"}`, a non-string pc_id → 400, an unknown pc_id → 404
   * `{detail: "Peer connection not found"}`, else 200 `{status: "success"}`. On a relay-only
   * connection, candidates a relay can't reach are dropped first (end-of-candidates kept).
   */
  patch(bodyText: string): Promise<SignallingResult>;
  readonly activeSessions: number;
  /** Disconnects every peer; apps/bot calls it at shutdown. */
  close(): Promise<void>;
}

export interface SignallingDeps {
  /** Runs one session to its end. Must never reject. */
  startSession(
    connection: SmallWebRTCConnection,
    admission: AllowedOffer,
    binding?: AnyCallBinding,
  ): Promise<void>;
  /** The codec every connection's encoders wrap; pipedog's process default otherwise. */
  opusCodec?: OpusCodec;
  candidates?: CandidateRules;
}

function invalidRequest(reason: string): SignallingResult {
  return { status: 400, body: { detail: `Invalid WebRTC request: ${reason}` } };
}

/** pipedog http.js's mapping: an HTTPException keeps its status, anything else is a 500. */
function failure(e: unknown): SignallingResult {
  rethrowIfCancelled(e);
  if (e instanceof HTTPException) return { status: e.statusCode, body: { detail: e.detail } };
  logger.error(`SmallWebRTC signalling error: ${e}`);
  return { status: 500, body: { detail: "Internal Server Error" } };
}

export function createSignallingServerWith(
  options: { ice: Pick<IceService, "serverPlan"> },
  deps: SignallingDeps,
): SignallingServer {
  const handler = new EidolonRequestHandler(deps.candidates);
  const sessions = new Set<Task<unknown>>();

  const startSession = (
    connection: SmallWebRTCConnection,
    admission: AllowedOffer,
    binding: AnyCallBinding | undefined,
  ): void => {
    // The answer goes out only after this returns, so the session runs on its own.
    const task = createTask(
      () => deps.startSession(connection, admission, binding),
      "eidolon-session",
    );
    sessions.add(task);
    task.addDoneCallback(() => sessions.delete(task));
  };

  return {
    async offer(admission, binding) {
      const body = admission.body;
      if (body === null) return invalidRequest(`${new Error("expected a JSON object")}`);
      if (typeof body.sdp !== "string" || typeof body.type !== "string") {
        return invalidRequest("sdp and type are required");
      }
      try {
        const request = SmallWebRTCRequest.fromDict(body);
        const answer = await handler.handleOffer(
          request,
          async () =>
            connectionPlan(
              await options.ice.serverPlan(),
              admission.opusBitrateBps,
              deps.opusCodec ?? getOpusCodec(),
            ),
          (connection) => startSession(connection, admission, binding),
        );
        return { status: 200, body: answer };
      } catch (e) {
        return failure(e);
      }
    },

    async patch(bodyText) {
      let body: Record<string, unknown>;
      try {
        // Request.json()'s parser, so a 400's detail reads as pipedog's handler would word it.
        const parsed: unknown = await new Response(bodyText).json();
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("expected a JSON object");
        }
        body = parsed as Record<string, unknown>;
      } catch (e) {
        return invalidRequest(`${e}`);
      }
      try {
        if (typeof body.pc_id !== "string") return invalidRequest("pc_id is required");
        await handler.handlePatchRequest(SmallWebRTCPatchRequest.fromDict(body));
        return { status: 200, body: { status: "success" } };
      } catch (e) {
        return failure(e);
      }
    },

    get activeSessions() {
      return sessions.size;
    },

    close() {
      return handler.close();
    },
  };
}
