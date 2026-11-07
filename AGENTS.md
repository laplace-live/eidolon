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
(`ghcr.io/laplace-live/eidolon`) since 2026-11-04. The offline chain is
TypeScript too: `packages/ingest`, run through the `laplace-*` commands in
`apps/cli`. The original Pipecat runtime in `laplace_eidolon/` stays, as the
`eidolon-python` rollback image, until it is retired, and its offline tools
(`laplace_eidolon/tools/`) with it, as the spec the port is checked against.
Both runtimes read the same LanceDB and Qdrant collection. The local web app and
the offline commands also ship as the npm package `@laplace.live/eidolon`
(`apps/eidolon`), which runs them, bundled, on the Bun it installs.

## Repository layout

```text
apps/bot/             the bot: HTTP server, routes, MCP, entry point; src/local/ is the
                      local web app's own entry and API, which production never loads
apps/web/             the local web app's pages (Vite, React, shadcn), served by src/local/
apps/cli/             every laplace-* command, the offline chain's included
apps/eidolon/         the npm package @laplace.live/eidolon: a Node launcher, and a build that
                      bundles the local app and the CLI with the web app, templates and jieba
packages/             subsystems, one Bun workspace package each (docs/typescript.md);
                      packages/ingest is the offline chain
laplace_eidolon/      the Python runtime (rollback only) and its offline chain (the spec)
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
  tools/                the Python offline chain, one console script per stage
personas/<id>/        a persona's template: persona.yaml, prompt.md (the system
                      prompt), glossary.toml, references/outfits/ (what take_selfie
                      redraws, one used per render). Her index, friends/ and
                      sources live in the data home, ~/.laplace/eidolon
                      (docs/personas.md)
data/                 local only, never committed: generated/ (laplace-generate-image)
streams/, vods/       empty: the Python tools' old defaults. A persona's sources are in
                      ~/.laplace/eidolon/sources/<id>/
.agents/skills/       agent skills; stream-archive-embed syncs new stream replays
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
| settings files, credentials, the data home, a persona's folder or its sources | [personas.md](docs/personas.md) |
| the offline chain (`packages/ingest` and its `laplace-*` commands) or their `--json` events | [typescript.md](docs/typescript.md#the-offline-chain) |
| the local web app (`apps/web`, `apps/bot/src/local`): local mode, its API, jobs or security | [web-app.md](docs/web-app.md) |
| changesets, the version PR, tags, or publishing the npm package (`apps/eidolon`) | [releasing.md](docs/releasing.md) |
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

The local web app, on loopback only ([web-app.md](docs/web-app.md)):

```bash
bun run app                            # builds apps/web/dist if missing, then `local --open`
bun run local                          # the local entry; prints the link that signs a browser in
bun run dev:local                      # its server alone, under --watch; --no-open, or each reload opens a tab
bun run dev:web                        # Vite on 127.0.0.1:5173, proxying to :7860; open /#<code>
bun run build:web                      # apps/web/dist
```

The offline chain, each command taking `--persona <id>` and working in that
persona's folders in the data home (`--json` reports NDJSON events on stdout):

```bash
bun run laplace-pipeline <url list>    # download → transcribe → refine → ingest → catalog, resumable
bun run laplace-pipeline --dry-run     # plans every video the persona's sources know; writes nothing
bun run laplace-download <url list>    # yt-dlp → vods/, installing its own yt-dlp; --expand <url>
bun run laplace-transcribe <audio>     # Soniox async → streams/<date>-<id>.md
bun run laplace-refine                 # LLM cleanup → streams/*.refined.json
bun run laplace-ingest-streams         # → stream_chunks.lance
bun run laplace-ingest-facts           # facts/ → persona_facts.lance
bun run laplace-build-stream-catalog   # → stream_catalog.json
bun run laplace-prepare-batch          # a series capture's new videos → lists/batches/
bun run laplace-extract-users          # mine danmaku JSON for glossary.toml terms
```

The npm package, `@laplace.live/eidolon` ([releasing.md](docs/releasing.md)):

```bash
bun run build:npm                      # stages it in apps/eidolon/pack/: bundles, web app, templates
bun run pack:npm                       # stages it, then packs apps/eidolon/laplace.live-eidolon-<version>.tgz
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
doesn't satisfy. Everything under `tools/` is one, named like its TypeScript
command (`uv run laplace-pipeline`, …). Those are the spec the port is checked
against, and still default to the checkout's `data/`, `streams/` and `vods/`,
which no longer hold any sources. Two exist only in Python:

```bash
uv run laplace-export-mem0       # dump a pre-migration Mem0 cloud account to JSON
uv run laplace-import-mem0       # load that dump into a Qdrant; idempotent, resumable
```

### Which checks to run

Match the gate to the surface you touched; don't reflexively run everything.

