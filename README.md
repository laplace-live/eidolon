# laplace-eidolon

A voice bot for a streamer roleplay persona, with optional RAG over
hand-compiled persona facts and refined past-stream transcripts, and optional
per-viewer long-term memory via Mem0.

The bot is TypeScript on [Bun](https://bun.sh), on its own voice engine, parts of
it ported from [pipedog](https://github.com/polvallverdu/pipedog), a TypeScript
port of [Pipecat](https://docs.pipecat.ai/); it lives in `apps/` and `packages/`,
and has run production since 2026-11-04. The offline chain that builds its indexes
is TypeScript too (`packages/ingest`).

The original Python implementation, a Pipecat bot and its offline tools, stays
in `laplace_eidolon/` as a reference implementation, and CI still publishes it
as `ghcr.io/laplace-live/eidolon-python`. It is no longer developed; how to run
it, and how it differs, is in
[`laplace_eidolon/README.md`](laplace_eidolon/README.md).

```
webrtc in → STT ∥ VAD → Smart Turn → the turn engine:
    RetrievalGate
    ∥ Mem0 (per-viewer memory, optional)
    ∥ StreamArchive (RAG over past streams, optional)
    ∥ PersonaFacts (RAG over hand-compiled streamer facts, optional)
    → LLM → segmenter → TTS → Speaker → webrtc out
```

## Quick start

```bash
npx @laplace.live/eidolon
```

That opens the local web app, which runs on your computer only: a wizard for your Soniox,
OpenRouter and Fish Audio keys (or other providers' for a persona that uses them), the 明前奶绿
demo or a persona of your own built from her prompt, facts and stream videos, a page to call her,
and one that shows what each provider has cost. The terminal prints the link that signs your
browser in. How it works, and how it stays out of a deployed bot, is in
[`docs/web-app.md`](docs/web-app.md).

It needs Node.js 20 or later and brings its own Bun. `npx @laplace.live/eidolon <command>` runs
the [offline commands](#building-the-rag-indexes-optional) without a checkout, and `--help` lists
them. Everything it keeps, settings and keys included, is in the data home, `~/.laplace/eidolon`;
it never reads a `.env`, so set it up in the app or through the environment.

The package reaches npm with the first public release. Until then, and to work on Eidolon, run
it from a checkout:

```bash
bun install
bun run app        # builds the web app when it isn't built, then opens it
```

### Supported platforms

LanceDB and ONNX Runtime, its native parts, decide where it runs:

| Platform | |
| --- | --- |
| macOS on Apple silicon | Yes, with an arm64 Node: an x64 one under Rosetta looks like an Intel Mac |
| Linux on x64 or arm64, with glibc | Yes |
| Intel Macs, musl Linux (Alpine), Windows | No |

The first `npx` downloads about 280 MB, mostly Bun, LanceDB and ONNX Runtime for your platform,
which unpack to about 0.7 GB on a Mac and more on Linux. On Linux x64, npm 11 also runs
onnxruntime-node's install script, which fetches CUDA libraries Eidolon never uses, about 240 MB
from NuGet, and fails the install when NuGet is out of reach. Skip it:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npx @laplace.live/eidolon
```

npm 12 runs no dependency's install script unless you allow it; leave onnxruntime-node's out.

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
Each persona can fill any of these roles with another provider instead: Claude or
DeepSeek on their own APIs or through OpenRouter, ElevenLabs, Cartesia or MiniMax
for her voice, Deepgram for hearing, or an experimental realtime voice model. The
local app keeps an account per key, several of one provider if you have them, and
lists each provider's models as its API offers them
([`docs/providers.md`](docs/providers.md)).

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
take a custom backend URL such as `http://localhost:7860`; the local web app
(`bun run app`) is a separate entry point with its own pages. To hold a scripted
call instead, run `bun apps/bot/scripts/e2e-call.ts --text` (or `--audio`).
How the bot is laid out and what keeps it working is in
[`docs/typescript.md`](docs/typescript.md).

## Building the RAG indexes (optional)

Both `persona_facts` and `stream_archive` no-op gracefully when their LanceDB
tables are missing, so the bot is runnable from a fresh checkout without these.
A persona's sources and its index live in the data home (`~/.laplace/eidolon`,
or `EIDOLON_HOME`), never in git or an image:

```text
~/.laplace/eidolon/sources/<id>/facts/     fact files, one fact per line
~/.laplace/eidolon/sources/<id>/lists/     URL lists, one video per line
~/.laplace/eidolon/personas/<id>/index/    what the ingests build
```

```bash
# Fact files → persona_facts (embeddings reuse OPENROUTER_API_KEY).
bun run laplace-ingest-facts

# Videos → transcripts → refined scenes → stream_chunks and the stream catalog.
# Transcription (Soniox) and refinement (OpenRouter) are billed; --dry-run
# shows what a run would do first.
bun run laplace-pipeline --dry-run ~/.laplace/eidolon/sources/<id>/lists/videos.txt
bun run laplace-pipeline ~/.laplace/eidolon/sources/<id>/lists/videos.txt
```

The offline commands work on the active persona, or the one `--persona <id>`
names. The download stage installs and updates its own yt-dlp; audio over five
hours also needs ffmpeg. Both ingests populate a jieba-tokenized `tokens`
column and build an FTS index on it after embedding, so hybrid search
(vector + Chinese BM25) works at runtime without an extra build step. From
npm, each is `npx @laplace.live/eidolon <command>`, its name without the
`laplace-` prefix: `npx @laplace.live/eidolon pipeline --dry-run`.

| Command                                | Purpose                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `bun run laplace-pipeline`             | Download → transcribe → refine → ingest, resumable; `--dry-run` plans |
| `bun run laplace-download`             | yt-dlp batch download; `--expand` lists a playlist's videos   |
| `bun run laplace-transcribe`           | Soniox async transcription, with the persona's glossary       |
| `bun run laplace-refine`               | Two LLM passes per scene → structured memory records          |
| `bun run laplace-ingest-streams`       | Refined transcripts → `stream_chunks`                         |
| `bun run laplace-ingest-facts`         | Fact files → `persona_facts`                                  |
| `bun run laplace-build-stream-catalog` | Broadcast overviews for date-scoped recall                    |
| `bun run laplace-prepare-batch`        | A series capture's new videos → a batch list                  |
| `bun run laplace-extract-users`        | Mine danmaku JSON for top usernames                           |
| `bun run laplace-search`               | Probe the index on the bot's exact retrieval path             |
| `bun run laplace-eval-retrieval`       | Score retrieval recall@k / MRR against known queries          |
| `bun run laplace-generate-image`       | Prompt + reference images → a PNG (billed)                    |
| `bun run gate-decisions`               | The retrieval gate benchmark (billed)                         |

Each takes `--help` except `gate-decisions`, which takes no arguments and starts
its billed run at once.

A server mounts its own copy of the data home, so a re-ingest reaches it by
copying `index/` there. See [`docs/personas.md`](docs/personas.md).

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
bun run laplace-eval-retrieval --verbose --save ~/.laplace/eidolon/sources/<id>/eval/baseline.json
# ... change something, ingest, re-run ...
bun run laplace-eval-retrieval --compare ~/.laplace/eidolon/sources/<id>/eval/baseline.json
```

Add new queries to the persona's `eval/queries.toml`, beside that baseline,
whenever you discover a question the bot mishandles — the harness becomes more
discriminating with every adversarial example you add.

## Self-host with Docker

CI publishes two images to GHCR, both tagged `edge`, `sha-…`, and per release
`X.Y.Z`, `X.Y` and `X`:

| Image                                 | Dockerfile            | Runs                     |
| ------------------------------------- | --------------------- | ------------------------ |
| `ghcr.io/laplace-live/eidolon`        | `apps/bot/Dockerfile` | the TypeScript bot       |
| `ghcr.io/laplace-live/eidolon-python` | `Dockerfile`          | the Python reference bot |

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

The TypeScript bot (the `eidolon` image) serves neither Pipecat's bundled demo
UI (`/`, `/client`) nor its `/start` session API; the `eidolon-python` image
serves `/start`, and the demo UI only with `EIDOLON_PIPECAT_DEMO_ENABLED`.

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
  origins allowed to call the TypeScript bot; blank allows every origin. The
  `eidolon-python` image always allows every origin.
- **Persistent state**: viewers' long-term memories live in Qdrant, so its
  storage volume is the one thing a restart must not lose; Mem0's change log
  sits beside it. Both images read each persona's index and private references
  from the data home mounted at `/data` (`docker-compose.yml` mounts yours).

## Releasing

Versions and the two changelogs, `apps/bot/CHANGELOG.md` and `apps/eidolon/CHANGELOG.md`, are
managed by [Changesets](https://github.com/changesets/changesets). A user-facing change ships with
a changeset; the Release workflow keeps a version PR open, and merging it tags
`laplace-eidolon@X.Y.Z` and `@laplace.live/eidolon@X.Y.Z`, publishes their GitHub Releases, pushes
both images with the version tags, and, once npm publishing is set up, publishes the npm package.
How, and that one-time setup, is in [`docs/releasing.md`](docs/releasing.md); the rules are in
[`AGENTS.md`](AGENTS.md#shipping-a-change).

## Persona authoring

A persona is a folder: `persona.yaml` (her identity and the settings she
changes), `prompt.md` (the system prompt, re-read on every connection),
`glossary.toml`, and `references/`. The repository ships 明前奶绿's under
`personas/milky-green/`; your own copy under `~/.laplace/eidolon/personas/`
overrides it file by file. The install's settings layer as code defaults <
`settings.yaml` < the environment, a persona's as code defaults < the environment
< her `persona.yaml`, with keys in `credentials.json`; every field is in
[`docs/personas.md`](docs/personas.md#layers). For richer detail beyond the
always-on system prompt, add atomic facts, one per line, to the persona's fact
files in `~/.laplace/eidolon/sources/<id>/facts/` and re-run
`bun run laplace-ingest-facts`.

## License

Eidolon is licensed under version 3 of the GNU Affero General Public License
([`LICENSE`](LICENSE)). The third-party code and data it includes, the code ported from pipedog,
jieba's dictionary, the Silero VAD and Smart Turn models and the Geist font, keep their own
licenses, in [`NOTICE`](NOTICE).

## References

- [pipedog](https://github.com/polvallverdu/pipedog) — the TypeScript Pipecat port the voice
  engine is ported from
- [Pipecat docs](https://docs.pipecat.ai/)
- [Pipecat client SDK (JS)](https://docs.pipecat.ai/client/js/introduction)
- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
