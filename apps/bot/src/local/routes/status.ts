// GET /api/local/status, which the home page polls, and POST /api/local/restart.
import { localError, localJson } from "../responses.ts";
import { restartTracker } from "../restart.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";
import { buildStatus, defaultStatusDeps, type StatusDeps, trackSessionErrors } from "../status.ts";

export function statusRoutes(
  app: LocalApp,
  deps: StatusDeps = defaultStatusDeps,
): LocalRouteSpec[] {
  // Built at boot, so this is what the server read then.
  restartTracker(app);
  trackSessionErrors(app);
  return [
    {
      route: "GET /api/local/status",
      handler: () => localJson(200, buildStatus(app, deps)),
    },
    {
      route: "POST /api/local/restart",
      handler() {
        if (app.activeCalls() > 0) {
          return localError(409, "call-active", "A restart would end the call; hang up first");
        }
        app.restart();
        return localJson(200, { ok: true });
      },
    },
  ];
}
