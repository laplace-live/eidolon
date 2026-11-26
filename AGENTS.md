# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`laplace-eidolon` is a personal assistant with a streamer role-play persona. In production (`ghcr.io/laplace-live/eidolon`), she chats and takes self-hosted SmallWebRTC calls (no Daily, telephony, or Pipecat Cloud) using Soniox, OpenRouter, and Fish Audio by default, plus optional in-process Mem0 and Zvec RAG indexes built offline (`packages/ingest`, `apps/cli`). On the owner's computer, the local app (`apps/bot/src/local`, `apps/web`), npm package (`@laplace.live/eidolon`), and Electron desktop app (`LAPLACE Eidolon`, `apps/desktop`) also run assistant tasks that edit files, search/read the web, and run approved commands ([assistant.md](docs/assistant.md)). All active code is TypeScript on Node 24.

## Repository layout

```text
apps/bot/             bot HTTP/RTVI/MCP server; src/chat/ is production chat, src/local/ is local mode
apps/web/             local web app (Vite, React, shadcn), served by apps/bot/src/local/
apps/cli/             laplace-* offline, query, eval, and task commands
apps/eidolon/         npm package @laplace.live/eidolon (launcher + bundled local app & CLI)
apps/desktop/         Electron app LAPLACE Eidolon (apps/web + staged backend on Electron's Node)
packages/             workspace subsystems (@eidolon/* and @laplace.live/eidolon-sdk; docs/typescript.md)
laplace_eidolon/      the Python, with tests/: for human readers only ("The Python" under Rules)
personas/<id>/        committed persona templates (prompt.md, persona.yaml, glossary.toml, outfits/)
data/, streams/, vods/  local-only scratch; live data/sources/indexes live in ~/.laplace/eidolon
scripts/              repo-wide tooling (changelog.ts, verify-docs.ts)
.agents/skills/       repo agent skills (e.g. stream-archive-embed)
docs/                 deep subsystem docs (linked below)
changelog.json        generated release notes across all released packages
```

Use **pnpm** (`packageManager`; Node 24). Run scripts from the repo root.

## Where to look

Read the entry for what you are about to touch. **Adding a subsystem means adding an entry here and writing the prose there — not a new section in this file.**

- TypeScript workspace map, offline chain (`packages/ingest`, `laplace-*`), `--json` progress, real-data tests → [typescript.md](docs/typescript.md)
- Self-hosting, Docker, `/mcp`, HTTP endpoints, identity/quotas, Mem0 → [self-hosting.md](docs/self-hosting.md) · [memory-admin.md](docs/memory-admin.md)
- Local web app (`apps/bot/src/local`, `apps/web`), jobs, security, i18n/Lingui strings, local smoke → [web-app.md](docs/web-app.md)
- Desktop app (`apps/desktop`), forwarder, companion window, Electron lane, smokes, signing, updater → [desktop.md](docs/desktop.md)
- Assistant tasks, `FolderPolicy`, approvals, commands, skills, MCP servers, `laplace-task` → [assistant.md](docs/assistant.md)
- Voice engine (`packages/voice`, `packages/webrtc`, `packages/runtime`), Floor, RTVI, real calls → [voice-engine.md](docs/voice-engine.md) · [frontend-loading-state.md](docs/frontend-loading-state.md)
- Chats, JSONL store, `runTurn`, group chat director, voice messages, viewer attachments, `/api/chat/*` → [chat.md](docs/chat.md)
- Providers, roles, accounts, model lists, realtime models, usage ledger → [providers.md](docs/providers.md)
- Personas, `persona.yaml`, `settings.yaml`, credentials, data home, deploying indexes → [personas.md](docs/personas.md) · `personas/milky-green/prompt.md`, `persona.yaml`, `glossary.toml`
- Hybrid retrieval, embedding/FTS rules, evaluation → [retrieval.md](docs/retrieval.md)
- Retrieval gate (`unlessSkipped`, Jev, timeline threshold) → [retrieval-gate.md](docs/retrieval-gate.md)
- Stream catalog, date-scoped recall, timeline queries, unbuilt recall gaps → [stream-recall.md](docs/stream-recall.md) · [recall-gaps.md](docs/recall-gaps.md)
- `take_selfie`, outfit exclusivity, `/api/selfie` → [selfies.md](docs/selfies.md)
- Client SDK (`@laplace.live/eidolon-sdk`) → [client-sdk.md](docs/client-sdk.md)
- Avatars, PSD2Live models, Studio Appearance, call screen, companion stage, vendored wasm → [avatar.md](docs/avatar.md)
- Per-viewer affection / XP tiers (design only, unbuilt) → [affection-system.md](docs/affection-system.md)
- Changesets, version PR, `changelog.json`, tags, npm publishing → [releasing.md](docs/releasing.md)
- Comment policy and worked examples → [comments.md](docs/comments.md)
- Environment variables (all 50+ documented) → [`.env.example`](.env.example)

