# The assistant

Assistant Mode: tasks a persona runs on the owner's computer, writing and editing files in a
folder and reading pages on the web, while she reports the result as her own. A task is a worker on
a model of its own, with no persona, that works through tools until it can report. In the local
app she starts one with `start_task` when the owner asks her in a chat; the task's card in that
chat takes the owner's answers, and she reports there when it ends. `laplace-task` runs one from a
terminal.

| Part | Where |
| --- | --- |
| the loop, `runTask`, and its meter, `UsageMeter` | `packages/engine/src/task.ts` and `task/` |
| the tools, `FolderPolicy`, the worker's prompt, the task's files | `packages/assistant` (`@eidolon/assistant`) |
| the `assistant` role, `createMind("assistant")` | `packages/providers`, `packages/engine/src/mind` |
| the app's tasks: `TaskManager`, `start_task` and her hint | `apps/bot/src/local/tasks/` |
| the task routes | `apps/bot/src/local/routes/tasks.ts` |
| the task card, the waiting bar, the Tasks list | `apps/web/src/features/tasks/` ([web-app.md](web-app.md#tasks)) |
| `laplace-task` | `apps/cli/src/task.ts` |

## Rules

- **Production never has the assistant.** Only `apps/bot/src/local` and `apps/cli` import
  `@eidolon/assistant`: Biome's `noRestrictedImports` holds it, and `boundaries.test.ts` keeps it
  out of what `main.ts` reaches. `docker.yml` skips the image build for `packages/assistant`, so
  lift the fence and the paths-ignore together, as with `@eidolon/ingest`. Production's chat
  endpoint never offers `start_task` (`production.test.ts`).
- **In the app, a task starts only in a chat:** her `start_task` is the one way in. No route
  creates, steers or deletes a task, and the Tasks page only lists them.
- **Only the local viewer answers a task.** Every task route is under `/api/local`, behind the
  session; a listed origin (`EIDOLON_LOCAL_ALLOWED_ORIGINS`) gets 403 on each.
- **The loop is the engine's, and the engine imports nothing from `@eidolon/assistant`.**
  `runTask` takes its tools, store, inbox and meter injected, and `start_task` reaches her turn as
  a background tool; only the engine talks to a mind.
- **Every path a tool touches passes `FolderPolicy` before any I/O.** The `AGENTS.md` and
  `CLAUDE.md` files the worker's prompt reads are read where they lie, from what the policy allows
  or, outside it, from a file of either name it doesn't deny (the folders' between home and the
  task's, where an owner's dotfiles link leads): a cloned repo's link to a key, or to any other
  file, stays out. A tool's failure, a refused path included, is a result with `isError`; it never
  throws into the loop.
- **Every entry is stored before it is shown,** and the outcome comes from the runtime, never from
  the worker's text.
- **A task's steps never enter the chat log.** The chat holds her `tool-call`, its `started`
  result and its `final`; every step is in the task's transcript.
- **Interruptions never stop a task.** Only a cancel does: the card's Stop, a Deny at its start,
  turning Assistant Mode off, or deleting its chat.
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
Settings → Assistant Mode edits them.

- **`assistant.enabled`** (default on) is Assistant Mode in the local app.
  - **Off:** she has no `start_task` and no hint, the Tasks list and its nav entry are hidden,
    and a card's answers are refused `409 assistant-off`; its Stop, and a Deny at a start, still
    work.
  - **Turning it off cancels every live task** (running, paused, awaiting approval or
    interrupted), and a start being made as it turns off: the manager waits for that start, then
    cancels it with the rest before it sends a request. PUT settings tells the manager when the
    effective value changes, so `ASSISTANT_ENABLED` in the environment outlasts the file, and
    answers once the cancels are done. Settings asks first while any task is live, counted from a
    fresh `GET tasks`.
  - `laplace-task`, a command run on purpose, ignores it.
- **Ready** means `createMind("assistant")` would resolve, an account and a model named and the
  account's key there, and that no assistant folder is or holds the home folder, which every
  task's `FolderPolicy` would refuse (`assistantProblem()` in `status.ts`, which sends nothing;
  such a folder can still come from `ASSISTANT_FOLDERS` or a hand-edited `settings.yaml`, which PUT
  settings would refuse). `GET status` carries `assistant: { enabled, ready, problem, running }`:
  `problem` says in English why it isn't ready, and `running` counts the manager's `running`
  tasks. Until it is ready she has no
  `start_task` and no hint, Settings and the Tasks list show `problem`, and a card's answers but a
  Deny at its start are refused `409 assistant-not-ready`, since each would run the task.
