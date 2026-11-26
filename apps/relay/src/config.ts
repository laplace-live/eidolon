import { envInt, envOptional, envStr, withoutTrailingSlashes } from "@eidolon/config";

export interface RelayConfig {
  readonly host: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly dbPath: string;
  readonly authIssuer: string;
  readonly authAudience: string;
  readonly jwksUrl: string;
}

export const DEFAULT_RELAY_AUTH_ISSUER = "https://id.laplace.live";
export const DEFAULT_RELAY_AUTH_AUDIENCE = "eidolon-relay";

export function loadRelayConfig(): RelayConfig {
  const host = envStr("EIDOLON_RELAY_HOST", "0.0.0.0");
  const port = envInt("EIDOLON_RELAY_PORT", 8788);
  const publicUrl = withoutTrailingSlashes(
    envStr("EIDOLON_RELAY_PUBLIC_URL", `http://localhost:${port}`),
  );
  const dbPath = envStr("EIDOLON_RELAY_DB_PATH", "./data/relay.sqlite");
  const authIssuer = withoutTrailingSlashes(
    envStr("EIDOLON_RELAY_AUTH_ISSUER", DEFAULT_RELAY_AUTH_ISSUER),
  );
  const authAudience = envStr("EIDOLON_RELAY_AUTH_AUDIENCE", DEFAULT_RELAY_AUTH_AUDIENCE);
  const explicitJwks = envOptional("EIDOLON_RELAY_JWKS_URL");
  const jwksUrl = explicitJwks ?? `${authIssuer}/.well-known/jwks.json`;

  return {
    host,
    port,
    publicUrl,
    dbPath,
    authIssuer,
    authAudience,
    jwksUrl,
  };
}
