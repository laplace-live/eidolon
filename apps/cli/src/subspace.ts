// laplace-subspace (`eidolon subspace`): inspect status, sign in to the Relay, or revoke paired devices.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dataHome,
  envOptional,
  errorText,
  spawnProcess,
  withoutTrailingSlashes,
} from "@eidolon/config";
import { lockInfoPath } from "@eidolon/config/lock";
import {
  completeDeviceAuthorization,
  DEFAULT_SUBSPACE_AUTH_URL,
  DEFAULT_SUBSPACE_RELAY_URL,
  discoverRelayAuthUrl,
  isAllowedAuthUrl,
  isAllowedRelayUrl,
  listShareableAddresses,
  resolveEffectiveRelayUrl,
  type SubspaceGrantView,
  type SubspaceStateSnapshot,
  SubspaceStore,
  signOutRelaySession,
  startDeviceAuthorization,
  subspaceAuthUrl,
} from "@eidolon/subspace";
import { ArgparseExit, type ParserSpec, parseArgs, parserError } from "./argparse.ts";
import { type CommandDeps, printer, reportExit, resolveIo } from "./io.ts";

const PROG = "laplace-subspace";

const USAGE = `usage: ${PROG} [-h] [--relay-url URL] [--auth-url URL] [--json] [{status,login,logout,grants,revoke}] [target]
`;

const HELP = `${USAGE}
Manage Subspace (remote server pairing and Relay account) in the data home.

positional arguments:
  {status,login,logout,grants,revoke}
                        Subcommand to run (default: status)
  target                Grant id for \`revoke\`

options:
  -h, --help            show this help message and exit
  --relay-url URL       Override the Subspace Relay base URL for login
  --auth-url URL        Override the LAPLACE ID / auth server base URL for login
  --json                Write JSON to stdout
`;

export const SUBSPACE_PARSER: ParserSpec = {
  prog: PROG,
  usage: USAGE,
  help: HELP,
  actions: [
    {
      dest: "action",
      flags: [],
      kind: "store",
      nargs: "?",
      default: "status",
      choices: ["status", "login", "logout", "grants", "revoke"],
    },
    { dest: "target", flags: [], kind: "store", nargs: "?" },
    { dest: "relayUrl", flags: ["--relay-url"], kind: "store" },
    { dest: "authUrl", flags: ["--auth-url"], kind: "store" },
    { dest: "json", flags: ["--json"], kind: "store_true" },
  ],
};

export interface RunningLocalServer {
  readonly baseUrl: string;
  readonly token: string;
  readonly pid: number | null;
}

function isLoopbackHost(host: string): boolean {
  if (host === "[::1]") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1) ?? [];
  return (
    octets.length === 3 &&
    octets.every((octet) => String(Number(octet)) === octet && Number(octet) <= 255)
  );
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function toGrantView(grant: SubspaceGrantView): SubspaceGrantView {
  return {
    id: grant.id,
    clientName: grant.clientName,
    mode: grant.mode,
    createdAt: grant.createdAt,
    lastSeenAt: grant.lastSeenAt,
  };
}