- **The `assistant` role** ([providers.md](providers.md)) has no default provider and no default
  model, whatever the provider: tasks stay off until both are named, and her chat model is never
  the fallback. `createMind("assistant", { account, model })` overrides both for one task, and
  fails as the settings would, before any request. On Anthropic a task's reply may run to 64,000
  tokens, thinking included, where her chat's stops at 4,096, so one long `write` fits; elsewhere
  no cap is sent and the provider's default applies.
- **`assistant.folders`** are granted read-write to every task, besides its own folder. A task she
  starts in one runs at once; anywhere else it asks the owner first.

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
  Home and every folder holding it (`/`, `/Users`, a link to home) are denied, not outside, since
  no grant may hold them: `ls ~` fails at once with `No task may read <home>, whatever access it is
  given.`
- **What is granted:** for `laplace-task`, `--folder`, `--allow` and `assistant.folders`; for an
  app task, its folder, `assistant.folders` as they stand when each run starts, and what its path
  approvals granted it.

## The tools

Ported from pi-mono's coding agent, but `todo` and `web_fetch`, which are eidolon's own; each says
in the worker's prompt what it is for.

| Tool | Takes | Limits |
| --- | --- | --- |
| `read` | `path`, `offset` (1-based), `limit` | text only, a note for binary and image files; 2,000 lines or 50 KB from the head, saying how to read on; of a line over 50 KB, its first 50 KB |
| `write` | `path`, `content` | makes parent folders; writes to one file queue, keyed by realpath |
| `edit` | `path`, `edits[{ oldText, newText }]` | an exact match, then a fuzzy one, which replaces only the text it covers; each edit unique and apart; keeps CRLF and the BOM; refuses a file that isn't UTF-8 |
| `ls` | `path`, `limit` | 500 entries or 50 KB; `/` after folders, dotfiles listed |
| `find` | `pattern`, `path`, `limit` | 1,000 results or 50 KB; `Bun.Glob` with `.gitignore` rules (the `ignore` package), not pi's `fd` |
| `grep` | `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `limit` | 100 matches, 500 characters of a line around its match, 50 KB; JavaScript regexes in Unicode mode, not pi's `rg`, though a `]` or `}` that closes nothing matches itself, as in `rg`; skips binary files |
| `web_fetch` | `url`, http or https | GET only, at most 5 redirects, 30 s for the whole call, 2 MB read and 50 KB shown. HTML becomes readable text: headings as `#`, list items as `-`, table cells apart, links as `text (url)`, `pre` fenced and `code` in backticks, with `script`, `style`, `noscript`, `svg`, `nav`, `footer` and `template` left out. Text, JSON, XML and JavaScript come as they are, and so does a body with no type or sent as `application/octet-stream` when it reads as UTF-8 text; anything else gets a line naming its type and size. A status of 400 or more is an error with its status line and the start of the body. `details`: `{ url, finalUrl, status, contentType, bytes }` |
| `todo` | `items[{ text, status }]` | replaces the whole list, the task's plan; its result's `details` hold it |

