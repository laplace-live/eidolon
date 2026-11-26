# Self-hosting

Production runs the TypeScript companion bot (`ghcr.io/laplace-live/eidolon`, built from
[`apps/bot/Dockerfile`](../apps/bot/Dockerfile) on Node 24, port `7860`, data home mounted at
`/data`): viewers chat with and call her there, and local mode and assistant tasks never load
([web-app.md](web-app.md#what-stays-out-of-production)). No Daily, no telephony, and no Pipecat
Cloud — the bot runs behind your own reverse proxy.

## Stack and local development

| Layer | Default service |
| --- | --- |
| STT | [Soniox](https://console.soniox.com/) (`stt-rt-v6`) |
| LLM | [OpenRouter](https://openrouter.ai/) (`~google/gemini-flash-latest`) |
| TTS | [Fish Audio](https://fish.audio/app/) (`drama-3`, WebSocket) |
| Transport | SmallWebRTC, relayed through [Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/) when configured |
| Vector store | LanceDB (local file, embeddings via OpenRouter; [retrieval.md](retrieval.md)) |
| Long-term memory | [Mem0](https://docs.mem0.ai/open-source)'s engine, embedded over Qdrant (optional) |

Model IDs above are defaults declared in [`.env.example`](../.env.example). Any persona can fill a
role with another provider from `packages/providers` ([providers.md](providers.md)). Mem0, the
reranker, the retrieval gate, and both LanceDB indexes degrade quietly when missing, so a fresh
checkout boots without them.

```bash
pnpm install
cp .env.example .env          # fill in SONIOX_API_KEY, OPENROUTER_API_KEY, FISH_API_KEY, FISH_VOICE_ID...
docker compose up -d qdrant   # optional: backs long-term memory (set MEM0_QDRANT_HOST=localhost)
pnpm dev                      # watch mode on :7860 (--port to move it); `pnpm start` without watch
```

Mem0 is a library inside the bot process, not a separate service — only Qdrant needs its own
container, and leaving `MEM0_QDRANT_HOST` blank switches memory off cleanly.

The production bot serves no UI. LAPLACE's `/ai` page accepts a custom backend URL such as
`http://localhost:7860`, while the local web app (`pnpm app`) is a separate entry point
([web-app.md](web-app.md)). To run a scripted call instead, use
`node apps/bot/scripts/e2e-call.ts --text` (or `--audio`).

## Self-hosting with Docker

CI publishes `ghcr.io/laplace-live/eidolon` from `apps/bot/Dockerfile`, tagged `edge`, `sha-…`,
and per release `X.Y.Z`, `X.Y`, and `X`. It listens on port `7860`, reads `.env`, mounts the
persona data home at `/data` (`EIDOLON_HOME=/data`), and writes Mem0's change log to
`/data/mem0/history.db` unless `MEM0_HISTORY_DB_PATH` overrides it (the `bot-ts` compose service
points `MEM0_HISTORY_DB_PATH` at `/var/lib/eidolon/mem0/history.db` on its own volume beside a
read-only `/data` mount, and publishes port `7861` → `7860`). To build and run `bot-ts` locally
from this checkout:

```bash
docker compose --profile ts up --build bot-ts
```

Production keeps `apps/bot/src/local`, `packages/assistant`, `@eidolon/ingest`, and
`@laplace.live/eidolon-sdk` out of its build and import graph (`boundaries.test.ts` and
`biome.json` enforce the fences; [`docker.yml`](../.github/workflows/docker.yml) ignores those
paths).

## HTTP endpoints

The TypeScript bot does not serve Pipecat's bundled demo UI (`/`, `/client`) or its `/start`
session API. Custom clients talk to `POST /api/offer` via [`@laplace.live/eidolon-sdk`](client-sdk.md)
or `@pipecat-ai/client-js` + `@pipecat-ai/small-webrtc-transport` using `GET /api/ice-servers` and
RTVI loading-state events ([frontend-loading-state.md](frontend-loading-state.md)).

| Endpoint | What it does |
| --- | --- |
| `GET /api/ice-servers` | ICE servers for the browser (minted Cloudflare TURN credentials) |
| `POST /api/offer` | SmallWebRTC SDP offer → answer |
| `PATCH /api/offer` | Trickle ICE candidates |
| `POST /api/offer/preflight` | Check anonymous quota before dialing |
| `GET /api/selfie/{id}` | Image rendered by `take_selfie` ([selfies.md](selfies.md)) |
| `GET /api/memories` | List the caller's Mem0 memories (`Authorization: Bearer <loginSyncToken>`; [memory-admin.md](memory-admin.md)) |
| `POST /api/memories/forget` | Wipe the caller's Mem0 memories (`Authorization: Bearer <loginSyncToken>`; [memory-admin.md](memory-admin.md)) |
| `POST /api/chat/*` | Stateless signed text chat when `EIDOLON_CHAT_SECRET` is set ([chat.md](chat.md#production-the-browser-keeps-the-chat)) |
| `POST /mcp` | Public MCP server (Streamable HTTP, read-only) |

## Public MCP server

The bot exposes a read-only [Model Context Protocol](https://modelcontextprotocol.io) endpoint
(Streamable HTTP) at `POST /mcp` (`/mcp/` answers without redirect; `GET /mcp` answers `405`
instead of opening an idle SSE stream):

| Tool | What it searches |
| --- | --- |
| `search_persona_facts` | Hand-compiled facts about the streamer |
| `search_streams` | Refined transcripts of past streams |

Access is anonymous by default and rate-limited per client IP
(`EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR`, default 20/h). Sending the same `loginSyncToken` used on
WebRTC offers as `Authorization: Bearer <token>` switches rate-limiting to per-Bilibili-UID at a
higher ceiling (`EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR`, default 120/h) — it raises throughput only
and unlocks no private data. Both tools return an empty result with a `note` when their LanceDB
table is absent.

Behind a reverse proxy, set `EIDOLON_MCP_ALLOWED_HOSTS` to your public domain(s) for DNS-rebinding
Host validation, and pass `POST /mcp` through unbuffered.

## Identity, quotas, and Mem0

- **Never trust token presence — always `resolveUserContext`**
  (`packages/access/src/user-context.ts`). An unvalidated string would let anyone bypass the
  anonymous quota and spawn a full STT+LLM+TTS pipeline per probe. Validation fails open to
  anonymous, and all callers share one 60 s TTL cache.
- **Branch on `UserContext.isLoggedIn`, never on field truthiness.** `face` is legitimately absent
  for some logged-in viewers.
- **Anonymous viewers skip Mem0 entirely** rather than sharing a `default-user` bucket where their
  memories would cross-pollute every other conversation.
- **Mem0 is self-hosted and runs embedded, not as a service.** `packages/memory` is Eidolon's own
  engine over Qdrant, writing mem0 payloads and `history.db`; no mem0 platform client reaches it.
  Every caller (`createMemoryProvider`, `createMemoryAdmin`) builds its engine from
  `buildMemoryConfig()`.
- **Live Mem0 check:** Unit tests fake Qdrant and both model calls, so after changing
  `packages/memory` or `/api/memories` (`apps/bot/src/memory-admin.ts`), start Qdrant with
  `docker compose up -d qdrant` and round-trip a real `add` → `search` → `deleteAll` through
  `openMemoryEngine(buildMemoryConfig())` (requires an embedding key and an LLM key).

## Production checklist

- **HTTPS and unbuffered proxying:** `getUserMedia` requires HTTPS outside `localhost`. Put Caddy,
  nginx, or Traefik in front with TLS, and disable buffering on `POST /api/offer`, `PATCH /api/offer`,
  `POST /api/chat/*`, and `POST /mcp` so WebRTC handshakes and streams do not hang.
- **TURN:** Set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN` so the bot mints
  short-lived credentials at `GET /api/ice-servers` and gathers relay-only candidates (keeping both
  server and viewer IPs out of SDPs), or configure static TURN via `WEBRTC_TURN_URL` (see
  [`.env.example`](../.env.example)).
- **Real client IP:** Behind a proxy, set `EIDOLON_REAL_IP_HEADER` (e.g. `cf-connecting-ip`), or
  every caller shares the proxy's single IP quota.
- **CORS:** `PIPECAT_ALLOWED_ORIGINS` accepts a comma-separated allowlist for the TypeScript bot;
  blank allows every origin.
- **Persistent state and persona mounts:** Keep Qdrant's storage volume across restarts, mount a
  writable volume for `MEM0_HISTORY_DB_PATH` if `/data` is read-only, and sync each persona's
  `index/` and `references/friends/` per [personas.md](personas.md#deploying-a-persona).
- **Watchtower deploys:** Every push to `master` not ignored by `docker.yml` rebuilds `:edge`, and
  Watchtower restarts production from it, dropping active calls. Merge production-facing changes at
  quiet hours.
