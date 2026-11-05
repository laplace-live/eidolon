// GET and DELETE /api/local/memories: one persona's memories of the local viewer, in the scope her
// calls store them under (identity.ts), so forgetting with one persona leaves the others'.
import { activePersona, errorText, logger, pyRepr } from "@eidolon/config";
import type { AdminOutcome } from "@eidolon/memory";
import type { MemoriesResponse } from "../api.ts";
import { memoryScopeOf } from "../identity.ts";
import { personaRefusal } from "../personas.ts";
import { localError, localJson } from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";

function failure(outcome: Extract<AdminOutcome<unknown>, { ok: false }>, what: string): Response {
  if (outcome.reason === "unavailable") {
    logger.error(
      `[memory-admin] Could not reach the Mem0 vector store: ${errorText(outcome.error)}`,
    );
    return localError(503, "unavailable", "Memory is unavailable: Qdrant did not answer");
  }
  logger.error(`[memory-admin] ${what} failed: ${errorText(outcome.error)}`);
  return localError(502, "upstream-failed", `Mem0 failed to ${what}`);
}

const MEMORY_OFF = "Memory is off: set a Qdrant host to turn it on";

export function memoriesRoutes(app: LocalApp): LocalRouteSpec[] {
  /** The persona a request names, or the active one; a Response when it names none. */
  const personaOf = (url: URL): string | Response => {
    const id = url.searchParams.get("persona") ?? activePersona().id;
    return personaRefusal(id) ?? id;
  };
  return [
    {
      route: "GET /api/local/memories",
      async handler(_request, { url }) {
        const persona = personaOf(url);
        if (persona instanceof Response) return persona;
        const admin = app.memoryAdmin();
        if (admin === null) return localError(503, "unavailable", MEMORY_OFF);
        const scope = memoryScopeOf(persona);
        const outcome = await admin.list(scope.userId, scope.agentId ?? undefined);
        if (!outcome.ok) return failure(outcome, "list memories");
        const body: MemoriesResponse = {
          persona,
          count: outcome.value.length,
          memories: outcome.value,
        };
        return localJson(200, body);
      },
    },
    {
      route: "DELETE /api/local/memories",
      async handler(_request, { url }) {
        const persona = personaOf(url);
        if (persona instanceof Response) return persona;
        const admin = app.memoryAdmin();
        if (admin === null) return localError(503, "unavailable", MEMORY_OFF);
        const scope = memoryScopeOf(persona);
        const outcome = await admin.forget(scope.userId, scope.agentId ?? undefined);
        if (!outcome.ok) return failure(outcome, "delete memories");
        logger.info(
          `[memory-admin] Wiped the local viewer's memories of ${pyRepr(persona)} ` +
            `(agent ${pyRepr(scope.agentId)})`,
        );
        return localJson(200, { ok: true });
      },
    },
  ];
}
