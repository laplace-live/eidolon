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

By default Soniox hears (STT), OpenRouter thinks (LLM) and Fish Audio speaks
(TTS), and a call needs their keys; each persona can fill any role with an
account of another provider from the catalog in `packages/providers`.
Everything else — Mem0, the reranker, the retrieval gate, both RAG indexes —
degrades quietly when its key, table, or vector store is missing, so a fresh
checkout runs.

The bot is TypeScript on Bun, built on pipedog (a TypeScript port of Pipecat),
in `apps/` and `packages/`; production has run it (`ghcr.io/laplace-live/eidolon`)
since 2026-11-04. The offline chain is TypeScript too: `packages/ingest`, run
through the `laplace-*` commands in `apps/cli`. The local web app and the
offline commands also ship as the npm package `@laplace.live/eidolon`
(`apps/eidolon`), which runs them, bundled, on the Bun it installs. The original
Python runtime is in the repo too, for human readers only; agents never touch it
([The Python](#the-python)).

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
laplace_eidolon/      the Python, with tests/: for human readers only ("The Python" under Rules)
personas/<id>/        a persona's template: persona.yaml, prompt.md (the system
                      prompt), glossary.toml, references/outfits/ (what take_selfie
                      redraws, one used per render). Her index, friends/ and
                      sources live in the data home, ~/.laplace/eidolon
                      (docs/personas.md)
data/                 local only, never committed: generated/ (laplace-generate-image)
streams/, vods/       empty and unused; a persona's sources are in
                      ~/.laplace/eidolon/sources/<id>/
.agents/skills/       agent skills; stream-archive-embed syncs new stream replays
docs/                 the topics too large to inline here
```

## Where to look

Read the row for what you are about to touch. **Adding a subsystem means adding
a row here and writing the prose there — not a new section in this file.**

| You're touching | Read first |
| --- | --- |
| a comment, anywhere | [comments.md](docs/comments.md) |
| `/api/memories`, or wiping a viewer's memories | [memory-admin.md](docs/memory-admin.md) |
| RTVI events the web client listens for | [frontend-loading-state.md](docs/frontend-loading-state.md) |
| per-viewer affection / XP tiers (design only, unbuilt) | [affection-system.md](docs/affection-system.md) |
| the persona's identity, voice, or hard rules | `personas/milky-green/prompt.md` and `persona.yaml` |
| settings files, credentials, the data home, a persona's folder or its sources | [personas.md](docs/personas.md) |
| the offline chain (`packages/ingest` and its `laplace-*` commands) or their `--json` events | [typescript.md](docs/typescript.md#the-offline-chain) |
| the local web app (`apps/web`, `apps/bot/src/local`): local mode, its API, jobs or security | [web-app.md](docs/web-app.md) |
| a string the web app shows, its languages, or its `.po` catalogs | [web-app.md](docs/web-app.md#strings-and-languages) |
| changesets, the version PR, tags, or publishing the npm package (`apps/eidolon`) | [releasing.md](docs/releasing.md) |
| any env var — all 50-odd are documented there | `.env.example` |
| Soniox's per-project vocabulary glossary | `personas/milky-green/glossary.toml` |
| broadcast overviews, date-scoped recall, the archive lookup tool, or when she last did something | [stream-recall.md](docs/stream-recall.md) |
| recalling a viewer or a particular SC, and recall's other gaps (design only, unbuilt) | [recall-gaps.md](docs/recall-gaps.md) |
| the `take_selfie` tool, image generation, or `/api/selfie` | [selfies.md](docs/selfies.md) |
| the retrieval gate, or why a turn skipped LanceDB | [retrieval-gate.md](docs/retrieval-gate.md) |
| anything under `apps/` or `packages/` | [typescript.md](docs/typescript.md) |
| a provider, an account, a role's provider or model, model lists, prices, realtime models, the usage ledger or the Usage page | [providers.md](docs/providers.md) |

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
bun run i18n                           # extract the app's strings into apps/web/src/locales/*.po
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

### Which checks to run

Match the gate to the surface you touched; don't reflexively run everything.

| You changed | Run |
| --- | --- |
| retrieval, tokenization, chunking, `top_k`, or `candidates` | `bun run laplace-eval-retrieval --compare ~/.laplace/eidolon/sources/<id>/eval/baseline.json`. A quality claim without a number is not a claim |
| an ingest, `EMBED_MODEL`, or `EMBED_DIM` | re-run **both** ingests (`bun run laplace-ingest-streams`, `laplace-ingest-facts`) into the persona's `index/`, then copy it to each server's mounted data home with the rsync in [personas.md](docs/personas.md#deploying-a-persona) |
| anything under `packages/ingest`, an offline command in `apps/cli`, or the write side of `packages/retrieval` | the gates below, then the stage's real-data test with `EIDOLON_REQUIRE_PARITY=1 bun test --no-env-file <file>`: `packages/ingest/test/*_real.test.ts` (streams, download, transcribe, refine, ingest_streams, pipeline), `apps/cli/test/ingest_facts_real.test.ts`, `packages/retrieval/test/write_real.test.ts`. They are free and only read `~/.laplace/eidolon` (`EIDOLON_REAL_HOME`). Without the variable a missing corpus skips silently |
| the bot's pipeline, the transport, or the werift patches | boot the bot and hold a real call (`bun apps/bot/scripts/e2e-call.ts --text`, or `--audio`) — none of this is unit-testable |
| `packages/imagegen` or the `take_selfie` tool | `bun run laplace-generate-image` against a real reference — it shares `generate()` with the bot, so a successful render is the check. Billed per image |
| the gate's recall questions, state, or threshold (`packages/context/src/gate.ts`), or `RETRIEVAL_GATE_MODEL` | `bun run gate-decisions` — re-scores the labeled turns of `docs/benchmarks/2026-09-19-retrieval-gate/` into its `decisions.json`, and exits non-zero if any turn that needs recall would be skipped. About $0.002 of gate calls |
| the gate's timeline questions or `TIMELINE_THRESHOLD` (`packages/context/src/gate.ts`) | `bun docs/benchmarks/2026-11-07-timeline-question/score.ts` — exits non-zero if any labeled turn lands on the wrong side of the threshold |
| `prompt.md`'s 表演提示 markup, or `FISH_MODEL` | no scripted check exists ([the 2026-10-17 benchmark](docs/benchmarks/2026-10-17-drama-3-markup/README.md) records what drama-3 does with each kind). Hold a real call, `bun apps/bot/scripts/e2e-call.ts --text "<a question her reply would mark up>" --headful`, and listen: a direction or a tag spoken aloud is a leak. Billed per character |
| `packages/memory`, or `/api/memories` (`apps/bot/src/memory-admin.ts`) | `docker compose up qdrant`, then round-trip a real `add` → `search` → `deleteAll` through `openMemoryEngine(buildMemoryConfig())`. The tests fake Qdrant and both model calls, so only a live run proves the wire format; it needs an embedding key and an LLM key |
| an env var | document it in `.env.example` in the same commit |
| anything under `apps/` or `packages/` | `bun run typecheck`, `bun run lint`, `bun run test`; for retrieval, the gate or the bot's pipeline, also the row above that names it |
| anything under `apps/web` | the row above, whose typecheck also runs both `apps/web` tsconfigs, then `bun run build:web`; after changing a string, `bun run i18n` and its `msgstr` in `zh-Hans.po` |
| local mode (`apps/bot/src/local`) | `bun test --no-env-file apps/bot/test/local` from the repository root, then `bun apps/bot/scripts/local-smoke.ts --headful`: a browser walk on a temporary data home that bills nothing |
| `apps/eidolon`, or a file the package bundles or copies | the gates above, then `bun run pack:npm` and `bun apps/eidolon/scripts/ci-install-check.ts apps/eidolon/<tarball>`, which CI runs on Linux x64: it installs the tarball with npm, boots it on a temporary home, signs in, and stops it |

## Rules

Things you would break without being told. How any of it *works* is in the
module that owns it.

### The Python

**The Python is for human readers only.**

- **What it covers:** `laplace_eidolon/`, `tests/`, `pyproject.toml`, `uv.lock` and every `*.py`
  file (benchmark scripts and old golden generators included). They are the original Pipecat
  runtime and its tools, kept as a reference for other users.
- **What agents never do with it:** read, run, edit, port from or cite any of it, or use it to
  decide how the TypeScript behaves. The TypeScript and its own tests are the only source of truth;
  a golden fixture is the TypeScript's record, updated when behavior changes on purpose.
- **The one exception:** release automation, not you, writes the version into `pyproject.toml`,
  `uv.lock` and `bot.py`.

`.claude/settings.json` denies Claude Code those paths and commands, and `no_python.test.ts`
(`apps/cli/test`) fails when TypeScript spawns the Python or this file or `docs/*.md` names it
outside this section and the layout's one line.

### Runtime

- **Optional dependencies fail open, never loud.** Mem0, both RAG providers, the
  reranker, the retrieval gate, and the LanceDB tables each log their failure
  and carry on without it: `packages/runtime/src/session/session.ts` opens the
  optional tiers that way, the gate's failure retrieves anyway, and a failed
  rerank falls back to RRF. A new optional tier follows that shape or it breaks
  fresh checkouts.
- **The retrieval gate may cancel a search, never delay one.**
  `unlessSkipped` (`packages/context/src/gate.ts`) starts the search at once and
  drops it only if Jev answers "skip" first. Awaiting the gate before searching
  would add its ~0.5 s to every recall turn, and its whole timeout to every turn
  while Jev is down.
- **An empty env var is not unset.** `.env` parses `KEY=` as `""`, so
  `Number(process.env.X ?? "60")` reads a plain `.env.example` copy's blank `X`
  as 0. Read env through `envInt`, `envFloat`, `envStr` or `envOptional`
  (`packages/config/src/env.ts`), which treat blank as unset.
- **No image service goes in the pipeline.** pipedog's `ImageGenService`
  generates an image from every `TextFrame` it sees, and this pipeline streams
  one per sentence into TTS — in the pipeline it would bill an image per
  sentence spoken. The `take_selfie` tool (`packages/tools/src/selfie.ts`) calls
  `renderSelfie`, and through it `generate()` from `@eidolon/imagegen`, directly
  instead. See [selfies.md](docs/selfies.md).
- **The persona's reference images are mutually exclusive outfits — exactly
  one reaches a render.** Hand the model two and it draws two of her: a group
  selfie with one friend came back with three people in frame. `selectOutfit`
  picks one by the hour, behind `referenceSources`
  (`packages/imagegen/src/references.ts`), the choke point the bot and
  `laplace-generate-image` share.

### The TypeScript bot

- **Only `packages/runtime` imports `@pipedog/*`.** Biome enforces it; every
  other package must stay usable without a pipeline.
- **`load-env.ts` is the only `.env` reader.** `bunfig.toml` sets `env = false`
  and tests pass `--no-env-file`; no module reads env at import. It walks up to
  the first `.env`, and a git worktree without one, wherever it lives, reads
  its main checkout's, real keys included; `EIDOLON_NO_DOTENV=1` skips it.
- **Production never runs local mode.** `main.ts` and the code it loads never
  import `apps/bot/src/local/` (Biome and `boundaries.test.ts` hold it), and
  nothing but that separate entry turns it on: no flag, setting or env var,
  which a server's mounted `settings.yaml` could flip.
- **No vendor SDK sends a request.** A provider is reached with `fetch`, through the
  clients in `packages/providers`, and every request that bills reports it with
  `reportUsage`, or the usage ledger misses it. `@eidolon/providers/catalog`
  imports nothing: the web app bundles it.
- **A model or voice belongs to its provider.** An environment `LLM_MODEL` applies
  only while `LLM_PROVIDER` fills her mind, `OPENROUTER_MODEL` only while
  OpenRouter does. The settings layers in `packages/config` apply it, so what
  the bot reads and what the local app shows agree.
- **A role names an account, not a provider.** A provider's id is its default
  account, which its variables configure, so a server needs no file; any other
  account (`openai-2`) is only in `credentials.json`'s `accounts`. Compare two
  roles' owners by `accountProvider`, never by id.
- **A model picker lists what the provider's API lists.** The catalog's models
  carry prices and call-time fields, not choices; with no listing, the field is
  free text. The exception is a closed offer (`openModels: false`, Fish's): it
  has no listing and runs an id it doesn't know as another model, so it is a
  choice among the catalog's.
- **The werift patches in `packages/runtime/src/webrtc/handler.ts` are
  load-bearing** — no default STUN server, disconnect on DTLS close, relay-only,
  the `raddr` scrub. Each one's failure mode is in [typescript.md](docs/typescript.md).
- **Run `bun test` from the repository root only.** Elsewhere `bunfig.toml`'s preload is
  skipped and the data home is the real one, so a test file that deletes in it imports
  `packages/config/test/isolated-guard.ts` first, and `isolated-guard.test.ts` enforces that.
- **The web app's strings are English source text in Lingui macros** (`apps/web`). A component
  writes `` t`Save` `` with `t` from `useLingui()` (`@lingui/react/macro`); other code uses `t`
  from `@lingui/core/macro`; a label looked up by code is a `msg` descriptor in a `*labels.ts`
  module; a sentence with a link or `<code>` in it is a `<Trans>`. After changing one, run
  `bun run i18n` and fill each new `msgstr` in `apps/web/src/locales/zh-Hans.po`; `catalog.test.ts`
  fails on a missing translation or a dropped placeholder.
- **A short label's English is Title Case; everything else is sentence case.** Buttons, menu
  items, headings, setting names, tab and column labels and `aria-label`s capitalize every word but
  articles, conjunctions and prepositions, whatever their length (`Add to Bookmarks`, `Hide until
  Next Update`), and capitalize a phrasal verb's particle (`Turn On`). Tooltips, descriptions,
  toasts, placeholders, errors and statuses are sentence case, and so is a heading phrased as a
  sentence or a question. `title-case.test.ts` checks every label it can place. Renaming a string
  orphans its translation: change its `msgid` in `zh-Hans.po` in the same pass, at every site that
  shows it, before re-extracting.
- **Never nest a `t` inside another `t`'s placeholder.** The native macro transform leaves the inner
  one uncompiled, and it renders nothing
  ([lingui/swc-plugin#284](https://github.com/lingui/swc-plugin/issues/284)): hoist it into a
  variable.
- **`bun test` has no macro transform, and a macro throws when it runs.** Keep macros out of the
  modules tests import; a test that needs one stubs `@lingui/core/macro` with
  `apps/web/src/test/lingui-macro.ts` in its own file, never in a bunfig preload.
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

- **Never trust token presence — always `resolveUserContext`**
  (`packages/access/src/user-context.ts`). An unvalidated string would let
  anyone skip the anonymous quota and spawn a full STT+LLM+TTS pipeline per
  probe. Validation fails open to anonymous, and every caller shares one 60s
  TTL cache.
- **Branch on `UserContext.isLoggedIn`, never on field truthiness.** `face` is
  legitimately absent for some logged-in viewers.
- **Anonymous viewers skip Mem0 entirely** rather than sharing a `default-user`
  bucket, where their memories would cross-pollute every other conversation.
- **Mem0 is self-hosted and runs embedded, not as a service.** `packages/memory`
  is its own engine over Qdrant, writing mem0's payloads and `history.db`; no
  mem0 platform client can reach it. Every caller — the pipeline's
  `openMemoryProvider` and `/api/memories`' `createMemoryAdmin` alike — builds
  its engine from `buildMemoryConfig()`, so a new one does too.
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
  ships no CJK tokenizer, so both ingests fill `tokens` with `tokenizeZh` and
  every query goes through `tokenizeZhQuery` (`packages/retrieval/src/tokenize.ts`).
  Stopwords are stripped from queries only — stripping them from the index
  collapses BM25.
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
- **`hybridSearch` (`packages/retrieval/src/hybrid.ts`) is the one search
  path.** The bot, the MCP server, `laplace-search` and `laplace-eval-retrieval`
  all go through it, so what the eval scores is what the bot runs. Keep it that
  way. All but the eval reach it via `LanceRetriever` (`retriever.ts`), which
  adds only the table handle and the stale-handle reopen — never scoring.
- **Similarity search can't answer occurrence questions.** "When did you last
  play X" and "how often" go through `StreamCatalog.timeline`
  (`packages/retrieval/src/stream_catalog.ts`); a bigger `top_k`, another
  reranker or another vector store won't get there
  ([recall-gaps.md](docs/recall-gaps.md)).

### The persona

- **Persona edits go in `prompt.md` and `persona.yaml`, not in code.** `buildPersonaPrefix`
  (`packages/context/src/persona.ts`) layers only per-session facts on top — current
  date, viewer name, recent stream dates, the voice and selfie tools' hints.
- **The Chinese prompt text is load-bearing.** The 不要主动念 lines in
  `buildPersonaPrefix` are what stop the model narrating the clock and reading
  UIDs aloud, and the wording tracks `prompt.md`'s vocabulary. Don't paraphrase
  it in passing.
- **`change_voice_style` is named once, as `VOICE_TOOL_NAME` in
  `packages/tools/src/voice.ts`.** It reaches the prompt through
  `voicePromptHint`, not through `prompt.md` — rename it in that one place.
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
  it yourself, unasked:
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
  into `packages/runtime/src/rtvi.ts`, and into the Python's files as "The
  Python" allows (`apps/bot/scripts/sync-version.ts`), and tags `laplace-eidolon@<version>`,
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
- **Tool descriptions are live API surface.** The MCP tools' descriptions and
  schemas (`toolDefinitions()` in `apps/bot/src/mcp/tools.ts`) and each
  `LlmTool`'s `schema` (`packages/tools`) go to a model as written: editing one
  changes runtime behavior. See [comments.md](docs/comments.md).

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
  sections, changelog narration (`we used to`, `the old X`), usage transcripts,
  commented-out code, pinned upstream versions and endpoint paths, tutorial
  comments on standard-library or framework behavior.
- **Never touch** `// @ts-expect-error`, `// biome-ignore`, `TODO`/`FIXME`, or
  license headers. When cleaning comments, change only comments.

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