`find` and `grep` skip `.git` and `node_modules`, never follow symlinks, and check the policy
before each folder they enter; an absolute pattern may name the folder as the task does or as
it lies on disk. `read` and `grep` read UTF-16 by its byte order mark, and as GB18030, which
`read` notes, text whose first 8,000 bytes fail as UTF-8 and pair as GBK's do; other text that
isn't UTF-8 (Latin-1, UTF-8 with a stray byte) reads as UTF-8, with replacement characters.
`read`, `write` and `web_fetch` run again after a restart cut them short; `edit` doesn't
(`replay: "never"`).

`grep` matches in a child Bun, since a backtracking regex can hold its thread for minutes (`\w+x`
over a long line); a cancel kills it, and it ends itself once the process that started it is
gone. A line whose test fails after 50 ms (past its backtracking limit JavaScriptCore answers no
match, with no error), or a batch of lines still running after 2 s, is left unsearched and named
in a notice that says how to simplify the pattern. The search goes on past it, and stops with
what it found once such lines have taken 5 s.

**`web_fetch` never reaches the owner's computer or network.** It is offered only when the task
may use the web (`createTaskTools(guard, { web })`), and `web.allows(host)` decides which sites,
asked at the call and again at every redirect.
- `localhost`, `*.localhost`, `*.local` and `*.internal` are refused by name, and a name is refused
  when any address it resolves to is loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7),
  link-local (169.254/16, fe80::/10), CGNAT (100.64/10), 0.0.0.0/8 or `::`, multicast or
  broadcast, or an IPv4-mapped IPv6 form of one. So is one of this computer's own addresses, or
  one on a network an interface is on, from each interface's address and prefix as
  `os.networkInterfaces()` gives them at each check (temporary IPv6 addresses come and go): a
  global IPv6 address and the LAN's /64 are in no fixed range. An address in a URL is checked the
  same way, and `webFetchHost` returns null for a refused one, so the owner is never asked about
  it. Every redirect target is checked again.
- The connection goes to the address that was checked, with the name sent as `Host` and as the TLS
  server name (Bun's documented "Connecting to a specific address"), so DNS rebinding can't lead
  it elsewhere. For the same reason it never goes through `HTTP_PROXY` or `HTTPS_PROXY`.
- **Behind a fake-IP proxy,** a TUN that answers every name from 198.18.0.0/15 and resolves the
  name itself when a connection reaches one of those, the address checked isn't the one reached.
  So a system answer with any address in that range is set aside, and the name is asked of
  Cloudflare's DNS over HTTPS by address (`GET https://1.1.1.1/dns-query?name=<host>&type=A` and
  `&type=AAAA`, `accept: application/dns-json`, `proxy: false`, under the call's cancel and 30 s).
  Its A and AAAA answers (CNAMEs skipped) are checked like any others and one is dialed, pinned;
  each redirect hop goes the same way. 198.18.0.0/15 in a URL or a DoH answer is refused, checked
  before the interfaces, since the TUN has its own address in it. A DoH request that fails, or
  answers anything but 200 with NOERROR or NXDOMAIN, and an answer with no address, fail the call
  with a message naming the proxy and the resolver; it never falls back to the stand-in. NXDOMAIN
  reads as `Can't find <host> (ENOTFOUND).`, and when none of the real addresses answers, the
  error says they came from DoH in the proxy's place before Bun's own text.
- **Not covered:** a TUN whose sniffer reads the Host or SNI of the pinned connection and resolves
  the name again (mihomo's sniffer, or sing-box's sniff, with override-destination) can still be
  led to loopback or the LAN by a rebinding name; this Mac's Surge carries a pinned connection to
  its address. Behind a fake-IP proxy Cloudflare sees every name fetched; a fake-IP range other
  than 198.18.0.0/15 isn't recognized; where 1.1.1.1 can't be reached every name fails, and where
  the proxy carries no IPv6, so does a name with only IPv6 addresses (`https://ipv6.google.com/`).
  An address on no network of this computer's (the router's public IPv4, a network behind the
  router) isn't refused, and an interface that declares a broad public prefix has all of it
  refused.