## Commands

```bash
pnpm install
pnpm dev                    # production bot on :7860 (`pnpm start` without watch)
pnpm app                    # builds web app if needed + `pnpm local --open`
pnpm local                  # local web server + supervisor (`pnpm dev:local` watches)
pnpm dev:web                # Vite on :5173 → :7860 (`pnpm build:web`, `pnpm i18n`)
pnpm dev:desktop            # unpackaged desktop (`pnpm build:desktop`, `pnpm package:desktop`)
pnpm smoke:desktop          # packaged desktop smoke (`pnpm smoke:desktop:dev` on macOS)
pnpm build:npm              # stage npm pkg (`pnpm pack:npm`, `pnpm build:sdk`, `pnpm pack:sdk`)
pnpm typecheck && pnpm lint && pnpm test && pnpm doc-check
pnpm format                 # biome format --write .
```

- **Offline chain** (`--persona <id>`, `--help`; [typescript.md](docs/typescript.md)): `pnpm laplace-pipeline`, `pnpm laplace-download`, `pnpm laplace-transcribe`, `pnpm laplace-refine`, `pnpm laplace-ingest-streams`, `pnpm laplace-ingest-facts`, `pnpm laplace-build-stream-catalog`, `pnpm laplace-prepare-batch`, `pnpm laplace-discover`, `pnpm laplace-extract-users`.
- **Query, task, and eval CLIs:** `pnpm laplace-search`, `pnpm laplace-eval-retrieval`, `pnpm laplace-generate-image`, `pnpm laplace-task` (`--help`; [assistant.md](docs/assistant.md#laplace-task)); billed benchmarks (take no `--help`, run immediately): `pnpm gate-decisions`, `pnpm director-decisions`, `pnpm review-decisions`.

### Which checks to run

Match the gate to what you touched; don't reflexively run paid or full-stack suites:

- **Any code under `apps/` or `packages/`** → `pnpm typecheck && pnpm lint && pnpm test [paths]` from repo root.
- **Any `.env` variable** → document in `.env.example` (and `docs/personas.md` if in `SETTINGS`) in the same commit.
- **`AGENTS.md`, `README.md`, `docs/`, `.changeset/`, or `package.json` scripts** → `pnpm doc-check`.
- **`apps/web`** → `pnpm typecheck && pnpm lint && pnpm test apps/web && pnpm build:web`; after changing UI strings, run `pnpm i18n` and fill `zh-Hans.po` ([web-app.md](docs/web-app.md#strings-and-languages)).
- **Local mode / chats (`apps/bot/src/local`, `packages/chat`, `packages/engine`)** → `pnpm test apps/bot/test/local` + `node apps/bot/scripts/local-smoke.ts --headful` (free browser walk; [web-app.md](docs/web-app.md#the-browser-smoke-test)). Changes to her task tools/hints also need the billed OpenRouter chat check ([assistant.md](docs/assistant.md#checking-her-side)).
- **`apps/desktop` or staged backend payload** → `pnpm test apps/desktop`, `pnpm build:desktop && pnpm package:desktop`, `EIDOLON_REQUIRE_STAGE=1 pnpm test apps/desktop/test/stage.test.ts`, `pnpm smoke:desktop`, `pnpm smoke:desktop:dev` (macOS), plus `node apps/desktop/scripts/test-on-electron.ts` when changing `jsRuntime()` or the node shim ([desktop.md](docs/desktop.md#testing)).
- **`apps/eidolon` / `packages/sdk`** → `pnpm pack:npm && node apps/eidolon/scripts/ci-install-check.ts apps/eidolon/*.tgz`; for SDK/avatars also `pnpm pack:sdk`, `packages/sdk/test/parity.test.ts`, and `apps/bot/test/local/static.test.ts` ([client-sdk.md](docs/client-sdk.md), [avatar.md](docs/avatar.md#testing)).
- **`packages/assistant`, `runTask`, `laplace-task`** → `pnpm test packages/assistant packages/engine apps/cli/test/task.test.ts`, plus `pnpm review-decisions` if changing `review.ts` (billed ~$0.002), and one billed `laplace-task` run if changing task behavior ([assistant.md](docs/assistant.md#laplace-task)).
- **Voice loop / transport / `packages/runtime`** → `pnpm test packages/voice packages/webrtc packages/runtime`, then billed `e2e-call.ts` + `e2e-compare.ts` ([voice-engine.md](docs/voice-engine.md#real-calls)).
- **Retrieval / offline ingest / `packages/retrieval` write side** → `pnpm laplace-eval-retrieval --compare ...` ([retrieval.md](docs/retrieval.md#evaluation)), re-run both ingests if changing embeddings, and run `EIDOLON_REQUIRE_PARITY=1 pnpm test` on the `*_real.test.ts` suites ([typescript.md](docs/typescript.md#real-data-tests)).
- **Gate / director / `prompt.md` markup / selfies / Mem0** → `pnpm gate-decisions`; run `pnpm director-decisions` for director question or state changes (`node docs/benchmarks/2026-11-10-director/score.ts --cached --check` only after threshold or label edits); live `e2e-call.ts` for markup ([personas.md](docs/personas.md#prompt-and-code-rules)); `pnpm laplace-generate-image` for selfies ([selfies.md](docs/selfies.md)); in-process Zvec round-trip for `packages/memory` ([self-hosting.md](docs/self-hosting.md#identity-quotas-and-mem0)).

## Rules

Things you would break without being told. Subsystem-specific rules live in the docs linked above.

### The Python

**The Python is for human readers only.**
- Covers `laplace_eidolon/`, `tests/`, `pyproject.toml`, `uv.lock`, and every `*.py` file (old reference runtime).
- Agents never read, run, edit, port from, or cite it, or use it to decide TypeScript behavior.
- Only release automation writes versions into `pyproject.toml`, `uv.lock`, and `bot.py`.
- `.claude/settings.json` denies those paths and `uv`/`python`/`pytest` commands; `apps/cli/test/no_python.test.ts` fails if TS spawns it or if `AGENTS.md` (outside this section and the one layout line) or `docs/*.md` names it.

### Architecture and boundaries

- **Production never runs local mode, assistant, ingest, SDK, or desktop.** `apps/bot/src/main.ts` never imports `apps/bot/src/local/`, `@eidolon/assistant`, `@eidolon/ingest`, `@eidolon/cli`, `@laplace.live/eidolon-sdk`, `@eidolon/chat/jsonl`, or `apps/desktop` (enforced by Biome and `boundaries.test.ts`; `docker.yml` skips builds for them). Only `packages/runtime` imports `@eidolon/voice` and `@eidolon/webrtc`.
- **Single-responsibility core paths:** Only `@eidolon/engine` talks to minds; only `@eidolon/providers/realtime` runs realtime sessions; no vendor SDK makes requests (`packages/providers` uses `fetch` + `reportUsage`, and `@eidolon/providers/catalog` stays import-free for `apps/web`).
- **Fail open and race safely:** Optional tiers (`Mem0`, RAG, reranker, retrieval gate) fail open (`packages/engine/src/parts.ts`); `unlessSkipped` races the gate without delaying recall ([retrieval-gate.md](docs/retrieval-gate.md)).
- **Env and `.env` hygiene:** `load-env.ts` (imported first by entry points, after `environ.ts` in local mode) is the only `.env` reader; never read `process.env` at module import, and always parse env values via `envInt`/`envFloat`/`envStr`/`envOptional` (`packages/config/src/env.ts`) so blank `KEY=` stays unset.
- **Node 24, pnpm policy, no Bun APIs, and `shippedPath`:** `packageManager` pins pnpm; `pnpm-workspace.yaml` enforces `allowBuilds` and 3-hour `minimumReleaseAge`. Never use Bun modules/globals/`import.meta.{dir,path}` or `Uint8Array.{fromBase64,toBase64,fromHex}` (`no_bun.test.ts`). Resolve shipped assets via `shippedPath` (`@eidolon/config`), never `import.meta` (exceptions: desktop main's `process.resourcesPath` and SDK avatar's `psd2liveRuntimeUrl()`).
- **Root Vitest & isolated data home:** Always run `pnpm test [paths]` from the repo root so `vitest.config.ts` loads `isolated-home.ts`. Tests deleting inside data home must import `packages/config/test/isolated-guard.ts` first.
- **Local desktop runs and Windows processes:** Spawn children with `spawnProcess`/`killTree` (`@eidolon/config`) and `jsRuntime()` (`ELECTRON_RUN_AS_NODE=1` must never reach GUI or owner-chosen commands/MCP servers). Every local desktop test run uses background mode (`EIDOLON_DESKTOP_BACKGROUND=1`) on a temp `EIDOLON_HOME` and `--user-data-dir` ([desktop.md](docs/desktop.md#driving-it-in-background-mode)).
- **Third-party ported headers:** Keep BSD-2 (`pipedog`), MIT (`pi-mono`, `deepseek-harness`, `cross-spawn`, `psd2live`), and ISC/BSD (`npm`) file headers, package `LICENSE-*`/`THIRD_PARTY.md` files, and `NOTICE` entries in sync (`build.test.ts` checks them).

### Shipping a change

- **User-facing changes require a changeset in the same commit:** run `pnpm changeset add --minor|--patch <packages> -m "<kind>: <summary>"` (`--minor` for features/substantial changes, `--patch` for fixes; skip for CI, docs, tests, dev tooling, invisible refactors). Use `laplace-eidolon,@laplace.live/eidolon` together for bot/CLI/local changes, add `laplace-eidolon-desktop` when desktop users see it, and name `@laplace.live/eidolon-sdk` for SDK changes (`@eidolon/*` are ignored). Summary must start with `feat:`/`fix:`/`perf:`/`chore:` + one capitalized plain sentence under ~80 chars ([releasing.md](docs/releasing.md#changesets)).
- **Never bump versions, push release tags, edit `CHANGELOG.md`/`changelog.json`, or publish to npm by hand.** Merging the Release PR automates it (`release.yml`). Every non-ignored push to `master` rebuilds `:edge` and Watchtower restarts production, dropping live calls.
- **UI strings:** Write English Lingui macros in Title Case for controls/headings and sentence case for prose/errors, run `pnpm i18n`, and update `zh-Hans.po` ([web-app.md](docs/web-app.md#strings-and-languages)).
- **Code discipline:** Fix defects with concrete triggers instead of speculative guards or single-caller abstractions; cite upstream bugs in comments; treat tool schemas and descriptions as live API surface.

## Comments

Sparse and terse: explain *why* (external quirk, measured number, trap, 1–2 line module orientation), never *what* or repo layout. Keep `// @ts-expect-error`, `// biome-ignore`, `TODO`/`FIXME`, and license headers untouched. Full guide: [comments.md](docs/comments.md).

## Editing these instructions

`CLAUDE.md` is a symlink to `AGENTS.md` — **edit the real file.**

**This file is a router, not an encyclopedia.** It carries cross-cutting rules and the "Where to look" index; subsystem internals and rules belong in [docs/](docs/). `pnpm doc-check` (`scripts/verify-docs.ts`, CI's `docs.yml`) enforces budgets on `AGENTS.md` and `README.md`, link/anchor integrity, reachability of every `docs/*.md` from here, script/workspace coverage, changeset summary format, and the Electron floor marker. **The budget is a smoke alarm for prose creeping back in, not a quota to spend.**
