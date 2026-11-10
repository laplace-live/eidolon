# Chats

Text chats with the personas, in the local web app. A chat is an append-only log of events with
one to six personas in it. Each persona's reply is a turn of the turn engine, which talks to her
mind without pipedog. In a group chat, the director decides who answers each line, and the
personas may answer each other ([Group chats](#group-chats)).

```text
@eidolon/chat         the format: events, the header, ChatStore, viewOf, parseMentions; safe in a browser
@eidolon/chat/jsonl   JsonlChatStore: the local store, in the data home
@eidolon/engine       runTurn: one persona's turn, from her view of the log to the events it adds;
                      runChat: a chat's answer to the viewer's line, turn by turn
@eidolon/context      Director: who answers each line of a group chat (director.ts)
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
| `message` | the runner for the viewer, the engine for her | `speaker`, `text`, and `attachments` (her selfies; `text` is empty on a message of photos alone); `interrupted` when she was cut off, keeping what she had said; `cutOff` when her provider stopped her short: `length` at its token limit, `refusal` when it refused or filtered her |
| `context` | the engine | A block a context provider put into her view: `role`, `content` and its `position` there; never shown |
| `context-removed` | the engine | Her earlier `context` blocks, by seq, that a provider took back out; the stream archive replaces its blocks when they change or move |
| `tool-call`, `tool-result` | the engine | Her call and what it returned; a call cut off has no result, and one that ran on past an interruption returns further down the log |
| `kickoff` | the engine | The greeting prompt she answered |
| `turn-failed` | the engine, or the runner when a turn throws | The failure, through `errorText`; the chat stays usable |
| `decision` | the engine (`runChat`) | Who answers the line at seq `after`, and how: `source: "single"` in a chat of one persona, else `mention`, `model` or `fallback`, with the director's `scores` when it asked. Every reply follows one, and one may choose no one |
| `title` | `PATCH`, or the runner for a new group | The chat's title; the last one wins |
| `participants` | `POST participants` | Personas added or removed |
| `settings` | `PATCH` | The chat's `chainLimit`; the last one wins |
| `call-started`, `call-ended` | nothing yet | Calls inside a chat |

**Reserved, so later steps need no format change:**
- a message's `modality`: `voice` and `call` messages carry their transcript in `text`;
- `audio` attachments;
- a reply's `voice` mode, and a `settings` event's `replyMode`.

**`ChatSummary`** is what the chat list shows: the title, the participants, `createdAt`,
`updatedAt`, the last message's text and the last seq. `summarize` derives it from a log, so a
store can always rebuild it.

## Her view: `viewOf`

`viewOf(header, events, persona, { windowMessages, nameOf })` builds the OpenAI-shaped messages a
call would hold for her, without the system message:

- **Her messages** are `assistant`, and **the viewer's** are `user`. An empty message is left
  out, and an interrupted one keeps what she said.
- **In a chat of two or more personas,** the viewer's lines read `观众名：text`, with the
  viewer's name (`viewerName`, else 观众). A chat of one keeps them unlabelled.
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
   - **Opened on a chat under way,** after a restart, a settings save or an eviction, the archive
     takes up as its recall scope the broadcasts her last `recall_streams` call returned, so
     `period: "selected"` still works. It doesn't when a recall block came after that call: the
     archive's own recall may have moved the scope, and the log doesn't record where.
   - **What fails:** a missing index or an unreachable Qdrant is logged once per chat and skipped.
     An index is tried again next turn, and Qdrant a minute later, since each try can wait out its
     timeout.
   - **The system instruction** is rebuilt every turn, since it carries the clock:
     `buildSystemInstruction` with no voice hint, and in a group the line naming the others
     ([below](#what-each-persona-sees)).
3. **Her view** is `viewOf` the log as stored. A greeting turn adds `buildGreetingKickoff` over her
   memories of the viewer, recorded as a `kickoff`.
4. **Recall:** the gate attaches its decision, then Mem0, the archive and the facts run in turn.
   The gate and the archive key their turn on the turn's id, since past the window a repeated line
   leaves the view's last lines as they were.
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
   - **In a group,** her request carries stop sequences, and her text is cut where she writes as
     someone else ([below](#what-each-persona-sees)).
   - **Rounds:** at most 4 mind calls per turn. A round's tool calls run in parallel and are
     recorded as a `tool-call` and a `tool-result` each. A tool she doesn't have, or one that
     throws, gets pipedog's error text, and one that times out gets no result.
6. **Tools' effects:** `switchVoice` throws. A `selfie` server message copies each image from the
   in-process selfie store into the chat's `files/` as soon as it is sent, while the URL still
   serves it (`SELFIE_TTL_SECONDS`), and the images become attachments on her message, or on a
   later one when the turn was interrupted first (step 8).
7. **The end:**
   - **Normally:** one `message` with her text and attachments. When the last round's finish
     reason says her provider stopped her short (OpenAI's `length` or `content_filter`,
     Anthropic's `max_tokens` or `refusal`), it is marked `cutOff`, and kept even with no text.
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

## Group chats

A chat holds one to six personas (`MAX_PARTICIPANTS`, in `@eidolon/chat`). With two or more, the
director decides who answers each line, and the personas may answer each other.

### The director

`Director` (`packages/context/src/director.ts`) sends one Decisions request per line. It runs on
the gate's plumbing: the active persona's `gate` role and its key, `decisionsUrl`,
`reportDecision`, and the `noul` questions. `DecisionsClient` (`gate.ts`) is the POST both share.

- **What Jev reads:**
  - `participants`: each one's id, name, `identity.summary` and `chat.interests`;
  - `earlier_lines`: the 8 lines before the latest, each a speaker (her name, or `viewer`), its
    text and its modality;
  - `latest`, the line to answer;
  - `recent_turns`: each persona's lines among the last 10, so no one dominates.
- **What it asks:**
  - for each persona but the latest line's speaker, `addressed_<id>` ("Is the latest message
    addressed to <name>, by name or by answering what she said?") and `interested_<id>` ("…about
    something <name> cares about (her interests above), or something she has a stake in?");
  - once, `invites_reply` ("Does the latest message invite a reply (a question, an opinion, a
    tease) rather than close the exchange?").

  Jev reads them literally, so a reworded question or state needs the benchmark run again.
- **Who answers the viewer's line:**
  1. The personas it @-mentions, in order, then those it addresses (`addressed` 0.5 or more), most
     addressed first. The source is `mention` when it mentions anyone, else `model`.
  2. Otherwise each candidate scores `interested × chat.talkativeness`, less 0.1 for whoever
     spoke the persona line before. Those at 0.3 or more answer, keenest first.
  3. With no one at that bar, the keenest answers anyway, the more talkative of a tie, because the
     viewer is never left unanswered.
  4. Two replies at most.
- **Who answers a persona's line:** someone answers only if `invites_reply` is 0.3 or more, then by
  the same rules, but with one reply at most and none forced. Each hop raises every bar by 0.1
  (`HOP_STEP`), so chains die down on their own.
- **Mentions** are `@` or `＠` and a participant's name or short name, case-blind
  (`parseMentions`, in `@eidolon/chat`, which the composer shares). A mention of someone not in the
  chat counts for nothing.
- **The bars** come from the 100 labelled lines of
  [`docs/benchmarks/2026-11-10-director/`](benchmarks/2026-11-10-director/README.md), which are
  synthetic until real logs replace them. All 100 are decided right, and stay right with any one
  bar moved 0.05 either way.
- **When it fails:** nobody can speak before it answers, so it gives up after 2 s
  (`DIRECTOR_TIMEOUT_SEC`) or on any error, and falls back to rules:
  1. the mentions;
  2. then the personas whose name or short name the line holds, in the order they appear;
  3. then, after the viewer's line only, the most talkative.

  The same caps apply. The source is `fallback`, with no scores. Without a key for the gate role,
  every group decision falls back.
- **A chat of one persona** makes no request: she answers every viewer line, as `single`.
- **Each reply's `mode`** is always `text` for now.

### The chain

`runChat` (`packages/engine/src/chat.ts`) answers each viewer line:

1. It reads the participants and the chain limit once, from the log as it stood. The limit is the
   last `settings` event's `chainLimit`, 0 to 6, else 3 (`DEFAULT_CHAIN_LIMIT`). A chat of one
   never chains.
2. It asks the director about the viewer's line, in the chat's usage scope, and yields the
   decision for the caller to store.
3. It runs each chosen persona's turn in order with `runTurn`. It reads the log again before each,
   so each turn sees what the ones before it said, and anything else stored meanwhile.
4. If a persona spoke and the chain limit isn't reached, it asks about the last persona line, one
   hop further, and so on until no one is chosen.

**Interrupting aborts the whole chain.** The running turn stores what she said as interrupted, and
every turn and hop still to come is dropped. An abort while the director decides stores nothing.

### What each persona sees

- **Her view** labels the viewer's lines with the viewer's name ([above](#her-view-viewof)), and
  folds another persona's run of lines into one `user` message of `名字：text` lines.
- **Her system instruction** gets one line after the viewer line, naming the others with their
  summaries. A persona with no summary is named alone:

  ```text
  这是群聊，群里还有：A（summary）、B；只用你自己的身份说话，不要替别人说话。
  ```

  A chat of one and a call get the prefix byte for byte as before, which a test pins.
- **She can't write another persona's line:**
  - **Stop sequences:** her request's `stop` (`stop_sequences` for Anthropic) holds `\n名字：`
    and `\n名字:` for the two other personas heard from last. That makes 4 strings, OpenAI's
    limit.
  - **The cut:** `SpeakerCut` (`packages/engine/src/group.ts`) catches what the stop sequences
    miss. It holds back the start of each line while it streams, and cuts her text before the
    first line that starts with another persona's name or short name and `：` or `:`,
    case-blind. Nothing after the cut is shown or stored, and the mind's stream is dropped there,
    with any tool calls it held.
- **Mem0 stores only the viewer's lines and hers.** In her view, other personas' lines are `user`
  messages, so storing them would make what they said memories about the viewer: B says 我最喜欢猫,
  and A's Mem0 records that the viewer likes cats. So the engine hands Mem0 its own list, in
  `turn.metadata[MEM0_STORE_KEY]`: the viewer's lines, unlabelled, and hers, the last 60.
  `Mem0MemoryProvider` stores that list when it is there, and the context otherwise, so calls are
  unchanged.
- **Recall runs on the latest line,** whoever wrote it, so another persona's question about a past
  stream recalls as the viewer's would.

### Costs

For each viewer line, at the default chain limit, the most it can cost is:
- 5 turns: 2 replies to the viewer, then 3 hops. Each turn is up to 4 mind calls, with its gate and
  recall as in a chat of one;
- 4 director calls: one for the viewer's line, and one before each of the 3 hops. The
  benchmark's 101 calls cost $0.0033 in all, about $0.00003 each, and took 413 ms at the median on
  a warm connection.

The defaults keep a typical line at one or two replies. A chain limit of 6 allows 8 turns and 7
director calls.

### Calibrating

- **Every group decision is a `decision` event with its scores,** so real logs can become the
  labelled lines.
- **`bun run director-decisions`** asks Jev about every labelled line, for about $0.003, and exits
  non-zero when any is decided wrong.
- **`bun docs/benchmarks/2026-11-10-director/score.ts --cached`** replays the stored scores through
  the director for free, after a threshold or a label changes.

## The local API

The runner (`apps/bot/src/local/chats/runner.ts`) keeps one `JsonlChatStore` at
`<data home>/chats`. Per chat, it keeps:
- one queue for sends, stops, participant changes and deletes;
- one append chain, which numbers each batch, stores it, and only then forwards it as an `events`
  line;
- one live buffer of the running reply's lines, from its start: a greeting's turn, or a viewer
  line's decisions and turns;
- the tools interrupted turns left running, by name.

**What a send does:**
- **New chat:** with one persona, her greeting starts right after the `201`, and `GET live`
  streams it. A group doesn't greet: it gets a `title` of the personas' short names, joined
  with 、.
- **New message:**
  1. It stops a running reply, and waits until what it said is stored as interrupted. The hops
     still to come are dropped.
  2. It stores the viewer's line.
  3. It starts the answer, `runChat`: each decision and each turn is stored, then streamed.

  The answer streams from the viewer's line on, so the viewer can step into a chain at any time.
- **A dropped connection** never stops a reply. It finishes and is stored, and `GET live` replays
  it. Only stop, a new message, `DELETE` and the server's shutdown abort one. Shutdown waits up to
  2 s for what was said to be stored.
- **A stop** waits its turn in the queue, so one that arrives while a send is still storing the
  viewer's line stops the reply that send starts.
- **A selfie still rendering when its turn was interrupted** is the runner's until it ends, as
  `late` (step 8 above):
  - **Storing:** what it brings is numbered on from the log like any append. It always lands
    after the line that interrupted its turn, and may land among that line's decisions and turns.
  - **Reaching the page:** no stream carries it, since its turn's streams have closed by then and
    the page may have none open. `GET chats/:id` lists the tool in `lateTools` until what it
    brought is stored. While that list isn't empty, the page reads the chat again every 2 s and
    shows the tool's quiet line, so the photo appears without a reload.
  - **What ends it:** stop and a new message leave it running. `DELETE` and shutdown cancel it.

| Method and path (under `/api/local`) | Body | Answer |
| --- | --- | --- |
| `GET chats` | | `ChatSummary[]`, newest activity first |
| `POST chats` | `{ participants: [id] }`, 1 to 6 personas, each once | `201 { id }`; one persona's greeting then runs |
| `GET chats/:id?afterSeq=n` | | `{ header, events, lateTools }`: the events after `afterSeq`, and the tools interrupted turns left running |
| `POST chats/:id/messages` | `{ text }`, 1 to 4000 characters | NDJSON `ChatStreamLine`s from the viewer's line on: each decision as an `events` line, and each turn from `started` to `ended` |
| `GET chats/:id/live` | | NDJSON of the running reply from its start, or `204` while none runs |
| `POST chats/:id/stop` | | `204` once the stopped reply's words are stored |
| `PATCH chats/:id` | `{ title }`, 1 to 80 characters on one line, or `{ chainLimit }`, a whole number from 0 to 6; one per request | Appends a `title`, or a `settings` that applies from the next viewer line |
| `POST chats/:id/participants` | `{ add?: [id], remove?: [id] }`, at least one persona, none in both | `200 { ok }` and a `participants` event; `400` when it adds one already there, removes one who isn't, or leaves fewer than 1 or more than 6 |
| `DELETE chats/:id` | | Stops any reply, then removes `chats/<id>/` and nothing else |
| `GET chats/:id/files/:name` | | The attachment: its type, `nosniff`, a sandbox CSP and `Cache-Control: private, max-age=31536000, immutable`; an `<img>` reads it with the cookie alone |

- **Text** is trimmed. A message may hold tabs and line breaks, but no other control character.
- **`missing-key`:** when a persona's mind role's provider takes a key and has none, `POST chats`
  and `POST messages` answer `409 missing-key` before anything is written, in the words a call's
  preflight uses. In a group, the message names her (`<id>'s mind role has no key.`).
- **Every persona in the chat is checked,** whether or not the director would choose her. One deleted
  since is `404 unknown-persona`, until she is removed: `POST participants` looks up only the
  personas it adds.
- **`unknown-chat`:** a chat the store doesn't have is `404 unknown-chat`.
- **An `error` line** ends a stream only when a turn threw and even its `turn-failed` couldn't be
  stored, or when the answer threw outside any turn, as when reading the log fails.

**Checks:**
- `bun test --no-env-file packages/chat packages/engine packages/context apps/bot/test/local`.
- `bun apps/bot/scripts/local-smoke.ts --headful`. It walks two chats against its fake
  OpenAI-compatible server, which also answers the director's Decisions route. It bills nothing.
  - **A chat of one:** New Chat and the greeting, a reply that streams in with its cue as a chip,
    the history after a reload, Rename and Delete.
  - **A group,** with a second persona made from no template: no greeting, an @-mention the
    composer completes, the second persona's answer, the first's answer to her a hop later, and
    each line under its persona's name.
- `bun run director-decisions` after changing the director's questions, state or thresholds
  ([Calibrating](#calibrating)).
- **By hand, billed:** a chat with milky-green on OpenRouter. Ask a recall question (it must call
  `recall_streams` or get archive context), and ask for a selfie, which must still show after
  `SELFIE_TTL_SECONDS`. Run Mem0 with `docker compose up qdrant`.
- **By hand, billed:** a group of two personas on OpenRouter. Its `decision` events must come
  from `mention` or `model` with scores, not `fallback`, and neither persona may write the other's
  lines.

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
