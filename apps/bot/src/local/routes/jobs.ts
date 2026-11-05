// /api/local/jobs: the offline chain's commands as child processes, and the URL batches they read.
import { type LocalApp, type LocalRouteSpec, notImplemented } from "../router.ts";

export function jobsRoutes(_app: LocalApp): LocalRouteSpec[] {
  return [
    { route: "POST /api/local/jobs", handler: notImplemented },
    { route: "GET /api/local/jobs", handler: notImplemented },
    { route: "GET /api/local/jobs/:id", handler: notImplemented },
    { route: "GET /api/local/jobs/:id/events", handler: notImplemented },
    { route: "GET /api/local/jobs/:id/log", handler: notImplemented },
    { route: "DELETE /api/local/jobs/:id", handler: notImplemented },
    { route: "POST /api/local/jobs/:id/resume", handler: notImplemented },
    { route: "POST /api/local/personas/:id/batches", handler: notImplemented },
  ];
}
