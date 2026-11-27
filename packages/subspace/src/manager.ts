import { errorText, logger, newId, withoutTrailingSlashes } from "@eidolon/config";
import {
  completeDeviceAuthorization,
  type DeviceAuthStart,
  discoverRelayAuthUrl,
  type RelayUser,
  signOutRelaySession,
  startDeviceAuthorization,
} from "./auth-client.ts";
import {
  performPairingHandshake,
  SubspaceClient,
  SubspaceConnectError,
  type SubspaceConnectionState,
} from "./client.ts";
import {
  grantSupportsRelay,
  hostTransportNeeds,
  readRelayAuthSafe,
  SubspaceHost,
  type SubspaceHostEvent,
} from "./host.ts";
import { listShareableAddresses, type ShareableAddress } from "./network.ts";
import {
  encodePairingCode,
  encodePairingUrl,
  isPairingExpired,
  isValidDirectHost,
  parsePairingInput,
  type SubspacePairingOffer,
} from "./protocol/index.ts";
import { renderPairingQrSvg } from "./qr.ts";
import {
  DEFAULT_SUBSPACE_AUTH_URL,
  DEFAULT_SUBSPACE_RELAY_URL,
  resolveEffectiveRelayUrl,
  subspaceAuthUrl,
} from "./settings.ts";
import {
  type SubspaceGrantRecord,
  type SubspaceSavedServer,
  type SubspaceServersFile,
  type SubspaceShareMode,
  SubspaceStore,
} from "./store.ts";

export interface SubspaceManagerDeps {
  readonly dataHome: string;
  readonly serverVersion: () => string;
  readonly activeCalls: () => number;
  readonly dispatchLocal: (request: Request) => Promise<Response>;
  readonly relayUrl?: () => string;
  readonly authUrl?: () => string;
  readonly callBridgeIdleMs?: number;
  readonly onHostEvent?: (event: SubspaceHostEvent) => void;
}

export interface SubspaceDeviceFlowSnapshot {
  readonly status: "idle" | "pending" | "approved" | "error";
  readonly userCode: string | null;
  readonly verificationUri: string | null;
  readonly verificationUriComplete: string | null;
  readonly expiresAt: number | null;
  readonly error: string | null;
}

export interface SubspaceServerView {
  readonly id: string;
  readonly name: string;
  readonly mode: "direct" | "relay";
  readonly activeTransport: "direct" | "relay" | null;
  readonly endpoint: {
    readonly host: string;
    readonly port: number;
    readonly tls?: boolean;
  } | null;
  readonly relay: { readonly url: string; readonly relayHostId: string } | null;
  readonly addedAt: number;
  readonly lastConnectedAt: number | null;
  readonly lastVersion: string | null;
  readonly connectionState: SubspaceConnectionState;
  readonly lastError: string | null;
  readonly lastErrorCode: SubspaceConnectError["code"] | null;
  readonly latencyMs: number | null;
}

export interface SubspaceOfferSnapshot {
  readonly mode: "direct" | "relay";
  readonly hasRelayFallback: boolean;
  readonly hostName: string;
  readonly expiresAt: number;
  readonly pairingUrl: string;
  readonly pairingCode: string;
  readonly qrSvg: string;
}

export interface SubspaceGrantView {
  readonly id: string;
  readonly clientName: string;
  readonly mode: "direct" | "relay";
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
}

export interface SubspaceStateSnapshot {
  readonly activeHostId: string | null;
  readonly servers: readonly SubspaceServerView[];
  readonly share: {
    readonly hostName: string;
    readonly shareMode: SubspaceShareMode;
    readonly directPort: number;
    readonly directAddress: string | null;
    readonly addresses: readonly ShareableAddress[];
    readonly listening: boolean;
    readonly listeningPort: number | null;
    readonly relayConnected: boolean;
    readonly relayError: string | null;
    readonly activeOffer: SubspaceOfferSnapshot | null;
    readonly grants: readonly SubspaceGrantView[];
  };
  readonly relayAuth: {
    readonly authUrl: string;
    readonly relayUrl: string;
    readonly status: "signed-out" | "pending" | "signed-in";
    readonly user: RelayUser | null;
    readonly deviceFlow: SubspaceDeviceFlowSnapshot;
  };
}

