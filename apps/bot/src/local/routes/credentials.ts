// /api/local/credentials: which keys are set (never their values), saving them, and checking one
// against its provider.
import { type LocalApp, type LocalRouteSpec, notImplemented } from "../router.ts";

export function credentialsRoutes(_app: LocalApp): LocalRouteSpec[] {
  return [
    { route: "GET /api/local/credentials", handler: notImplemented },
    { route: "PUT /api/local/credentials", handler: notImplemented },
    { route: "POST /api/local/credentials/check", handler: notImplemented },
  ];
}