| You changed | Run |
| --- | --- |
| any Python file | `uv run ruff check .` and `uv run pyright` |
| `mcp_server.py`, `rate_limit.py`, or `user_context.py` | `uv run pytest` — the suite covers the MCP mount and its quotas, nothing else |
| retrieval, tokenization, chunking, `top_k`, or `candidates` | `bun run laplace-eval-retrieval --compare ~/.laplace/eidolon/sources/<id>/eval/baseline.json`. A quality claim without a number is not a claim |
| an ingest, `EMBED_MODEL`, or `EMBED_DIM` | re-run **both** ingests (`bun run laplace-ingest-streams`, `laplace-ingest-facts`) into the persona's `index/`, then copy it to each server's mounted data home with the rsync in [personas.md](docs/personas.md#deploying-a-persona) |
| anything under `packages/ingest`, an offline command in `apps/cli`, or the write side of `packages/retrieval` | the gates below, then the stage's real-data test with `EIDOLON_REQUIRE_PARITY=1 bun test --no-env-file <file>`: `packages/ingest/test/*_real.test.ts` (streams, download, transcribe, refine, ingest_streams, pipeline), `apps/cli/test/ingest_facts_real.test.ts`, `packages/retrieval/test/write_real.test.ts`. They are free and only read `~/.laplace/eidolon` (`EIDOLON_REAL_HOME`); refine's and the pipeline's need `uv`. Without the variable a missing corpus skips silently |
| the bot's pipeline, the transport, or a monkey-patch | boot the bot and hold a real call (`bun apps/bot/scripts/e2e-call.ts --text`, or `--audio`) — none of this is unit-testable |
| `image_generation.py` | `uv run laplace-generate-image` against a real reference — it shares `generate()` with the bot, so a successful render is the check. Billed per image |
| `retrieval_gate.py`'s questions, state, or threshold, or `RETRIEVAL_GATE_MODEL` | `uv run python docs/benchmarks/2026-09-19-retrieval-gate/decisions.py` — exits non-zero if any labeled turn that needs recall would be skipped |
| `prompt.md`'s 表演提示 markup, or `FISH_MODEL` | `uv run python docs/benchmarks/2026-10-17-drama-3-markup/render.py` (add `--model` for another model) — any `leaked` entry in its results means markup is read aloud. Billed per character |
| `mem0_local.py`, `memory_service.py`, or `memory_admin.py` | `docker compose up qdrant`, then round-trip a real store → search → delete. No test covers Mem0; it needs a live vector store and an embedding key |
| an env var | document it in `.env.example` in the same commit |
| anything under `apps/` or `packages/` | `bun run typecheck`, `bun run lint`, `bun run test`; for retrieval, the gate or the bot's pipeline, the TypeScript CLI or call that matches the Python row above |
| anything under `apps/web` | the row above, whose typecheck also runs both `apps/web` tsconfigs, then `bun run build:web` |
| local mode (`apps/bot/src/local`) | `bun test --no-env-file apps/bot/test/local` from the repository root, then `bun apps/bot/scripts/local-smoke.ts --headful`: a browser walk on a temporary data home that bills nothing |
| `apps/eidolon`, or a file the package bundles or copies | the gates above, then `bun run pack:npm` and `bun apps/eidolon/scripts/ci-install-check.ts apps/eidolon/<tarball>`, which CI runs on Linux x64: it installs the tarball with npm, boots it on a temporary home, signs in, and stops it |

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
  and tests pass `--no-env-file`; no module reads env at import. It walks up to
  the first `.env`, which from a worktree is the outer checkout's, real keys
  included; `EIDOLON_NO_DOTENV=1` skips it.
- **Production never runs local mode.** `main.ts` and the code it loads never
  import `apps/bot/src/local/` (Biome and `boundaries.test.ts` hold it), and
  nothing but that separate entry turns it on: no flag, setting or env var,
  which a server's mounted `settings.yaml` could flip.
- **The werift patches in `packages/runtime/src/webrtc/handler.ts` are
  load-bearing** — no default STUN server, disconnect on DTLS close, relay-only,
  the `raddr` scrub. Each one's failure mode is in [typescript.md](docs/typescript.md).
- **Python is the behavioral spec until it is retired.** A golden fixture that fails
  means the port drifted; fix the port, not the fixture.
- **Run `bun test` from the repository root only.** Elsewhere `bunfig.toml`'s preload is
  skipped and the data home is the real one, so a test file that deletes in it imports
  `packages/config/test/isolated-guard.ts` first, and `isolated-guard.test.ts` enforces that.
- **Never find a shipped file through `import.meta`.** The npm package runs bundles, where every
  module's folder is `dist/`. A file the code ships with (a template, the web build, jieba's
  data, an entry to spawn) resolves through `shippedPath` in `@eidolon/config`, under the
  launcher's `EIDOLON_APP_ROOT` or else the checkout, and `apps/eidolon`'s build copies it in.

### The offline chain

