# laplace-eidolon

A voice bot for a streamer roleplay persona, with optional RAG over
hand-compiled persona facts and refined past-stream transcripts, and optional
per-viewer long-term memory via Mem0.

The bot is TypeScript on [Bun](https://bun.sh), built on
[pipedog](https://github.com/polvallverdu/pipedog), a TypeScript port of
[Pipecat](https://docs.pipecat.ai/); it lives in `apps/` and `packages/`, and
has run production since 2026-11-04. The offline chain that builds its indexes
is Python (`laplace_eidolon/tools/`), as is the original Pipecat bot
(`laplace_eidolon/`), kept as a rollback image until it is retired.

```
transport.input → STT → user_aggregator → RetrievalGate
    → Mem0 (per-viewer memory, optional)
    → StreamArchive (RAG over past streams, optional)
    → PersonaFacts (RAG over hand-compiled streamer facts, optional)
    → LLM → TTS → transport.output → assistant_aggregator
```

## Stack

| Layer            | Service                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| STT              | [Soniox](https://console.soniox.com/) (`stt-rt-v5`)                       |
| LLM              | [OpenRouter](https://openrouter.ai/) (default `~google/gemini-flash-latest`) |
| TTS              | [Fish Audio](https://fish.audio/app/) (`drama-3`, WebSocket)              |
| Transport        | SmallWebRTC, relayed through [Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/) when configured |
| Vector store     | LanceDB (local file, embeddings via OpenRouter)                           |
| Long-term memory | [Mem0](https://docs.mem0.ai/open-source)'s engine, self-hosted over Qdrant (optional) |

Model IDs above are defaults. Every model the project runs — these three plus
the embedding, reranker, and offline refinement models — is declared in one
block at the top of [`.env.example`](.env.example); override any of them there.

No Daily, no telephony, no Pipecat Cloud — this repo is wired for self-hosting
behind your own reverse proxy.

## Local development

```bash
bun install
cp .env.example .env          # fill in SONIOX_API_KEY, OPENROUTER_API_KEY,
                              # FISH_API_KEY, FISH_VOICE_ID...
docker compose up -d qdrant   # optional: backs long-term memory
bun run dev                   # watch mode on localhost:7860; --port to move it
bun run typecheck && bun run lint && bun run test
```

`bun run start` runs it without watch mode. Mem0 is a library inside the bot
process, not a service — the only thing it needs running is Qdrant, and only if
you want long-term memory. Set `MEM0_QDRANT_HOST=localhost` in `.env` to point
the bot at the container above; leave it blank and the bot boots normally with
memory switched off.

The bot serves no UI. The web client is LAPLACE's `/ai` page, whose settings
take a custom backend URL such as `http://localhost:7860`. To hold a scripted
call instead, run `bun apps/bot/scripts/e2e-call.ts --text` (or `--audio`).
How the port is laid out and what keeps it working is in
[`docs/typescript.md`](docs/typescript.md).

The Python bot still runs, for comparison or rollback:

```bash
uv sync                                # runtime deps + laplace_eidolon package
uv run python -m laplace_eidolon.bot   # the same API on localhost:7860
```

## Building the RAG indexes (optional)

Both `persona_facts` and `stream_archive` no-op gracefully when their LanceDB
tables are missing, so the bot is runnable from a fresh checkout without these.
The offline chain is Python:

```bash
uv sync --extra tools

# Refine raw stream transcripts → JSON sidecars (uses OPENROUTER_API_KEY).
uv run laplace-refine

# Build the LanceDB indexes.
uv run laplace-ingest-streams   # → <data home>/personas/milky-green/index/stream_chunks.lance
uv run laplace-ingest-facts     # → <data home>/personas/milky-green/index/persona_facts.lance
```

Both ingest scripts populate a jieba-tokenized `tokens` column and build an
FTS index on it after embedding, so hybrid search (vector + Chinese BM25)
works at runtime without an extra build step.

Other offline tools registered as console scripts:

| Command                          | Source module                              | Purpose                                            |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| `uv run laplace-pipeline`        | `laplace_eidolon.tools.pipeline`           | End-to-end download → transcribe → refine → ingest |
| `uv run laplace-download`        | `laplace_eidolon.tools.download`           | yt-dlp wrapper for batch VOD fetch                 |
| `uv run laplace-transcribe`      | `laplace_eidolon.tools.transcribe`         | Whisper / Soniox transcription                     |
| `uv run laplace-search`          | `laplace_eidolon.tools.search`             | REPL-style retrieval against the LanceDB index     |
| `uv run laplace-eval-retrieval`  | `laplace_eidolon.tools.eval_retrieval`     | Score retrieval recall@k / MRR vs known queries    |
| `uv run laplace-generate-image`  | `laplace_eidolon.tools.generate_image`     | Prompt + reference images → a PNG (billed)         |
| `uv run laplace-extract-users`   | `laplace_eidolon.tools.extract_users`      | Mine danmaku JSON for top usernames                |
| `uv run laplace-export-mem0`     | `laplace_eidolon.tools.export_mem0`        | Dump a pre-migration Mem0 cloud account to JSON    |
| `uv run laplace-import-mem0`     | `laplace_eidolon.tools.import_mem0`        | Load that dump into a Qdrant (idempotent, resumable) |

The query-side tools also exist on the TypeScript bot's own code path, with the
same flags and output: `bun run laplace-search`, `bun run laplace-eval-retrieval`,
`bun run laplace-generate-image`, and `bun run gate-decisions` (the retrieval
gate benchmark).

The indexes live in the persona's folder in the data home (`~/.laplace/eidolon`,
or `EIDOLON_HOME`), never in git or an image: a server mounts its own copy, so
a re-ingest reaches it by copying `index/` there. See
[`docs/personas.md`](docs/personas.md).

### Retrieval pipeline

Each runtime turn flows through this when `persona_facts` / `stream_archive`
are enabled:

1. **Build a query** from the last few user turns. Short voice utterances
   ("嗯, 那呢？") get rescued by prior context.
2. **Embed the query** once with `EMBED_MODEL` (default Gemini, 3072-dim).
3. **Date pre-filter**. If the query mentions a date (`2026年5月9日` / `5月9号` /
   `2024年3月`), narrow the candidate pool with a SQL where-clause on the `date`
   column before scoring.
4. **Hybrid search** (vector + jieba-tokenized BM25/FTS) pulls
   `PERSONA_FACTS_CANDIDATES` (default 30) or `STREAM_ARCHIVE_CANDIDATES`
   (default 15) candidates. Stopwords are stripped from the FTS query side
   ("你", "什么", "了") to prevent BM25 score collapse on common tokens.
5. **Cross-encoder rerank**. `cohere/rerank-4-fast` via OpenRouter
   re-scores down to `top_k` (8 for facts, 3 for chunks), on the same key
   the LLM uses. Set `RERANK_ENABLED=false` to fall back to LanceDB's
   default RRF fusion — worth keeping on at ~10k+ rows, at $0.002/search.

Alongside the search, the retrieval gate asks a small model whether the turn
needs recall at all, and cancels both searches if not — it never delays one;
see [`docs/retrieval-gate.md`](docs/retrieval-gate.md).

To measure how well retrieval is doing on a known set of questions:

```bash
uv run laplace-eval-retrieval --verbose --save data/eval/baseline.json
# ... change something, ingest, re-run ...
uv run laplace-eval-retrieval --compare data/eval/baseline.json
```

Add new queries to `data/eval/queries.toml` whenever you discover a question
the bot mishandles — the harness becomes more discriminating with every
adversarial example you add.

## Self-host with Docker

CI publishes two images to GHCR, both tagged `edge`, `sha-…`, and per release
`X.Y.Z`, `X.Y` and `X`:

| Image                                 | Dockerfile            | Runs                     |
| ------------------------------------- | --------------------- | ------------------------ |
| `ghcr.io/laplace-live/eidolon`        | `apps/bot/Dockerfile` | the TypeScript bot       |
| `ghcr.io/laplace-live/eidolon-python` | `Dockerfile`          | the Python bot (rollback) |

Both listen on port `7860`, read the same `.env`, and keep Mem0's change log
in `/app/data/mem0`. To build from this checkout instead:

```bash
docker compose up --build                # Python bot on :7860, plus Qdrant
docker compose --profile ts up --build   # adds the TypeScript bot on :7861
```

Endpoints worth knowing:

| Endpoint                                    | What it does                                |
| ------------------------------------------- | ------------------------------------------- |
| `GET  /api/ice-servers`                     | ICE servers for the browser (minted Cloudflare TURN credentials) |
| `POST /api/offer`                           | SmallWebRTC SDP offer → answer              |
| `PATCH /api/offer`                          | Trickle ICE candidates                      |
| `POST /api/offer/preflight`                 | Check the anonymous quota before dialing    |
| `GET  /api/selfie/{id}`                     | A picture the `take_selfie` tool rendered   |
| `GET  /api/memories`                        | List the caller's Mem0 memories (auth req.) |
| `POST /api/memories/forget`                 | Wipe the caller's Mem0 memories (auth req.) |
| `POST /mcp`                                 | Public MCP server (Streamable HTTP, read-only) |

The TypeScript bot serves neither Pipecat's bundled demo UI (`/`, `/client`)
nor its `/start` session API. The Python bot serves `/start`, and the demo UI
only with `EIDOLON_PIPECAT_DEMO_ENABLED`.

A custom frontend talks to `POST /api/offer` directly, or uses
[`@pipecat-ai/client-js`](https://www.npmjs.com/package/@pipecat-ai/client-js)
with
[`@pipecat-ai/small-webrtc-transport`](https://www.npmjs.com/package/@pipecat-ai/small-webrtc-transport),
passing it the list from `GET /api/ice-servers`.

See [`docs/frontend-loading-state.md`](docs/frontend-loading-state.md) for how
to surface backend pipeline state (transcribing / thinking / speaking) in the
custom client — uses the RTVI events the bot already emits.

See [`docs/memory-admin.md`](docs/memory-admin.md) for the per-viewer Mem0
admin endpoints (`GET /api/memories`, `POST /api/memories/forget`) — both
authenticated with the same `loginSyncToken` the WebRTC offer carries, both
scoped to the caller's own Bilibili UID.

### Public MCP server

The bot also serves a read-only [Model Context Protocol](https://modelcontextprotocol.io)
endpoint (Streamable HTTP) at `POST /mcp`, exposing two tools over the same
RAG indexes the voice pipeline uses:

| Tool                   | What it searches                                  |
| ---------------------- | ------------------------------------------------- |
| `search_persona_facts` | Hand-compiled facts about the streamer            |
| `search_streams`       | Refined transcripts of past streams               |

Point any MCP client at `https://<your-host>/mcp` (`/mcp/` answers too, with no
redirect either way). Access is anonymous by default and rate-limited per client IP
(`EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR`, default 20/h). Send the same
`loginSyncToken` the WebRTC client uses as an `Authorization: Bearer <token>`
header to be rate-limited per Bilibili UID at a higher ceiling
(`EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR`, default 120/h) — the token raises your
throughput only; it unlocks no private data. Both tools no-op gracefully (an
empty result with a `note`) when their LanceDB index hasn't been built.

Behind a reverse proxy, set `EIDOLON_MCP_ALLOWED_HOSTS` to your public
domain(s) so the DNS-rebinding Host check accepts requests; the proxy must pass
`POST /mcp` through unbuffered, like `/api/offer`.

### Production checklist

- **HTTPS is required** for `getUserMedia` on anything that isn't `localhost`.
  Put Caddy / nginx / Traefik in front and terminate TLS there. The proxy must
  pass `POST /api/offer` and `PATCH /api/offer` through unchanged (no
  buffering) — these are small JSON requests but the WebRTC handshake
  hangs if they're delayed or rewritten.
- **TURN**: set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN`.
  The bot mints short-lived credentials, serves them at `GET /api/ice-servers`,
  and gathers relay candidates only, so neither your server's IP nor the
  viewer's reaches the other side's SDP (media never crosses an HTTP proxy, so
  only a relay hides the origin). Static TURN (coturn and the like) works too,
  through `WEBRTC_TURN_URL`; see `.env.example`.
- **Real client IP**: behind a proxy, set `EIDOLON_REAL_IP_HEADER` (e.g.
  `cf-connecting-ip`), or every viewer shares the proxy's anonymous quota.
- **CORS**: `PIPECAT_ALLOWED_ORIGINS` takes a comma-separated list of the
  origins allowed to call the bot; blank allows every origin. The Python bot
  always allows every origin.
- **Persistent state**: viewers' long-term memories live in Qdrant, so its
  storage volume is the one thing a restart must not lose; Mem0's change log
  sits beside it. Both images read each persona's index and private references
  from the data home mounted at `/data` (`docker-compose.yml` mounts yours).

## Releasing

Versions and `apps/bot/CHANGELOG.md` are managed by
[Changesets](https://github.com/changesets/changesets). A user-facing change
ships with a changeset (`bunx changeset`); the Release workflow keeps a version
PR open, and merging it tags `laplace-eidolon@X.Y.Z`, publishes the GitHub
Release, and pushes both images with the version tags. The rules are in
[`AGENTS.md`](AGENTS.md#shipping-a-change).

## Persona authoring

A persona is a folder: `persona.yaml` (her identity and the settings she
changes), `prompt.md` (the system prompt, re-read on every connection),
`glossary.toml`, and `references/`. The repository ships 明前奶绿's under
`personas/milky-green/`; your own copy under `~/.laplace/eidolon/personas/`
overrides it file by file. Settings layer as code defaults < `settings.yaml` <
`persona.yaml` < the environment, with keys in `credentials.json`; every field
is in [`docs/personas.md`](docs/personas.md). For richer detail beyond the
always-on system prompt, add atomic facts to `data/*设定集.txt` /
`data/*事件集.txt` and re-run `laplace-ingest-facts`.

## References

- [pipedog](https://github.com/polvallverdu/pipedog) — the TypeScript Pipecat port the bot runs on
- [Pipecat docs](https://docs.pipecat.ai/)
- [Pipecat client SDK (JS)](https://docs.pipecat.ai/client/js/introduction)
- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