export interface SubspacePairSnapshot extends SubspaceStateSnapshot {
  readonly pairedServerId: string;
}

const IDLE_FLOW: SubspaceDeviceFlowSnapshot = {
  status: "idle",
  userCode: null,
  verificationUri: null,
  verificationUriComplete: null,
  expiresAt: null,
  error: null,
};

function codedError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

/** Coordinates Subspace host sharing, paired server connections, Relay login, and active proxy routing. */
export class SubspaceManager {
  readonly store: SubspaceStore;
  readonly host: SubspaceHost;
  readonly #deps: SubspaceManagerDeps;
  readonly #clients = new Map<string, SubspaceClient>();
  readonly #relayUrlFn: () => string;
  readonly #authUrlFn: (() => string) | undefined;

  #deviceFlow: SubspaceDeviceFlowSnapshot = IDLE_FLOW;
  #devicePollAbort: AbortController | null = null;
  #cachedOffer: {
    readonly source: SubspacePairingOffer;
    readonly snapshot: SubspaceOfferSnapshot;
  } | null = null;
  #stopped = false;

  constructor(deps: SubspaceManagerDeps) {
    this.#deps = deps;
    this.store = new SubspaceStore(deps.dataHome);
    this.#relayUrlFn =
      deps.relayUrl ?? (() => resolveEffectiveRelayUrl(() => this.store.readSavedRelayUrl()));
    this.#authUrlFn = deps.authUrl;
    this.host = new SubspaceHost({
      store: this.store,
      serverVersion: deps.serverVersion,
      dispatch: deps.dispatchLocal,
      relayUrl: this.#relayUrlFn,
      onEvent: deps.onHostEvent,
    });
  }

  #readRelayAuthOrBadRequest() {
    const { auth, error } = readRelayAuthSafe(this.store);
    if (error !== null) throw codedError("bad-request", error);
    return auth;
  }

  #hasActiveCallsOnHostKey(hostPublicKeyB64: string): boolean {
    const existing = this.store
      .readServers()
      .servers.find((s) => s.hostPublicKeyB64 === hostPublicKeyB64);
    return existing !== undefined && (this.#clients.get(existing.id)?.activeCallCount ?? 0) > 0;
  }

  get activeHostId(): string | null {
    return this.store.readServers().activeHostId;
  }

  get activeCallCount(): number {
    let total = 0;
    for (const client of this.#clients.values()) total += client.activeCallCount;
    return total;
  }

  async boot(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.host.ensureStartedFromDisk();
      const { activeHostId, servers } = this.store.readServers();
      for (const server of servers) {
        const client = this.#clientFor(server);
        if (server.id === activeHostId) client.start();
      }
    } catch (error) {
      logger.error(`[subspace] Failed to restore Subspace state: ${errorText(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#devicePollAbort?.abort();
    this.#devicePollAbort = null;
    for (const client of this.#clients.values()) client.stop();
    this.#clients.clear();
    await this.host.stop();
  }

  async getState(): Promise<SubspaceStateSnapshot> {
    const identity = await this.store.loadOrCreateIdentity();
    const { activeHostId, servers } = this.store.readServers();
    const { auth: relayAuth, error: relayAuthError } = readRelayAuthSafe(this.store);
    let configRelayError: string | null = relayAuthError;
    const grants: readonly SubspaceGrantRecord[] = this.store.readGrants();
    const activeOffer =
      identity.shareMode === "off"
        ? null
        : this.#offerSnapshot(
            this.host.activeOffer(identity.shareMode === "relay" ? "relay" : "direct"),
          );
    const { needsRelay } = hostTransportNeeds(identity.shareMode, grants);
    let relayUrl = DEFAULT_SUBSPACE_RELAY_URL;
    let authUrl = relayAuth?.authUrl ?? DEFAULT_SUBSPACE_AUTH_URL;
    try {
      relayUrl = withoutTrailingSlashes(this.#relayUrlFn());
    } catch (error) {
      configRelayError ??= error instanceof Error ? error.message : String(error);
    }
    if (relayAuth?.authUrl === undefined) {
      try {
        authUrl =
          this.#authUrlFn !== undefined
            ? withoutTrailingSlashes(this.#authUrlFn())
            : subspaceAuthUrl();
      } catch (error) {
        configRelayError ??= error instanceof Error ? error.message : String(error);
      }
    }
    if (
      needsRelay &&
      relayAuth !== null &&
      configRelayError === null &&
      this.host.activeRelayUrl !== null &&
      this.host.activeRelayUrl !== relayUrl
    ) {
      this.host.startRelay();
    }

    return {
      activeHostId,
      servers: servers.map((server) => {
        const client = this.#clientFor(server);
        return {
          id: server.id,
          name: server.name,
          mode: server.mode,
          activeTransport: client.activeTransport,
          endpoint: server.endpoint ?? null,
          relay: server.relay ?? null,
          addedAt: server.addedAt,
          lastConnectedAt: server.lastConnectedAt,
          lastVersion: server.lastVersion,
          connectionState: client.state,
          lastError: client.lastError,
          lastErrorCode: client.lastErrorCode,
          latencyMs: client.latencyMs,
        };
      }),
      share: {
        hostName: identity.hostName,
        shareMode: identity.shareMode,
        directPort: identity.directPort,
        directAddress: identity.directAddress,
        addresses: listShareableAddresses(),
        listening: this.host.listening,
        listeningPort: this.host.directPort,
        relayConnected: this.host.relayConnected,
        relayError: this.host.relayError ?? (needsRelay ? configRelayError : null),
        activeOffer,
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
        status:
          relayAuth !== null
            ? "signed-in"
            : this.#deviceFlow.status === "pending"
              ? "pending"
              : "signed-out",
        user: relayAuth?.user ?? null,
        deviceFlow: this.#deviceFlow,
      },
    };
  }

  async setActiveHostId(hostId: string | null): Promise<SubspaceStateSnapshot> {
    if (hostId !== null) this.#requireServer(hostId);
    if (hostId !== this.activeHostId) {
      await this.#refreshRemoteActiveCalls();
      if (this.#totalActiveCalls() > 0) {
        throw codedError("call-active", "A call is in progress; hang up before switching servers");
      }
    }
    // Re-read after awaiting in case another caller removed hostId or switched activeHostId.
    const previous = this.activeHostId;
    const updated = this.store.setActiveHostId(hostId);
    if (previous !== null && previous !== hostId) {
      this.#clients.get(previous)?.stop();
    }
    if (hostId !== null) {
      const server = updated.servers.find((s) => s.id === hostId);
      if (server === undefined) {
        throw codedError("unknown-subspace-server", "Unknown Subspace server");
      }
      this.#clientFor(server).start();
    }
    return await this.getState();
  }

  async pairServer(input: {
    readonly code: string;
    readonly name?: string;
    readonly activate?: boolean;
  }): Promise<SubspacePairSnapshot> {
    const parsed = parsePairingInput(input.code);
    if (!parsed.ok) {
      throw new SubspaceConnectError(
        "invalid-pairing-code",
        "That pairing link or code is not valid",
      );
    }
    if (isPairingExpired(parsed.offer)) {
      throw new SubspaceConnectError(
        "pairing-expired",
        "This pairing link has expired; ask the remote host for a new one",
      );
    }
    const offer = parsed.offer;
    await this.#refreshRemoteActiveCalls();
    if (this.#hasActiveCallsOnHostKey(offer.hostPublicKeyB64)) {
      throw codedError(
        "call-active",
        "A call is in progress on this server; hang up before re-pairing it",
      );
    }
    const handshake = await performPairingHandshake(offer);
    await this.#refreshRemoteActiveCalls();
    if (this.#hasActiveCallsOnHostKey(offer.hostPublicKeyB64)) {
      handshake.tunnel.mux.close("Call active");
      handshake.tunnel.ws.terminate();
      throw codedError(
        "call-active",
        "A call is in progress on this server; hang up before re-pairing it",
      );
    }
    const saved: SubspaceSavedServer = {
      id: newId(),
      name: input.name?.trim() || handshake.hostName || offer.hostName,
      hostPublicKeyB64: offer.hostPublicKeyB64,
      grantId: handshake.grantId,
      deviceToken: handshake.deviceToken,
      mode: offer.endpoint !== undefined ? "direct" : "relay",
      ...(offer.endpoint !== undefined ? { endpoint: offer.endpoint } : {}),
      ...(handshake.relay !== undefined ? { relay: handshake.relay } : {}),
      addedAt: Date.now(),
      lastConnectedAt: Date.now(),
      lastVersion: handshake.serverVersion,
    };
    const file = this.store.upsertServer(saved);
    const persisted =
      file.servers.find((s) => s.hostPublicKeyB64 === saved.hostPublicKeyB64) ?? saved;
    this.#clients.get(persisted.id)?.stop();
    this.#attachClient(persisted, handshake.tunnel);
    await this.#refreshRemoteActiveCalls();
    if (input.activate && this.#totalActiveCalls() === 0) {
      await this.setActiveHostId(persisted.id);
    }
    return { ...(await this.getState()), pairedServerId: persisted.id };
  }

  async updateServer(
    id: string,
    patch: { readonly name?: string; readonly host?: string; readonly port?: number },
  ): Promise<SubspaceStateSnapshot> {
    const nextEndpointFor = (server: SubspaceSavedServer) => {
      const nextEndpoint =
        server.endpoint !== undefined
          ? {
              host: patch.host?.trim() || server.endpoint.host,
              port: patch.port ?? server.endpoint.port,
              ...(server.endpoint.tls ? { tls: true } : {}),
            }
          : server.endpoint;
      const endpointChanged =
        nextEndpoint?.host !== server.endpoint?.host ||
        nextEndpoint?.port !== server.endpoint?.port;
      return { nextEndpoint, endpointChanged };
    };
    const initial = this.#requireServer(id);
    const initialPatch = nextEndpointFor(initial.server);
    if (initialPatch.endpointChanged) {
      await this.#clients.get(id)?.refreshActiveCallCount();
      if ((this.#clients.get(id)?.activeCallCount ?? 0) > 0) {
        throw codedError(
          "call-active",
          "A call is in progress on this server; hang up before changing its address or port",
        );
      }
    }
    // Re-read after awaiting so concurrent pairings or activeHostId switches aren't overwritten.
    const { file, server: target } = this.#requireServer(id);
    const { nextEndpoint, endpointChanged } = nextEndpointFor(target);
    if (endpointChanged && (this.#clients.get(id)?.activeCallCount ?? 0) > 0) {
      throw codedError(
        "call-active",
        "A call is in progress on this server; hang up before changing its address or port",
      );
    }
    const updated: SubspaceSavedServer = {
      ...target,
      name: patch.name?.trim() || target.name,
      ...(nextEndpoint !== undefined ? { endpoint: nextEndpoint } : {}),
    };
    this.store.saveServers({
      activeHostId: file.activeHostId,
      servers: file.servers.map((s) => (s.id === id ? updated : s)),
    });
    this.#clients.get(id)?.updateServer(updated);
    return await this.getState();
  }

  async removeServer(id: string): Promise<SubspaceStateSnapshot> {
    if (this.activeHostId === id) {
      await this.#refreshRemoteActiveCalls();
      if (this.#totalActiveCalls() > 0) {
        throw codedError(
          "call-active",
          "A call is in progress; hang up before removing the active server",
        );
      }
    }
    this.#clients.get(id)?.stop();
    this.#clients.delete(id);
    const { removed } = this.store.removeServer(id);
    if (!removed) {
      throw codedError("unknown-subspace-server", "Unknown Subspace server");
    }
    return await this.getState();
  }

  async connectServer(id: string): Promise<SubspaceStateSnapshot> {
    const { server } = this.#requireServer(id);
    await this.#clientFor(server).connect();
    return await this.getState();
  }

  async disconnectServer(id: string): Promise<SubspaceStateSnapshot> {
    const { server } = this.#requireServer(id);
    this.#clientFor(server).disconnectManually();
    return await this.getState();
  }

  async updateShareSettings(patch: {
    readonly hostName?: string;
    readonly shareMode?: SubspaceShareMode;
    readonly directAddress?: string | null;
    readonly directPort?: number;
  }): Promise<SubspaceStateSnapshot> {
    const current = await this.store.loadOrCreateIdentity();
    if (
      patch.directAddress !== undefined &&
      patch.directAddress !== null &&
      patch.directAddress.trim() !== "" &&
      !isValidDirectHost(patch.directAddress.trim())
    ) {
      throw codedError("bad-request", "Invalid direct endpoint host");
    }
    if (patch.shareMode === "relay" && this.#readRelayAuthOrBadRequest() === null) {
      throw codedError(
        "relay-auth-required",
        "Sign in to the Subspace Relay before sharing via Relay",
      );
    }
    const next = {
      ...current,
      hostName: patch.hostName?.trim() || current.hostName,
      shareMode: patch.shareMode ?? current.shareMode,
      directAddress:
        patch.directAddress === undefined
          ? current.directAddress
          : patch.directAddress === null || patch.directAddress.trim() === ""
            ? null
            : patch.directAddress.trim(),
      directPort: patch.directPort ?? current.directPort,
    };
    if (
      next.hostName !== current.hostName ||
      next.shareMode !== current.shareMode ||
      next.directAddress !== current.directAddress ||
      next.directPort !== current.directPort
    ) {
      this.store.saveIdentity(next);
      await this.host.reloadIdentity();
    }

    if (next.shareMode === "off") {
      this.host.clearInvites();
    } else if (
      next.shareMode !== current.shareMode &&
      (current.shareMode === "direct" || current.shareMode === "relay")
    ) {
      this.host.clearInvites(current.shareMode);
    }

    const grants = this.store.readGrants();
    const { needsDirect, needsRelay } = hostTransportNeeds(next.shareMode, grants);

    if (needsDirect) {
      await this.host.startDirect(next.directPort);
    } else {
      await this.host.stopDirect();
    }

    if (needsRelay) {
      let shouldStartRelay = false;
      try {
        shouldStartRelay = this.store.readRelayAuth() !== null;
      } catch {
        // Let startRelay() surface corrupt-credential state on host.relayError without blocking Off/Direct edits.
        shouldStartRelay = true;
      }
      if (shouldStartRelay) this.host.startRelay();
    } else {
      this.host.stopRelay();
    }
    return await this.getState();
  }

  async createShareOffer(
    options: {
      readonly mode?: "auto" | "direct" | "relay";
      readonly address?: string;
      readonly port?: number;
      readonly rotate?: boolean;
    } = {},
  ): Promise<{
    readonly pairingUrl: string;
    readonly pairingCode: string;
    readonly qrSvg: string;
    readonly expiresAt: number;
    readonly hasRelayFallback: boolean;
    readonly state: SubspaceStateSnapshot;
  }> {
    const mode = options.mode ?? "auto";
    if (mode === "relay" && this.#readRelayAuthOrBadRequest() === null) {
      throw codedError("relay-auth-required", "Sign in to the Subspace Relay first");
    }
    const identity = await this.store.loadOrCreateIdentity();
    const explicitAddress = options.address?.trim() || undefined;
    const chosenAddress =
      mode === "relay"
        ? undefined
        : explicitAddress ||
          identity.directAddress ||
          listShareableAddresses()[0]?.address ||
          "127.0.0.1";
    const targetShareMode = mode === "relay" ? "relay" : "direct";
    const addressChanged = chosenAddress !== undefined && identity.directAddress !== chosenAddress;
    if (identity.shareMode !== targetShareMode || addressChanged) {
      this.store.saveIdentity({
        ...identity,
        shareMode: targetShareMode,
        ...(chosenAddress !== undefined ? { directAddress: chosenAddress } : {}),
      });
      await this.host.reloadIdentity();
    }
    const offer = await this.host.createPairingOffer({
      mode,
      address: explicitAddress ?? (addressChanged ? chosenAddress : undefined),
      port: options.port,
      rotate: options.rotate,
    });
    const snapshot = this.#offerSnapshot(offer)!;
    return {
      pairingUrl: snapshot.pairingUrl,
      pairingCode: snapshot.pairingCode,
      qrSvg: snapshot.qrSvg,
      expiresAt: snapshot.expiresAt,
      hasRelayFallback: snapshot.hasRelayFallback,
      state: await this.getState(),
    };
  }

  async revokeGrant(grantId: string): Promise<SubspaceStateSnapshot> {
    if (!this.host.revokeGrant(grantId)) {
      throw codedError("unknown-subspace-grant", "Unknown Subspace device grant");
    }
    return await this.getState();
  }

  async startRelayAuth(): Promise<SubspaceStateSnapshot> {
    this.#devicePollAbort?.abort();
    const abort = new AbortController();
    this.#devicePollAbort = abort;

    let relayUrl: string;
    let authUrl: string;
    try {
      relayUrl = withoutTrailingSlashes(this.#relayUrlFn());
      authUrl =
        this.#authUrlFn !== undefined
          ? withoutTrailingSlashes(this.#authUrlFn())
          : await discoverRelayAuthUrl(relayUrl, abort.signal);
    } catch (error) {
      throw codedError(
        "bad-request",
        error instanceof Error ? error.message : "Invalid Subspace URL",
      );
    }
    let started: DeviceAuthStart;
    try {
      started = await startDeviceAuthorization(authUrl, abort.signal);
    } catch {
      throw codedError("upstream-failed", "Could not reach the Relay auth server");
    }
    this.#deviceFlow = {
      status: "pending",
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      verificationUriComplete: started.verificationUriComplete,
      expiresAt: started.expiresAt,
      error: null,
    };

    void this.#pollRelayLogin(
      authUrl,
      relayUrl,
      started.deviceCode,
      started.intervalSec,
      started.expiresAt,
      abort,
    );
    return await this.getState();
  }

  async logoutRelayAuth(): Promise<SubspaceStateSnapshot> {
    this.#devicePollAbort?.abort();
    this.#devicePollAbort = null;
    this.#deviceFlow = IDLE_FLOW;
    const logoutRecord = this.store.readRelayAuthForLogout();
    this.store.saveRelayAuth(null);
    this.host.clearRelayInvites();
    this.host.stopRelay();
    if (logoutRecord !== null) {
      if (logoutRecord.corrupt) {
        logger.warning(
          "[subspace] relay-auth.json was corrupted or used a disallowed auth URL; cleared local credentials without revoking remote session",
        );
      } else {
        await signOutRelaySession(logoutRecord.authUrl, logoutRecord.token);
      }
    }
    const identity = await this.store.loadOrCreateIdentity();
    if (identity.shareMode === "relay") {
      this.store.saveIdentity({ ...identity, shareMode: "off" });
      await this.host.reloadIdentity();
    }
    return await this.getState();
  }

  async proxyToActive(
    request: Request,
    targetPathWithSearch: string,
    expectedHostId?: string,
  ): Promise<Response> {
    const activeId = expectedHostId ?? this.activeHostId;
    if (activeId === null) {
      throw new SubspaceConnectError("subspace-unreachable", "No remote Subspace server is active");
    }
    const server = this.store.readServers().servers.find((s) => s.id === activeId);
    if (server === undefined) {
      throw new SubspaceConnectError(
        "subspace-unreachable",
        "Active Subspace server no longer exists",
      );
    }
    const client = this.#clientFor(server);
    if (client.manuallyDisconnected) {
      throw new SubspaceConnectError("subspace-unreachable", "Disconnected from remote server");
    }
    return await client.proxyFetch(request, targetPathWithSearch);
  }

  async #refreshRemoteActiveCalls(): Promise<void> {
    await Promise.all([...this.#clients.values()].map((client) => client.refreshActiveCallCount()));
  }

  #totalActiveCalls(): number {
    return this.#deps.activeCalls() + this.activeCallCount;
  }

  #offerSnapshot(offer: SubspacePairingOffer | null): SubspaceOfferSnapshot | null {
    if (offer === null) {
      this.#cachedOffer = null;
      return null;
    }
    if (this.#cachedOffer?.source === offer) return this.#cachedOffer.snapshot;
    const pairingUrl = encodePairingUrl(offer);
    const snapshot: SubspaceOfferSnapshot = {
      mode: offer.mode,
      hasRelayFallback: offer.relay !== undefined,
      hostName: offer.hostName,
      expiresAt: offer.expiresAt,
      pairingCode: encodePairingCode(offer),
      pairingUrl,
      qrSvg: renderPairingQrSvg(pairingUrl),
    };
    this.#cachedOffer = { source: offer, snapshot };
    return snapshot;
  }

  #requireServer(id: string): {
    readonly file: SubspaceServersFile;
    readonly server: SubspaceSavedServer;
  } {
    const file = this.store.readServers();
    const server = file.servers.find((s) => s.id === id);
    if (server === undefined) {
      throw codedError("unknown-subspace-server", "Unknown Subspace server");
    }
    return { file, server };
  }

  #clientFor(server: SubspaceSavedServer): SubspaceClient {
    const existing = this.#clients.get(server.id);
    if (existing !== undefined) return existing;
    return this.#attachClient(server);
  }

  #updateSavedServer(
    serverId: string,
    updater: (server: SubspaceSavedServer) => SubspaceSavedServer,
  ): void {
    const current = this.store.readServers();
    let updatedServer: SubspaceSavedServer | null = null;
    const servers = current.servers.map((s) => {
      if (s.id !== serverId) return s;
      const next = updater(s);
      updatedServer = next;
      return next;
    });
    this.store.saveServers({ activeHostId: current.activeHostId, servers });
    if (updatedServer !== null) {
      this.#clients.get(serverId)?.updateServer(updatedServer);
    }
  }

  #attachClient(
    server: SubspaceSavedServer,
    initialTunnel?: ConstructorParameters<typeof SubspaceClient>[2],
  ): SubspaceClient {
    const client = new SubspaceClient(
      server,
      {
        onConnected: (info) => {
          this.#updateSavedServer(server.id, (s) => {
            const nextRelay = info.relay ?? s.relay;
            return {
              ...s,
              ...(nextRelay !== undefined ? { relay: nextRelay } : {}),
              lastConnectedAt: Date.now(),
              lastVersion: info.version,
            };
          });
        },
        onRelayUpdated: (relay) => {
          this.#updateSavedServer(server.id, (s) => ({ ...s, relay }));
        },
      },
      initialTunnel,
      this.#deps.callBridgeIdleMs === undefined
        ? undefined
        : { callBridgeIdleMs: this.#deps.callBridgeIdleMs },
    );
    this.#clients.set(server.id, client);
    return client;
  }

  async #pollRelayLogin(
    authUrl: string,
    relayUrl: string,
    deviceCode: string,
    intervalSec: number,
    expiresAt: number,
    abort: AbortController,
  ): Promise<void> {
    const result = await completeDeviceAuthorization({
      authUrl,
      deviceCode,
      intervalSec,
      expiresAt,
      signal: abort.signal,
    });
    if (abort.signal.aborted || this.#stopped || result.status === "aborted") return;
    if (result.status !== "approved") {
      const error =
        result.status === "expired"
          ? "Verification code expired"
          : result.status === "profile-failed"
            ? "Account approved sign-in, but could not load account profile"
            : result.message;
      this.#deviceFlow = { ...IDLE_FLOW, status: "error", error };
      return;
    }
    this.store.saveRelayAuth({
      authUrl,
      relayUrl,
      token: result.accessToken,
      user: result.user,
      savedAt: Date.now(),
    });
    this.#deviceFlow = { ...IDLE_FLOW, status: "approved" };
    if (
      this.store.readGrants().some(grantSupportsRelay) ||
      (await this.store.loadOrCreateIdentity()).shareMode !== "off"
    ) {
      this.host.startRelay();
    }
  }
}