export async function probeRunningLocalServer(): Promise<{
  readonly server: RunningLocalServer;
  readonly subspace: SubspaceStateSnapshot;
} | null> {
  let info: { pid?: unknown; port?: unknown; host?: unknown };
  let token: string;
  try {
    info = JSON.parse(readFileSync(lockInfoPath("local-server"), "utf8")) as {
      pid?: unknown;
      port?: unknown;
      host?: unknown;
    };
    token = readFileSync(join(dataHome(), "local-token"), "utf8").trim();
  } catch {
    return null;
  }
  if (
    typeof info.host !== "string" ||
    !isLoopbackHost(info.host) ||
    typeof info.port !== "number" ||
    !Number.isInteger(info.port) ||
    info.port < 1 ||
    info.port > 65535 ||
    token === ""
  ) {
    return null;
  }
  const baseUrl = `http://${info.host}:${info.port}`;
  try {
    // Prove the listener holds our local-token before sending Bearer credentials to it.
    const nonce = randomBytes(16).toString("base64url");
    const probeRes = await fetch(`${baseUrl}/api/local/session?probe=${nonce}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!probeRes.ok) return null;
    const probeBody = (await probeRes.json().catch(() => null)) as { proof?: unknown } | null;
    const expectedProof = createHmac("sha256", token)
      .update(`probe:${nonce}`, "utf8")
      .digest("base64url");
    if (
      typeof probeBody?.proof !== "string" ||
      !timingSafeEqual(digest(probeBody.proof), digest(expectedProof))
    ) {
      return null;
    }

    const res = await fetch(`${baseUrl}/api/local/subspace`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const subspace = (await res.json()) as SubspaceStateSnapshot;
    return {
      server: { baseUrl, token, pid: typeof info.pid === "number" ? info.pid : null },
      subspace,
    };
  } catch {
    return null;
  }
}

export function tryOpenExternalUrl(url: string): void {
  if (envOptional("SSH_CONNECTION")) return;
  const cmd: [string, ...string[]] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    spawnProcess(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // Headless systems fall back cleanly to the printed verification URL.
  }
}

export async function runDeviceLoginFlow(options: {
  readonly relayUrl: string;
  readonly authUrl?: string;
  readonly store: SubspaceStore;
  readonly json: boolean;
  readonly out: (line?: string) => void;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const authUrl = options.authUrl
    ? withoutTrailingSlashes(options.authUrl)
    : await discoverRelayAuthUrl(options.relayUrl, options.signal);
  const started = await startDeviceAuthorization(authUrl, options.signal);
  if (options.json) {
    options.out(
      JSON.stringify({
        event: "device_code",
        authUrl,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        verificationUriComplete: started.verificationUriComplete,
        expiresAt: started.expiresAt,
      }),
    );
  } else {
    options.out(`Open in your browser to sign in to Subspace Relay:`);
    options.out(`  ${started.verificationUriComplete}`);
    options.out(`One-time verification code: ${started.userCode}`);
    tryOpenExternalUrl(started.verificationUriComplete);
  }

  const result = await completeDeviceAuthorization({
    authUrl,
    deviceCode: started.deviceCode,
    intervalSec: started.intervalSec,
    expiresAt: started.expiresAt,
    signal: options.signal,
  });
  if (result.status !== "approved") {
    if (result.status === "aborted") return false;
    if (result.status === "expired") throw new Error("Verification code expired");
    if (result.status === "profile-failed") {
      throw new Error("Account sign-in approved, but profile lookup failed");
    }
    throw new Error(result.message);
  }
  options.store.saveRelayAuth({
    authUrl,
    relayUrl: options.relayUrl,
    token: result.accessToken,
    user: result.user,
    savedAt: Date.now(),
  });
  if (options.json) {
    options.out(JSON.stringify({ event: "signed_in", user: result.user }));
  } else {
    options.out(`Signed in to Subspace Relay as ${result.user.name} (${result.user.email}).`);
  }
  return true;
}

export async function subspaceMain(
  argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  const out = printer(io.stdout);
  const err = printer(io.stderr);
  let ns: Record<string, unknown>;
  try {
    ns = parseArgs(SUBSPACE_PARSER, argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }

  const action = (ns.action as string | undefined) ?? "status";
  const target = ns.target as string | null | undefined;
  const json = Boolean(ns.json);
  const store = new SubspaceStore(dataHome());

  if (action === "revoke" && !target) {
    return reportExit(io, parserError(SUBSPACE_PARSER, "revoke requires a grant id"));
  }

  const running = await probeRunningLocalServer();

  if (action === "status") {
    if (running !== null) {
      if (json) {
        out(JSON.stringify(running.subspace, null, 2));
        return 0;
      }
      const s = running.subspace;
      out(`Subspace host: ${s.share.hostName} (running at ${running.server.baseUrl})`);
      out(
        `Share mode: ${s.share.shareMode} (Direct listening: ${s.share.listening ? `yes on :${s.share.listeningPort}` : "no"}, Relay: ${s.share.relayConnected ? "connected" : "offline"})`,
      );
      out(
        `Relay account: ${
          s.relayAuth.user ? `${s.relayAuth.user.name} (${s.relayAuth.user.email})` : "signed out"
        } [${s.relayAuth.relayUrl} via ${s.relayAuth.authUrl}]`,
      );
      out(`Active host: ${s.activeHostId ?? "this-computer"}`);
      out(`Saved servers: ${s.servers.length}`);
      for (const srv of s.servers) {
        out(`  - ${srv.id}  ${srv.name}  [${srv.mode}]  ${srv.connectionState}`);
      }
      out(`Paired devices: ${s.share.grants.length}`);
      for (const g of s.share.grants) {
        out(`  - ${g.id}  ${g.clientName}  [${g.mode}]`);
      }
      return 0;
    }
    const identity = await store.loadOrCreateIdentity();
    const servers = store.readServers();
    const grants = store.readGrants();
    let relayAuth = null;
    try {
      relayAuth = store.readRelayAuth();
    } catch {
      // Corrupt relay-auth.json should not block inspecting Subspace status offline.
    }
    let authUrl = relayAuth?.authUrl ?? DEFAULT_SUBSPACE_AUTH_URL;
    if (relayAuth?.authUrl === undefined) {
      try {
        authUrl = subspaceAuthUrl();
      } catch {
        // Show default auth URL in offline status when env override is invalid.
      }
    }
    let relayUrl = relayAuth?.relayUrl ?? DEFAULT_SUBSPACE_RELAY_URL;
    if (relayAuth?.relayUrl === undefined) {
      try {
        relayUrl = resolveEffectiveRelayUrl(() => store.readSavedRelayUrl());
      } catch {
        // Show default relay URL in offline status when env/saved override is invalid or corrupt.
      }
    }
    const snapshot = {
      running: false,
      activeHostId: servers.activeHostId,
      servers: servers.servers.map((s) => ({ id: s.id, name: s.name, mode: s.mode })),
      share: {
        hostName: identity.hostName,
        shareMode: identity.shareMode,
        directPort: identity.directPort,
        addresses: listShareableAddresses(),
        grants: grants.map(toGrantView),
      },
      relayAuth: {
        authUrl,
        relayUrl,
        status: relayAuth ? "signed-in" : "signed-out",
        user: relayAuth?.user ?? null,
      },
    };
    if (json) {
      out(JSON.stringify(snapshot, null, 2));
      return 0;
    }
    out(`Subspace host: ${identity.hostName} (server stopped)`);
    out(`Share mode: ${identity.shareMode}`);
    out(
      `Relay account: ${
        relayAuth ? `${relayAuth.user.name} (${relayAuth.user.email})` : "signed out"
      } [${relayUrl} via ${authUrl}]`,
    );
    out(`Saved servers: ${servers.servers.length}`);
    out(`Paired devices: ${grants.length}`);
    for (const g of grants) out(`  - ${g.id}  ${g.clientName}  [${g.mode}]`);
    return 0;
  }

  if (action === "grants") {
    const grants: readonly SubspaceGrantView[] =
      running?.subspace.share.grants ?? store.readGrants().map(toGrantView);
    if (json) {
      out(JSON.stringify(grants, null, 2));
      return 0;
    }
    if (grants.length === 0) {
      out("No paired Subspace devices.");
      return 0;
    }
    for (const g of grants) {
      const seen = g.lastSeenAt === null ? "never" : new Date(g.lastSeenAt).toISOString();
      out(`${g.id}\t${g.clientName}\t${g.mode}\tlast seen ${seen}`);
    }
    return 0;
  }

  if (action === "revoke") {
    const grantId = target!;
    if (running !== null) {
      let res: Response;
      try {
        res = await fetch(
          `${running.server.baseUrl}/api/local/subspace/share/grants/${encodeURIComponent(grantId)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${running.server.token}` },
            signal: deps.signal,
          },
        );
      } catch (error) {
        if (deps.signal?.aborted) return 130;
        err(`Failed to revoke grant ${grantId}: ${errorText(error)}`);
        return 1;
      }
      if (!res.ok) {
        const body = await res.text();
        err(`Failed to revoke grant ${grantId}: ${body}`);
        return 1;
      }
    } else if (!store.removeGrant(grantId)) {
      err(`Unknown grant id: ${grantId}`);
      return 1;
    }
    if (json) out(JSON.stringify({ revoked: grantId }));
    else out(`Revoked access for ${grantId}.`);
    return 0;
  }

  if (action === "logout") {
    if (running !== null) {
      let res: Response;
      try {
        res = await fetch(`${running.server.baseUrl}/api/local/subspace/auth/logout`, {
          method: "POST",
          headers: { authorization: `Bearer ${running.server.token}` },
          signal: deps.signal,
        });
      } catch (error) {
        if (deps.signal?.aborted) return 130;
        err(`Failed to sign out: ${errorText(error)}`);
        return 1;
      }
      if (!res.ok) {
        err(`Failed to sign out: ${await res.text()}`);
        return 1;
      }
    } else {
      const logoutRecord = store.readRelayAuthForLogout();
      store.saveRelayAuth(null);
      if (logoutRecord !== null) {
        if (logoutRecord.corrupt) {
          err(
            "Warning: relay-auth.json was corrupted or used a disallowed auth URL; cleared local credentials without revoking remote session.",
          );
        } else {
          await signOutRelaySession(logoutRecord.authUrl, logoutRecord.token);
        }
      }
      const identity = await store.loadOrCreateIdentity();
      if (identity.shareMode === "relay") {
        store.saveIdentity({ ...identity, shareMode: "off" });
      }
    }
    if (json) out(JSON.stringify({ status: "signed-out" }));
    else out("Signed out of Subspace Relay.");
    return 0;
  }

  let relayUrl: string;
  try {
    relayUrl =
      typeof ns.relayUrl === "string" && ns.relayUrl.trim()
        ? withoutTrailingSlashes(ns.relayUrl.trim())
        : resolveEffectiveRelayUrl(() => store.readSavedRelayUrl());
  } catch (error) {
    err(`Relay login failed: ${errorText(error)}`);
    return 1;
  }
  if (!isAllowedRelayUrl(relayUrl)) {
    return reportExit(
      io,
      parserError(
        SUBSPACE_PARSER,
        `--relay-url must use https/wss or loopback http/ws: ${relayUrl}`,
      ),
    );
  }
  const authUrl =
    typeof ns.authUrl === "string" && ns.authUrl.trim()
      ? withoutTrailingSlashes(ns.authUrl.trim())
      : undefined;
  if (authUrl !== undefined && !isAllowedAuthUrl(authUrl)) {
    return reportExit(
      io,
      parserError(SUBSPACE_PARSER, `--auth-url must use https or loopback http: ${authUrl}`),
    );
  }
  try {
    const ok = await runDeviceLoginFlow({
      relayUrl,
      authUrl,
      store,
      json,
      out,
      signal: deps.signal,
    });
    if (!ok) return deps.signal?.aborted ? 130 : 1;
    if (running !== null) {
      // Ensure a running server picks up relay-auth.json if relay share is active.
      await fetch(`${running.server.baseUrl}/api/local/subspace/share/settings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${running.server.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }).catch(() => {});
    }
    return 0;
  } catch (error) {
    err(`Relay login failed: ${errorText(error)}`);
    return 1;
  }
}
