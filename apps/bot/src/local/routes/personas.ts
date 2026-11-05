// /api/local/personas: listing, creating and switching personas, and each one's files.
import { type LocalApp, type LocalRouteSpec, notImplemented } from "../router.ts";

export function personasRoutes(_app: LocalApp): LocalRouteSpec[] {
  return [
    { route: "GET /api/local/personas", handler: notImplemented },
    { route: "POST /api/local/personas", handler: notImplemented },
    { route: "PUT /api/local/personas/active", handler: notImplemented },
    { route: "GET /api/local/personas/:id/prompt", handler: notImplemented },
    { route: "PUT /api/local/personas/:id/prompt", handler: notImplemented },
    { route: "GET /api/local/personas/:id/glossary", handler: notImplemented },
    { route: "PUT /api/local/personas/:id/glossary", handler: notImplemented },
    { route: "GET /api/local/personas/:id/identity", handler: notImplemented },
    { route: "PUT /api/local/personas/:id/identity", handler: notImplemented },
    { route: "GET /api/local/personas/:id/references", handler: notImplemented },
    { route: "GET /api/local/personas/:id/references/:kind/:name", handler: notImplemented },
    { route: "POST /api/local/personas/:id/references/:kind/:name", handler: notImplemented },
    { route: "DELETE /api/local/personas/:id/references/:kind/:name", handler: notImplemented },
    { route: "GET /api/local/personas/:id/avatar", handler: notImplemented },
    { route: "PUT /api/local/personas/:id/avatar", handler: notImplemented },
    { route: "DELETE /api/local/personas/:id/avatar", handler: notImplemented },
    { route: "GET /api/local/personas/:id/facts", handler: notImplemented },
    { route: "GET /api/local/personas/:id/facts/:file", handler: notImplemented },
    { route: "PUT /api/local/personas/:id/facts/:file", handler: notImplemented },
    { route: "DELETE /api/local/personas/:id/facts/:file", handler: notImplemented },
    { route: "GET /api/local/personas/:id/index", handler: notImplemented },
  ];
}
