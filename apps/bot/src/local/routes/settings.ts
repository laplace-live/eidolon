// GET and PUT /api/local/settings: every SETTINGS row, layer by layer.
import { type LocalApp, type LocalRouteSpec, notImplemented } from "../router.ts";

export function settingsRoutes(_app: LocalApp): LocalRouteSpec[] {
  return [
    { route: "GET /api/local/settings", handler: notImplemented },
    { route: "PUT /api/local/settings", handler: notImplemented },
  ];
}
