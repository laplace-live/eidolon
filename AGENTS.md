# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`laplace-eidolon` is a voice bot for a streamer RP persona, self-hosted over
SmallWebRTC — no Daily, no telephony, no Pipecat Cloud. Two halves share one
LanceDB instance: a runtime pipeline that answers viewers over WebRTC, and an
offline batch chain that builds the indexes it reads.

```text
transport.input → STT → user_aggregator → RetrievalGate
    → Mem0 → StreamArchive → PersonaFacts → LLM → TTS → transport.output
```

Soniox (STT), OpenRouter (LLM), and Fish Audio (TTS) are required. Everything
else — Mem0, the reranker, the retrieval gate, both RAG indexes — degrades
quietly when its key, table, or vector store is missing, so a fresh checkout
runs.

The runtime is TypeScript on Bun, built on pipedog (a TypeScript port of
Pipecat), in `apps/` and `packages/`; production has run it
(`ghcr.io/laplace-live/eidolon`) since 2026-11-04. The offline chain is Python
(`laplace_eidolon/tools/`). The original Pipecat runtime in `laplace_eidolon/`
stays, as the `eidolon-python` rollback image, until it is retired. Both
runtimes read the same LanceDB and Qdrant collection.

## Repository layout

```text
apps/bot/             the bot: HTTP server, routes, MCP, entry point; apps/cli/ its CLIs
packages/             its subsystems, one Bun workspace package each (docs/typescript.md)
laplace_eidolon/      the Python runtime (rollback only) and the offline chain
  bot.py                pipeline + Starlette app; the process entry point
  offer_middleware.py   rate limit, body normalization, preflight for /api/offer
  user_context.py       loginSyncToken → UserContext via the Workers helper API
  audio_quality.py      per-session Opus bitrate from the offer's audioQuality
  persona_facts.py      RAG FrameProcessor over hand-compiled fan facts
  stream_archive.py     RAG FrameProcessor over refined stream transcripts
  retriever.py          one LanceDB table: handle, stale-reopen, search
  retrieval.py          hybrid search — vector + jieba FTS + optional rerank
  retrieval_gate.py     Jev decides per turn whether both RAG services search
  embeddings.py         embedding client, LanceDB table access, disk cache
  voice_switching.py    the change_voice_style LLM tool and its styles
  image_generation.py   the take_selfie LLM tool, its prompt, and /api/selfie
  mcp_server.py         public read-only MCP server mounted at /mcp
  mem0_local.py         self-hosted Mem0 config — embedded engine over Qdrant
  memory_service.py     Mem0 subclass · memory_admin.py serves /api/memories
  rate_limit.py         per-IP sliding-window quota · env.py numeric env vars
  openrouter.py         attribution headers + usage-cost extraction
  tools/                the offline chain, one console script per stage
personas/<id>/        a persona's template: persona.yaml, prompt.md (the system
                      prompt), glossary.toml, references/outfits/ (what take_selfie
                      redraws, one used per render). Her index and friends/ live
                      in the data home, ~/.laplace/eidolon (docs/personas.md)
data/                 local only, never committed: fact .txt sources, eval/,
                      embed_cache.db
streams/              transcripts <id>.md + <id>.refined.json sidecars (untracked)
vods/                 downloaded audio + .info.json sidecars (untracked)
docs/                 the topics too large to inline here
tests/                pytest — no network, no LanceDB
```

## Where to look

Read the row for what you are about to touch. **Adding a subsystem means adding
a row here and writing the prose there — not a new section in this file.**

