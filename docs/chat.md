# Chats

Text chats with the personas, in the local web app. A chat is an append-only log of events, and
any number of personas can be in one, although the Chats page starts each with one persona for
now. Each persona's reply is a turn of the turn engine, which talks to her mind without pipedog.

```text
@eidolon/chat         the format: events, the header, ChatStore, viewOf; safe in a browser
@eidolon/chat/jsonl   JsonlChatStore: the local store, in the data home
@eidolon/engine       runTurn: one persona's turn, from her view of the log to the events it adds
apps/bot/src/local/chats/, routes/chats.ts   the runner and /api/local/chats
apps/web/src/features/chats/                 the Chats page (web-app.md)
```

**Production keeps no chats yet.** Only `apps/bot/src/local` imports the engine and the JSONL
store. A Biome rule forbids them in the rest of `apps/bot/src`, and `boundaries.test.ts` follows
`main.ts`'s imports to prove it. `@eidolon/chat` itself imports no other package, and nothing from
Bun or Node outside `src/jsonl.ts`, because `apps/web` bundles it and laplace's client will too.

## The format

A log is a header line, then one event per line:

- **The header,** `ChatHeader`, is written once: `format` (1), the chat's `id` (a UUIDv7, so ids
  sort by time), `createdAt` and the `participants` it started with.
- **Each event** carries a `seq` (1, 2, 3… with no gaps) and `at` (ms since the epoch).
  - The engine emits drafts without either (`ChatEventDraft`). Whoever stores them numbers them
    on from the log's last event (`stampEvents`).
  - `sig` is reserved for the production endpoint (below). Nothing local writes it, and every
    reader ignores it.

**The log keeps what was said and what each persona was given,** never how it arrived. Stream
deltas and tool states only go over the wire. Each persona's view is rebuilt from the log, so what
isn't stored, she never saw.

| Event | Written by | What it holds |
| --- | --- | --- |
| `message` | the runner for the viewer, the engine for her | `speaker`, `text`, and `attachments` (her selfies; `text` is empty on a message of photos alone); `interrupted` when she was cut off, keeping what she had said |
| `context` | the engine | A block a context provider put into her view: `role`, `content` and its `position` there; never shown |
| `context-removed` | the engine | Her earlier `context` blocks, by seq, that a provider took back out; the stream archive replaces its blocks when they change or move |
| `tool-call`, `tool-result` | the engine | Her call and what it returned; a call cut off has no result, and one that ran on past an interruption returns further down the log |
| `kickoff` | the engine | The greeting prompt she answered |
| `turn-failed` | the engine, or the runner when a turn throws | The failure, through `errorText`; the chat stays usable |
| `decision` | the runner | Who answers the line at seq `after`, and how. Step 1 writes `source: "single"` before every reply |
| `title` | `PATCH` | The chat's title; the last one wins |
| `participants` | nothing yet | Personas added or removed, for group chat |
| `settings`, `call-started`, `call-ended` | nothing yet | Per-chat reply mode and chain limit, and calls inside a chat |

**Reserved, so later steps need no format change:**
- a message's `modality`: `voice` and `call` messages carry their transcript in `text`;
- `audio` attachments;
- the `decision` sources other than `single`, and their `scores`.

**`ChatSummary`** is what the chat list shows: the title, the participants, `createdAt`,
`updatedAt`, the last message's text and the last seq. `summarize` derives it from a log, so a
store can always rebuild it.

## Her view: `viewOf`

`viewOf(header, events, persona, { windowMessages, nameOf })` builds the OpenAI-shaped messages a
call would hold for her, without the system message:

- **Her messages** are `assistant`, and **the viewer's** are `user`. An empty message is left
  out, and an interrupted one keeps what she said.
- **Another persona's messages** fold into one `user` message of `名字：text` lines, one per line,
  for a run of them in a row.
- **Her tool calls** become an `assistant` message with `tool_calls`, each followed by its `tool`
  result. A call with no result reads `CANCELLED`, and an empty result reads `COMPLETED`, as
  pipedog writes them.
- **Her `context` blocks** are spliced in at their `position` in seq order, so they accumulate as a
  call's do. A `context-removed` takes the named blocks out again.
- **Her `kickoff`** is a `user` message.
- **Another persona's context, tools and kickoff** are left out.
- **The window** is the last `CHAT_WINDOW_MESSAGES` (60) lines: messages, and her kickoffs. It
  opens on a line that isn't hers, as a call's context does, and keeps the context and tool events
  from then on. Older lines are Mem0's to recall. 60 is a constant, not a setting.

`viewWithBlocks` also maps each block in the view to its event's seq. A turn needs that map to
record which blocks a provider removed.

## The local store: `JsonlChatStore`

```text
<data home>/chats/<chat id>/
  chat.jsonl    the header line, then one event per line
  meta.json     its ChatSummary, and the log's length when it was written
  files/        attachments, named <sha256>.<ext>
```

