import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { newId, withoutTrailingSlashes } from "@eidolon/config";
import { z } from "zod";
import {
  constantTimeEqual,
  generateX25519KeyPair,
  isAllowedRelayUrl,
  sha256Hex,
  utf8Encode,
} from "./protocol/index.ts";
import { DEFAULT_SUBSPACE_AUTH_URL } from "./settings.ts";

export type SubspaceShareMode = "off" | "direct" | "relay";

const HostIdentitySchema = z.object({
  hostName: z.string().trim().min(1).max(120),
  publicKeyB64: z.string().min(1),
  privateKeyPkcs8B64: z.string().min(1),
  directPort: z.number().int().min(0).max(65535),
  directAddress: z.string().trim().min(1).nullable(),
  shareMode: z.enum(["off", "direct", "relay"]),
  createdAt: z.number().int().positive(),
});

const GrantRecordSchema = z.object({
  id: z.string().min(1),
  clientName: z.string().trim().min(1).max(120),
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  relayTokenSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  mode: z.enum(["direct", "relay"]),
  createdAt: z.number().int().positive(),
  lastSeenAt: z.number().int().positive().nullable(),
});

const GrantsFileSchema = z.object({
  grants: z.array(GrantRecordSchema),
});

const SavedServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  hostPublicKeyB64: z.string().min(1),
  grantId: z.string().min(1),
  deviceToken: z.string().min(1),
  mode: z.enum(["direct", "relay"]),
  endpoint: z
    .object({
      host: z.string().trim().min(1),
      port: z.number().int().min(1).max(65535),
      tls: z.boolean().optional(),
    })
    .optional(),
  relay: z
    .object({
      url: z.string().url(),
      relayHostId: z.string().min(1),
    })
    .optional(),
  addedAt: z.number().int().positive(),
  lastConnectedAt: z.number().int().positive().nullable(),
  lastVersion: z.string().nullable(),
});

const ServersFileSchema = z.object({
  activeHostId: z.string().min(1).nullable(),
  servers: z.array(SavedServerSchema),
});

const RelayAuthRecordSchema = z.object({
  authUrl: z.string().url().default(DEFAULT_SUBSPACE_AUTH_URL),
  relayUrl: z.string().url(),
  token: z.string().min(1),
  user: z.object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable().optional(),
  }),
  savedAt: z.number().int().positive(),
});

export type SubspaceHostIdentity = z.infer<typeof HostIdentitySchema>;
export type SubspaceGrantRecord = z.infer<typeof GrantRecordSchema>;
export type SubspaceSavedServer = z.infer<typeof SavedServerSchema>;
export type SubspaceServersFile = z.infer<typeof ServersFileSchema>;
export type SubspaceRelayAuthRecord = z.infer<typeof RelayAuthRecordSchema>;

function defaultHostName(): string {
  return hostname().replace(/\.local$/i, "") || "Eidolon";
}

function readJsonFile<T>(path: string, schema: z.ZodType<T>): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  return schema.parse(JSON.parse(text));
}

