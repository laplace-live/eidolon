# laplace-eidolon

A Pipecat voice bot for a streamer roleplay persona, with optional RAG over
hand-compiled persona facts and refined past-stream transcripts, and optional
per-viewer long-term memory via Mem0.

```
transport.input → STT → user_aggregator
    → Mem0 (per-viewer memory, optional)
    → PersonaFacts (RAG over hand-compiled streamer facts, optional)
    → StreamArchive (RAG over past streams, optional)
    → LLM → TTS → transport.output → assistant_aggregator
```

## Stack

| Layer            | Service                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| STT              | [Soniox](https://console.soniox.com/) (`stt-rt-v5`)                       |
| LLM              | [OpenRouter](https://openrouter.ai/) (default `openai/gpt-4o-2024-11-20`) |
| TTS              | [Fish Audio](https://fish.audio/app/) (`s2-pro`, WebSocket)               |
| Transport        | SmallWebRTC (Pipecat, self-hosted)                                        |
| Vector store     | LanceDB (local file, embeddings via OpenRouter)                           |
| Long-term memory | [Mem0](https://app.mem0.ai/) (optional)                                   |

No Daily, no telephony, no Pipecat Cloud — this repo is wired for self-hosting
behind your own reverse proxy.

## Local development

```bash
uv sync                                # install runtime deps + laplace_eidolon package
uv sync --extra tools                  # add faster-whisper + soniox CLI for ingest
cp .env.example .env                   # fill in SONIOX_API_KEY, OPENROUTER_API_KEY,
                                       # FISH_API_KEY, FISH_VOICE_ID, MEM0_API_KEY...
uv run python -m laplace_eidolon.bot   # boots the dev runner on localhost:7860
```

The bot uses `python -m` rather than a `laplace-bot` console script because
Pipecat's runner discovers the `bot()` function via `sys.modules["__main__"]`,
which a console-script entry doesn't satisfy. All offline tools (below) ship
as proper console scripts.

Open http://localhost:7860/client for the bundled Pipecat demo UI (good
for end-to-end testing while the custom `frontend/` is being built).

## Building the RAG indexes (optional)

Both `persona_facts` and `stream_archive` no-op gracefully when their LanceDB
tables are missing, so the bot is runnable from a fresh checkout without these.

```bash
uv sync --extra tools

# Refine raw stream transcripts → JSON sidecars (uses OPENROUTER_API_KEY).
uv run laplace-refine

# Build the LanceDB indexes.
uv run laplace-ingest-streams   # → data/lancedb/stream_chunks.lance
uv run laplace-ingest-facts     # → data/lancedb/persona_facts.lance
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
| `uv run laplace-extract-users`   | `laplace_eidolon.tools.extract_users`      | Mine danmaku JSON for top usernames                |

The indexes live under `server/data/lancedb/` and are baked into the Docker
image at build time. Re-run ingest then `docker compose build` to pick them up.

### Retrieval pipeline

Each runtime turn flows through this when `persona_facts` / `stream_archive`
are enabled:

1. **Build a query** from the last few user turns
   ([`retrieval.build_query_text`](laplace_eidolon/retrieval.py)). Short voice
   utterances ("嗯, 那呢？") get rescued by prior context.
2. **Embed the query** once with `EMBED_MODEL` (default Gemini, 3072-dim).
3. **Date pre-filter** (persona_facts only). If the query mentions a date
   (`2026年5月9日` / `5月9号` / `2024年3月`), narrow the candidate pool with a
   SQL where-clause on the `date` column before scoring.
4. **Hybrid search** (vector + jieba-tokenized BM25/FTS) pulls
   `PERSONA_FACTS_CANDIDATES` (default 30) or `STREAM_ARCHIVE_CANDIDATES`
   (default 15) candidates. Stopwords are stripped from the FTS query side
   ("你", "什么", "了") to prevent BM25 score collapse on common tokens.
5. **Optional cross-encoder rerank**. With `COHERE_API_KEY` set,
   Cohere `rerank-v4.0-fast` re-scores down to `top_k` (8 for facts,
   3 for chunks). Without the key, LanceDB's default RRF fusion is used —
   strongly recommended at ~10k+ rows; ~$1/1000 reranks in production.

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

```bash
docker compose up --build
```

That builds the image from `Dockerfile`, copies in `laplace_eidolon/`,
`persona.md`, and any LanceDB indexes you've built, and runs:

```
uv run python -m laplace_eidolon.bot --host 0.0.0.0 --port 7860
```

The container exposes port `7860`. Endpoints worth knowing:

| Endpoint                                    | What it does                                |
| ------------------------------------------- | ------------------------------------------- |
| `GET  /`                                    | 302 → `/client/`                            |
| `GET  /client/*`                            | Bundled Pipecat demo UI (static)            |
| `POST /api/offer`                           | SmallWebRTC SDP offer → answer              |
| `PATCH /api/offer`                          | Trickle ICE candidates                      |
| `POST /start` and `POST /sessions/{id}/...` | RTVI session shim                           |
| `GET  /api/memories`                        | List the caller's Mem0 memories (auth req.) |
| `POST /api/memories/forget`                 | Wipe the caller's Mem0 memories (auth req.) |
| `POST /mcp/`                                | Public MCP server (Streamable HTTP, read-only) |

A custom frontend (any framework) talks to `POST /api/offer` directly, or uses
[`@pipecat-ai/client-js`](https://www.npmjs.com/package/@pipecat-ai/client-js)

- [`@pipecat-ai/small-webrtc-transport`](https://www.npmjs.com/package/@pipecat-ai/small-webrtc-transport).

See [`docs/frontend-loading-state.md`](docs/frontend-loading-state.md) for how
to surface backend pipeline state (transcribing / thinking / speaking) in the
custom client — uses the RTVI events the bot already emits.

See [`docs/memory-admin.md`](docs/memory-admin.md) for the per-viewer Mem0
admin endpoints (`GET /api/memories`, `POST /api/memories/forget`) — both
authenticated with the same `loginSyncToken` the WebRTC offer carries, both
scoped to the caller's own Bilibili UID.

### Public MCP server

The bot also serves a read-only [Model Context Protocol](https://modelcontextprotocol.io)
endpoint (Streamable HTTP) at `POST /mcp/`, exposing two tools over the same
RAG indexes the voice pipeline uses:

| Tool                   | What it searches                                  |
| ---------------------- | ------------------------------------------------- |
| `search_persona_facts` | Hand-compiled facts about the streamer            |
| `search_streams`       | Refined transcripts of past streams               |

Point any MCP client at `https://<your-host>/mcp` (the server canonicalizes to
`/mcp/`; clients that don't follow 307 redirects should use the trailing slash
directly). Access is anonymous by default and rate-limited per client IP
(`EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR`, default 20/h). Send the same
`loginSyncToken` the WebRTC client uses as an `Authorization: Bearer <token>`
header to be rate-limited per Bilibili UID at a higher ceiling
(`EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR`, default 120/h) — the token raises your
throughput only; it unlocks no private data. Both tools no-op gracefully (an
empty result with a `note`) when their LanceDB index hasn't been built.

Behind a reverse proxy, set `EIDOLON_MCP_ALLOWED_HOSTS` to your public
domain(s) so the SDK's DNS-rebinding Host check accepts requests; the proxy
must pass `POST /mcp/` through unbuffered, like `/api/offer`.

### Production checklist

- **HTTPS is required** for `getUserMedia` on anything that isn't `localhost`.
  Put Caddy / nginx / Traefik in front and terminate TLS there. The proxy must
  pass `POST /api/offer` and `PATCH /api/offer` through unchanged (no
  buffering) — these are small JSON requests but the WebRTC handshake
  hangs if they're delayed or rewritten.
- **TURN/STUN**: SmallWebRTC defaults to Google's public STUN
  (`stun:stun.l.google.com:19302`) when the client requests default ICE
  servers via `POST /start`. For users behind symmetric NAT you'll need
  your own TURN server (`coturn` is fine); inject ICE servers from the
  custom frontend.
- **CORS**: the dev runner ships with `allow_origins=["*"]`, which is
  permissive but fine for getting started. Lock it down by adding a custom
  CORS middleware to `pipecat.runner.run.app` before calling `main()` — see
  `laplace_eidolon/bot.py` for the import surface.
- **Persistent state**: nothing the bot writes locally needs to survive a
  restart, but LanceDB indexes do live in the image. To update them
  without a rebuild, mount `data/`, `streams/`, and `persona.md` as
  volumes (commented example in `docker-compose.yml`).

## Persona authoring

Edit `persona.md` — it's loaded as the LLM `system_instruction` on every
connection. Restart the bot to pick up changes. For richer detail beyond
the always-on system prompt, add atomic facts to `data/*设定集.txt` /
`data/*事件集.txt` and re-run `laplace-ingest-facts`.

## References

- [Pipecat docs](https://docs.pipecat.ai/)
- [Pipecat Development Runner guide](https://docs.pipecat.ai/api-reference/server/utilities/runner/guide)
- [Pipecat deployment pattern](https://docs.pipecat.ai/pipecat/deployment/pattern)
- [Pipecat client SDK (JS)](https://docs.pipecat.ai/client/js/introduction)
- [`small-webrtc-prebuilt` source](https://github.com/pipecat-ai/small-webrtc-prebuilt) — reference UI