- **Chats aren't in a persona's folder,** since one chat can hold several personas.
- **Privacy:** folders are made 0700 and files 0600.
- **Names are checked before they touch the disk.** A chat id must be a lowercase UUID. An
  attachment is a PNG, JPEG, WebP, GIF or AVIF, named by its content's hash. SVG is refused, since
  the app serves attachments from its own origin.
- **Appends:**
  - Each batch is one `appendFile`, then `fsync`, and resolves only once it is durable.
  - A batch that doesn't continue the log's seqs is refused with `seq-gap`, and nothing is
    written.
  - One process writes, the server that holds the `local-server` lock, and the store runs one
    operation per chat at a time.
- **`meta.json` is derived.** It is written through a temporary file and a rename after every
  append. It is rebuilt from the log when it is missing, doesn't parse, or names another length
  than the log has.
- **A torn last line** has no newline after it, or its JSON doesn't parse, as a crash mid-append
  leaves it. Reads drop it, the next append truncates it, and the repair is logged once. A bad line
  before the last fails the read, and the list skips that chat.
- **No compression yet.** A compressed log would be `chat.jsonl.zst`, beside the same layout.

`runChatStoreContract` (`@eidolon/chat/contract`) is the suite every store passes:
- seq contiguity, and a gap refused;
- `afterSeq` reads;
- the list's order and summaries;
- remove;
- a torn last line, through a hook the store provides.

It takes the test runner's `describe`, `test` and `expect`, so a store in laplace runs it as is.

## A turn: `runTurn`

`runTurn(request, deps)` streams a turn's output:
- `started`;
- `delta` lines of her text;
- `tool` states (`running`, `done`, `failed`);
- `events` with the drafts to store;
- `ended`, always last.

The caller numbers and stores each `events` line before it forwards it. A reader that stops reading
aborts the turn. The engine never rejects for the turn's own failures.

1. **It runs as her:** inside `withPersona(persona)` and `withUsageScope({ source: "chat",
   session: <chat id> })`. Jobs a provider spawns, such as Mem0's store, outlive the turn and keep
   both scopes.
