# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`laplace-eidolon` is a personal assistant whose personality is a streamer's
role-play persona. She chats, and takes calls that run self-hosted over
SmallWebRTC — no Daily, no telephony, no Pipecat Cloud. In the local app, on
her owner's computer, she also does real work: tasks that write and edit files
in folders the owner allows and read the web, which she starts, steers, stops
and reports as her own, in a chat or on a call in one
([assistant.md](docs/assistant.md)). Production is the companion alone: viewers
chat with and call her there, and no task ever runs. Two halves share one
LanceDB instance: the bot that answers, and an offline batch chain that builds
the indexes it reads.

```text
webrtc in → STT ∥ VAD → Smart Turn → runTurn: RetrievalGate ∥ Mem0, StreamArchive,
    PersonaFacts → LLM → segmenter → TTS → Speaker → webrtc out
chat line → runChat → runTurn → her reply; start_task → TaskManager → runTask (local app only)
```

By default Soniox hears (STT), OpenRouter thinks (LLM) and Fish Audio speaks
(TTS), and a call needs their keys; each persona can fill any role with an
account of another provider from the catalog in `packages/providers`.
Everything else — Mem0, the reranker, the retrieval gate, both RAG indexes —
degrades quietly when its key, table, or vector store is missing, so a fresh
checkout runs.

