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
- **Every path a tool touches passes `FolderPolicy` before any I/O.** The `AGENTS.md` and
  `CLAUDE.md` files the worker's prompt reads are read where they lie, from what the policy allows
  or, outside it, from a file of either name it doesn't deny (the folders' between home and the
  task's, where an owner's dotfiles link leads): a cloned repo's link to a key, or to any other
  file, stays out. A tool's failure, a refused path included, is a result with `isError`; it never
  throws into the loop.
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
  fails as the settings would, before any request. On Anthropic a task's reply may run to 64,000
  tokens, thinking included, where her chat's stops at 4,096, so one long `write` fits; elsewhere
  no cap is sent and the provider's default applies.
- **`assistant.folders`** are granted read-write to every task, besides its own folder.

## `FolderPolicy`

- **Grants:** the task's folder, read-write, and the folders granted it, each read or read-write.
  A grant that is or holds the home folder (`/`, `~`, `/Users`, a link to home) is refused with
  `GrantRefused`, and one that comes to lead there during the task (a link past a missing folder,
  once the task makes that folder) grants nothing from then on; `~/Git` is fine.
- **Denied, even inside a grant:** the data home, the app root (`EIDOLON_APP_ROOT`, or the
  checkout), `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.netrc` and `~/.git-credentials`,
  and the `.env` the app reads (`findDotenv`'s), where it leads if it is a link. From a linked
  worktree that `.env` is the main checkout's, and the main checkout is denied with it, unless the
  worktree lies inside it: then the `.env` alone is. macOS and Windows compare these in any case.
- **Never written: anything in a git directory,** a `.git` folder or any folder git takes for one
  whatever its name (a `HEAD` beside `objects/` and `refs/`, or beside a `commondir`: a bare
  `site.git`), nor the piece that would make a folder one. git runs a git directory's config and
  hooks (a `core.fsmonitor` on the owner's next `git status`) without showing a change. Reading is
  fine.
- **Decided on disk:** a path's realpath, or its deepest existing ancestor's plus the rest, must lie
  in a grant, so `..` and symlinks, dangling ones included, can't lead out. A dangling link's `..`
  is taken on disk, as the kernel takes it: past a missing folder it leads nowhere, and the path
  is refused (`nope/../../..` isn't home). A grant that leads nowhere grants nothing.
- **A refused path** is an error result naming it. One outside the grants carries `refused`
  (`{ path, access }`), for an approval to ask about; a denied one doesn't, as no approval opens it.
  `laplace-task`'s `--folder` and `--allow` decide what is granted.

## The tools

Ported from pi-mono's coding agent, but `todo`; each says in the worker's prompt what it is for.

| Tool | Takes | Limits |
| --- | --- | --- |
| `read` | `path`, `offset` (1-based), `limit` | text only, a note for binary and image files; 2,000 lines or 50 KB from the head, saying how to read on; of a line over 50 KB, its first 50 KB |
| `write` | `path`, `content` | makes parent folders; writes to one file queue, keyed by realpath |
| `edit` | `path`, `edits[{ oldText, newText }]` | an exact match, then a fuzzy one, which replaces only the text it covers; each edit unique and apart; keeps CRLF and the BOM; refuses a file that isn't UTF-8 |
| `ls` | `path`, `limit` | 500 entries or 50 KB; `/` after folders, dotfiles listed |
| `find` | `pattern`, `path`, `limit` | 1,000 results or 50 KB; `Bun.Glob` with `.gitignore` rules (the `ignore` package), not pi's `fd` |
| `grep` | `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `limit` | 100 matches, 500 characters of a line around its match, 50 KB; JavaScript regexes in Unicode mode, not pi's `rg`, though a `]` or `}` that closes nothing matches itself, as in `rg`; skips binary files |
| `todo` | `items[{ text, status }]` | replaces the whole list, the task's plan; its result's `details` hold it |

`find` and `grep` skip `.git` and `node_modules`, never follow symlinks, and check the policy
before each folder they enter; an absolute pattern may name the folder as the task does or as
it lies on disk. `read` and `grep` read UTF-16 by its byte order mark, and as GB18030, which
`read` notes, text whose first 8,000 bytes fail as UTF-8 and pair as GBK's do; other text that
isn't UTF-8 (Latin-1, UTF-8 with a stray byte) reads as UTF-8, with replacement characters.
`read` and `write` run again after a restart cut them short; `edit` doesn't (`replay: "never"`).

`grep` matches in a child Bun, since a backtracking regex can hold its thread for minutes (`\w+x`
over a long line); a cancel kills it, and it ends itself once the process that started it is
gone. A line whose test fails after 50 ms (past its backtracking limit JavaScriptCore answers no
match, with no error), or a batch of lines still running after 2 s, is left unsearched and named
in a notice that says how to simplify the pattern. The search goes on past it, and stops with
what it found once such lines have taken 5 s.

## The loop

`runTask` is pi-agent-core's `agent-loop.ts`, with the queue handling of its `agent.ts`, on
eidolon's `Mind`. A run is turns: take steering, make a request, run its tool calls, end the
turn; it ends once a turn makes no calls and no follow-up waits. Arguments are validated against
the tool's schema before anything runs (pi's `validateToolArguments`, after a tool's
`prepareArguments`); the gate sees each call that validated, one at a time, in order; a batch
runs in parallel unless one of its tools is sequential; `afterToolCall` may change a result, or
end the run once every result in a batch asks to. Steering enters after a batch, follow-ups only
when the run would end.

What it adds to pi:

- **Durable.** Each entry is in the transcript before its event is yielded, and a `tool-start`
  before its call runs. A store holding more than its brief resumes: a call with no `tool-start`
  runs as new, one with a `tool-start` and no result runs again under `replay: "safe"`, and gets
  "Interrupted by a restart…" under `never`. A stored reply the output limit cut off has its
  unanswered calls answered as below, never run, and a last reply that can't be the report is
  asked again, with a note after it saying why.
- **Steering doesn't wait out a sequential batch:** the calls not yet started get "Skipped to
  process an incoming message."
- **Context, in the request only:** sizes count four characters a token, and a token for each
  Chinese, Japanese or Korean character or fullwidth mark. A tool result older than the newest
  40,000 tokens becomes a stub naming the call and its size. The boundary moves in steps of
  20,000, so the newest 20,000 to 40,000 tokens stay whole and each request between two steps
  only adds to the one before, which keeps the provider's prompt cache. Past
  `assistant.contextTokens` less 16,384 (less a quarter, in a window under 65,536), the older part
  is compacted into pi's structured summary through the task's own mind, keeping the newest
  ~20,000 tokens whole (half the threshold, where that is less); a summary that was cut off or
  stopped fails the task. A provider's context-overflow error compacts once and retries.
- **Thinking, on Anthropic,** goes back with a reply only while everything before it is as it
  was ([prefix checks](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/prefix-checks)),
  so a masking step or a compaction drops the thinking of the replies before it.
- **Retries:** a 429, a 5xx, a network error, an error event mid-stream that says it will pass
  (Anthropic's `overloaded_error`, OpenRouter's "Provider disconnected unexpectedly"), or a reply
  that ended with no finish reason or one outside pi's set (DeepSeek's
  `insufficient_system_resource`) is retried after 1, 4 and 15 seconds.
- **Pauses:** at each multiple of `assistant.spendPauseUsd` (0 never), when the same calls repeat
  three turns running (one whose arguments couldn't be read is the same only when the text it
  sent is; the pause names each call by its arguments' first 200 characters), and for an approval
  (the gate's, or a refused path's with `pauseOnRefused`).
- **The outcome is the runtime's:** `succeeded` with the last reply as its report, `failed`,
  `cancelled` or `paused`. A reply the output limit cut off runs none of its calls: each gets pi's
  "Re-issue the tool call with complete arguments" result, and the task goes on. A call whose
  arguments aren't a JSON object gets an error result and never runs; the rest of its batch does.
  A reply with no calls that was cut off, stopped by its provider (`content_filter`, `refusal`),
  or ended for tool calls it didn't make can't be the report, and fails the task.

## The task's files

`<data home>/tasks/<id>/`, the folder 0700 and its files 0600; the id is a UUIDv7.

- **`transcript.jsonl`** is append-only, each line `{ seq, at, type, … }` synced before it is shown:
  `brief`, `assistant` (its text, its calls and its `finishReason`; a call whose arguments
  couldn't be read keeps their text as `unparsed`, its `arguments` `{}`), `tool-start`,
  `tool-result`, `steer`, `follow-up`, `compaction`, `pause`, `resume` and `end`. A torn last line
  is dropped.
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
  root, one holding home, or a link that leads nowhere, exits 2 before anything is made.
- **Output:** the worker's words as they stream and a line per tool on stdout, then how it ended;
  logs on stderr. Under `--json`, stdout carries only NDJSON: `task`, each `TaskEvent`, then
  `outcome`.
- **Exits** 0 succeeded, 1 failed, 3 paused, 130 cancelled (Ctrl-C); each but the first prints
  the command that resumes it. A spend pause in a terminal asks `Continue? [y/N]` and goes on in
  the same process on yes; `--json` never asks.
- **A model with no price** (an `openai-compatible` account, or a model the catalog doesn't price
  on a provider that, unlike OpenRouter, doesn't report each request's cost), or a server that
  reports no usage, can't count toward the spend pauses. While they are on, the command's gate
  pauses its task (`approval` under `--json`) before the first call that would run after such a
  request, though not while every call fails before running. In a terminal it asks to go on
  without them for the rest of the run, and each `--resume` asks again after its first request,
  so resume it with `--model` on a priced model, or start it with `assistant.spendPauseUsd` at 0.
- **The worker's words and tool lines** reach the terminal with their control characters as
  `\u` escapes, so a file name can't write the clipboard (OSC 52) or move the cursor.
- **A transcript gone or damaged** since the task stopped exits 2 on `--resume`, and leaves
  `task.json` as it was.
- **One process per task:** a task holds the lock `task:<id>` while it runs, so a second
  `--resume` of it exits 1.
- **It is A's billed check:** `bun run laplace-task --folder <tmp>/mg-react-todomvc "写一个 React
  TodoMVC，单文件 index.html"` on a model you pick, then open the page and try adding, ticking,
  deleting and the three filters.
