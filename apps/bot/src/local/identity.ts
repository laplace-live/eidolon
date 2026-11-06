// The local app's one viewer: whoever sits at this computer, signed in by the session cookie or the
// Bearer secret and never by anything a request body says. Their calls skip the anonymous quota
// that guards the public bot from strangers, and their memories are kept per persona.
import {
  type AllowedOffer,
  audioQualityFrom,
  audioQualitySettings,
  offerRequestData,
  parseOfferBody,
  sessionBitrateFor,
  UNKNOWN_CLIENT_IP,
  type UserContext,
} from "@eidolon/access";
import {
  activePersona,
  envOptional,
  errorText,
  logger,
  pyRepr,
  pyStrip,
  setSettingDefaults,
} from "@eidolon/config";
import { LOCAL_VIEWER_MID } from "@eidolon/context";
import type { AdminOutcome, MemoryAdmin } from "@eidolon/memory";
import type { SignallingServer } from "@eidolon/runtime";
import { jsonResponse } from "../responses.ts";
import { personaSetting } from "./personas.ts";
import { localError } from "./responses.ts";
import type { LocalHandler } from "./router.ts";

/** The Mem0 user of the local viewer's memories: a session keys Mem0 on `String(mid)`. */
export const LOCAL_MEMORY_USER = String(LOCAL_VIEWER_MID);

/** The local viewer, named by local.viewerName as it reads now; nameless omits the viewer line. */
export function localViewer(): UserContext {
  const name = pyStrip(envOptional("EIDOLON_LOCAL_VIEWER_NAME") ?? "");
  return Object.freeze({
    mid: LOCAL_VIEWER_MID,
    uname: name || null,
    face: null,
    isLoggedIn: true,
  });
}

export interface MemoryScope {
  readonly userId: string;
  readonly agentId: string | null;
}

/**
 * Keeps each persona's memories apart: while memory.agentId is unset, the Mem0 agent id is the
 * active persona's id. It lies beneath the settings files, not in one: production's milky-green
 * memories carry no agent id, and a deployed persona.yaml must not start filtering them away.
 */
export function usePersonaMemoryScope(): void {
  setSettingDefaults((persona) => ({ MEM0_AGENT_ID: persona.id }));
}

/** The scope a call to the active persona stores and recalls under, read the way Mem0 reads it. */
export function activeMemoryScope(): MemoryScope {
  return { userId: LOCAL_MEMORY_USER, agentId: envOptional("MEM0_AGENT_ID") ?? null };
}

/** The scope of persona `id`'s memories, whether or not it is active. The caller validates `id`. */
export function memoryScopeOf(id: string): MemoryScope {
  if (id === activePersona().id) return activeMemoryScope();
  return { userId: LOCAL_MEMORY_USER, agentId: personaSetting(id, "MEM0_AGENT_ID") ?? id };
}

export interface IdentityParts {
  readonly signalling: Pick<SignallingServer, "offer">;
  /** Built per request, so saving the Qdrant settings needs no restart; null while memory is off. */
  readonly memoryAdmin: () => MemoryAdmin | null;
}

/** The local handlers for POST /api/offer, POST /api/offer/preflight and /api/memories*. */
export interface IdentityHandlers {
  readonly offer: LocalHandler;
  readonly preflight: LocalHandler;
  readonly listMemories: LocalHandler;
  readonly forgetMemories: LocalHandler;
}

/** The 503 or 502 for a Mem0 admin call that failed, logged. */
export function memoryFailure(
  outcome: Extract<AdminOutcome<unknown>, { ok: false }>,
  what: string,
): Response {
  if (outcome.reason === "unavailable") {
    logger.error(
      `[memory-admin] Could not reach the Mem0 vector store: ${errorText(outcome.error)}`,
    );
    return localError(503, "unavailable", "Memory is unavailable: Qdrant did not answer");
  }
  logger.error(`[memory-admin] ${what} failed: ${errorText(outcome.error)}`);
  return localError(502, "upstream-failed", `Mem0 failed to ${what}`);
}

export const MEMORY_OFF = "Memory is off: set a Qdrant host to turn it on";

export function identityHandlers(parts: IdentityParts): IdentityHandlers {
  return {
    async offer(request, { server }) {
      const body = parseOfferBody(await request.text());
      const requestData = offerRequestData(body);
      const admission: AllowedOffer = {
        allowed: true,
        user: localViewer(),
        token: null,
        body,
        requestData,
        opusBitrateBps: sessionBitrateFor(audioQualityFrom(requestData), audioQualitySettings()),
        clientIp: server.requestIP(request)?.address ?? UNKNOWN_CLIENT_IP,
        quota: null,
      };
      logger.info(`[local] Offer from the local viewer to ${pyRepr(activePersona().id)}`);
      const result = await parts.signalling.offer(admission);
      return jsonResponse(result.status, result.body);
    },

    preflight: () => jsonResponse(200, { ok: true, anonymous: false }),

    async listMemories() {
      const admin = parts.memoryAdmin();
      if (admin === null) return localError(503, "unavailable", MEMORY_OFF);
      const scope = activeMemoryScope();
      const outcome = await admin.list(scope.userId, scope.agentId ?? undefined);
      if (!outcome.ok) return memoryFailure(outcome, "list memories");
      const memories = outcome.value;
      logger.info(
        `[memory-admin] Listed ${memories.length} memories for the local viewer ` +
          `(agent ${pyRepr(scope.agentId)})`,
      );
      return jsonResponse(200, {
        user_id: scope.userId,
        uname: localViewer().uname,
        count: memories.length,
        memories,
      });
    },

    async forgetMemories() {
      const admin = parts.memoryAdmin();
      if (admin === null) return localError(503, "unavailable", MEMORY_OFF);
      const scope = activeMemoryScope();
      const outcome = await admin.forget(scope.userId, scope.agentId ?? undefined);
      if (!outcome.ok) return memoryFailure(outcome, "delete memories");
      logger.info(
        `[memory-admin] Wiped the local viewer's memories (agent ${pyRepr(scope.agentId)})`,
      );
      return jsonResponse(200, { ok: true, user_id: scope.userId });
    },
  };
}