| You're touching | Read first |
| --- | --- |
| a comment or a docstring, anywhere | [comments.md](docs/comments.md) |
| `/api/memories`, or wiping a viewer's memories | [memory-admin.md](docs/memory-admin.md) |
| RTVI events the web client listens for | [frontend-loading-state.md](docs/frontend-loading-state.md) |
| per-viewer affection / XP tiers (design only, unbuilt) | [affection-system.md](docs/affection-system.md) |
| the persona's identity, voice, or hard rules | `personas/milky-green/prompt.md` and `persona.yaml` |
| settings files, credentials, the data home, or a persona's folder | [personas.md](docs/personas.md) |
| any env var — all 50-odd are documented there | `.env.example` |
| Soniox's per-project vocabulary glossary | `personas/milky-green/glossary.toml` |
| broadcast overviews, date-scoped recall, or the archive lookup tool | [stream-recall.md](docs/stream-recall.md) |
| the `take_selfie` tool, image generation, or `/api/selfie` | [selfies.md](docs/selfies.md) |
| the retrieval gate, or why a turn skipped LanceDB | [retrieval-gate.md](docs/retrieval-gate.md) |
| anything under `apps/` or `packages/` (the TypeScript bot) | [typescript.md](docs/typescript.md) |

## Commands

The bot:

```bash
bun install
bun run dev                            # watch mode on :7860 (--port to move it); `start` without watch
bun run typecheck && bun run lint && bun run test
bun run laplace-search / laplace-eval-retrieval / laplace-generate-image / gate-decisions
```

The Python side:

```bash
uv sync                                # runtime deps
uv sync --extra tools                  # + faster-whisper, soniox (offline only)
uv run python -m laplace_eidolon.bot   # the Python bot on :7860 — NOT a console script

uv run ruff check .                    # lint — import sorting only, line length 100
uv run pyright                         # types
uv run pytest                          # tests
docker compose up --build              # Python bot + Qdrant; --profile ts adds the TS bot on :7861
```

The Python bot is deliberately not a `laplace-*` console script: Pipecat's runner
discovers `bot()` through `sys.modules["__main__"]`, which a generated launcher
doesn't satisfy. Everything under `tools/` is a console script:

```bash
uv run laplace-pipeline          # download → transcribe → refine → ingest, resumable
uv run laplace-download          # yt-dlp batch fetch → vods/
uv run laplace-transcribe        # soniox (default) or local whisper → streams/*.md
uv run laplace-refine            # LLM cleanup → streams/*.refined.json
uv run laplace-ingest-streams    # → stream_chunks.lance
uv run laplace-ingest-facts      # → persona_facts.lance
uv run laplace-search            # probe the archive on the bot's exact retrieval path
uv run laplace-eval-retrieval    # recall@k / MRR against data/eval/queries.toml
uv run laplace-extract-users     # mine danmaku JSON for glossary.toml terms
uv run laplace-export-mem0       # dump a pre-migration Mem0 cloud account to JSON
uv run laplace-import-mem0       # load that dump into a Qdrant; idempotent, resumable
uv run laplace-generate-image    # prompt + reference images → a PNG, via OpenRouter's image API
```

### Which checks to run

Match the gate to the surface you touched; don't reflexively run everything.

| You changed | Run |
| --- | --- |
| any Python file | `uv run ruff check .` and `uv run pyright` |
| `mcp_server.py`, `rate_limit.py`, or `user_context.py` | `uv run pytest` — the suite covers the MCP mount and its quotas, nothing else |
| retrieval, tokenization, chunking, `top_k`, or `candidates` | `uv run laplace-eval-retrieval` against `data/eval/baseline.json`. A quality claim without a number is not a claim |
| an ingest script, `EMBED_MODEL`, or `EMBED_DIM` | re-run **both** ingests into the persona's `index/`, then copy it to each server's mounted data home |
| the pipeline, the transport, or a monkey-patch | boot the bot and hold a real call (`bun apps/bot/scripts/e2e-call.ts --text`, or `--audio`) — none of this is unit-testable |
| `image_generation.py` | `uv run laplace-generate-image` against a real reference — it shares `generate()` with the bot, so a successful render is the check. Billed per image |
| `retrieval_gate.py`'s questions, state, or threshold, or `RETRIEVAL_GATE_MODEL` | `uv run python docs/benchmarks/2026-09-19-retrieval-gate/decisions.py` — exits non-zero if any labeled turn that needs recall would be skipped |
| `prompt.md`'s 表演提示 markup, or `FISH_MODEL` | `uv run python docs/benchmarks/2026-10-17-drama-3-markup/render.py` (add `--model` for another model) — any `leaked` entry in its results means markup is read aloud. Billed per character |
| `mem0_local.py`, `memory_service.py`, or `memory_admin.py` | `docker compose up qdrant`, then round-trip a real store → search → delete. No test covers Mem0; it needs a live vector store and an embedding key |
| an env var | document it in `.env.example` in the same commit |
| anything under `apps/` or `packages/` | `bun run typecheck`, `bun run lint`, `bun run test`; for retrieval, the gate or the pipeline, the TypeScript CLI or call that matches the Python row above |

