// GET and DELETE /api/local/memories: one persona's memories of the local viewer.
import { type LocalApp, type LocalRouteSpec, notImplemented } from "../router.ts";

export function memoriesRoutes(_app: LocalApp): LocalRouteSpec[] {
  return [
    { route: "GET /api/local/memories", handler: notImplemented },
    { route: "DELETE /api/local/memories", handler: notImplemented },
  ];
}
