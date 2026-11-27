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

function readCleanEnvValue(name: string, raw: string, expectation: string): string {
  const value = raw.trim();
  if (value === "" || /[\s\\]/.test(value)) {
    throw new Error(`${name} ${expectation} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function readNormalizedUrl(name: string, raw: string, stripTrailingSlashes: boolean): string {
  // Reject shell line-continuation characters and single-slash typos before URL parsing.
  const value = readCleanEnvValue(
    name,
    raw,
    "must be a valid http(s) URL without whitespace or backslashes",
  );
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${name} must be a valid http(s) URL (got ${JSON.stringify(raw)})`);
  }
  const parsed = URL.parse(value);
  if (parsed === null) {
    throw new Error(`${name} must be a valid http(s) URL (got ${JSON.stringify(raw)})`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https (got ${JSON.stringify(raw)})`);
  }
  // Preserve explicit default port (e.g. :443) for string-matched JWT iss while canonicalizing case.
  const explicitPortMatch = /^https?:\/\/(?:\[[^\]]+\]|[^/:]+):(\d+)/i.exec(value);
  const authority =
    explicitPortMatch !== null && parsed.port === ""
      ? `${parsed.hostname}:${explicitPortMatch[1]}`
      : parsed.host;
  const canonical = `${parsed.protocol}//${authority}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return stripTrailingSlashes ? withoutTrailingSlashes(canonical) : canonical;
}

function readNormalizedToken(name: string, raw: string): string {
  return readCleanEnvValue(name, raw, "must not be empty or contain whitespace or backslashes");
}

export function loadRelayConfig(): RelayConfig {
  const host = envStr("EIDOLON_RELAY_HOST", "0.0.0.0").trim() || "0.0.0.0";
  const port = envInt("EIDOLON_RELAY_PORT", 8788);
  const publicUrl = readNormalizedUrl(
    "EIDOLON_RELAY_PUBLIC_URL",
    envStr("EIDOLON_RELAY_PUBLIC_URL", `http://localhost:${port}`),
    true,
  );
  const dbPath = envStr("EIDOLON_RELAY_DB_PATH", "./data/relay.sqlite");
  const authIssuer = readNormalizedUrl(
    "EIDOLON_RELAY_AUTH_ISSUER",
    envStr("EIDOLON_RELAY_AUTH_ISSUER", DEFAULT_RELAY_AUTH_ISSUER),
    true,
  );
  const authAudience = readNormalizedToken(
    "EIDOLON_RELAY_AUTH_AUDIENCE",
    envStr("EIDOLON_RELAY_AUTH_AUDIENCE", DEFAULT_RELAY_AUTH_AUDIENCE),
  );
  const explicitJwks = envOptional("EIDOLON_RELAY_JWKS_URL");
  const jwksUrl =
    explicitJwks === undefined
      ? `${authIssuer}/.well-known/jwks.json`
      : readNormalizedUrl("EIDOLON_RELAY_JWKS_URL", explicitJwks, false);

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