- A URL's user and password aren't sent. A redirect to a site the task may not use ends the call
  with an error naming the target, which the worker fetches directly to ask for that site.
- It runs no scripts and is `replay: "safe"`; the worker's rules say page text is untrusted.

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

- **A reply's calls run in its order when one writes:** `write` and `edit` are sequential, so a
  batch holding either runs one call at a time. A model that writes a file and reads it back in
  one reply expects the read to see the write; in parallel the read can finish first and fail, as
  it did on Claude Sonnet 5.5. Batches of reads alone still run in parallel.
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
- **The meter,** `UsageMeter` (`task/meter.ts`), adds up the records `createMind`'s `tap` hands
  it. The loop tells it each time a request's reply comes back whole (`requestEnded()`), a
  summary's included, never a failed attempt's. A request with no usage record leaves the
  context's size to the loop's estimate.
- **Pauses:**
  - **Spend:** at each multiple of `assistant.spendPauseUsd` (0 never).
  - **Unpriced:** while spend pauses are on, a request the meter couldn't count pauses the task
    before the next request, whatever that reply's calls did: they run, or fail before running,
    first. A request can't be counted when its model has no price (an `openai-compatible`
    account, or a model the catalog doesn't price on a provider that doesn't report cost) or it
    ended with no usage record. The only way on is without spend pauses: whoever continues sets
    the task's `spendPauseUsd` to 0.
  - Both are checked before each turn's request and again right after a compaction's summary, so
    a summary that crosses a step, or couldn't be counted, pauses before the turn's own request.
  - **Stall:** when the same calls repeat three turns running (one whose arguments couldn't be
    read is the same only when the text it sent is; the pause names each call by its arguments'
    first 200 characters).
  - **Approval:** the gate's, or a refused path's with `pauseOnRefused`.
- **The outcome is the runtime's:** `succeeded` with the last reply as its report, `failed`,
  `cancelled`, or `paused` for spend, stall, approval or unpriced. A reply the output limit cut
  off runs none of its calls: each gets pi's "Re-issue the tool call with complete arguments"
  result, and the task goes on. A call whose arguments aren't a JSON object gets an error result
  and never runs; the rest of its batch does. A reply with no calls that was cut off, stopped by
  its provider (`content_filter`, `refusal`), or ended for tool calls it didn't make can't be the
  report, and fails the task.

## The task's files

`<data home>/tasks/<id>/`, the folder 0700 and its files 0600; the id is a UUIDv7.

