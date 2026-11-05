// GET /api/local/voices/search: Fish Audio's public voice library, searched without the key.
import { type LocalApp, type LocalRouteSpec, notImplemented } from "../router.ts";

export function voicesRoutes(_app: LocalApp): LocalRouteSpec[] {
  return [{ route: "GET /api/local/voices/search", handler: notImplemented }];
}
