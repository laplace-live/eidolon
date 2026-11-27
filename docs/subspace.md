# Subspace (亚空间)

Subspace connects LAPLACE Eidolon Desktop, the local web app (`@laplace.live/eidolon`), and future
mobile clients to a remote Eidolon server. Instead of merging conversations across hosts, switching
the active host in the sidebar targets the entire UI — Home, Call, Studio, Chats, Tasks, Jobs,
Usage, and server Settings — at that remote instance (`activeHostId` in `<data home>/subspace/servers.json`).
When a remote server is active, every conversation row in the sidebar shows an orbit badge
(`data-subspace-chat`).

## Connection modes

- **Direct Network (no account required):** Pairs over LAN, Tailscale, or a custom host using
  `ws://<host>:<port>/v1/subspace`. Intended for single-network or mesh-VPN setups without logging
  into a relay. In the macOS desktop app, LAN endpoints require **System Settings → Privacy & Security → Local
  Network** permission for `LAPLACE Eidolon`.
- **Subspace Relay:** Pairs across NATs and firewalls via `apps/relay` (`@eidolon/relay`), run
  locally with `pnpm relay` or deployed as `ghcr.io/laplace-live/eidolon-relay` from
  [`apps/relay/Dockerfile`](../apps/relay/Dockerfile) via [`.github/workflows/relay.yml`](../.github/workflows/relay.yml)
  (default relay: `https://eidolon-relay.vrp.moe`, configured via `subspace.relayUrl` /
  `EIDOLON_SUBSPACE_RELAY_URL`). Users authenticate via RFC 8628 device authorization against
  `https://id.laplace.live` (`subspace.authUrl` / `EIDOLON_SUBSPACE_AUTH_URL`, or auto-discovered
  from a custom relay's `/healthz`), exchange their session at `/api/auth/token` for short-lived
  JWTs, and connect to the relay. The relay verifies JWTs statelessly against JWKS, checks host
  ownership + X25519 challenge proofs, and splices opaque binary WebSocket frames (`SubspaceHost` ↔
  Relay ↔ `SubspaceClient`), never storing accounts or seeing plaintext payloads.

## End-to-end encryption & multiplexing (`packages/subspace`)

`packages/subspace` (`@eidolon/subspace`) implements the transport, pairing store, UDP call
bridge, and host/client manager. The WebCrypto-only wire protocol under
`packages/subspace/src/protocol/` has zero `node:*` imports so browser and React Native apps can
share it verbatim:

1. **Pairing link / QR:** `eidolon://pair?code=<base64url>` embeds the host's pinned X25519
   public key, endpoint or `relayHostId`, display name, expiry timestamp, and a single-use pairing
   ticket.
2. **Handshake:** Dual-DH X25519 key exchange (`e2ee_hello` / `e2ee_ready`) verified against the
   pinned host public key, deriving directional 256-bit AES-GCM keys, 4-byte IV prefixes, and a
   channel-bound `authBinding` via HKDF-SHA-256 over the handshake transcript.
3. **Framing & mux:** Strictly monotonic 64-bit sequence numbers prevent replay/reordering;
   concurrent `MuxEndpoint` streams carry HTTP/NDJSON requests (`REQ_*`, `RES_*`, `REQ_ABORT`),
   keepalive `PING`/`PONG`, and `CALL_UDP_*` datagrams.
4. **SmallWebRTC audio bridge (`webrtc-bridge.ts`):** Rewrites remote `/api/offer` SDP answers and
   bridges UDP packets between loopback sockets and `MuxEndpoint` `CALL_UDP_*` channels so voice
   calls work even behind strict symmetric NATs.

## Local proxy & desktop isolation

- **Proxy bypass:** Requests to `/api/local/session`, `/api/local/subspace*`, or carrying
  `X-Eidolon-Target: local` always execute against the local computer (`apps/bot/src/local/extension.ts`).
- **Desktop shell safety:** The Electron forwarder passes `X-Eidolon-Target: local` for quit checks
  and version probes; remote `POST /api/local/restart` replies tag `X-Eidolon-Subspace: remote` so
  the shell does not treat a remote restart as a local backend restart; `GET /api/local/tasks`
  carries `X-Eidolon-Subspace-Host` so `TaskWatch` resets its notification baseline cleanly across
  host switches; and `RouteError` offers direct local recovery actions when an active remote server
  is unreachable.

## CLI & self-hosting Relay

- **`pnpm laplace-pair` (`eidolon pair`):** Prints a terminal QR code and pairing link for the
  running local app, or starts a headless local server in the foreground (`--relay`, `--address`,
  `--port`, `--name`, `--rotate`, `--wait`/`--no-wait`, `--json`).
- **`pnpm laplace-subspace` (`eidolon subspace`):** Manages Subspace from the CLI (`status`,
  `login`, `logout`, `grants`, `revoke <id>`, with optional `--relay-url` and `--auth-url`).
- **Relay configuration:** Configure `EIDOLON_RELAY_PUBLIC_URL`, `EIDOLON_RELAY_DB_PATH`,
  `EIDOLON_RELAY_AUTH_ISSUER`, `EIDOLON_RELAY_AUTH_AUDIENCE`, and optional `EIDOLON_RELAY_JWKS_URL`
  (defaults to `<issuer>/.well-known/jwks.json`). Run with `pnpm relay`, `apps/relay/Dockerfile`,
  or `ghcr.io/laplace-live/eidolon-relay` (built by [`.github/workflows/relay.yml`](../.github/workflows/relay.yml),
  tagged `edge`, `sha-…`, and `X.Y.Z` / `X.Y` / `X` on release).
