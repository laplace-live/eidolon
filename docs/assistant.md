# The assistant

Assistant Mode: tasks a persona runs on the owner's computer, writing and editing files in a
folder and reading pages on the web, while she reports the result as her own. A task is a worker on
a model of its own, with no persona, that works through tools until it can report. In the local
app she starts one with `start_task` when the owner asks her in a chat, or on a call in a chat of
hers alone; the task's card in that chat takes the owner's answers, and she reports there when it
ends. While it runs, she says how it is going from a status block of her tasks that each of her
turns rebuilds, reads its detail with `check_task`, passes the owner's changes on with
`steer_task`, and stops it with `stop_task`. The owner chooses how much of it each chat shows
([Display](#display)). `laplace-task` runs one from a terminal.

| Part | Where |
| --- | --- |
| the loop, `runTask`, and its meter, `UsageMeter` | `packages/engine/src/task.ts` and `task/` |
| the tools, `FolderPolicy`, the worker's prompt, the task's files | `packages/assistant` (`@eidolon/assistant`) |
| the `assistant` role, `createMind("assistant")` | `packages/providers`, `packages/engine/src/mind` |
| the app's tasks, `TaskManager` | `apps/bot/src/local/tasks/manager.ts` |
| `start_task`, her hint and her nudges | `apps/bot/src/local/tasks/tool.ts` |
| `steer_task`, `stop_task` and `check_task` | `apps/bot/src/local/tasks/her-tools.ts` |
| the status block, `后台的活` | `apps/bot/src/local/tasks/status.ts` |
| what a call takes of her tasks | `apps/bot/src/local/tasks/calls.ts`, and the chat runner (`chats/runner.ts`) |
| a chat's display: its milestones on a call, and the composer's commands | `apps/bot/src/local/tasks/milestones.ts`; `apps/web/src/features/chats/commands.ts` |
| the task routes | `apps/bot/src/local/routes/tasks.ts` |
| the task card, the waiting bar, the Tasks list | `apps/web/src/features/tasks/` ([web-app.md](web-app.md#tasks)) |
| `laplace-task` | `apps/cli/src/task.ts` |

## Rules

- **Production never has the assistant.** Only `apps/bot/src/local` and `apps/cli` import
  `@eidolon/assistant`: Biome's `noRestrictedImports` holds it, and `boundaries.test.ts` keeps it
  out of what `main.ts` reaches. `docker.yml` skips the image build for `packages/assistant`, so
  lift the fence and the paths-ignore together, as with `@eidolon/ingest`. Production's chat
  endpoint offers none of her task tools and no status block (`production.test.ts`), and its
  call binding hands a call nothing of tasks (`apps/bot/test/chat/call.test.ts`).
- **Only the owner's own lines make her start, steer or stop a task; only its card answers it.**
  In the app a task starts only from her `start_task`, in a chat or on a call in one. No route
  creates, steers or deletes a task, and the Tasks page only lists them. Allow, Deny and Continue
  come only from the card and the waiting bar, never from her tools or her voice.
- **Only the local viewer answers a task.** Every task route is under `/api/local`, behind the
  session; a listed origin (`EIDOLON_LOCAL_ALLOWED_ORIGINS`) gets 403 on each, and on the chats
  that offer her task tools.
- **The loop is the engine's, and the engine imports nothing from `@eidolon/assistant`.**
  `runTask` takes its tools, store, inbox and meter injected; `start_task` reaches her turn as a
  background tool, and her other task tools and the status block as the tools and providers the
  turn's request hands it. Only the engine talks to a mind.
- **Every path a tool touches passes `FolderPolicy` before any I/O.** The `AGENTS.md` and
  `CLAUDE.md` files the worker's prompt reads are read where they lie, from what the policy allows
  or, outside it, from a file of either name it doesn't deny (the folders' between home and the
  task's, where an owner's dotfiles link leads): a cloned repo's link to a key, or to any other
  file, stays out. A tool's failure, a refused path included, is a result with `isError`; it never
  throws into the loop.
- **Every entry is stored before it is shown,** and the outcome comes from the runtime, never from
  the worker's text.
- **Nothing the worker wrote reaches her above a tool's output.** Its report, plan, steps, file
  names and the paths or sites it asks about can quote a page it fetched, so her view holds them
  only in a `tool` message: her `start_task` call's `final`, or `check_task`'s result. The one
  exception is a turn on an Anthropic account offered no tools at all, which sends its calls and
  results as notes in the user's turn, with no tool to act on them ([The report](#the-report)).
  The status block and her nudges carry the runtime's facts and her own words alone. Her retellings
  are her own lines, which Mem0 stores like any other.
- **A task's steps never enter the chat log.** The log holds her task tools' calls and results,
  `check_task`'s bounded summary included, and the status block; every step is in the task's
  transcript.
- **Interruptions never stop a task.** Only a cancel does: the card's Stop, or the same Stop in
  `/stop`'s dialog, a Deny at its start, turning Assistant Mode off, deleting its chat, or her
  `stop_task` on the owner's word.
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
  - **Off:** she has none of her task tools and no hint, though the status block still lists her
    tasks; the Tasks list and its nav entry are hidden, and a card's answers are refused
    `409 assistant-off`; its Stop, and a Deny at a start, still work.
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
  tasks. Until it is ready she has none of her task tools and no hint, Settings and the Tasks list
  show `problem`, and a card's answers but a Deny at its start are refused
  `409 assistant-not-ready`, since each would run the task.
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
  - `todo`, the latest plan; `step`, the latest tool call it started (`{ tool, head }`: the tool,
    and the call's `path`, `url`, `pattern`, `glob` or `query`, else its arguments' JSON, cut at
    120 characters);
  - `inbox`, the lines a run hasn't taken yet (`steer`, `followUp`): the owner's answers to a path
    question, and her `steer_task` lines, each starting `The assistant updates the brief: `;
  - `web`: `{ mode, hosts, denied }`, mode `ask`, `any` or `off`, `ask` when absent;
  - `denied: true`: the owner denied it at its start.

## In the local app

### Her side

Her task tools and her hint (`apps/bot/src/local/tasks/`) go only with her answers to the owner's
lines in a chat of hers alone, while Assistant Mode is on and ready: a typed line, a voice message,
or a line spoken or typed on a call in that chat ([Calls](#calls)). Her greeting, her report turns
and her follow-ups on a call answer no line of the owner's, so they never get them: a task can't
start another, and a page a task quotes can't talk her into acting on the computer. A group chat,
a group or realtime call, `/call` and production's chat endpoint never offer them.

- **`start_task` and the hint** go with every such answer. The turn engine takes the tool as a
  background tool, and her other task tools as tools the turn is handed
  ([chat.md](chat.md#a-turn-runturn)).
- **`steer_task`, `stop_task` and `check_task`** go beside it only while a task of hers in the chat
  is live: running, awaiting approval, paused or interrupted. The runner reads that from the
  manager's tasks in memory as the turn starts (`snapshotsOf`), since a call's reply can't wait for
  a read, and the turn keeps the tools it was offered. So her tool list changes once when a task of
  hers there becomes live and once when her last live one there ends, and each change makes a mind
  that caches the prompt read all of it again, since the tools come first in it.
- **Every turn of hers in a chat** gets the status block ([below](#the-status-block)), whatever
  tools it is offered.

#### `start_task`

- **Arguments:** `{ goal, deliverable?, folder, check? }`, OpenClaw's objective, output, write scope
  and verification; `goal` and `folder` are needed, the folder absolute or under `~`. Their
  descriptions are in Chinese, in her register, and are live API surface, as the hint is. The
  tool's description also names what a task can't do yet, so that she says so and starts nothing:
  open a file, a page or an app to show the owner, run a program or a command, delete, move or
  rename a file, or look at an image.
- **It answers at once:** `{ task, status }`, status `running` or `awaiting-approval`, stored as
  her `tool-result` with `stage: "started"`. Her next round reads it as it is, and so does each
  later view of hers until the `final` replaces it ([chat.md](chat.md#her-view-viewof)), so her
  line follows the status: under way, or waiting for the owner's Allow on the card. The task's
  origin is `{ id, persona, call }`: the chat, her, and her call.
- **When her rounds run out** ([chat.md](chat.md#a-turn-runturn)), her answer round offers
  `start_task` alone, so she can still hand the work to a task. A start there runs, and one more
  round, offered nothing she may call, gives her line on it.
- **A refusal** the manager explains (Assistant Mode off or not ready, a folder it won't grant, a
  file or a path under one, one another live task works in) is an error result she tells the
  owner; there is no task.
- **`cancelOnInterruption` is false:** her turn's interruption never reaches the task.
- **Her hint**, after the selfie hint in her persona prefix:
  "你能直接用这台电脑做事：写代码、做网页、写和改文件、上网查资料，都是你自己动手。要用电脑就调用
  start_task 工具，这是你碰电脑的唯一方式，不要说自己用不了电脑。不过现在你在电脑上只会读写文件、
  上网看网页：打开文件、网页或软件给对方看，运行程序，删除或移动文件，看图片，这些还做不到，
  对方要的话就直说，告诉对方文件在哪，别为这些调用 start_task。调用后看返回的 status：running
  是已经开始了，说一句交给你了就行；awaiting-approval 是还没开始，得对方在聊天里的任务卡片上点了
  允许才开始，要跟对方说一声。交出去的事别再调用一次，做完了结果会自己回来。"
- **Deleting a chat** stops its live tasks, after any `start_task` call the manager is still
  answering.

#### Naming a task

Her task tools take `task`: her task's number in the chat, among her own tasks there, ended ones
included, counted from 1 in the order they started (`createdAt`, then id). The status block shows
it as 任务N. No record is ever deleted, so a number stays its task's. The schema says `integer`; a
number written as text is taken too, and so is the task's id, as her `start_task` result shows it.
Either way it names a task only among hers in this chat. Left out, it means her only live task.
What she reads when it names none:

- `No task of yours in this chat is still going.`, with `task` left out and none live;
- `Name the task: 1 (running), 3 (paused).`, with `task` left out and more than one live;
- `You have no task 4 in this chat: yours here are 1 to 3.`

#### `steer_task`

`steer_task({ task?, text })` passes the owner's change on to a live task of hers. The manager's
`steer(id, text)` adds `The assistant updates the brief: <text>` to the task's inbox, its text
stripped and at most 2,000 characters, and writes `task.json` at once, so the line outlives a
restart. The prefix is `STEER_PREFIX` in `apps/bot/src/local/api.ts`, which the web app reads too.
The line answers, allows and continues nothing; the worker reads it as a line it is told:

| The task | It reads the line | Her result's `note` |
| --- | --- | --- |
| running | before its next request | `Passed on: it reads this before its next step.` |
| awaiting approval | first, once Allow runs it | `Queued: it hasn't started, and reads this first once the owner allows it on its card.` |
| paused on a path or site question | when the answer resumes it, before the manager's own line answering a path | `Queued: it waits for the owner's answer on its card, and reads this when it goes on.` |
| paused for spend, a stall or an unpriced request | at Continue | `Queued: it is paused until the owner continues it on its card, and reads this then.` |
| interrupted | when it resumes: at the server's next start, or at Continue | `Queued: it was interrupted, and reads this when it resumes.` |

- **Her result** is `{ task, status, note }`. An ended task is an error she can tell the owner,
  `Task 2 has ended (succeeded): start_task starts a new one for the change.`, and so are a blank
  text (`steer_task needs the text to pass on.`) and one over 2,000 characters (`The text to pass
  on is over 2,000 characters.`); nothing is written then.
- **A Deny at its start, a Stop or the task's end drops it** with the rest of the inbox. A Deny on
  a path or a site question answers that question alone: the run goes on and reads her lines, then
  the manager's refusal of a path.
- **While the task waits on the owner,** its card and the waiting bar list her lines it hasn't
  read above their answers, so an Allow or a Continue from either covers them
  ([web-app.md](web-app.md#tasks)). Once the run reads one, Show Steps shows it among the lines the
  task was told.
- **No route steers a task:** the owner tells her.
- **What a steer can reach.** A page a task quoted reaches her as a tool's output (a `final`, a
  `check_task` result), and could talk her, in an answer to the owner's line, into steering another
  live task of hers, whose worker follows the line as it follows its brief. `FolderPolicy`'s
  denials hold, but per-site approvals bound that task only while its web mode is still `ask`:
  after Allow Any Site, at its start or on a site question, it fetches from any site without
  asking, and every task reads and writes all of `assistant.folders`. Nothing guards steering by
  web mode: the worker reads pages itself, so a page can address it directly, and a steer adds no
  reach a page lacks.
- **A steer that lands as the task finishes,** after the loop last looks for steering and before
  the end clears the inbox, is dropped. The window is milliseconds wide and nothing triggers it on
  purpose, so nothing guards it.

#### `stop_task`

`stop_task({ task? })` is the card's Stop, the manager's `cancel(id)`: a live task ends `cancelled`
once its run has stored its end, and one still waiting for its start's Allow can be stopped too.
Its description has her call it only when the owner clearly says to stop, and ask first when she
isn't sure; there is no confirmation, since the owner's word is one.

- **Her result** is `{ task, status: "cancelled", written }`, the count of files it wrote, which
  stay. A run that had ended some other way before the stop reached it answers with its own status,
  `{ task, status, note: "It had already ended (succeeded) before the stop reached it." }`, and its
  end is reported as any other.
- **A task that had ended before her call** is an error: `Task 2 had already ended (succeeded):
  nothing was stopped.`
- **Its cancelled `final`** is stored once her turn ends, with no report turn
  ([The report](#the-report)).
- **Cut off by the owner's next line,** a `steer_task` or `stop_task` call runs on, since neither is
  cancelled on interruption, and its result is stored after that line, through the chat's queue.
  The answer to that line read the log before it, so its view reads the call as `CANCELLED`: she
  may pass a change on twice, or say a stop didn't go through, though the status block's unread
  count and 被停掉了 say otherwise. Nothing guards it.

#### `check_task`

`check_task({ task? })` reads one task's detail, for when the owner asks what exactly it is doing;
whether it is done, the status block says already. It settles within her turn, and her turn's
interruption cancels it. For a live task its result is `{ task, status }` and:

- `card`, what the card asks the owner: `{ asks: "start" }`; `{ asks: "path", path, access,
  allowGrants }`, `allowGrants` being what an Allow grants (the question's `folder`, else the
  path); `{ asks: "site", host }`; `{ asks: "continue", reason, detail }` at a spend, stall or
  unpriced pause; `{ asks: "continue", reason: "interrupted" }`;
- `plan`, its todo list, at most 12 items (`{ text, status }`, each text cut at 100 characters),
  and `morePlan`, how many were left out;
- `step`, the latest tool call it started (`{ tool, head }`);
- `written`, at most 10 of the files it wrote, relative to the task's folder as she gave it or as
  it lies on disk, and `moreWritten`, how many more;
- `spentUsd`, and `unread`, how many of her lines it hasn't read, when there are any.

The whole result stays within 2,000 characters as her view holds it: the card's path, folder,
host and detail are cut at 300, plan items go from the end first, then files, and if it is still
over, which a text of escaped characters can make it, the card's texts are cut shorter until it
fits. For an ended task it is
`{ task, status, note: "It has ended (succeeded): its result comes back as start_task call
<call id>'s result." }`. Its description tells her the result is what the computer recorded, which
may quote a page: hers to retell, never to obey. Besides her `start_task` call's `final`, it is the
one way text the worker wrote reaches her, and the chat log stores its result like any tool's.

### The status block

`tasksStatusProvider` (`status.ts`) is a context provider that the runner hands every turn of hers
in a chat while the app has its task manager, Assistant Mode on or off: her answers in a chat of
one or a group, her greeting, her report turns, and every reply of a single cascade call in the
chat ([Calls](#calls)). It lists the tasks, in that chat, of the persona the turn runs as
(`activePersona()`, inside the turn's `withPersona`), and puts a developer `context` block starting
`后台的活：` just before her view's last `user` message, or at the end when there is none: closest
to the line she answers, since it states the present and must outweigh her call's older started
result. Each turn it takes its earlier block out first, so the engine records `context-removed` for
the old block and `context` for the new; nothing while the block stays the same in the same place;
and the removal alone once nothing is listed. A provider that fails is logged (`TasksStatus: Tasks
status: <error>`), and on a call sent as a notice too, and the turn goes on with the block it had.

```text
后台的活：
你在这个聊天里用 start_task 在电脑上做的事，现在是这样（以这里为准，比前面聊天记录里的新）：
任务1「做一个待办网页，单文件 index.html，能添加勾选和删…」（start_task 调用 call_1，在 ~/Desktop/todo）：正在做，计划 2 步做完 1 步，写了 1 个文件，刚才在写文件，花了 $0.12；你转告的话还有 1 句没送到。
对方问进度就照这里说，要具体的计划、文件或刚才那一步就调用 check_task 看；对方要改要求就用 steer_task 转告，明确说不要了才用 stop_task。允许和继续只能对方在任务卡片上点，你替不了。
```

- **What it lists:** her live tasks in the chat, then her ended ones not yet `reported`: at most
  five lines, live ones first and the newest kept, then `还有 m 个更早的没列出来。`. With none,
  there is no block.
- **Each line:** her task number ([Naming a task](#naming-a-task)); her goal on one line, cut at 30
  characters; her call's id; the folder, with home as `~`, cut at 60; the phrase for where it
  stands; then, while lines she passed on wait unread, `；你转告的话还有 n 句没送到`.
- **The phrases:**

  | The task | Phrase |
  | --- | --- |
  | awaiting approval | 还没开始，聊天里的任务卡片在等对方点允许，点了才开始 |
  | running | 正在做, then whichever it knows, in this order: `，计划 T 步做完 D 步`, `，写了 K 个文件`, `，刚才在<what it did>`, `，花了 $X.XX` |
  | paused on a path | 停着，任务卡片在问对方能不能读任务文件夹外面的一个地方，对方答了才接着做 (写 for a write) |
  | paused on a site | 停着，任务卡片在问对方能不能上一个网站看看，对方答了才接着做 |
  | paused for spend | 停着，已经花了 $X.XX，任务卡片在问对方要不要接着做 |
  | paused for a stall | 停着，连着几轮都在做一样的事，像是卡住了，任务卡片在问对方要不要接着做 |
  | paused, unpriced | 停着，这个模型的花费算不出来，任务卡片在问对方要不要不管花费接着做 |
  | interrupted | 中断了，程序重启时停在半路，对方在任务卡片上点继续就接着做 |
  | succeeded, not yet reported | 刚做完，结果会出现在那次调用的返回里 |
  | failed, not yet reported | 刚失败了，原因会出现在那次调用的返回里 |
  | cancelled, not yet reported | 被停掉了 |

  What it did is the latest step's tool, through a fixed table: 读文件, 写文件, 改文件, 看文件夹,
  找文件, 在文件里搜, 上网看网页 and 排计划, and 用工具 for a tool the table doesn't name.
- **The last line** names her task tools only on a turn offered them, as above. Every other turn
  (her greeting, her report turns, a group's turns, a call's follow-ups) ends
  `对方问进度就照这里说。允许、继续和停止都只能对方在任务卡片上点，你替不了。`
- **Never in it,** whatever the worker wrote, which may quote a page: the plan's texts, the step's
  head, file names, the path, folder or host the card asks about, a pause's detail, the outcome's
  report or error, and the inbox's lines. `tasks-status.test.ts` plants a sentinel in each, and
  finds it nowhere in the block.
- **On a call:** a call's seed leaves out the chat's stored block and her task nudges, stale by
  then (`withoutTaskContext`), and a single cascade call's replies get a fresh block. A realtime
  call gets none. A group call opens on the chat's own events rather than a seed, and takes no
  providers, so as it opens the runner stores a `context-removed` for every persona's stored block
  and task nudges there (`staleTaskContext`): none says a task still runs after its `final`, or
  names task tools a group call never offers. Her next text turn's block is fresh again.

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
- **A steer,** `steer(id, text)`, her `steer_task`, runs in the task's own queue, with Assistant
  Mode on or off: 400 `bad-request` for a text blank or over 2,000 characters once stripped, 409
  `conflict` for a task that has ended ([`steer_task`](#steer_task)).
- **The latest step,** `step`, is set at each `tool-start`, from the call in the run's latest reply,
  which a resume takes from the stored reply.
- **What a turn reads at once:** `snapshotsOf(chatId)`, a chat's tasks as they stand in memory,
  oldest first, and none before the first load. The runner decides there whether to offer her task
  tools, since a call's reply can't wait.
- **A pause for the owner** (a path, a site, spend, a stall or an unpriced request) calls the
  `waiting` hook, once `task.json` is written, which the runner passes on to a call of hers
  ([Calls](#calls)). It is never called at a start, an answer, an end or an interruption, nor for a
  pause a cancel has already asked to end; a throw is logged, and the pause stands.
- **A plan getting further** calls the `progress` hook beside it, once the snapshot holds the
  plan: each time a `todo` result raises its done count, never for the same count or a lower one,
  a `todo` that failed, another tool, or the plan a resume reads back. The runner decides whether
  a call is told ([Display](#display)); a throw is logged, and the run goes on.
- **A cancel** (Stop, on the card or in `/stop`'s dialog, her `stop_task`, a Deny at the start,
  Assistant Mode off, a deleted chat) aborts the run, which stores `end(cancelled)`, or stores it
  under the task's lock when no run holds it, and drops the queued lines. A run already past its
  last check for the cancel stores its pause anyway; the cancel then ends the paused task as well,
  so it never answers with a live one. It works with Assistant Mode off, and on a damaged
  transcript. A cancelled task never runs again, and no record is ever deleted: they say what was
  done on the computer.
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

The owner answers from the task's card in the chat, or the waiting bar above its composer, or
above the dock during a call ([web-app.md](web-app.md#tasks)), through `POST tasks/:id/approve`
with `{ answer: "once" | "always" | "deny", pending?, model?, web? }`. Answers to one task are
taken one at a time. Nothing else answers one: her task tools allow and continue nothing, and on a
call she points the owner to the card, where a yes said aloud answers nothing ([Calls](#calls)).
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
  - Either way the run goes on with a line it is told, after any lines she passed on: `The owner
    allowed read access to <folder>. Try again.` (or `read-write`; the path itself when it was
    granted alone), or `The owner refused access to <path>.`
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
  it has stored its `started` result, and until every start of hers the manager is answering, or a
  call's start the chat has yet to store, is stored. Then, in one turn of the chat's queue, it
  stores her call's `final` and decides in the same step who tells it, so no viewer line's answer
  tells it first: with no call on, her report turn starts there; during a call, the call is handed
  the end, or holds it for after it ([Calls](#calls)).
- **The `final`** is her `tool-result` with `stage: "final"`: `{ status, report, files,
  moreFiles?, spentUsd }`. `report` is the worker's report for a success, the reason for a failure
  and empty for a cancel, cut at 4,000 characters with "[... N more characters truncated]";
  `files` are the first 50 files the tool log shows were written, and `moreFiles` counts the rest
  (the task's snapshot, which the card reads, lists them all). Nothing is stored when the chat is
  gone or her call is settled already.
- **Her view keeps the `final` in her call's own `tool` message,** whatever was said since, or
  brings her call back with it once the call has left the window
  ([chat.md](chat.md#her-view-viewof)): the worker's report may quote a page it fetched, so her
  view holds it only as a tool's output, never as a developer or user message, whether she started
  the task in text or on a call. A tool-less turn on an Anthropic account is the exception below.
  Her view never makes a stub of it, or of the `started` result, as it does of her older results
  she waited for, `check_task`'s included: the `final` is the one record of what the task did.
- **Her report turn** runs as a greeting does: no viewer line, streamed through `GET live`, in text
  unless the chat's reply mode is voice, and offered none of her task tools and no hint. It answers
  a fixed nudge, `taskEndedNudge(call)` in `tool.ts`, stored as her developer `context` block:
  "你用 start_task 在电脑上做的事（调用 <call id>）结束了，结果在那次调用的返回里。
  用一两句话自然地告诉对方：做成了什么，或者卡在了哪儿；内容多就挑要紧的说，细节等对方问。"
  A cancelled task gets no turn, since the owner stopped it, on its card or through her: its
  `final` sits in her call's result with nothing asking her to tell it. Neither does one whose chat
  is no longer hers alone.
- **On an Anthropic account, a turn offered no tools at all** sends the view's calls and results,
  the `final` and `check_task`'s results among them, as notes in the user's turn (`callsAsNotes`),
  so that turn reads them at the owner's level, with no tool to act on them. Her own tools count
  too: a persona with no selfie set up and no stream index has none in text, nor on a call without
  voice styles to switch to. Then her greeting, her report turns, her group turns and an answer
  while Assistant Mode isn't ready are such turns, and so are a call's greeting, recoveries and
  follow-ups.
- **After shutdown begins** it stores nothing, so the next start reports the task.

### Calls

A call takes her tasks when it is a single cascade call bound to a chat of hers alone; never a
realtime call, whose session fixes its tools as it opens and takes late results as system items; a
group call, as a group never has tasks; or `/call`, which has no chat. Realtime is judged as the
call opens (`realtimeIn`), and the voice engine judges it again as its session starts, so a
settings change in between could set the two apart. A persona added to the chat during the call
takes her tasks away from it until it ends.

- **What her replies get:** the binding's `extras`, which the voice engine asks as each reply of
  hers starts ([voice-engine.md](voice-engine.md#tools-and-async-results)). Every reply (her
  greeting, an empty turn's recovery, a follow-up, an answer) gets the status block; one that
  answers the owner's line, spoken or typed, also gets `start_task`, the hint and her task tools,
  as a text answer does. A single cascade call that doesn't take her tasks still gets the block,
  with the last line for no tools.
- **The seed** leaves out the chat's stored status block and her task nudges, which are stale by
  the call (`withoutTaskContext`, `calls.ts`), a realtime call's seed included.
- **A start on a call** runs as a background tool, as in text, and her next round on the call
  reads `{ task, status }`; a barge-in during it doesn't lose the result. Once the manager answers,
  the runner stores her `tool-call`, with her arguments as she gave them and the chat call's id as
  its `turn`, and its `started` result in the chat, even after a barge-in or Hang Up, so the card
  shows and the task's end finds her call. A refused start stores nothing; her line on the call
  says why. The call's `GET live` ends only once those are stored, so the page's read after the
  call shows the card; shutdown stops waiting after 2 s.
- **Approvals** are answered only on the card and on the waiting bar, which sits above the dock
  during a call.
- **A pause:** when a task of hers in the chat pauses for the owner (a path, a site, spend, a stall
  or an unpriced request), the manager's `waiting` hook has the runner hand the call
  `taskWaitingNudge(call)`, once per pause and whatever the chat's display, with her `tool-call`
  and `started` result first when the call's log lacks them, the call without its `said`, which
  the call's seed holds as her line already. It names no path or site:
  "你用 start_task 在电脑上做的事（调用 <call id>）停下来了，要等对方在聊天里的任务卡片上点一下才会
  接着做；嘴上答应不算，得在卡片上点。用一句话自然地提醒对方去看看卡片。"
  It is due only while the task still asks what it paused on, asked as a reply would take the
  nudge: answered on the card, or ended, before then, it is dropped. A reply that took it while it
  was due still speaks it, even when the owner answers the card before she does. With no call,
  nothing is said: the waiting bar shows it.
- **A plan getting further,** in a verbose chat alone: the manager's `progress` hook has the
  runner hand the call `taskProgressNudge(call)`, at most once every 30 s ([Display](#display)).
- **An end during the call:** `report()` stores the `final`, then hands the call the end, with her
  `tool-call` and `started` result first when the call's log lacks them, and `taskEndedNudge(call)`.
  A cancel goes with no nudge, only settling her call there, and is never held.
- **Ends she never told:** as the call opens, it is handed each end of hers in the chat she hasn't
  told, with its call and started result, for her greeting (`untoldEnds`, `calls.ts`, which reads
  the log, so this holds across a restart). An end is a `start_task` `final` that isn't cancelled,
  and it stays untold until either:
  - a `call-ended` after it names her call in `told`. Her lines on a call never tell an end by
    themselves;
  - or a line of hers with words comes after it, typed or as a voice message. One that answers her
    report turn's nudge on an end tells that end alone. It answers the latest task nudge of hers
    since her previous line, not her latest block: her turn records its providers' blocks after its
    nudge. So when a redial cuts her report on the first of two ends after part of a line, the new
    call is handed the second.
- **Who speaks a nudge:** her next reply offered no task tools: a follow-up, started at once when
  the floor is free, or her greeting before the call is up. A reply to the owner's line that is
  offered them leaves the nudge for a follow-up after it, so the reply asked to tell of an end, or
  to point to a card, is never offered a task tool. Her later answers to the owner's lines read the
  `final` at tool level with her task tools offered, as they do in text
  ([What a steer can reach](#steer_task)). A reply cut before its turn records the nudge, such as
  her greeting when the owner speaks as the call connects, leaves it for her next reply without
  them.
- **A call that doesn't take her tasks** is handed nothing: the ends that come during it are held
  for after it, and on a single call, so are those she never told as it opens.
- **Told on the call:** an end is told there only by a line of hers, cut off or whole, after a
  reply of hers recorded its nudge. The runner follows the call's log in its order through the
  binding's `onContext` and `onTranscript` ([chat.md](chat.md#the-binding)); a reply that took
  several nudges records them joined by a blank line, and each counts. Only `taskEndedNudge(call)`
  itself counts, so a reply that took a milestone's nudge alone tells no end. `call-ended` names
  the ends she told in `told`, left out when there are none.
- **After the call,** once `call-ended` is stored and unless the server is stopping, the runner
  tells in text, one report turn at a time while the chat is hers alone, each end the call held,
  and each it was handed that she didn't tell there. It never scans the log for finals: it tells
  only what this call held or was handed. A reply already under way when the end reached the call,
  and her answer to the owner's line while the nudge waited for the follow-up after it, recorded no
  nudge, so their lines tell nothing: if the owner hangs up before that follow-up speaks, she tells
  the end in text. So she does when the follow-up recorded the nudge but the hang-up came before it
  said anything.
- **The web's `reportStored`,** which the page waits on after a task ends, takes her report as in
  the log once a `call-ended` names the end as told, or once her line, not on a call, or her failed
  turn comes after her report turn's nudge on it; her answer to the owner's line counts only after
  that nudge. A turn outside a call stores its nudge before her parts and mind are made
  ([chat.md](chat.md#a-turn-runturn)), so a report turn that fails there, as when her mind's
  account has lost its key, still ends the wait, and so does her answer to an owner's line that
  cut one short. A report turn the owner stops before she writes leaves the page asking `GET live`
  for its 60 s with nothing coming, and so does an end in a chat that is no longer hers alone.
- **A shutdown mid-call** skips the tell after the call, and the task is `reported` by then,
  whether the call was handed the end or held it. The next cascade call in the chat hands the end
  again, since its start reads the chat for ends she never told and her lines on the earlier call
  don't count; a line of hers in text first counts as telling it.
- **A call that never stores its `call-ended`** records no tells: the server killed mid-call,
  `dev:local`'s reload included, which doesn't wait for the stop hooks, or the append failing. The
  ends she told on it stay untold, so the next call has her tell them again, unless a line of hers
  in text comes first.

### Display

How much of her tasks a chat shows, and what she says of them on a call. A chat's display is the
last `settings` event that sets `display` (`displayOf`), else the app's `chats.display`
(`CHAT_DISPLAY`, default `normal`, [personas.md](personas.md#settingsyaml)), read where each
decision is made. The owner sets the chat's with `/focus`, `/normal` or `/verbose` in the
composer, or with Task Display in its Chat Settings, the only control during a call, when the
composer takes nothing; the app's is Task Display on Settings → Assistant Mode
([web-app.md](web-app.md#tasks)). A command is never a line: it stores the `settings` event alone,
starts no turn, and never reaches her.

| Display | In the chat | On a call |
| --- | --- | --- |
| `focus` | Task cards are hidden, but for one Show Task or the Tasks list brings into view, until the display changes. Her lines, her words before her calls included, and the waiting bar stay | Her line on each start, her pointer at each pause, and each end |
| `normal` | Each task is one card, its steps behind Show Steps | As in focus |
| `verbose` | Her newest running task's card opens its steps, streamed live from the task and never stored | As in normal, and a short line each time its plan gets further |

- **What no display changes:** her prompt, her hint, her tools, the status block and her nudges,
  whose Chinese is load-bearing and checked only by billed runs; and the waiting bar, since a task
  that waits on the owner must be seen. In focus, her lines and the status block still speak of
  the task card: the waiting bar carries its question and buttons, and Show Task brings it back.
- **In text, verbose adds no lines of hers:** the card shows the steps for nothing, while each line
  would be a turn that bills, is stored, and feeds Mem0 progress chatter.
- **Production ignores it:** its endpoint runs no tasks, and its window rebuilds a browser's
  `settings` event from `replyMode` and `chainLimit` alone ([chat.md](chat.md#the-window)).

#### `/stop`

`/stop` opens a dialog of the chat's live tasks, read afresh, newest first: "Stop this task?" with
one, "Stop which task?" with several. Each row's Stop is the card's Stop (`DELETE tasks/:id`), and
Cancel stops nothing; with no live task a toast says so. It takes nothing after it: the cards show
no number for the owner to name, so `/stop 2` is refused. She says nothing about it: a cancel gets
its `final` and no turn, in text and on a call ([The report](#the-report)).

#### Milestones on a call

In a verbose chat, a call that takes her tasks ([Calls](#calls)) is told as a task's plan gets
further, through the manager's `progress` hook and row 31 of the call's Floor
([voice-engine.md](voice-engine.md#tools-and-async-results)), as a pause's pointer is:

- **A milestone** is the done count of the task's plan (`todo`) rising past what this call was
  last handed for that task, while some item is still to do. The plan's last item is the end's to
  tell, and tool steps, files written and a task with no plan give none. The runner reads the task
  as it stands when it hands the call one (`taskProgress`, `milestones.ts`), so steps done
  meanwhile make one milestone, and a step done just before a pause or the end makes none.
- **The display is read at each hand-off,** from the log: leaving verbose stops the next, though
  one already handed may still be said, and turning it on counts from the next step done.
- **At most one every 30 s per call** (`MILESTONE_GAP_MS`), with no timer: a step done inside the
  gap is dropped, and the next one past it, or the end, says the count.
- **`due`** holds while the task still runs, the milestone is the newest handed for it, and no
  line of the owner's has been stored on the call since, so her answer to 到哪了 isn't followed by
  the same step again.
- **The nudge,** `taskProgressNudge(call)` in `tool.ts`, names no count, step or path: a count in
  it would be stale by the time she speaks, and she reads the plan's count in the status block,
  which her follow-up gets fresh:
  "你用 start_task 在电脑上做的事（调用 <call id>）又往前做了一些。照「后台的活」里它那条的计划步数，
  用一句话随口告诉对方现在做完几步了；具体是哪一步你看不到，别猜，也别念路径或文件名。"
- **It never asks her to tell an end:** only `taskEndedNudge(call)` itself does ([Calls](#calls)).
- **What it costs:** a follow-up reply each, with Mem0's store of the call's lines and a short line
  spoken. On Gemini 3.8 Flash through OpenRouter with Mem0 on, the owner's ledger puts that at
  about $0.016 ($0.0063 her mind, $0.0092 Mem0, under $0.001 of Fish's `drama-3`), about $0.019
  once `drama-3`'s price rises after 2026-11-30, and $0.03 or more on `google/gemini-4-hydrogen`.
  The gap holds it to 2 a minute, about $0.033.
- **What is stored:** her milestone line, as heard, is a call line in the chat like any other, so
  Mem0 may keep progress chatter. The nudge stays in the call's own log.

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

### Checking her side

The tests script every mind, and `local-smoke` walks tasks in a chat, in each display and on a
call with a fake mind ([web-app.md](web-app.md#the-browser-smoke-test)). Whether a real model
follows her hint, her tools' descriptions, the status block and her nudges takes billed checks,
after a change to any of them.

**A chat, on OpenRouter,** about $0.20, most of it the worker: Assistant Mode on a model you pick,
her mind on the model to check, a temporary data home with `EIDOLON_NO_DOTENV=1` and only the
OpenRouter key exported, so Mem0 stays out. In one chat with milky-green:

1. Ask for a single-file to-do page in a folder outside `assistant.folders`, such as
   `/tmp/c-check/todo`. Her line must say the card asks to start it, not that she is at work.
2. Ask 弄好了吗 before Allow: it hasn't started, and waits for the owner's Allow.
3. Allow Once, then ask 弄好了吗 again: it is under way, not waiting for Allow.
4. Ask 写到哪了，具体给我说: she calls `check_task`, and names a step of the plan or a file.
5. Ask 标题改成『今天的事』: she calls `steer_task`, and the page's title changes.
6. After her report, ask 帮我打开它: she starts no task, and says where the file is.
7. Start a second task, then say 算了别做了: she calls `stop_task`, and it ends cancelled.

**A call, by hand,** with the owner's go-ahead, since it bills Soniox and Fish besides OpenRouter:
`bun run app` with the `.env`'s keys, a chat with milky-green alone, then Call.

1. Ask aloud for a page in a new folder outside `assistant.folders`: she calls `start_task`, and her
   line mentions the card's Allow.
2. Allow Once on the waiting bar above the dock.
3. Ask 写到哪了 midway: she answers from the status block, or through `check_task`.
4. She speaks the end in a sentence or two, reading no path aloud.
5. Ask 帮我打开它: no task starts.
6. Hang Up. The log holds her call and its started result among the call's lines, the `final`, her
   line after it, a `call-ended` whose `told` names her call, and no report in text.
7. Type `/verbose`, call again, and ask for a task whose plan takes three or more steps, such as a
   page with a list, a form and a style sheet. As its steps finish she says short lines on how far
   it has got, at most one every 30 s, never naming a step or a path and never twice for one.

A change to the voice loop also needs its real calls
([voice-engine.md](voice-engine.md#real-calls)), billed the same way.

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