- **`transcript.jsonl`** is append-only, each line `{ seq, at, type, … }` synced before it is shown:
  `brief`, `assistant` (its text, its calls and its `finishReason`; a call whose arguments
  couldn't be read keeps their text as `unparsed`, its `arguments` `{}`), `tool-start`,
  `tool-result`, `steer`, `follow-up`, `compaction`, `pause`, `resume` and `end`. A torn last line
  is dropped.
- **`task.json`** is the snapshot a list reads, replaced whole through a rename: its brief,
  status, model, grants, spend, the files read and written, and its outcome. Still version 1, it
  may also hold, each checked when present:
  - `chat`: `{ id, persona, call }`, the chat, the persona and her `start_task` call. Only the
    app's tasks have it, and the app touches no task without it, since `laplace-task` may be
    running that one;
  - `reported: true`: its `final` is in the chat;
  - `pending` (`start`; a `path` with its access and `folder`, what an Allow grants, absent when
    the path alone is granted; or a `fetch` with its host) and `pause` (the latest pause's reason
    and detail);
  - `todo`, the latest plan; `inbox`, the lines a run hasn't taken yet (`steer`, `followUp`);
  - `web`: `{ mode, hosts, denied }`, mode `ask`, `any` or `off`, `ask` when absent;
  - `denied: true`: the owner denied it at its start.

## In the local app

### Her side: `start_task`

`start_task` and her hint (`apps/bot/src/local/tasks/tool.ts`) are offered only in her answers to
the owner's lines, typed or spoken, in a chat of hers alone while Assistant Mode is on and ready.
Her greeting and her report turns answer no line of the owner's, so they never get them: a task
can't start another, and a page a task quotes can't talk her into one. A group chat, a call and
production's chat endpoint never offer them. The turn engine takes the tool as a background tool
([chat.md](chat.md#a-turn-runturn)).

- **Arguments:** `{ goal, deliverable?, folder, check? }`, OpenClaw's objective, output, write scope
  and verification; `goal` and `folder` are needed, the folder absolute or under `~`. Their
  descriptions are in Chinese, in her register, and are live API surface, as the hint is.
- **It answers at once:** `{ task, status }`, status `running` or `awaiting-approval`, stored as
  her `tool-result` with `stage: "started"`; she then says a line about taking it on, and that the
  card may first ask the owner to allow it. The task's
  origin is `{ id, persona, call }`: the chat, her, and her call.
- **A refusal** the manager explains (Assistant Mode off or not ready, a folder it won't grant, a
  file or a path under one, one another live task works in) is an error result she tells the
  owner; there is no task.
- **`cancelOnInterruption` is false:** her turn's interruption never reaches the task.
- **Her hint**, after the selfie hint in her persona prefix:
  "你能直接用这台电脑做事：写代码、做网页、整理文件、上网查资料，都是你自己动手。要用电脑就调用
  start_task 工具，这是你碰电脑的唯一方式，不要说自己用不了电脑。调用后说一句交给你了就行；聊天里的任务卡片要是
  在问要不要开始，得对方点了允许才会开始，顺口提醒对方一声。做完了结果会自己回来。"
  It can't name the task's status: her view holds the call's started result as pipedog's placeholder,
  which says only that the call runs on.
- **Deleting a chat** stops its live tasks, after any `start_task` call the manager is still
  answering.

### The manager

`TaskManager` (`apps/bot/src/local/tasks/manager.ts`): one per server, made once by
`createLocalExtension().routes()`, handed to the routes, PUT settings, status and the chat runner,
and started once the server listens, before the ready line prints, so a start that can't bind
never resumes a task. `app.onStop` stops it before the chat runner shuts down.

- **Its tasks are the app's:** those whose `task.json` has `chat`. `laplace-task`'s are never
  listed, marked, resumed, cancelled or reported.
- **A start** expands `~` in the folder, which must be absolute, pass `FolderPolicy` as a grant and
  as a write, be a folder or not exist yet, and neither hold nor lie inside a live task's folder
  (`A task is already working in <folder>: <goal>.`); starts are made one at a time. A file is
  refused 400 `invalid-path` (`<folder> can't be a task's folder: it is a file`), and a path under
  one with the stat's ENOTDIR, since Always at the start would add it to `assistant.folders`. Inside `assistant.folders` the task runs at
  once; anywhere else it is `awaiting-approval`. It runs on the role's account and model;
  `deliverable` defaults to the goal and `check` to "Check the deliverable against the goal".
- **A run,** one per task, holds the lock `task:<id>`:
  - `runTask` on `createMind("assistant", { account, model, tap })`, billed through one
    `UsageMeter` per task, kept while the server runs unless the model changes, since a new one
    forgets an uncounted request;
  - its tools are `createTaskTools(policy, { web })`, `web` over the task's live web state and
    left out when the mode is `off`; its prompt is `buildTaskPrompt` with `loadContextFiles`;
  - `pauseOnRefused`, and a gate that pauses a `web_fetch` to a site not yet allowed before its
    `tool-start`, so the call is asked about again on resume;
  - it makes the folder if it is missing, and grants `assistant.folders` as they stand plus the
    task's own grants.
- **`task.json` follows the run** (`snapshot-file.ts`): at most once a second while it streams,
  and at once at every status change. `GET` answers from memory, so it is current while the file
  lags. The events stream follows the transcript, woken at each append.
- **Stopping the server** aborts each run's requests, makes its store and inbox take nothing more,
  and leaves it `interrupted`. The next start resumes interrupted tasks while Assistant Mode is on
  and ready; otherwise they wait for Continue. A task `task.json` calls `running` at a start, a
  crash's leftover, becomes `interrupted` unless another process holds its lock.
- **A run that can't be prepared,** as when its folder can no longer be made or granted, ends
  `failed` with the reason.
- **A cancel** (Stop, a Deny at the start, Assistant Mode off, a deleted chat) aborts the run,
  which stores `end(cancelled)`, or stores it under the task's lock when no run holds it, and drops
  the queued lines. A run already past its last check for the cancel stores its pause anyway; the
  cancel then ends the paused task as well, so it never answers with a live one. It works with
  Assistant Mode off, and on a damaged transcript. A cancelled task never runs again, and no record
  is ever deleted: they say what was done on the computer.
- **An app task goes on from its card:** `laplace-task --resume` refuses one, exiting 2 before it
  takes the lock.

| Event | Status |
| --- | --- |
| a start in `assistant.folders`, an Allow, a path or site answer, Continue | `running` |
| a start anywhere else | `awaiting-approval`, `pending: start` |
| a spend, stall or unpriced pause | `paused`, with `pause` |
| a refused path; a site not yet allowed | `paused`, with `pause` and `pending` (`path` or `fetch`) |
| the run ends | `succeeded`, `failed` or `cancelled`, with `outcome` and `endedAt` |
| the server stops mid-run | `interrupted` |

### Approvals

The owner answers from the task's card in the chat, or the waiting bar above its composer
([web-app.md](web-app.md#tasks)), through `POST tasks/:id/approve` with `{ answer: "once" |
"always" | "deny", pending?, model?, web? }`. Answers to one task are taken one at a time.
`pending` is the question answered, as the snapshot's `pending` gave it, its `folder` included;
the card and the bar always send it, so an answer from a view that shows an earlier question
(another tab, a poll behind) is refused 409 `nothing-pending` instead of answering the next one,
and so is one from a view that showed another folder for the same path.

- **At the start** (`pending: start`):
  - Allow Once runs the task; Always Allow first adds its folder to `assistant.folders`.
  - Deny ends it `cancelled` with `denied: true`, even with Assistant Mode off.
  - The card may pick another account and model first, checked as `createMind` checks it: a
    refused one answers 400 and changes nothing. It may set web access: Ask for Each Site (`ask`),
    Any Site (`any`) or No Web (`off`).
- **A path** (`pending: path`, from a tool result's `refused`; a denied place, home included, is
  never asked about):
  - What an Allow grants is decided when the task pauses, and the question names it as
    `pending.folder`: the path itself when it is a folder on disk, else its parent when that is
    one, unless it is home or holds it. Otherwise there is no `folder` and the path alone is
    granted: a file right in home (or in `/`), a path under a file (`~/.gitconfig/x`), and one
    whose folder isn't made yet, since a grant holds its own path and that folder could then be
    written as a file.
  - Allow grants exactly what the question named, with the access asked for, whatever the path
    has become by the answer.
  - Always Allow, offered only for a write whose question names a `folder`, also adds that folder
    to `assistant.folders`. A read, or a write of a path granted alone, gets Allow Once and Deny
    alone, and the manager takes an Always on either as Allow Once: every task may write in
    `assistant.folders`, and one she starts there runs without asking.
  - Either way the run goes on with a line it is told: `The owner allowed read access to
    <folder>. Try again.` (or `read-write`; the path itself when it was granted alone), or `The
    owner refused access to <path>.`
- **A site** (`pending: fetch`): Allow Once adds the host, Allow Any Site sets the mode to `any`,
  and Deny adds the host to `denied`, whose calls the gate then blocks with `The owner refused
  fetching from <host>.`; a denial outlasts a later Any Site.
- **Always Allow** writes `settings.yaml`'s `assistant.folders` through `addAssistantFolder`
  (`routes/tasks.ts`), unless the file lists the folder already, then installs the settings again
  for the next run's grants. A folder whose path holds a comma, or whitespace at either end, is
  refused with 400: the list is read back split on commas and trimmed, so it would come back as
  another folder (`/tmp/a,/etc` as `/etc`); Allow Once still works. While `ASSISTANT_FOLDERS` is
  set in the environment the file's list doesn't take effect, but the answer still grants this task.
- **Continue** (`POST tasks/:id/continue`, `{ spendPauseUsd? }`) answers a spend, stall or unpriced
  pause, or an interrupted task. After an unpriced pause it turns the task's spend pauses off;
  otherwise a `spendPauseUsd` in the body replaces the task's own.

### The report

At each end the manager calls the chat runner's `report(snapshot)`, once `task.json` is written,
and marks the task `reported` once it resolves. If it throws, or the server stops first, the next
start reports the task again.

- **It waits until no reply runs in the chat,** since a task can end before the reply that started
  it has stored its `started` result. Then, in one turn of the chat's queue, it stores her call's
  `final` and starts her report turn, so no viewer line's answer tells it first.
- **The `final`** is her `tool-result` with `stage: "final"`: `{ status, report, files,
  moreFiles?, spentUsd }`. `report` is the worker's report for a success, the reason for a failure
  and empty for a cancel, cut at 4,000 characters with "[... N more characters truncated]";
  `files` are the first 50 files the tool log shows were written, and `moreFiles` counts the rest
  (the task's snapshot, which the card reads, lists them all). Nothing is stored when the chat is
  gone or her call is settled already.
- **Her view keeps the `final` in her call's own `tool` message,** whatever was said since
  ([chat.md](chat.md#her-view)): the worker's report may quote a page it fetched, so it reaches her
  only as a tool's output, never as a developer or user message.
- **Her report turn** runs as a greeting does: no viewer line, streamed through `GET live`, in text
  unless the chat's reply mode is voice, and offered neither `start_task` nor its hint. It answers
  a fixed nudge, `taskEndedNudge(call)` in `tool.ts`, stored as her developer `context` block:
  "你用 start_task 在电脑上做的事（调用 <call id>）结束了，结果在那次调用的返回里。
  用一两句话自然地告诉对方：做成了什么，或者卡在了哪儿；内容多就挑要紧的说，细节等对方问。"
  A cancelled task gets no turn, since the owner stopped it: its `final` sits in her call's result
  with nothing asking her to tell it. Neither does one whose chat is in a call or no longer hers
  alone.
- **On an Anthropic account, a report turn with no tools at all** (her own included) sends the
  view's calls and results as notes in the user's turn, as every Anthropic turn without tools
  does (`callsAsNotes`), so that one turn reads the report at the owner's level. It offers her no
  tool to act on it with.
- **After shutdown begins** it stores nothing, so the next start reports the task.

### The routes

`apps/bot/src/local/routes/tasks.ts`, under `/api/local`, each needing the session. Every `:id` is
checked as a lowercase UUID before any lookup (400 `bad-request`), and an unknown id, a
`laplace-task` task's included, is 404 `unknown-task`. Bodies are JSON under 16 KB.

| Route | Body | Answers |
| --- | --- | --- |
| `GET tasks?chat=<id>` | | `{ tasks }`, newest first: the app's, or one chat's. 400 for a `chat` that isn't a chat id |
| `GET tasks/:id` | | The snapshot |
| `GET tasks/:id/events?after=<offset>` | | NDJSON: each transcript entry as `transcript.jsonl` holds it, from byte `after` (default 0), then each one the run stores; it ends when the run stops: it ends, pauses, waits for an answer, or the server stops. 400 for an `after` that isn't a byte offset, 416 `range-not-satisfiable` past the file's end |
| `POST tasks/:id/approve` | `{ answer, pending?, model?, web? }` | The snapshot, `running` at once while the run goes on, or `cancelled` for a start's Deny. 400 `bad-request` for a body of the wrong shape, a model `createMind` refuses or an Always that `assistant.folders` can't hold, 400 `unknown-account`; 409 `nothing-pending` (it runs, waits for nothing, or asks something other than `pending`), `assistant-off`, `assistant-not-ready` or `task-locked`, and `conflict` when Always meets a `settings.yaml` that doesn't parse |
| `POST tasks/:id/continue` | `{ spendPauseUsd? }`, `{}` at least | The snapshot, `running` at once. 400 for a `spendPauseUsd` that isn't 0 or more; 409 `pending`, `not-paused`, `assistant-off`, `assistant-not-ready` or `task-locked` |
| `DELETE tasks/:id` | | The card's Stop: the snapshot once the run has stored its end, `cancelled` if it was live and as it was if it had ended. Works with Assistant Mode off; 409 `task-locked` while `laplace-task` holds the task |

## `laplace-task`

```bash
bun run laplace-task --folder <path> [--allow <path>]... [--web any|off] \
  [--model <account>/<model>] [--deliverable <text>] [--check <text>] [--json] "<goal>"
bun run laplace-task --resume <id> [--model <account>/<model>] [--web any|off] [--json]
```

- **One task in the foreground,** on the assistant role's model unless `--model` names another,
  split at its first slash (`openrouter/anthropic/claude-sonnet-5.5`). With neither, it exits 2
  saying how to choose one. The npm package runs it as `eidolon task`.
- **Its folder is made if missing,** once the policy lets a task write there. `--folder`,
  `--allow` and `assistant.folders` are read-write grants; a folder in the data home or the app
  root, one holding home, or a link that leads nowhere, exits 2 before anything is made.
- **The web:** `--web any` gives the task `web_fetch` for every site (still never this computer or
  its network); `off`, the default, leaves it out. No site is asked about, as this is an explicit
  command. `task.json` keeps the choice, so `--resume` keeps a task's `any` until `--web off` is
  given.
- **Output:** the worker's words as they stream and a line per tool on stdout, then how it ended;
  logs on stderr. Under `--json`, stdout carries only NDJSON: `task`, each `TaskEvent`, then
  `outcome`.
- **Exits** 0 succeeded, 1 failed, 3 paused, 130 cancelled (Ctrl-C); each but the first prints
  the command that resumes it. A spend pause in a terminal asks `Continue? [y/N]` and goes on in
  the same process on yes; `--json` never asks.
- **A model whose spend can't be counted** pauses the task after its first request, as the loop
  does while spend pauses are on (reason `unpriced`, the same under `--json`). In a terminal it
  asks `<detail> Continue without spend pauses? [y/N]`; on yes it goes on in the same process with
  spend pauses off and stores `spendPauseUsd: 0` in `task.json`, so a `--resume` doesn't ask
  again. Under `--json` or with no terminal it exits 3, and each `--resume` pauses again after its
  first request: resume it with `--model` on a priced model, or set `assistant.spendPauseUsd` to 0.
- **The worker's words and tool lines** reach the terminal with their control characters as
  `\u` escapes, so a file name can't write the clipboard (OSC 52) or move the cursor.
- **A transcript gone or damaged** since the task stopped exits 2 on `--resume`, and leaves
  `task.json` as it was.
- **One process per task:** a task holds the lock `task:<id>` while it runs, so a second
  `--resume` of it exits 1.
- **An app task** (its `task.json` has `chat`) is refused: `--resume` exits 2 before it takes the
  lock, saying the task goes on from its card in its chat.
- **It is A's billed check:** `bun run laplace-task --folder <tmp>/mg-react-todomvc "写一个 React
  TodoMVC，单文件 index.html"` on a model you pick, then open the page and try adding, ticking,
  deleting and the three filters.
