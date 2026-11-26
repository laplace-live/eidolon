import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function safeHashEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.byteLength === 32 && a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function openRelayDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

type PreparedStatement = ReturnType<DatabaseSync["prepare"]>;

/** SQLite backing store for registered Subspace hosts, single-use pairing invites, and device tokens. */
export class RelayStore {
  readonly #selectHost: PreparedStatement;
  readonly #updateHost: PreparedStatement;
  readonly #insertHost: PreparedStatement;
  readonly #pruneExpiredInvites: PreparedStatement;
  readonly #insertInvite: PreparedStatement;
  readonly #pruneHostExpiredInvites: PreparedStatement;
  readonly #selectHostInvites: PreparedStatement;
  readonly #deleteInviteIfValid: PreparedStatement;
  readonly #insertDevice: PreparedStatement;
  readonly #selectDevice: PreparedStatement;
  readonly #deleteDevice: PreparedStatement;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subspace_hosts (
        relay_host_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        public_key_b64 TEXT NOT NULL,
        host_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subspace_invites (
        invite_id TEXT PRIMARY KEY,
        relay_host_id TEXT NOT NULL,
        ticket_sha256 TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_subspace_invites_host ON subspace_invites(relay_host_id);
      CREATE INDEX IF NOT EXISTS idx_subspace_invites_expires ON subspace_invites(expires_at);
      CREATE TABLE IF NOT EXISTS subspace_devices (
        relay_host_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        token_sha256 TEXT NOT NULL,
        client_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (relay_host_id, grant_id)
      );
    `);
    this.#selectHost = db.prepare(
      "SELECT user_id, public_key_b64 FROM subspace_hosts WHERE relay_host_id = ?",
    );
    this.#updateHost = db.prepare(
      "UPDATE subspace_hosts SET host_name = ?, updated_at = ? WHERE relay_host_id = ?",
    );
    this.#insertHost = db.prepare(
      "INSERT INTO subspace_hosts (relay_host_id, user_id, public_key_b64, host_name, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.#pruneExpiredInvites = db.prepare("DELETE FROM subspace_invites WHERE expires_at <= ?");
    this.#insertInvite = db.prepare(
      "INSERT OR REPLACE INTO subspace_invites (invite_id, relay_host_id, ticket_sha256, expires_at) VALUES (?, ?, ?, ?)",
    );
    this.#pruneHostExpiredInvites = db.prepare(
      "DELETE FROM subspace_invites WHERE relay_host_id = ? AND expires_at <= ?",
    );
    this.#selectHostInvites = db.prepare(
      "SELECT invite_id, ticket_sha256 FROM subspace_invites WHERE relay_host_id = ?",
    );
    this.#deleteInviteIfValid = db.prepare(
      "DELETE FROM subspace_invites WHERE invite_id = ? AND expires_at > ?",
    );
    this.#insertDevice = db.prepare(
      "INSERT OR REPLACE INTO subspace_devices (relay_host_id, grant_id, token_sha256, client_name, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.#selectDevice = db.prepare(
      "SELECT token_sha256 FROM subspace_devices WHERE relay_host_id = ? AND grant_id = ?",
    );
    this.#deleteDevice = db.prepare(
      "DELETE FROM subspace_devices WHERE relay_host_id = ? AND grant_id = ?",
    );
  }

  claimOrVerifyHost(input: {
    readonly relayHostId: string;
    readonly userId: string;
    readonly publicKeyB64: string;
    readonly hostName: string;
  }): "ok" | "owned-by-other" | "key-conflict" {
    const existing = this.#selectHost.get(input.relayHostId) as
      | { user_id: string; public_key_b64: string }
      | undefined;
    const now = Date.now();
    if (existing !== undefined) {
      if (existing.user_id !== input.userId) return "owned-by-other";
      if (existing.public_key_b64 !== input.publicKeyB64) return "key-conflict";
      this.#updateHost.run(input.hostName, now, input.relayHostId);
      return "ok";
    }
    this.#insertHost.run(input.relayHostId, input.userId, input.publicKeyB64, input.hostName, now);
    return "ok";
  }

  putInvite(input: {
    readonly inviteId: string;
    readonly relayHostId: string;
    readonly ticketSha256: string;
    readonly expiresAt: number;
  }): void {
    this.#pruneExpiredInvites.run(Date.now());
    this.#insertInvite.run(input.inviteId, input.relayHostId, input.ticketSha256, input.expiresAt);
  }

  consumeInvite(relayHostId: string, ticketSha256: string, nowMs = Date.now()): boolean {
    this.#pruneHostExpiredInvites.run(relayHostId, nowMs);
    const rows = this.#selectHostInvites.all(relayHostId) as {
      invite_id: string;
      ticket_sha256: string;
    }[];
    for (const row of rows) {
      if (safeHashEqual(row.ticket_sha256, ticketSha256)) {
        const deleted = this.#deleteInviteIfValid.run(row.invite_id, nowMs);
        return Number(deleted.changes) === 1;
      }
    }
    return false;
  }

  installDevice(input: {
    readonly relayHostId: string;
    readonly grantId: string;
    readonly tokenSha256: string;
    readonly clientName: string;
  }): void {
    this.#insertDevice.run(
      input.relayHostId,
      input.grantId,
      input.tokenSha256,
      input.clientName,
      Date.now(),
    );
  }

  verifyDevice(relayHostId: string, grantId: string, tokenSha256: string): boolean {
    const row = this.#selectDevice.get(relayHostId, grantId) as
      | { token_sha256: string }
      | undefined;
    if (row === undefined) return false;
    return safeHashEqual(row.token_sha256, tokenSha256);
  }

  revokeDevice(relayHostId: string, grantId: string): void {
    this.#deleteDevice.run(relayHostId, grantId);
  }
}
