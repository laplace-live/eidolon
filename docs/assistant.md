# The assistant

Assistant Mode: tasks a persona runs on the owner's computer, writing and editing files and
looking things up in a folder, while she reports the result as her own. A task is a worker on a
model of its own, with no persona, that works through tools until it can report. So far it runs
from `laplace-task`; the local app's tasks and her `start_task` tool come later.

| Part | Where |
| --- | --- |
| the loop, `runTask` | `packages/engine/src/task.ts` and `task/` |
| the tools, `FolderPolicy`, the worker's prompt, the task's files | `packages/assistant` (`@eidolon/assistant`) |
| the `assistant` role, `createMind("assistant")` | `packages/providers`, `packages/engine/src/mind` |
| `laplace-task` | `apps/cli/src/task.ts` |

## Rules

- **Production never has the assistant.** Only `apps/bot/src/local` and `apps/cli` import
  `@eidolon/assistant`: Biome's `noRestrictedImports` holds it, and `boundaries.test.ts` keeps it
  out of what `main.ts` reaches. `docker.yml` skips the image build for `packages/assistant`, so
  lift the fence and the paths-ignore together, as with `@eidolon/ingest`.
- **The loop is the engine's, and the engine imports nothing from `@eidolon/assistant`.**
  `runTask` takes its tools, store, inbox and meter injected; only the engine talks to a mind.
- **Every path a tool touches passes `FolderPolicy` before any I/O.** A tool's failure, a refused
  path included, is a result with `isError`; it never throws into the loop.
- **Every entry is stored before it is shown,** and the outcome comes from the runtime, never from
  the worker's text.
- **The worker has no persona:** the brief, the folder's `AGENTS.md` and `CLAUDE.md`, its tools'
  rules, the date and the folder. No `prompt.md`, Mem0 or persona facts.
- **Every task request is billed as source `task`, with the task's id as its session.** `runTask`
  runs in that usage scope; `createMind`'s `tap` hands each record to the task's meter too.
- **Ported pi-mono files keep pi's MIT header,** then `Ported from pi-mono <path>@ac78a60`; the
  package keeps `LICENSE-pi` and `THIRD_PARTY.md`, and `NOTICE` names the holder
  (`apps/eidolon/test/build.test.ts` checks it).

## Assistant Mode and the role

The settings are rows of `SETTINGS`, documented with the rest in [personas.md](personas.md):
`assistant.enabled`, `.provider`, `.model`, `.folders`, `.spendPauseUsd` and `.contextTokens`.

- **`assistant.enabled`** (default on) turns Assistant Mode off in the local app.
  `laplace-task`, a command run on purpose, ignores it.
- **The `assistant` role** ([providers.md](providers.md)) has no default provider and no default
  model, whatever the provider: tasks stay off until both are named, and her chat model is never
  the fallback. `createMind("assistant", { account, model })` overrides both for one task, and
  fails as the settings would, before any request.
- **`assistant.folders`** are granted read-write to every task, besides its own folder.

## `FolderPolicy`

- **Grants:** the task's folder, read-write, and the folders granted it, each read or read-write.
  A grant that is or holds the home folder (`/`, `~`, `/Users`, a link to home) is refused with
  `GrantRefused`; `~/Git` is fine.
- **Denied, even inside a grant:** the data home, the app root (`EIDOLON_APP_ROOT`, or the
  checkout), `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.netrc` and `~/.git-credentials`.
  macOS and Windows compare these in any case.
- **Decided on disk:** a path's realpath, or its deepest existing ancestor's plus the rest, must lie
  in a grant, so `..` and symlinks, dangling ones included, can't lead out.
- **A refused path** is an error result naming it. One outside the grants carries `refused`
  (`{ path, access }`), for an approval to ask about; a denied one doesn't, as no approval opens it.
  `laplace-task`'s `--folder` and `--allow` decide what is granted.

## The tools

Ported from pi-mono's coding agent, but `todo`; each says in the worker's prompt what it is for.

