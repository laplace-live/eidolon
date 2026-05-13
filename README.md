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
| STT              | [Soniox](https://console.soniox.com/) (`stt-rt-v4`)                       |
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

Other offline tools registered as console scripts:

| Command                      | Source module                              | Purpose                                            |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------- |
| `uv run laplace-pipeline`    | `laplace_eidolon.tools.pipeline`           | End-to-end download → transcribe → refine → ingest |
| `uv run laplace-download`    | `laplace_eidolon.tools.download`           | yt-dlp wrapper for batch VOD fetch                 |
| `uv run laplace-transcribe`  | `laplace_eidolon.tools.transcribe`         | Whisper / Soniox transcription                     |
| `uv run laplace-search`      | `laplace_eidolon.tools.search`             | REPL-style retrieval against the LanceDB index     |
| `uv run laplace-extract-users` | `laplace_eidolon.tools.extract_users`    | Mine danmaku JSON for top usernames                |

The indexes live under `server/data/lancedb/` and are baked into the Docker
image at build time. Re-run ingest then `docker compose build` to pick them up.

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

| Endpoint                                    | What it does                     |
| ------------------------------------------- | -------------------------------- |
| `GET  /`                                    | 302 → `/client/`                 |
| `GET  /client/*`                            | Bundled Pipecat demo UI (static) |
| `POST /api/offer`                           | SmallWebRTC SDP offer → answer   |
| `PATCH /api/offer`                          | Trickle ICE candidates           |
| `POST /start` and `POST /sessions/{id}/...` | RTVI session shim                |

A custom frontend (any framework) talks to `POST /api/offer` directly, or uses
[`@pipecat-ai/client-js`](https://www.npmjs.com/package/@pipecat-ai/client-js)

- [`@pipecat-ai/small-webrtc-transport`](https://www.npmjs.com/package/@pipecat-ai/small-webrtc-transport).

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
