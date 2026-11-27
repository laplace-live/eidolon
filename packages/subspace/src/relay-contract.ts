import { z } from "zod";

export const RELAY_CLOSE_CODE = {
  UNAUTHORIZED: 4401,
  HOST_NOT_FOUND: 4404,
  TIMEOUT: 4408,
  HOST_OWNED_BY_OTHER: 4409,
  RATE_LIMITED: 4429,
  AUTH_UNAVAILABLE: 4503,
} as const;

export const RELAY_PATHS = {
  HOST_CONTROL: "/v1/host/control",
  HOST_DATA: "/v1/host/data",
  CLIENT_CONNECT: "/v1/client/connect",
} as const;

export const RelayHostIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/);
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const HostHelloSchema = z.object({
  type: z.literal("host_hello"),
  v: z.literal(1),
  relayHostId: RelayHostIdSchema,
  hostPublicKeyB64: z.string().min(1).max(256),
  hostName: z.string().trim().min(1).max(120),
  devices: z
    .array(
      z.object({
        grantId: z.string().min(1).max(64),
        tokenHash: Sha256HexSchema,
        clientName: z.string().trim().min(1).max(120),
      }),
    )
    .max(512)
    .optional(),
  revokedGrantIds: z.array(z.string().min(1).max(64)).max(512).optional(),
});

export const HostChallengeSchema = z.object({
  type: z.literal("host_challenge"),
  challengeB64: z.string().min(1).max(256),
  relayEphPubB64: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
});

export const HostChallengeAckSchema = z.object({
  type: z.literal("host_challenge_ack"),
  proofB64: z.string().min(1).max(256),
});

export const HostHelloAckSchema = z.object({
  type: z.literal("host_hello_ack"),
  relayHostId: RelayHostIdSchema,
  userId: z.string().min(1).max(256),
});

export const InviteCreateSchema = z.object({
  type: z.literal("invite_create"),
  inviteId: z.string().min(1).max(64),
  ticketHash: Sha256HexSchema,
  expiresAt: z.number().int().positive(),
});

export const InviteCreatedSchema = z.object({
  type: z.literal("invite_created"),
  inviteId: z.string().min(1).max(64),
});

export const InviteRevokeSchema = z.object({
  type: z.literal("invite_revoke"),
  inviteId: z.string().min(1).max(64),
});

export const InviteRevokedSchema = z.object({
  type: z.literal("invite_revoked"),
  inviteId: z.string().min(1).max(64),
});

export const DeviceInstallSchema = z.object({
  type: z.literal("device_install"),
  grantId: z.string().min(1).max(64),
  tokenHash: Sha256HexSchema,
  clientName: z.string().trim().min(1).max(120),
});

export const DeviceInstalledSchema = z.object({
  type: z.literal("device_installed"),
  grantId: z.string().min(1).max(64),
});

export const DeviceRevokeSchema = z.object({
  type: z.literal("device_revoke"),
  grantId: z.string().min(1).max(64),
});

export const DeviceRevokedSchema = z.object({
  type: z.literal("device_revoked"),
  grantId: z.string().min(1).max(64),
});

export const ConnectionOpenSchema = z.object({
  type: z.literal("connection_open"),
  sessionId: z.string().min(1).max(64),
  grantId: z.string().min(1).max(64).nullable(),
});

export const RelayHostControlInboundSchema = z.discriminatedUnion("type", [
  HostHelloSchema,
  HostChallengeAckSchema,
  InviteCreateSchema,
  InviteRevokeSchema,
  DeviceInstallSchema,
  DeviceRevokeSchema,
]);

export const RelayHostControlOutboundSchema = z.discriminatedUnion("type", [
  HostChallengeSchema,
  HostHelloAckSchema,
  InviteCreatedSchema,
  InviteRevokedSchema,
  DeviceInstalledSchema,
  DeviceRevokedSchema,
  ConnectionOpenSchema,
]);

export const ClientAuthSchema = z.object({
  type: z.literal("client_auth"),
  v: z.literal(1),
  relayHostId: RelayHostIdSchema,
  credential: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("invite"), relayTicket: Sha256HexSchema }),
    z.object({
      kind: z.literal("device"),
      grantId: z.string().min(1).max(64),
      relayToken: Sha256HexSchema,
    }),
  ]),
});

export const RelayReadySchema = z.object({
  type: z.literal("relay_ready"),
  sessionId: z.string().min(1).max(64),
});

export const HostDataAuthSchema = z.object({
  type: z.literal("host_data_auth"),
  v: z.literal(1),
  relayHostId: RelayHostIdSchema,
  sessionId: z.string().min(1).max(64),
});

export type RelayHostControlInbound = z.infer<typeof RelayHostControlInboundSchema>;
export type RelayHostControlOutbound = z.infer<typeof RelayHostControlOutboundSchema>;
export type ClientAuthMessage = z.infer<typeof ClientAuthSchema>;
export type RelayReadyMessage = z.infer<typeof RelayReadySchema>;
export type HostDataAuthMessage = z.infer<typeof HostDataAuthSchema>;
