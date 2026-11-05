// GET /api/local/status, which the home page polls, and POST /api/local/restart.
import { type LocalApp, type LocalRouteSpec, notImplemented } from "../router.ts";

export function statusRoutes(_app: LocalApp): LocalRouteSpec[] {
  return [
    { route: "GET /api/local/status", handler: notImplemented },
    { route: "POST /api/local/restart", handler: notImplemented },
  ];
}
