// laplace-subspace (`eidolon subspace`): inspect status, sign in to the Relay, or revoke paired devices.
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
  discoverRelayAuthUrl,
  listShareableAddresses,
  type SubspaceStateSnapshot,
  SubspaceStore,
  signOutRelaySession,
  startDeviceAuthorization,
  subspaceAuthUrl,
  subspaceRelayUrl,
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
    typeof info.port !== "number" ||
    !Number.isInteger(info.port) ||
    token === ""
  ) {
    return null;
  }
  const baseUrl = `http://${info.host}:${info.port}`;
  try {
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
    if (result.status === "aborted" || result.status === "expired") return false;
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
    const relayAuth = store.readRelayAuth();
    const authUrl = relayAuth?.authUrl ?? subspaceAuthUrl();
    const relayUrl = subspaceRelayUrl();
    const snapshot = {
      running: false,
      activeHostId: servers.activeHostId,
      servers: servers.servers.map((s) => ({ id: s.id, name: s.name, mode: s.mode })),
      share: {
        hostName: identity.hostName,
        shareMode: identity.shareMode,
        directPort: identity.directPort,
        addresses: listShareableAddresses(),
        grants: grants.map((g) => ({
          id: g.id,
          clientName: g.clientName,
          mode: g.mode,
          createdAt: g.createdAt,
          lastSeenAt: g.lastSeenAt,
        })),
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
    const grants = running?.subspace.share.grants ?? store.readGrants();
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
      const res = await fetch(
        `${running.server.baseUrl}/api/local/subspace/share/grants/${encodeURIComponent(grantId)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${running.server.token}` },
          signal: deps.signal,
        },
      );
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
      await fetch(`${running.server.baseUrl}/api/local/subspace/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${running.server.token}` },
        signal: deps.signal,
      });
    } else {
      const current = store.readRelayAuth();
      store.saveRelayAuth(null);
      if (current !== null) await signOutRelaySession(current.authUrl, current.token);
    }
    if (json) out(JSON.stringify({ status: "signed-out" }));
    else out("Signed out of Subspace Relay.");
    return 0;
  }

  const relayUrl =
    typeof ns.relayUrl === "string" && ns.relayUrl.trim()
      ? withoutTrailingSlashes(ns.relayUrl.trim())
      : subspaceRelayUrl();
  const authUrl =
    typeof ns.authUrl === "string" && ns.authUrl.trim()
      ? withoutTrailingSlashes(ns.authUrl.trim())
      : undefined;
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