## Rules

Things you would break without being told. How any of it *works* is in the
module that owns it.

### Runtime

- **Optional dependencies fail open, never loud.** Mem0, both RAG services, the
  reranker, the retrieval gate, and the LanceDB tables are each wrapped in a
  try/except that logs and continues. A new optional tier follows that shape
  or it breaks fresh checkouts.
- **The retrieval gate may cancel a search, never delay one.**
  `unless_skipped` starts the search at once and drops it only if Jev answers
  "skip" first. Awaiting the gate before searching would add its ~0.5 s to
  every recall turn, and its whole timeout to every turn while Jev is down.
- **`load_dotenv(override=True)` runs before any other import that reads
  `os.getenv`.** Module-level constants evaluate at import time, so a deferred
  load pins them to their fallbacks. This is why `bot.py` has imports below
  statements, and why it is exempt from `from __future__ import annotations`.
- **An empty env var is not unset.** python-dotenv parses `KEY=` as `""`, so
  `int(os.getenv("X", "60"))` crashes on a plain `.env.example` copy. Every
  numeric env read goes through `env.env_int` / `env.env_float`; for strings
  use `os.getenv("X") or "default"`.
- **Pure ASGI middleware, never `BaseHTTPMiddleware`.** Starlette's version
  doesn't catch `BaseException`, so a client disconnect surfaces as a 500, and
  its response hard-codes `background = None`, silently dropping the background
  task that actually starts the bot. `repro_no_response.py` reproduces both.
- **Pipecat exposes no seam for ICE servers or Opus bitrate**, so `bot.py`
  monkey-patches `SmallWebRTCConnection.__init__` and `OpusEncoder.__init__` at
  import. Both are load-bearing; the per-session bitrate reaches the encoder
  through a `ContextVar` set in the offer middleware.
- **With TURN configured, the server gathers relay candidates only** — a third
  monkey-patch, on `aiortc.rtcicetransport.connection_kwargs`. It keeps the
  origin's IP out of every SDP, which the Cloudflare proxy cannot do because
  media never traverses it. `TransportPolicy.RELAY` suppresses only the host
  candidate, so the patch also drops the STUN server; restoring it re-exposes
  the origin through a server-reflexive candidate.
- **`install_mcp` is not idempotent** — it wraps the app lifespan, and a second
  call makes `session_manager.run()` raise at startup. Same for
  `install_offer_middleware`, `install_memory_admin`, and
  `install_selfie_route`: once each, at startup.
- **`OpenRouterImageGenService` must never go in the pipeline.** The
  `ImageGenService` base it inherits generates an image from every `TextFrame`
  it sees, and this pipeline streams one per sentence into TTS — adding it to
  `Pipeline([...])` bills an image per sentence spoken. The `take_selfie`
  handler calls `run_image_gen` directly instead. See
  [selfies.md](docs/selfies.md).
- **The persona's reference images are mutually exclusive outfits — exactly
  one reaches a render.** Hand the model two and it draws two of her: a group
  selfie with one friend came back with three people in frame. `select_outfit`
  picks one by the hour, behind `reference_sources`, the choke point the bot
  and `laplace-generate-image` share.

### The TypeScript bot

- **Only `packages/runtime` imports `@pipedog/*`.** Biome enforces it; every
  other package must stay usable without a pipeline.