function writeSecretJson(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Directory might belong to another owner; rename check handles failures.
    }
  }
  const tmp = join(dir, `.${newId()}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function normalizeServersFile(file: SubspaceServersFile): SubspaceServersFile {
  if (file.activeHostId !== null && !file.servers.some((s) => s.id === file.activeHostId)) {
    return { activeHostId: null, servers: file.servers };
  }
  return file;
}

/** Persistent storage under `<dataHome>/subspace/` for host keys, device grants, and servers. */
export class SubspaceStore {
  readonly dir: string;
  readonly #hostPath: string;
  readonly #grantsPath: string;
  readonly #serversPath: string;
  readonly #relayAuthPath: string;
  #serversCache: SubspaceServersFile | null = null;
  #identityTask: Promise<SubspaceHostIdentity> | null = null;

  constructor(dataHomeDir: string) {
    this.dir = join(dataHomeDir, "subspace");
    this.#hostPath = join(this.dir, "host.json");
    this.#grantsPath = join(this.dir, "grants.json");
    this.#serversPath = join(this.dir, "servers.json");
    this.#relayAuthPath = join(this.dir, "relay-auth.json");
  }

  loadOrCreateIdentity(): Promise<SubspaceHostIdentity> {
    if (this.#identityTask !== null) return this.#identityTask;
    const task = (async () => {
      const existing = readJsonFile(this.#hostPath, HostIdentitySchema);
      if (existing !== null) return existing;
      const kp = await generateX25519KeyPair();
      const created: SubspaceHostIdentity = {
        hostName: defaultHostName(),
        publicKeyB64: kp.publicKeyB64,
        privateKeyPkcs8B64: kp.privateKeyPkcs8B64,
        directPort: 0,
        directAddress: null,
        shareMode: "off",
        createdAt: Date.now(),
      };
      this.saveIdentity(created);
      return created;
    })().finally(() => {
      if (this.#identityTask === task) this.#identityTask = null;
    });
    this.#identityTask = task;
    return task;
  }

  saveIdentity(identity: SubspaceHostIdentity): void {
    writeSecretJson(this.#hostPath, HostIdentitySchema.parse(identity));
  }

  readGrants(): SubspaceGrantRecord[] {
    return readJsonFile(this.#grantsPath, GrantsFileSchema)?.grants ?? [];
  }

  saveGrants(grants: readonly SubspaceGrantRecord[]): void {
    writeSecretJson(this.#grantsPath, { grants });
  }

  addGrant(grant: SubspaceGrantRecord): void {
    const next = [...this.readGrants().filter((g) => g.id !== grant.id), grant];
    this.saveGrants(next);
  }

  removeGrant(id: string): boolean {
    const current = this.readGrants();
    const next = current.filter((g) => g.id !== id);
    if (next.length === current.length) return false;
    this.saveGrants(next);
    return true;
  }

  touchGrant(id: string): void {
    const current = this.readGrants();
    const next = current.map((g) => (g.id === id ? { ...g, lastSeenAt: Date.now() } : g));
    this.saveGrants(next);
  }

  async verifyGrantToken(grantId: string, token: string): Promise<SubspaceGrantRecord | null> {
    const grant = this.readGrants().find((g) => g.id === grantId);
    if (grant === undefined) return null;
    const actualHex = await sha256Hex(utf8Encode(token));
    if (!constantTimeEqual(utf8Encode(actualHex), utf8Encode(grant.tokenSha256))) return null;
    return grant;
  }

  readServers(): SubspaceServersFile {
    if (this.#serversCache !== null) return this.#serversCache;
    const file = readJsonFile(this.#serversPath, ServersFileSchema);
    const normalized =
      file === null ? { activeHostId: null, servers: [] } : normalizeServersFile(file);
    this.#serversCache = normalized;
    return normalized;
  }

  saveServers(file: SubspaceServersFile): void {
    const parsed = ServersFileSchema.parse(file);
    writeSecretJson(this.#serversPath, parsed);
    this.#serversCache = normalizeServersFile(parsed);
  }

  upsertServer(server: SubspaceSavedServer): SubspaceServersFile {
    const current = this.readServers();
    const existingIndex = current.servers.findIndex(
      (s) => s.id === server.id || s.hostPublicKeyB64 === server.hostPublicKeyB64,
    );
    const merged: SubspaceSavedServer =
      existingIndex === -1
        ? server
        : {
            ...server,
            id: current.servers[existingIndex]!.id,
            addedAt: current.servers[existingIndex]!.addedAt,
          };
    const servers =
      existingIndex === -1
        ? [...current.servers, merged]
        : current.servers.map((s, i) => (i === existingIndex ? merged : s));
    const next: SubspaceServersFile = { activeHostId: current.activeHostId, servers };
    this.saveServers(next);
    return next;
  }

  removeServer(id: string): { readonly removed: boolean; readonly file: SubspaceServersFile } {
    const current = this.readServers();
    const servers = current.servers.filter((s) => s.id !== id);
    if (servers.length === current.servers.length) return { removed: false, file: current };
    const activeHostId = current.activeHostId === id ? null : current.activeHostId;
    const next: SubspaceServersFile = { activeHostId, servers };
    this.saveServers(next);
    return { removed: true, file: next };
  }

  setActiveHostId(hostId: string | null): SubspaceServersFile {
    const current = this.readServers();
    if (hostId !== null && !current.servers.some((s) => s.id === hostId)) {
      throw Object.assign(new Error(`Unknown Subspace server ${hostId}`), {
        code: "unknown-subspace-server",
      });
    }
    const next: SubspaceServersFile = { activeHostId: hostId, servers: current.servers };
    this.saveServers(next);
    return next;
  }

  readRelayAuth(): SubspaceRelayAuthRecord | null {
    return readJsonFile(this.#relayAuthPath, RelayAuthRecordSchema.nullable());
  }

  /**
   * Reads `relay-auth.json` for logout: falls back to recovering `authUrl` and `token` from
   * partially corrupt JSON so the remote session can still be revoked, or reports `corrupt: true`
   * when unparseable.
   */
  readRelayAuthForLogout():
    | { readonly authUrl: string; readonly token: string; readonly corrupt: false }
    | { readonly corrupt: true }
    | null {
    try {
      const auth = this.readRelayAuth();
      if (auth === null) return null;
      const authUrl = withoutTrailingSlashes(auth.authUrl.trim());
      if (!isAllowedRelayUrl(authUrl)) return { corrupt: true };
      return { authUrl, token: auth.token, corrupt: false };
    } catch {
      try {
        const raw = JSON.parse(readFileSync(this.#relayAuthPath, "utf8")) as {
          authUrl?: unknown;
          token?: unknown;
        } | null;
        const authUrl = typeof raw?.authUrl === "string" ? raw.authUrl.trim() : "";
        const token = typeof raw?.token === "string" ? raw.token.trim() : "";
        if (authUrl && isAllowedRelayUrl(authUrl) && token) {
          return { authUrl: withoutTrailingSlashes(authUrl), token, corrupt: false };
        }
      } catch {
        // Unparseable JSON; caller warns before clearing the file.
      }
      return { corrupt: true };
    }
  }

  saveRelayAuth(auth: SubspaceRelayAuthRecord | null): void {
    if (auth === null) {
      writeSecretJson(this.#relayAuthPath, null);
      return;
    }
    writeSecretJson(this.#relayAuthPath, RelayAuthRecordSchema.parse(auth));
  }
}