2. **Her parts** are what a call's session builds:
   - **What they are:** Mem0 (for a logged-in viewer, which the local viewer is), the stream
     archive, persona facts, the retrieval gate, `take_selfie` and `recall_streams`. There is no
     voice tool, since text has no voice to switch.
   - **How long they last:** they are kept per chat and persona until the settings generation
     changes, for the 32 chats used last. Providers remember the conversation they serve (the turn
     they last searched, the archive's recall scope), so two chats never share them.
   - **What fails:** a missing index or an unreachable Qdrant is logged once per chat and skipped.
     An index is tried again next turn, and Qdrant a minute later, since each try can wait out its
     timeout.
   - **The system instruction** is rebuilt every turn, since it carries the clock:
     `buildSystemInstruction` with no voice hint.
3. **Her view** is `viewOf` the log as stored. A greeting turn adds `buildGreetingKickoff` over her
   memories of the viewer, recorded as a `kickoff`.
4. **Recall:** the gate attaches its decision, then Mem0, the archive and the facts run in turn.
   Each block one of them inserts is recorded as a `context` at its position. Each block from the
   log one of them takes out is recorded as a `context-removed` first, so the next turn's view is
   the one this turn left. A block put back exactly as it was, in the same order among the rest,
   stays the log's block and records neither, so an unchanged archive overview adds nothing.
5. **The mind:**
   - **The client:** `createMind()` is the provider that fills her mind role, over
     `@eidolon/providers`' fetch clients. It sends what a call's `createLlm` sends: the catalog's
     call-time fields, OpenRouter's usage body and headers, `developer` as `user` everywhere but
     OpenAI, Gemini's single system message, and Anthropic's prompt caching, fallbacks and message
     conversion.
   - **One mind per turn,** so Anthropic's signed thinking goes back with the round after a tool
     call.
   - **Rounds:** at most 4 mind calls per turn. A round's tool calls run in parallel and are
     recorded as a `tool-call` and a `tool-result` each. A tool she doesn't have, or one that
     throws, gets pipedog's error text, and one that times out gets no result.
6. **Tools' effects:** `switchVoice` throws. A `selfie` server message copies each image from the
   in-process selfie store into the chat's `files/` as soon as it is sent, while the URL still
   serves it (`SELFIE_TTL_SECONDS`), and the images become attachments on her message, or on a
   later one when the turn was interrupted first (step 8).
7. **The end:**
   - **Normally:** one `message` with her text and attachments.
   - **On abort:** the message is marked `interrupted`, keeping what she said, and none is stored
     if she said nothing.
   - **On a failure:** her partial text is stored as interrupted, followed by `turn-failed`.
8. **A tool that runs on:** an interruption cancels a running tool, unless the tool's
   `cancelOnInterruption` is false, as `take_selfie`'s is, and the caller passes `late`
   (`LateTools`).
   - **How long it runs:** until it finishes, its own `timeoutSecs` passes, or `late.signal`
     aborts. The turn ends without waiting for it.
   - **What it brings:** before the turn ends, `late.add` gets a promise of the events the tool
     adds when it ends:
     - its `tool-result`, under the interrupted turn, so her next view reads the result where the
       call is, not `CANCELLED`, and she doesn't take the photo again;
     - then a `message` from her with `text: ""`, carrying the photos it saved after her
       interrupted message was built. Photos saved before that stay on that message. `viewOf` leaves
       an empty message out, so the photo adds no line to her view.
   - **When it times out:** it brings no result, only photos it had already saved. Without
     `late`, every tool is cancelled with its turn.

## The local API

The runner (`apps/bot/src/local/chats/runner.ts`) keeps one `JsonlChatStore` at
`<data home>/chats`. Per chat, it keeps:
- one queue for sends and deletes;
- one append chain, which numbers each batch, stores it, and only then forwards it as an `events`
  line;
- one live buffer of the running turn's lines, from its start;
- the tools interrupted turns left running, by name.

**What a send does:**
- **New chat:** with one persona, her greeting starts right after the `201`, and `GET live`
  streams it.
- **New message:**
  1. It stops a running turn, and waits until what that turn said is stored as interrupted.
  2. It stores the viewer's line and a `decision`.
  3. It starts her reply.

  The answer streams from the viewer's line on. This is how the viewer will step into a group
  chat's conversation.
- **A dropped connection** never stops a turn. The turn finishes and is stored, and `GET live`
  replays it. Only stop, `DELETE` and the server's shutdown abort a turn. Shutdown waits up to 2 s
  for what was said to be stored.
- **A selfie still rendering when its turn was interrupted** is the runner's until it ends, as
  `late` (step 8 above):
  - **Storing:** what it brings goes through the chat's queue, so it never lands between a send's
    line and its decision, and is numbered on from the log like any append.
  - **Reaching the page:** no stream carries it, since its turn's streams have closed by then and
    the page may have none open. `GET chats/:id` lists the tool in `lateTools` until what it
    brought is stored. While that list isn't empty, the page reads the chat again every 2 s and
    shows the tool's quiet line, so the photo appears without a reload.
  - **What ends it:** stop and a new message leave it running. `DELETE` and shutdown cancel it.

| Method and path (under `/api/local`) | Body | Answer |
| --- | --- | --- |
| `GET chats` | | `ChatSummary[]`, newest activity first |
| `POST chats` | `{ participants: [id] }`, exactly one persona | `201 { id }`; her greeting then runs |
| `GET chats/:id?afterSeq=n` | | `{ header, events, lateTools }`: the events after `afterSeq`, and the tools interrupted turns left running |
| `POST chats/:id/messages` | `{ text }`, 1 to 4000 characters | NDJSON `ChatStreamLine`s, from the viewer's line to `ended` |
| `GET chats/:id/live` | | NDJSON of the running turn from its start, or `204` while none runs |
| `POST chats/:id/stop` | | `204` once the stopped turn's words are stored |
| `PATCH chats/:id` | `{ title }`, 1 to 80 characters on one line | Appends a `title` |
| `DELETE chats/:id` | | Stops any turn, then removes `chats/<id>/` and nothing else |
| `GET chats/:id/files/:name` | | The attachment: its type, `nosniff`, a sandbox CSP and `Cache-Control: private, max-age=31536000, immutable`; an `<img>` reads it with the cookie alone |

- **Text** is trimmed. A message may hold tabs and line breaks, but no other control character.
- **`missing-key`:** when her mind role's provider takes a key and has none, `POST chats` and
  `POST messages` answer `409 missing-key` before anything is written, in the words a call's
  preflight uses.
- **`unknown-chat`:** a chat the store doesn't have is `404 unknown-chat`.
- **An `error` line** ends a stream only when a turn threw and even its `turn-failed` couldn't be
  stored.

**Checks:**
- `bun test --no-env-file packages/chat packages/engine apps/bot/test/local`.
- `bun apps/bot/scripts/local-smoke.ts --headful`. It walks a chat against its fake
  OpenAI-compatible server: New Chat and the greeting, a reply that streams in with its cue as a
  chip, the history after a reload, Rename and Delete. It bills nothing.
- **By hand, billed:** a chat with milky-green on OpenRouter. Ask a recall question (it must call
  `recall_streams` or get archive context), and ask for a selfie, which must still show after
  `SELFIE_TTL_SECONDS`. Run Mem0 with `docker compose up qdrant`.

## Later: chats in production

**Production chats will live only in each viewer's browser,** in IndexedDB in laplace's `/ai`
page, behind the same `ChatStore`. The store passes `runChatStoreContract`.

**The server keeps no transcripts.**
- **The endpoint is stateless:** the browser sends the chat's window, and the server answers
  with the turn's events, signed.
- **`sig`** is an HMAC over `canonicalForSig(chatId, event)`: the chat id, a newline, then the
  event without `sig` as JSON with its keys sorted. The server drops any persona, context, tool or
  decision event whose signature doesn't verify, so a browser can't put words in her mouth or
  recall in her view.
- **Quotas** are per viewer, for text, voice and the decision model.