- **`load-env.ts` is the only `.env` reader.** `bunfig.toml` sets `env = false`
  and tests pass `--no-env-file`; no module reads env at import.
- **The werift patches in `packages/runtime/src/webrtc/handler.ts` are
  load-bearing** — no default STUN server, disconnect on DTLS close, relay-only,
  the `raddr` scrub. Each one's failure mode is in [typescript.md](docs/typescript.md).
- **Python is the behavioral spec until it is retired.** A golden fixture that fails
  means the port drifted; fix the port, not the fixture.

### Identity and quotas

- **Never trust token presence — always `resolve_user_context`.** An
  unvalidated string would let anyone skip the anonymous quota and spawn a full
  STT+LLM+TTS pipeline per probe. Validation fails open to anonymous, and every
  caller shares one 60s TTL cache.
- **Branch on `UserContext.is_logged_in`, never on field truthiness.** `face` is
  legitimately absent for some logged-in viewers.
- **Anonymous viewers skip Mem0 entirely** rather than sharing a `default-user`
  bucket, where their memories would cross-pollute every other conversation.
- **Mem0 is self-hosted and runs embedded, not as a service.** `MemoryClient`
  cannot reach it: it demands a cloud key and validates it against a
  `/v1/ping/` only the platform serves. Every caller — the pipeline and
  `/api/memories` alike — builds its engine from
  `mem0_local.build_local_config()`, so a new one does too.
- **Behind a proxy, set `EIDOLON_REAL_IP_HEADER`** or every caller rate-limits
  as the proxy's single IP.

### Retrieval

- **Ingest-time and query-time vectors must come from the same model and
  dimension.** Changing `EMBED_MODEL` or `EMBED_DIM` means re-running both
  ingest scripts; the LanceDB schema is fixed-size and old vectors are not
  comparable to new ones. Mem0's Qdrant collection reads the same two vars
  and pins its dimension at creation, so it also needs a new
  `MEM0_QDRANT_COLLECTION` — and viewers' memories do not survive that.
- **FTS runs over the jieba-tokenized `tokens` column, never raw text.** LanceDB
  ships no CJK tokenizer, so both ingest scripts populate `tokens` and every
  query goes through `retrieval.tokenize_zh_query`. Stopwords are stripped from
  queries only — stripping them from the index collapses BM25.
- **A persona's index is never committed.** It lives in the data home
  (`personas/<id>/index/`), and a deployment mounts it at `/data`; the images
  carry only the templates. A re-ingest reaches production by copying the index
  to the server, not by pushing.
- **`retrieval.py` is the one search path.** The bot, the MCP server, and
  `laplace-eval-retrieval` all go through it, so what the eval scores is what
  the bot runs. Keep it that way. The first two reach it via
  `retriever.LanceRetriever`, which adds only the table handle and the
  stale-reopen retry — never scoring.

### The persona

- **Persona edits go in `prompt.md` and `persona.yaml`, not in code.** `_build_persona_prefix`
  layers only per-session facts on top — current date, viewer name, recent
  stream dates, available voice styles.
- **The Chinese prompt text is load-bearing.** The 不要主动念 lines are what stop
  the model narrating the clock and reading UIDs aloud, and the wording tracks
  `prompt.md`'s vocabulary. Don't paraphrase it in passing.
- **`change_voice_style` is named once, as `_TOOL_NAME` in
  `voice_switching.py`.** It reaches the prompt through `persona_prefix_hint`,
  not through `prompt.md` — rename it in that one place.
- **Settings come in layers:** code defaults < `settings.yaml` < `persona.yaml` <
  the environment, and secrets only in `credentials.json` or the environment.
  A new setting adds its row to `SETTINGS` (`packages/config/src/settings.ts`)
  and to [personas.md](docs/personas.md), with the variable that configures it;
  a test holds the two in step.
- **A template under `personas/` is published.** Never add an index, a friend
  image, or anything a viewer said to one; those belong in the data home.

### Shipping a change

