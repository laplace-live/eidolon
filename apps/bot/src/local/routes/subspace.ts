// Subspace remote pairing, host sharing, and Relay account routes under /api/local/subspace.
import { isValidDirectHost, type SubspaceManager } from "@eidolon/subspace";
import { z } from "zod";
import type {
  ErrorCode,
  SubspacePairResponse,
  SubspaceShareOfferResponse,
  SubspaceStateResponse,
} from "../api.ts";
import { localError, localJson, readJson } from "../responses.ts";
import type { LocalRouteSpec } from "../router.ts";

const ActiveBodySchema = z.object({ hostId: z.string().min(1).nullable() });
const PairBodySchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  activate: z.boolean().optional(),
});
const DirectHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isValidDirectHost, "Invalid direct endpoint host");

const UpdateServerBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  host: DirectHostSchema.optional(),
  port: z.number().int().min(1).max(65535).optional(),
});
const ShareOfferBodySchema = z.object({
  mode: z.enum(["auto", "direct", "relay"]).default("auto"),
  address: DirectHostSchema.optional(),
  port: z.number().int().min(0).max(65535).optional(),
  rotate: z.boolean().optional(),
});
const ShareSettingsBodySchema = z.object({
  hostName: z.string().trim().min(1).max(120).optional(),
  shareMode: z.enum(["off", "direct", "relay"]).optional(),
  directAddress: DirectHostSchema.nullable().optional(),
  directPort: z.number().int().min(0).max(65535).optional(),
});

const STATUS_BY_CODE: Readonly<Partial<Record<ErrorCode, number>>> = {
  "bad-request": 400,
  conflict: 409,
  "call-active": 409,
  "invalid-pairing-code": 400,
  "pairing-expired": 410,
  "pairing-failed": 400,
  "subspace-unreachable": 502,
  "relay-unreachable": 502,
  "local-network-blocked": 502,
  "upstream-failed": 502,
  "relay-auth-required": 409,
  "relay-auth-expired": 409,
  "relay-auth-rejected": 502,
  "unknown-subspace-server": 404,
  "unknown-subspace-grant": 404,
};

const MESSAGE_BY_CODE: Readonly<Partial<Record<ErrorCode, string>>> = {
  "bad-request": "Invalid request",
  conflict: "Active Subspace server changed; reload and try again",
  "call-active": "A call is in progress; hang up before changing Subspace hosts",
  "invalid-pairing-code": "That pairing link or code is not valid",
  "pairing-expired": "This pairing link has expired; ask the remote host for a new one",
  "pairing-failed": "Pairing with the remote Subspace server failed",
  "subspace-unreachable": "Could not reach the Subspace server",
  "relay-unreachable": "Could not reach the Subspace Relay",
  "local-network-blocked":
    "Could not reach the server on your local network; check that it is running and that Local Network access is enabled in macOS System Settings",
  "upstream-failed": "Could not reach the Relay auth server",
  "relay-auth-required": "Sign in to the Subspace Relay first",
  "relay-auth-expired": "Your Subspace Relay session has expired; sign out and sign in again",
  "relay-auth-rejected":
    "The Subspace Relay rejected authentication; check the Relay server configuration or sign in again",
  "unknown-subspace-server": "Unknown Subspace server",
  "unknown-subspace-grant": "Unknown Subspace device grant",
};

function subspaceErrorResponse(error: unknown): Response {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && Object.hasOwn(STATUS_BY_CODE, code)) {
    const mappedCode = code as ErrorCode;
    return localError(STATUS_BY_CODE[mappedCode]!, mappedCode, MESSAGE_BY_CODE[mappedCode]!);
  }
  throw error;
}

export function subspaceRoutes(manager?: SubspaceManager | null): LocalRouteSpec[] {
  const withManager = async <T>(
    fn: (m: SubspaceManager) => Promise<T>,
    status = 200,
  ): Promise<Response> => {
    if (manager === undefined || manager === null) {
      return localError(503, "unavailable", "Subspace is not initialized on this server");
    }
    try {
      return localJson(status, await fn(manager));
    } catch (error) {
      return subspaceErrorResponse(error);
    }
  };

  return [
    {
      route: "GET /api/local/subspace",
      handler: () => withManager((m): Promise<SubspaceStateResponse> => m.getState()),
    },
    {
      route: "POST /api/local/subspace/active",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const parsed = ActiveBodySchema.safeParse(body.value);
        if (!parsed.success)
          return localError(400, "bad-request", "Send { hostId: string | null }");
        return withManager((m) => m.setActiveHostId(parsed.data.hostId));
      },
    },
    {
      route: "POST /api/local/subspace/servers",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const parsed = PairBodySchema.safeParse(body.value);
        if (!parsed.success)
          return localError(400, "invalid-pairing-code", "Enter a pairing link or code");
        return withManager((m): Promise<SubspacePairResponse> => m.pairServer(parsed.data), 201);
      },
    },
    {
      route: "PATCH /api/local/subspace/servers/:id",
      async handler(request, { params }) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const parsed = UpdateServerBodySchema.safeParse(body.value);
        if (!parsed.success) {
          return localError(400, "bad-request", "Invalid server update fields");
        }
        return withManager((m) => m.updateServer(params.id!, parsed.data));
      },
    },
    {
      route: "DELETE /api/local/subspace/servers/:id",
      handler: (_request, { params }) => withManager((m) => m.removeServer(params.id!)),
    },
    {
      route: "POST /api/local/subspace/servers/:id/connect",
      handler: (_request, { params }) => withManager((m) => m.connectServer(params.id!)),
    },
    {
      route: "POST /api/local/subspace/servers/:id/disconnect",
      handler: (_request, { params }) => withManager((m) => m.disconnectServer(params.id!)),
    },
    {
      route: "POST /api/local/subspace/share/offer",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const parsed = ShareOfferBodySchema.safeParse(body.value);
        if (!parsed.success)
          return localError(400, "bad-request", 'Send { mode: "direct" | "relay" }');
        return withManager(
          (m): Promise<SubspaceShareOfferResponse> => m.createShareOffer(parsed.data),
        );
      },
    },
    {
      route: "POST /api/local/subspace/share/settings",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const parsed = ShareSettingsBodySchema.safeParse(body.value);
        if (!parsed.success) return localError(400, "bad-request", "Invalid share settings");
        return withManager((m) => m.updateShareSettings(parsed.data));
      },
    },
    {
      route: "DELETE /api/local/subspace/share/grants/:id",
      handler: (_request, { params }) => withManager((m) => m.revokeGrant(params.id!)),
    },
    {
      route: "POST /api/local/subspace/auth/start",
      handler: () => withManager((m) => m.startRelayAuth()),
    },
    {
      route: "POST /api/local/subspace/auth/logout",
      handler: () => withManager((m) => m.logoutRelayAuth()),
    },
  ];
}