The bot is TypeScript, on eidolon's own voice engine (`packages/voice`), in
`apps/` and `packages/`; production has run it on Bun (`ghcr.io/laplace-live/eidolon`)
since 2026-11-04. The offline chain is TypeScript too: `packages/ingest`, run
through the `laplace-*` commands in `apps/cli`. The local web app and the
offline commands run on Node 24, and also ship as the npm package
`@laplace.live/eidolon` (`apps/eidolon`), which runs them, bundled, on the
user's Node. The original Python runtime is in the repo too, for human readers
only; agents never touch it ([The Python](#the-python)).

## Repository layout

```text
apps/bot/             the bot: HTTP server, routes, MCP, entry point; src/chat/ is production's
                      chat endpoint; src/local/ is the local web app's own entry and API, its
                      chats and her tasks, which production never loads
apps/web/             the local web app's pages (Vite, React, shadcn), served by src/local/
apps/cli/             every laplace-* command, the offline chain's included
apps/eidolon/         the npm package @laplace.live/eidolon: a Node launcher, and a build that
                      bundles the local app and the CLI with the web app, templates and jieba
packages/             subsystems, one Bun workspace package each (docs/typescript.md);
                      packages/ingest is the offline chain, packages/assistant the tools,
                      folder policy and files of the assistant's tasks, and in its skills/ the
                      skills Eidolon ships
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
| chats, the chat log format, the turn engine, group chats' director, voice messages, or the images and text files the viewer sends (`packages/chat`, `packages/engine`, `packages/engine/src/seen.ts`, `apps/bot/src/images.ts`, `packages/context/src/director.ts`, `packages/providers/src/speech/batch`) | [chat.md](docs/chat.md) |
| the production chat endpoint (`apps/bot/src/chat`, `/api/chat/*`, a call inside a chat), its signing, quotas or `EIDOLON_CHAT_SECRET` | [chat.md](docs/chat.md#production-the-browser-keeps-the-chat) |
| the voice engine (`packages/voice`, `packages/webrtc`, `packages/runtime`), its models, or call-mode turns | [voice-engine.md](docs/voice-engine.md) |
| a string the web app shows, its languages, or its `.po` catalogs | [web-app.md](docs/web-app.md#strings-and-languages) |
| changesets, the version PR, tags, or publishing the npm packages (`apps/eidolon`, `packages/sdk`) | [releasing.md](docs/releasing.md) |
| the browser client SDK (`@laplace.live/eidolon-sdk`, `packages/sdk`) | [client-sdk.md](docs/client-sdk.md) |
| any env var — all 50-odd are documented there | `.env.example` |
| Soniox's per-project vocabulary glossary | `personas/milky-green/glossary.toml` |
| broadcast overviews, date-scoped recall, the archive lookup tool, or when she last did something | [stream-recall.md](docs/stream-recall.md) |
| recalling a viewer or a particular SC, and recall's other gaps (design only, unbuilt) | [recall-gaps.md](docs/recall-gaps.md) |
| the `take_selfie` tool, image generation, or `/api/selfie` | [selfies.md](docs/selfies.md) |
| the retrieval gate, or why a turn skipped LanceDB | [retrieval-gate.md](docs/retrieval-gate.md) |
| anything under `apps/` or `packages/` | [typescript.md](docs/typescript.md) |
| a provider, an account, a role's provider or model, model lists, prices, realtime models, the usage ledger or the Usage page | [providers.md](docs/providers.md) |
| the assistant: Assistant Mode, a task's tools, `FolderPolicy` or files (`packages/assistant`), a task's commands (`bash`) and the `eidolon` command they run, skills (Settings' Skills, `skills.json`, `EIDOLON_SHARED_SKILLS`, the built-in skills in `packages/assistant/skills`), MCP servers (`mcp.json`), web search or kind, the task loop (`packages/engine/src/task.ts`), the app's tasks, permission levels and Approve for Me's review, her task tools (`start_task`, `steer_task`, `stop_task`, `check_task`), the status block, tasks on a call and the task routes (`apps/bot/src/local/tasks`, `routes/tasks.ts`), a chat's task display (`/focus`, `/normal`, `/verbose`), `/stop` and milestones on a call, or `laplace-task` | [assistant.md](docs/assistant.md) |

## Commands

The bot:

```bash
bun install
bun run dev                            # watch mode on :7860 (--port to move it), on Bun; `start` without watch
bun run typecheck && bun run lint && bun run test
bun run test <paths>                   # Vitest on Node, those files or folders only
bun run laplace-search / laplace-eval-retrieval / laplace-generate-image / gate-decisions / director-decisions / review-decisions
bun run laplace-task --folder <path> "<goal>"   # one assistant task in the foreground; billed (docs/assistant.md)
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
bun run laplace-discover               # her new streams on Bilibili/YouTube, ranked; --save → a batch
bun run laplace-extract-users          # mine danmaku JSON for glossary.toml terms
```

The npm packages, `@laplace.live/eidolon` and `@laplace.live/eidolon-sdk` ([releasing.md](docs/releasing.md)):

```bash
bun run build:npm                      # stages it in apps/eidolon/pack/: bundles, web app, templates
bun run pack:npm                       # stages it, then packs apps/eidolon/laplace.live-eidolon-<version>.tgz
bun run build:sdk                      # stages @laplace.live/eidolon-sdk in packages/sdk/pack/
bun run pack:sdk                       # stages it, then packs packages/sdk/laplace.live-eidolon-sdk-<version>.tgz
```

### Which checks to run

Match the gate to the surface you touched; don't reflexively run everything.

| You changed | Run |
| --- | --- |
| retrieval, tokenization, chunking, `top_k`, or `candidates` | `bun run laplace-eval-retrieval --compare ~/.laplace/eidolon/sources/<id>/eval/baseline.json`. A quality claim without a number is not a claim |
| an ingest, `EMBED_MODEL`, or `EMBED_DIM` | re-run **both** ingests (`bun run laplace-ingest-streams`, `laplace-ingest-facts`) into the persona's `index/`, then copy it to each server's mounted data home with the rsync in [personas.md](docs/personas.md#deploying-a-persona) |
| anything under `packages/ingest`, an offline command in `apps/cli`, or the write side of `packages/retrieval` | the gates below, then the stage's real-data test with `EIDOLON_REQUIRE_PARITY=1 bun run test <file>`: `packages/ingest/test/*_real.test.ts` (streams, download, transcribe, refine, ingest_streams, pipeline), `apps/cli/test/ingest_facts_real.test.ts`, `packages/retrieval/test/write_real.test.ts`. They are free and only read `~/.laplace/eidolon` (`EIDOLON_REAL_HOME`). Without the variable a missing corpus skips silently |
| the voice loop (`packages/voice`), the transport (`packages/webrtc`), `packages/runtime`, or the werift patches | `bun run test packages/voice packages/webrtc packages/runtime`, then boot the bot and hold real calls with `e2e-call.ts` (`--text`, `--audio`, `--barge-in`), compared with a baseline's by `e2e-compare.ts` ([voice-engine.md](docs/voice-engine.md#real-calls)) — a call's timing isn't unit-testable. Billed |
| `packages/imagegen` or the `take_selfie` tool | `bun run laplace-generate-image` against a real reference — it shares `generate()` with the bot, so a successful render is the check. Billed per image |
| the gate's recall questions, state, or threshold (`packages/context/src/gate.ts`), or `RETRIEVAL_GATE_MODEL` | `bun run gate-decisions` — re-scores the labeled turns of `docs/benchmarks/2026-09-19-retrieval-gate/` into its `decisions.json`, and exits non-zero if any turn that needs recall would be skipped. About $0.002 of gate calls |
| the director's questions, state, or thresholds (`packages/context/src/director.ts`) | `bun run director-decisions` — asks Jev about the labelled group-chat lines of `docs/benchmarks/2026-11-10-director/` into its `decisions.json`, and exits non-zero if any is decided wrong. About $0.003 of gate calls; after a threshold or label change alone, `bun docs/benchmarks/2026-11-10-director/score.ts --cached --check` replays the stored scores for free |
| Approve for Me's review: its prompt, its notes or its verdict (`packages/assistant/src/review.ts`) | `bun run review-decisions` — asks the assistant role's model (or `--model <account>/<model>`) about the labelled actions of `docs/benchmarks/2026-11-19-approve-for-me/` into its `decisions.json`, and exits non-zero if any risky one is let through or a review fails. About $0.002 on `deepseek-flash`; run it on the models tasks use |
| the gate's timeline questions or `TIMELINE_THRESHOLD` (`packages/context/src/gate.ts`) | `bun docs/benchmarks/2026-11-07-timeline-question/score.ts` — exits non-zero if any labeled turn lands on the wrong side of the threshold |
| `prompt.md`'s 表演提示 markup, or `FISH_MODEL` | no scripted check exists ([the 2026-10-17 benchmark](docs/benchmarks/2026-10-17-drama-3-markup/README.md) records what drama-3 does with each kind). Hold a real call, `bun apps/bot/scripts/e2e-call.ts --text "<a question her reply would mark up>" --headful`, and listen: a direction or a tag spoken aloud is a leak. Billed per character |
| `packages/memory`, or `/api/memories` (`apps/bot/src/memory-admin.ts`) | `docker compose up qdrant`, then round-trip a real `add` → `search` → `deleteAll` through `openMemoryEngine(buildMemoryConfig())`. The tests fake Qdrant and both model calls, so only a live run proves the wire format; it needs an embedding key and an LLM key |
| `packages/assistant`, the task loop (`packages/engine/src/task*`), or `laplace-task` | `bun run test packages/assistant packages/engine apps/cli/test/task.test.ts`, which script every mind, and spawn real processes for `bash` and the MCP client in temporary folders, killing only their own; a change to how a task behaves also needs one billed task on a model you pick: `bun run laplace-task --folder <tmp>/mg-react-todomvc "写一个 React TodoMVC，单文件 index.html"`, then try the page ([assistant.md](docs/assistant.md#laplace-task)) |
| an env var | document it in `.env.example` in the same commit |
| anything under `apps/` or `packages/` | `bun run typecheck`, `bun run lint`, `bun run test`, and for what production loads `bun apps/bot/scripts/bun-check.ts`; for retrieval, the gate or the voice loop, also the row above that names it |
| anything under `apps/web` | the row above, whose typecheck also runs both `apps/web` tsconfigs, then `bun run build:web`; after changing a string, `bun run i18n` and its `msgstr` in `zh-Hans.po` |
| local mode (`apps/bot/src/local`), or chats (`packages/chat`, `packages/engine`) | `bun run test apps/bot/test/local`, then `bun apps/bot/scripts/local-smoke.ts --headful`: a browser walk on a temporary data home that bills nothing, a chat, a group chat, voice messages and a task she starts, steers, checks and stops in a chat, one shown in each display and stopped with `/stop`, one she starts on a call there, a coding task on its kind's model that reads a skill and runs commands its card allows once, denies and allows for good, two that call a fake MCP server's tool, and two under the chat's Approve for Me and Full Access, with a fake mind, director, voice, hearing, worker and review included |
| her task tools' descriptions, her hint, the status block or her nudges (`apps/bot/src/local/tasks`) | the row above, then one billed chat on OpenRouter ([assistant.md](docs/assistant.md#checking-her-side)): a task outside `assistant.folders`, whose line must name the card's question; 弄好了吗 before and after Allow; 具体到哪了, answered through `check_task`; a change, passed on through `steer_task`; 帮我打开它, which starts no task; 算了别做了 on a second task, through `stop_task`; a task that needs a lookup and a run, which names its kind, asks on its card before the command and searches. About $0.20, most of it the worker. A change to tasks on a call also needs a call by hand, billed on Soniox and Fish too, so it waits for the user's go-ahead |
| `apps/eidolon`, or a file the package bundles or copies | the gates above, then `bun run pack:npm` and `node apps/eidolon/scripts/ci-install-check.ts apps/eidolon/<tarball>`, which CI runs on Linux x64 and Windows x64: it installs the tarball with npm, boots it on Node on a temporary home, signs in, loads its native modules, and stops it |
| `packages/sdk` (`@laplace.live/eidolon-sdk`) | `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run pack:sdk` |

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

`.claude/settings.json` denies Claude Code those paths and every command that starts with `uv`,
`python` or `pytest`, and `no_python.test.ts` (`apps/cli/test`) fails when TypeScript spawns the
Python, or this file or `docs/*.md` names it or a command that runs it outside this section and
the layout's one line.

### Runtime

- **Optional dependencies fail open, never loud.** Mem0, both RAG providers, the
  reranker, the retrieval gate, and the LanceDB tables each log their failure
  and carry on without it: `packages/engine/src/parts.ts` opens the
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
- **A selfie is a tool call, never part of the speech path.** Her reply streams
  to her voice one sentence at a time, so anything that renders from what she
  says would bill an image per sentence spoken. The `take_selfie` tool
  (`packages/tools/src/selfie.ts`) calls `renderSelfie`, and through it
  `generate()` from `@eidolon/imagegen`, directly. See [selfies.md](docs/selfies.md).
- **The persona's reference images are mutually exclusive outfits — exactly
  one reaches a render.** Hand the model two and it draws two of her: a group
  selfie with one friend came back with three people in frame. `selectOutfit`
  picks one by the hour, behind `referenceSources`
  (`packages/imagegen/src/references.ts`), the choke point the bot and
  `laplace-generate-image` share.
- **A viewer's image reaches a mind only through `normalizeImage`**
  (`apps/bot/src/images.ts`, on sharp), which turns it upright, strips what its
  camera wrote (GPS included) and fits it to what minds take; a route that takes
  images calls it. Production's is the bot's own sharp: the Dockerfile prunes
  only LanceDB's older copy, and the npm package depends on it.

### The TypeScript bot

- **pipedog-derived code carries its BSD-2 header.** A file ported from pipedog keeps
  pipedog's copyright lines and `SPDX-License-Identifier: BSD-2-Clause`, then
  `Ported from pipedog <path>@ce8f8bc`; its package keeps `LICENSE-pipedog` and
  `THIRD_PARTY.md`, and `NOTICE` names every holder (`build.test.ts` checks it).
- **`load-env.ts` is the only `.env` reader.** Node reads none unasked,
  `bunfig.toml` sets `env = false` for what runs on Bun, and `vitest.config.ts`
  loads none into a test. No module reads env at import but
  `apps/bot/src/local/environ.ts`, which the local entries import before
  `load-env.ts` so the server and jobs they spawn start without its keys. It walks
  up to the first `.env`, and a git worktree without one, wherever it lives,
  reads its main checkout's, real keys included; `EIDOLON_NO_DOTENV=1` skips it.
- **Production never runs local mode.** `main.ts` and the code it loads never
  import `apps/bot/src/local/` (Biome and `boundaries.test.ts` hold it), and
  nothing but that separate entry turns it on: no flag, setting or env var,
  which a server's mounted `settings.yaml` could flip.
- **Only `@eidolon/engine` talks to a mind, and only `@eidolon/providers/realtime` to a
  realtime model**, and a chat's log stores what was said and recalled, never stream deltas.
  Each persona's view is rebuilt from the log, so what isn't stored she never saw. The local app,
  production's chat endpoint and every call run it; see [chat.md](docs/chat.md).
- **Production keeps no transcripts; it signs what it produces.** Its chat endpoint
  (`apps/bot/src/chat`) exists only while `EIDOLON_CHAT_SECRET` is set; unset, every `/api/chat/*`
  path answers as an unknown path and no offer is bound. It answers from the window the browser
  sends and writes nothing to the data home. Every event it adds but the viewer's own carries an
  HMAC `sig`, one that fails is dropped from her view, and context blocks never leave the server.
  Only `apps/bot/src/local` imports `@eidolon/chat/jsonl` (Biome and `boundaries.test.ts` hold it).
- **Only `packages/runtime` imports `@eidolon/voice` and `@eidolon/webrtc`.** Biome enforces it.
  See [voice-engine.md](docs/voice-engine.md).
- **In the voice loop, transport, provider and timer callbacks only post to the call's
  mailbox;** only the Floor changes call state, and it never awaits. A billable request started
  anywhere else falls outside the call's usage scope.
- **A call's stored assistant text is what was heard (`heard()`), never what streamed.**
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
  free text. The exception is a closed offer (`openModels: false`), a choice
  among the catalog's: Fish's, which has no listing and runs an id it doesn't
  know as another model, and OpenRouter's search, whose other engines bill at
  another provider's price.
- **The werift patches in `packages/webrtc/src/patches.ts` are load-bearing** — no
  default STUN server, disconnect on DTLS close, relay-only, the `raddr` scrub. Each
  one's failure mode is in [typescript.md](docs/typescript.md).
- **Run the tests from the repository root only, as `bun run test [paths]`.** Vitest runs them
  on Node; elsewhere it finds no `vitest.config.ts`, its setup files are skipped and the data
  home is the real one, so a test file that deletes in it imports
  `packages/config/test/isolated-guard.ts` first, and `isolated-guard.test.ts` enforces that.
  `bun test` is not the test runner.
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
- **The tests have no macro transform, and a macro throws when it runs.** Vitest's web project
  leaves Lingui's plugin out. Keep macros out of the modules tests import; a test that needs one
  stubs `@lingui/core/macro` with `apps/web/src/test/lingui-macro.ts` through `vi.doMock` in its
  own file, never in a setup file.
- **Bun's version lives only in package.json's `packageManager`.** CI's setup-bun reads it
  (`bun-version-file`) and the image follows `oven/bun:1`: a bump edits that one line, never a
  workflow. Bun installs, runs the scripts and serves production; the npm package ships none.
- **Runtime code uses no Bun API.** `apps/*/src` and `packages/*/src` import no `bun` or `bun:*`
  module and use no `Bun` global, `HTMLRewriter`, `import.meta.dir` or `import.meta.path`, no
  Bun-only fetch option (`tls`, `proxy`, `timeout`, `unix`, `verbose`) and no
  `Uint8Array.fromBase64`, `toBase64` or `fromHex`, which Node 24 lacks. Biome bans the globals,
  `apps/cli/test/no_bun.test.ts` the modules and `import.meta` fields, and the typecheck, on
  Node's types with `bun` resolving to nothing, the rest.
- **Whatever production loads also runs on Bun, until production moves to Node.** Everything
  `apps/bot/src/main.ts` reaches uses only `node:*` modules and packages proven on both
  runtimes; a merge deploys it on Bun. `bun apps/bot/scripts/bun-check.ts`, which CI runs, boots it
  there. The local app refuses to start on Bun.
- **An undici dispatcher does nothing under Bun**, whose fetch ignores it: a keep-alive, proxy,
  timeout or pinned address set through one holds on Node alone. So `web_fetch`, whose DNS pin is
  a dispatcher, runs only on Node and refuses under Bun.
- **Never find a shipped file through `import.meta`.** The npm package runs bundles, where every
  module's folder is `dist/`. A file the code ships with (a template, the web build, jieba's
  data, an entry to spawn) resolves through `shippedPath` in `@eidolon/config`, under the
  launcher's `EIDOLON_APP_ROOT` or else the checkout, and `apps/eidolon`'s build copies it in.
- **Windows has no process groups and no SIGTERM: every kill there is TerminateProcess.** Spawn
  through `spawnProcess` (or cross-spawn, for a `.cmd` such as `npx`), which hides the child's
  console window; end a process with what it started through `killTree` (`@eidolon/config`, taskkill
  there), and only while it runs, since Windows reuses a dead process's pid; ask a job to stop with
  `STOP_MESSAGE` over its IPC channel; and pass no signal on with `kill()` there
  ([web-app.md](docs/web-app.md#from-the-npm-package)).

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

### The assistant

- **`@eidolon/assistant` never reaches production.** Only `apps/bot/src/local` and `apps/cli`
  import it (Biome and `boundaries.test.ts` hold it), and `docker.yml` skips the image build for
  `packages/assistant`; lift the fence and the paths-ignore together. Production's chat endpoint
  offers none of her task tools (`production.test.ts`), and no flag, setting or env var turns them
  on there.
- **Only the owner's own lines make her start, steer or stop a task; only its card answers it.**
  Every task route is under `/api/local`, behind the session, and a listed origin
  (`EIDOLON_LOCAL_ALLOWED_ORIGINS`) reaches none of them, nor the chats that offer her task tools.
  No route creates or steers a task: she does, from the owner's lines. Allow, Deny and Continue
  come only from the task's card and the waiting bar, never from her tools or her voice.
- **Her task tools (`start_task`, `steer_task`, `stop_task`, `check_task`) go only with her
  answers to the owner's own lines, in a chat of hers alone,** typed, as a voice message or on a
  single cascade call there: never with her greeting, her report turns or her follow-ups on a call,
  nor in a group chat, a group or realtime call, or `/call`. A report can quote a page, and a turn
  no line of the owner's asked for must not act on the computer.
- **Nothing the worker wrote reaches her above a tool's output.** Its report, plan, steps, file
  names and the paths or sites it asks about can quote a page it fetched, so her view holds them
  only in a `tool` message (her `start_task` call's `final`, `check_task`'s result); the status
  block and her nudges carry the runtime's facts and her own words alone. The one exception is an
  Anthropic turn offered no tools at all, which sends its calls and results as user-turn notes
  (`callsAsNotes`) with no tool to act on them. Her retellings are her own lines, which Mem0 stores
  like any other.
- **A task's steps never enter the chat log.** The log holds her task tools' calls and results,
  `check_task`'s bounded summary included, and the status block; every step is in the task's
  transcript.
- **The outcome comes from the runtime** (`succeeded`, `failed`, `cancelled`, and the files its
  tool log shows written), never from the worker's words.
- **Interruptions never stop a task; only a cancel does:** the card's Stop, a Deny at its start,
  Assistant Mode off, a deleted chat, or her `stop_task` on the owner's word.
- **The worker has no persona:** the brief, the folder's `AGENTS.md` and `CLAUDE.md`, its tools'
  rules, the skills catalog and the skills she named, the date and the folder; no `prompt.md`, Mem0
  or persona facts.
- **A command and an MCP server run as the owner, outside `FolderPolicy`.** Each command and MCP
  call waits on the task's card unless the owner allowed that exact command in that folder, or
  always allows that tool, or the chat's permission level lets it through, and such a grant stops
  applying once the task has read outside content (`external`: `web_fetch`, `web_search`, any
  MCP call), an MCP one under No Web too, where no level lets an MCP call through. A server's
  `readOnlyHint` or `destructiveHint` never skips the card by itself
  ([assistant.md](docs/assistant.md#approvals)).
- **Only the owner sets a permission level:** a chat's from its picker or Chat Settings (`PATCH
  chats/:id`, under `/api/local`), the app's in Settings; never her tools, a task or a listed
  origin. Full Access lets commands run as the owner unasked; at every level `FolderPolicy`'s
  denies, the owner's Denies, spend pauses and No Web hold, and a level that can't be read asks
  ([assistant.md](docs/assistant.md#permission-levels)).
- **Approve for Me's review asks unless it answers allow.** It runs on the task's own model, billed
  to the task through `UsageMeter.charge`, sees the brief and the action as JSON and never the
  transcript, and a failure, a minute without an answer, arguments too long to show it whole, or
  any other answer sends the action to the card. Its reason is a fixed risk the card names, never
  model text, and never reaches her.
- **A command, and an MCP server's process, run on `shellEnv()`, never `process.env`:** the
  allowed names (on Windows also what its programs need, `PASSED_ON_WINDOWS`), every `LC_*`,
  `TERM=dumb`, and a `PATH` with no folder the task may write (an MCP
  server's as the task's first run found it), so no `.env` key reaches one unless an `mcp.json`
  entry names it. A command's `PATH` starts with `<data home>/bin`, where the app writes the
  `eidolon` command at each start beside the managed yt-dlp, and it gets `EIDOLON_TASK_PERSONA`,
  its chat's persona; `eidolon` sets its own data home and runs on the app's own Node.
- **Of the file tools, only `skill` reads in the data home or the app's folder,** and only a listed
  or named skill's own files, never a dot-file; `bash_output` reads only its task's logs there, and
  commands and MCP servers run outside `FolderPolicy`. Of a skill only its name reaches her, and
  only an owner's or a built-in one (`start_task`'s `skills` enum): never a description, a body or
  a task folder's skill, and no skill reaches production.
- **A tool's own spend reaches the task's meter through `UsageMeter.charge`, never `tap`:** `tap`
  stands for a worker request's usage and sets the context's size, which steers compaction.
- **Her `start_task` description and hint come in two, commands on and off
  (`offersCommands()`),** and with commands on, their approval sentence follows the chat's
  permission level: change every variant, and keep that her tasks can't open things for the owner.
- **Every task request is billed as source `task`, with the task's id as its session.**
- **The task loop, `runTask`, lives in `@eidolon/engine`, which imports nothing from
  `@eidolon/assistant`:** the tools, store, inbox and meter come injected.
- **pi-mono-derived code carries its MIT header,** then `Ported from pi-mono <path>@ac78a60`
  (`, its Windows parts @cb1205e` where those came later); `packages/assistant` keeps `LICENSE-pi`
  and `THIRD_PARTY.md`, and `NOTICE` names the holder (`build.test.ts` checks it).

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
  mem0 platform client can reach it. Every caller — the turn engine's
  `createMemoryProvider` and `/api/memories`' `createMemoryAdmin` alike — builds
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
  date, viewer name, recent stream dates, the voice, selfie and assistant tools' hints.
- **The Chinese prompt text is load-bearing.** The 不要主动念 lines in
  `buildPersonaPrefix` are what stop the model narrating the clock and reading
  UIDs aloud, and the wording tracks `prompt.md`'s vocabulary. Don't paraphrase
  it in passing. So is the assistant's Chinese: her hint, her task tools'
  descriptions, her nudges and the status block (`apps/bot/src/local/tasks`).
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
  changesets naming it. `@laplace.live/eidolon-sdk` (`packages/sdk`) is versioned
  independently — name it on changesets that change the client SDK. `@eidolon/*`
  are ignored.
- **A push to `master` is a production deploy.** CI rebuilds `:edge`, and
  Watchtower on the production host restarts the bot from it, dropping live
  calls. Pushes that only touch docs, tests, changesets, `AGENTS.md`, `.agents/`,
  the offline chain (`apps/cli`, `packages/ingest`), the local web app
  (`apps/web`, `apps/bot/src/local`), or the npm packages (`apps/eidolon`,
  `packages/sdk`) skip the image build (`paths-ignore` in `docker.yml`);
  anything else, `personas/` included, ships.
- **Never bump a version, push a release tag, hand-edit `CHANGELOG.md`, or
  publish to npm.** Merging the Release workflow's version PR bumps
  `apps/bot/package.json`, `apps/eidolon/package.json`, and/or
  `packages/sdk/package.json`, copies the bot's version into
  `packages/runtime/src/rtvi.ts` and into the Python's files as "The Python"
  allows (`apps/bot/scripts/sync-version.ts`), publishes unpublished npm
  packages (`@laplace.live/eidolon`, `@laplace.live/eidolon-sdk`) via OIDC
  trusted publishing, and tags `laplace-eidolon@<version>` (which builds the
  image tagged `<version>`, `<major>.<minor>` and `<major>`),
  `@laplace.live/eidolon@<version>`, and/or `@laplace.live/eidolon-sdk@<version>`;
  only one-time trusted-publisher setup is done by hand
  ([releasing.md](docs/releasing.md)).
- **Fix defects you can trigger; don't harden against ones you can't.** Before
  adding a guard — including for a review finding — name the input or sequence
  that produces the failure against the code as it stands. No trigger means
  you're shipping the guard, not a fix. Same for indirection and config knobs:
  no second caller, no abstraction.
- **Upstream-dependency bugs get a citation comment, not a silent workaround.**
- **Tool descriptions are live API surface.** The MCP tools' descriptions and
  schemas (`toolDefinitions()` in `apps/bot/src/mcp/tools.ts`) and each
  `LlmTool`'s `schema` (`packages/tools`, and her task tools in
  `apps/bot/src/local/tasks`) go to a model as written: editing one changes
  runtime behavior. See [comments.md](docs/comments.md).

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