- **Every user-facing change ships with a changeset in the same commit** — add
  it yourself, unasked, for the Python and the TypeScript bot alike:
  `bunx changeset add --minor laplace-eidolon -m "feat: Remember a viewer's nickname"`.
  `--minor` for features and substantial behavior changes, `--patch` for fixes
  and small changes. Start with `feat:`/`fix:`/`perf:`/`chore:`, then one
  capitalized plain sentence under ~80 chars, written for users; the prefix is
  stripped and the rest ships as the GitHub Release notes. No changeset for CI,
  docs, tests, dev-only tooling, or refactors nobody notices. `laplace-eidolon`
  (`apps/bot`) is the only released package; `@eidolon/*` are ignored.
- **A push to `master` is a production deploy.** CI rebuilds `:edge`, and
  Watchtower on the production host restarts the bot from it, dropping live
  calls. Pushes that only touch docs, tests, changesets or `AGENTS.md` skip the
  image build (`paths-ignore` in `docker.yml`); anything else, `personas/`
  included, ships.
- **Never bump a version, push a release tag, or hand-edit `CHANGELOG.md`.**
  Merging the Release workflow's version PR bumps `apps/bot/package.json`,
  copies it into `pyproject.toml`, `uv.lock`, `bot.py` and `rtvi.ts`
  (`apps/bot/scripts/sync-version.ts`), and tags `laplace-eidolon@<version>`,
  which builds the image tagged `<version>`, `<major>.<minor>` and `<major>`.
- **Fix defects you can trigger; don't harden against ones you can't.** Before
  adding a guard — including for a review finding — name the input or sequence
  that produces the failure against the code as it stands. No trigger means
  you're shipping the guard, not a fix. Same for indirection and config knobs:
  no second caller, no abstraction.
- **Upstream-dependency bugs get a citation comment, not a silent workaround.**
- **`@mcp.tool()` docstrings and `Field(description=...)` strings are live API
  surface** — FastMCP ships them to the model. Editing one changes runtime
  behavior. See [comments.md](docs/comments.md).

### Style

- `from __future__ import annotations` at the top of every module. The
  exceptions are `bot.py` and the two `__init__.py` files.
- PEP 604/585 syntax: `str | None`, `dict[str, Any]`, `list[float]`.
- Type hints on everything. They carry the load that docstrings otherwise would.
- Line length 100. Ruff enforces import sorting and pyflakes
  (`select = ["I", "F"]`) and nothing else, so the rest is on you.

## Comments

Sparse and terse — a long comment is worse than no comment. Full policy, with
worked keep/delete examples, in [comments.md](docs/comments.md).

- **Write one only if it is** external behavior (an upstream bug or SDK
  contract — link it), a measured number nobody can re-derive from the code, a
  trap where tidying the line causes a bug, or one or two sentences of
  orientation at module top. Explain *why*, never *what*.
- **The dividing line:** a comment about something outside this repo can be a
  paragraph; one about this repo's own structure gets a sentence, or nothing.
- **Banned:** banner dividers, `What lives here:` indexes, `Why X and not Y`
  sections, changelog narration (`we used to`, `the old X`), `Usage::`
  transcripts, commented-out code, pinned upstream versions and endpoint paths,
  tutorial comments on stdlib behavior.
- **Never touch** `# type: ignore`, `# noqa`, `TODO`/`FIXME`, or license
  headers. When cleaning comments, change only comments.

## Editing these instructions

`CLAUDE.md` is a symlink to `AGENTS.md` — **edit the real file.**

**This file is a router, not an encyclopedia.** It carries rules — the things
you'd break without being told — plus the table that says where everything else
lives. How a subsystem *works* belongs in [docs/](docs/) or in the module that
owns it, because that content grows with the project and otherwise every task
pays to load it. So: a new subsystem adds a **row**, not a section; a rule that
needs a paragraph to justify itself keeps its one-line form here and puts the
paragraph in its doc. Each rule must stand alone — a reader who never follows
the link should still not break anything.