| Tool | Takes | Limits |
| --- | --- | --- |
| `read` | `path`, `offset` (1-based), `limit` | text only, a note for binary and image files; 2,000 lines or 50 KB from the head, saying how to read on |
| `write` | `path`, `content` | makes parent folders; writes to one file queue, keyed by realpath |
| `edit` | `path`, `edits[{ oldText, newText }]` | an exact match, then a fuzzy one; each edit unique and apart; keeps CRLF and the BOM; refuses a file that isn't UTF-8 |
| `ls` | `path`, `limit` | 500 entries or 50 KB; `/` after folders, dotfiles listed |
| `find` | `pattern`, `path`, `limit` | 1,000 results or 50 KB; `Bun.Glob` with `.gitignore` rules (the `ignore` package), not pi's `fd` |
| `grep` | `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `limit` | 100 matches, lines cut at 500 characters, 50 KB; JavaScript regexes, not pi's `rg`; skips binary files |
| `todo` | `items[{ text, status }]` | replaces the whole list, the task's plan; its result's `details` hold it |

`find` and `grep` skip `.git` and `node_modules`, never follow symlinks, and check the policy
before each folder they enter. `read` and `write` run again after a restart cut them short;
`edit` doesn't (`replay: "never"`).

## The loop

`runTask` is pi-agent-core's `agent-loop.ts`, with the queue handling of its `agent.ts`, on
eidolon's `Mind`. A run is turns: take steering, make a request, run its tool calls, end the
turn; it ends once a turn makes no calls and no follow-up waits. Arguments are validated against
the tool's schema before anything runs (pi's `validateToolArguments`, after a tool's
`prepareArguments`); the gate sees calls one at a time, in order; a batch runs in parallel unless
one of its tools is sequential; `afterToolCall` may change a result, or end the run once every
result in a batch asks to. Steering enters after a batch, follow-ups only when the run would end.

What it adds to pi:

- **Durable.** Each entry is in the transcript before its event is yielded, and a `tool-start`
  before its call runs. A store holding more than its brief resumes: a call with no `tool-start`
  runs as new, one with a `tool-start` and no result runs again under `replay: "safe"`, and gets
  "Interrupted by a restart…" under `never`.
- **Steering doesn't wait out a sequential batch:** the calls not yet started get "Skipped to
  process an incoming message."
- **Context, in the request only:** a tool result older than the newest 40,000 tokens becomes a
  stub naming the call and its size; past `assistant.contextTokens` − 16,384, the older part is
  compacted into pi's structured summary through the task's own mind, keeping the newest ~20,000
  tokens whole. A provider's context-overflow error compacts once and retries.
- **Retries:** a 429, a 5xx or a network error is retried after 1, 4 and 15 seconds.
- **Pauses:** at each multiple of `assistant.spendPauseUsd` (0 never), when the same calls repeat
  three turns running, and for an approval (the gate's, or a refused path's with `pauseOnRefused`).
- **The outcome is the runtime's:** `succeeded` with the last reply as its report, `failed`,
  `cancelled` or `paused`. A reply the output limit cut off can't be the report, and fails the task.

## The task's files

`<data home>/tasks/<id>/`, the folder 0700 and its files 0600; the id is a UUIDv7.

- **`transcript.jsonl`** is append-only, each line `{ seq, at, type, … }` synced before it is shown:
  `brief`, `assistant` (its text and calls), `tool-start`, `tool-result`, `steer`, `follow-up`,
  `compaction`, `pause`, `resume` and `end`. A torn last line is dropped.
- **`task.json`** is the snapshot a list reads, replaced whole through a rename: its brief,
  status, model, grants, spend, the files read and written, and its outcome.

## `laplace-task`

```bash
bun run laplace-task --folder <path> [--allow <path>]... [--model <account>/<model>] \
  [--deliverable <text>] [--check <text>] [--json] "<goal>"
bun run laplace-task --resume <id> [--model <account>/<model>] [--json]
```

- **One task in the foreground,** on the assistant role's model unless `--model` names another,
  split at its first slash (`openrouter/anthropic/claude-sonnet-5.5`). With neither, it exits 2
  saying how to choose one. The npm package runs it as `eidolon task`.
- **Its folder is made if missing,** once the policy lets a task write there. `--folder`,
  `--allow` and `assistant.folders` are read-write grants; a folder in the data home or the app
  root, or one holding home, exits 2 before anything is made.
- **Output:** the worker's words as they stream and a line per tool on stdout, then how it ended;
  logs on stderr. Under `--json`, stdout carries only NDJSON: `task`, each `TaskEvent`, then
  `outcome`.
- **Exits** 0 succeeded, 1 failed, 3 paused, 130 cancelled (Ctrl-C); each but the first prints
  the command that resumes it. A spend pause in a terminal asks `Continue? [y/N]` and goes on in
  the same process on yes; `--json` never asks.
- **One process per task:** a task holds the lock `task:<id>` while it runs, so a second
  `--resume` of it exits 1.
- **It is A's billed check:** `bun run laplace-task --folder <tmp>/mg-react-todomvc "写一个 React
  TodoMVC，单文件 index.html"` on a model you pick, then open the page and try adding, ticking,
  deleting and the three filters.