- **`@eidolon/ingest` never reaches the bot image.** Biome forbids importing it
  outside `packages/ingest` and `apps/cli`, because `docker.yml` skips the image
  build for changes to those two; lift both together.
- **Under `--json`, stdout carries NDJSON events only**, read line by line by
  whatever spawned the command. Library code reports through `onProgress` and
  the logger (stderr) and never writes to stdout; the `apps/cli` command owns
  printing, the locks and the exit code.
- **Real-data tests never write to the data home.** They read
  `EIDOLON_REAL_HOME` (`~/.laplace/eidolon`), write to temporary folders, clone
  the embedding cache, and fake every paid request. `EIDOLON_REQUIRE_PARITY=1`
  turns their skips into failures.

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
  ingests; the LanceDB schema is fixed-size and old vectors are not
  comparable to new ones. Mem0's Qdrant collection reads the same two vars
  and pins its dimension at creation, so it also needs a new
  `MEM0_QDRANT_COLLECTION` — and viewers' memories do not survive that.
- **FTS runs over the jieba-tokenized `tokens` column, never raw text.** LanceDB
  ships no CJK tokenizer, so both ingests populate `tokens` and every
  query goes through `retrieval.tokenize_zh_query`. Stopwords are stripped from
  queries only — stripping them from the index collapses BM25.
- **A persona's index is never committed.** It lives in the data home
  (`personas/<id>/index/`), and a deployment mounts it at `/data`; the images
  carry only the templates. A re-ingest reaches production by copying the index
  to the server, not by pushing, and only with `rsync --checksum --delete-after
  --delay-updates`: a plain copy leaves the MCP server on the old tables until a
  restart, and calls that start mid-copy get no recall
  ([personas.md](docs/personas.md#deploying-a-persona)).
- **A persona's sources are never committed or deployed, and the ingest needs
  all of them.** Fact files, URL lists, audio and transcripts live in
  `<data home>/sources/<id>/`, which the bot never reads. `laplace-ingest-streams`
  rebuilds the whole `stream_chunks` table from every transcript in `streams/`,
  so a transcript missing there drops its stream from the index
  ([personas.md](docs/personas.md#a-personas-sources)).
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
- **Settings come in layers:** an app setting is code defaults < `settings.yaml`
  < the environment, a persona's is code defaults < the environment < her
  `persona.yaml`, and the environment's `FISH_VOICE_ID_<STYLE>` voices skip a
  persona with her own voice. Secrets go only in `credentials.json` or the
  environment. A new setting adds its row to `SETTINGS` (`packages/config/src/settings.ts`)
  and to [personas.md](docs/personas.md), with the variable that configures it;
  a test holds the two in step.
- **A template under `personas/` is published.** Never add an index, a source
  file, a friend image, or anything a viewer said to one; those belong in the
  data home.

### Shipping a change

- **Every user-facing change ships with a changeset in the same commit** — add
  it yourself, unasked, for the Python and the TypeScript bot alike:
  `bunx changeset add --minor laplace-eidolon,@laplace.live/eidolon -m "feat: Remember a viewer's nickname"`.
  `--minor` for features and substantial behavior changes, `--patch` for fixes
  and small changes. Start with `feat:`/`fix:`/`perf:`/`chore:`, then one
  capitalized plain sentence under ~80 chars, written for users; the prefix is
  stripped and the rest ships as the GitHub Release notes. No changeset for CI,
  docs, tests, dev-only tooling, or refactors nobody notices. `laplace-eidolon`
  (`apps/bot`) and the npm package `@laplace.live/eidolon` (`apps/eidolon`) are
  released together at one version, so name both: each changelog lists only the
  changesets naming it. `@eidolon/*` are ignored.
- **A push to `master` is a production deploy.** CI rebuilds `:edge`, and
  Watchtower on the production host restarts the bot from it, dropping live
  calls. Pushes that only touch docs, tests, changesets, `AGENTS.md`, `.agents/`,
  the offline chain (`apps/cli`, `packages/ingest`), the local web app
  (`apps/web`, `apps/bot/src/local`) or the npm package (`apps/eidolon`) skip the
  image build (`paths-ignore` in `docker.yml`); anything else, `personas/`
  included, ships.
- **Never bump a version, push a release tag, hand-edit `CHANGELOG.md`, or
  publish to npm.** Merging the Release workflow's version PR bumps
  `apps/bot/package.json` and `apps/eidolon/package.json`, copies the version
  into `pyproject.toml`, `uv.lock`, `bot.py` and `rtvi.ts`
  (`apps/bot/scripts/sync-version.ts`), and tags `laplace-eidolon@<version>`,
  which builds the image tagged `<version>`, `<major>.<minor>` and `<major>`,
  and `@laplace.live/eidolon@<version>`. That run publishes the npm package while
  the `NPM_PUBLISH` variable is `true`; only its one-time setup is done by hand
  ([releasing.md](docs/releasing.md)).
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
