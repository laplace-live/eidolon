// GET and DELETE /api/local/memories: one persona's memories of the local viewer, in the scope her
// calls store them under (identity.ts), so forgetting with one persona leaves the others'.
import { logger, pyRepr } from "@eidolon/config";
import type { MemoriesResponse } from "../api.ts";
import { MEMORY_OFF, memoryFailure, memoryScopeOf } from "../identity.ts";
import { queryPersona } from "../personas.ts";
import { localError, localJson } from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";

export function memoriesRoutes(app: LocalApp): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/memories",
      async handler(_request, { url }) {
        const persona = queryPersona(url);
        if (persona instanceof Response) return persona;
        const admin = app.memoryAdmin();
        if (admin === null) return localError(503, "unavailable", MEMORY_OFF);
        const scope = memoryScopeOf(persona);
        const outcome = await admin.list(scope.userId, scope.agentId ?? undefined);
        if (!outcome.ok) return memoryFailure(outcome, "list memories");
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
        const persona = queryPersona(url);
        if (persona instanceof Response) return persona;
        const admin = app.memoryAdmin();
        if (admin === null) return localError(503, "unavailable", MEMORY_OFF);
        const scope = memoryScopeOf(persona);
        const outcome = await admin.forget(scope.userId, scope.agentId ?? undefined);
        if (!outcome.ok) return memoryFailure(outcome, "delete memories");
        logger.info(
          `[memory-admin] Wiped the local viewer's memories of ${pyRepr(persona)} ` +
            `(agent ${pyRepr(scope.agentId)})`,
        );
        return localJson(200, { ok: true });
      },
    },
  ];
}
