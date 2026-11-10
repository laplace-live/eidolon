# Chats

Chats with the personas, in the local web app, in text and in voice messages. A chat is an
append-only log of events with one to six personas in it. Each persona's reply is a turn of the
turn engine, which talks to her mind without pipedog. In a group chat, the director decides who
answers each line, and the personas may answer each other ([Group chats](#group-chats)). Either
side may send a recorded clip instead of a line ([Voice messages](#voice-messages)).

```text
@eidolon/chat         the format: events, the header, ChatStore, viewOf, parseMentions; safe in a browser
@eidolon/chat/jsonl   JsonlChatStore: the local store, in the data home
@eidolon/engine       runTurn: one persona's turn, from her view of the log to the events it adds;
                      runChat: a chat's answer to the viewer's line, turn by turn;
                      hearVoiceMessage: the viewer's clip, heard
@eidolon/context      Director: who answers each line, and in text or voice (director.ts)
@eidolon/providers/speech-batch   synthesize and transcribe: a whole voice message per request
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
| `message` | the runner for the viewer, the engine for her | `speaker`, `text`, and `attachments` (her selfies; `text` is empty on a message of photos alone); `modality: "voice"` on a voice message, whose first attachment is its audio and whose `text` is its transcript; `interrupted` when she was cut off, keeping what she had said; `cutOff` when her provider stopped her short: `length` at its token limit, `refusal` when it refused or filtered her |
| `context` | the engine | A block a context provider put into her view: `role`, `content` and its `position` there; never shown |
| `context-removed` | the engine | Her earlier `context` blocks, by seq, that a provider took back out; the stream archive replaces its blocks when they change or move |
| `tool-call`, `tool-result` | the engine | Her call and what it returned; a call cut off has no result, and one that ran on past an interruption returns further down the log |
| `kickoff` | the engine | The greeting prompt she answered |
| `turn-failed` | the engine, or the runner when a turn throws | The failure, through `errorText`; the chat stays usable. `code: "voice-failed"` when her reply, stored just before it, was meant as a voice message but stayed text |
| `decision` | the engine (`runChat`) | Who answers the line at seq `after`, and how: `source: "single"` in a chat of one persona, else `mention`, `model` or `fallback`, with the director's `scores` when it asked, and each reply's `mode`, `text` or `voice`. Every reply follows one, and one may choose no one. In a chat of one in `auto`, it lands just before her reply, after her turn's other events |
| `title` | `PATCH` | The chat's title; the last one wins. Until there is one, the page names the chat by who is in it now |
| `participants` | `POST participants` | Personas added or removed |
| `settings` | `PATCH` | The chat's `chainLimit` or `replyMode`; the last of each wins |
| `call-started`, `call-ended` | nothing yet | Calls inside a chat |

**Reserved, so later steps need no format change:** a message's `modality: "call"`, which carries
a call's turn with its transcript in `text`.

**`ChatSummary`** is what the chat list shows: the title, the participants, `createdAt`,
`updatedAt`, the last message's text and the last seq. `summarize` derives it from a log, so a
store can always rebuild it.

## Her view: `viewOf`

`viewOf(header, events, persona, { windowMessages, nameOf })` builds the OpenAI-shaped messages a
call would hold for her, without the system message:

- **Her messages** are `assistant`, and **the viewer's** are `user`. An empty message is left
  out, and an interrupted one keeps what she said. A voice message is its transcript; the
  engine reads the viewer's that was heard as nothing as `（听不清）` (`UNHEARD`).
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
  attachment is a PNG, JPEG, WebP, GIF or AVIF image, or WebM, Ogg, MP4 or MP3 audio, named by its
  content's hash. SVG is refused, since the app serves attachments from its own origin. An audio
  attachment carries `durationMs` where something measured it.
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
- `tool` states (`running`, `done`, `failed`), and in a voice reply, `voice`'s while her voice role
  speaks;
- `events` with the drafts to store;
- `ended`, always last.

A request's `mode`, `text` by default, says whether her reply is a voice message
([step 9](#a-turn-runturn)). It is the one option a turn takes for voice, so a later caller, such
as a call run on the engine, can ask for her voice variant the same way.

The caller numbers and stores each `events` line before it forwards it. A reader that stops reading
aborts the turn. The engine never rejects for the turn's own failures.

1. **It runs as her:** inside `withPersona(persona)` and `withUsageScope({ source: "chat",
   session: <chat id> })`. Jobs a provider spawns, such as Mem0's store, outlive the turn and keep
   both scopes.
2. **Her parts** are what a call's session builds:
   - **What they are:** Mem0 (for a logged-in viewer, which the local viewer is), the stream
     archive, persona facts, the retrieval gate, `take_selfie` and `recall_streams`.
   - **The voice variant:** a voice reply (`PartsOptions.voice`) also gets her voice-style tool,
     first, as a call orders them, while her voice has styles to switch between. Her styles are
     read the first time a voice reply in the chat needs them, and kept with her other parts, so a
     text reply never reads them.
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
     `buildSystemInstruction`, with `voicePromptHint` in a voice reply alone, and in a group the
     line naming the others ([below](#what-each-persona-sees)).
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
6. **Tools' effects:** `switchVoice` sets the voice her voice reply is spoken in, and throws in a
   text reply, which isn't offered the tool. A `selfie` server message copies each image from the
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
   - **A voice reply** is step 9's message.
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
9. **A voice reply** (`mode: "voice"`) is written as a text reply is, cues included, and its
   deltas stream the same. Then:
   - **Speaking it:** the stream gets `{ type: "tool", name: "voice", state: "running" }`, her
     voice role speaks her whole text, in the voice `switchVoice` chose if she called it, and the
     audio is saved with `saveAttachment` and its length.
   - **What is stored:** one `message` with `modality: "voice"`, the audio first and any photos
     after it, and the transcript in `text`, cues and all.
   - **When speaking or saving fails:** the tool line ends `failed`, her message is stored as
     text, and a `turn-failed` with `code: "voice-failed"` follows it.
   - **An interruption while she is spoken** stores her words as interrupted text, with no audio.
   - **A reply with no words** isn't spoken.

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
    tease) rather than close the exchange?");
  - once, and only when some candidate's reply mode is `auto`, `voice_moment` ("Would a voice
    message suit a reply to the latest message better than text…?",
    [Voice messages](#voice-messages)).

  Jev reads them literally, so a reworded question or state needs the benchmark run again.
- **Who answers the viewer's line:**
  1. The personas it @-mentions, in order, then those it addresses (`addressed` 0.5 or more), most
     addressed first. The source is `mention` when it mentions anyone, else `model`.
  2. Otherwise each candidate scores `interested × chat.talkativeness`, less 0.1 for whoever
     spoke the persona line before. Those at 0.3 or more answer, keenest first.
  3. With no one at that bar, the keenest answers anyway, the more talkative of a tie, because the
     viewer is never left unanswered. A persona whose talkativeness is 0 is passed over unless
     everyone's is, even when the penalty sinks the others below her.
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

  The same caps apply. The source is `fallback`, with no scores, so every reply is in text unless
  her mode is `voice`. Without a key for the gate role, every group decision falls back.
- **A chat of one persona:** she answers every viewer line, as `single`. The director asks only
  `voice_moment`, and only while her reply mode is `auto`; otherwise it makes no request. She
  doesn't wait for it ([Voice messages](#voice-messages)).
- **Each reply's `mode`** follows her reply mode: `voice` is voice, `text` is text, and `auto` is
  voice when `voice_moment` clears its bar ([Voice messages](#voice-messages)).

### The chain

`runChat` (`packages/engine/src/chat.ts`) answers each viewer line:

1. It reads the participants, their reply modes and the chain limit once, from the log as it
   stood. The limit is the last `settings` event's `chainLimit`, 0 to 6, else 3
   (`DEFAULT_CHAIN_LIMIT`). A chat of one never chains.
2. It asks the director about the viewer's line, in the chat's usage scope, and yields the
   decision for the caller to store.
3. It runs each chosen persona's turn in order with `runTurn`, in the mode the decision gave her.
   It reads the log again before each, so each turn sees what the ones before it said, and
   anything else stored meanwhile.
4. If a persona spoke and the chain limit isn't reached, it asks about the last persona line, one
   hop further, and so on until no one is chosen.

**Interrupting aborts the whole chain.** The running turn stores what she said as interrupted, and
every turn and hop still to come is dropped. An abort while the director decides stores nothing.

### What each persona sees

- **Her view** labels the viewer's lines with the viewer's name ([above](#her-view-viewof)), and
  folds another persona's run of lines into one `user` message of `名字：text` lines.
- **Her system instruction** gets one line after the viewer line, naming the others by their
  identity names, joined with 、:

  ```text
  这是群聊，群里还有：A、B；只用你自己的身份说话，不要替别人说话。
  ```

  It leaves out `identity.summary`, the English sentence written for the retrieval gate. A chat of
  one and a call get the prefix byte for byte as before, which a test pins.
- **She can't write anyone else's line:**
  - **Stop sequences:** her request's `stop` (`stop_sequences` for Anthropic) holds `\n名字：`
    and `\n名字:` for the two other personas heard from last. That makes 4 strings, OpenAI's
    limit. A mind on the `openai` or `xai` provider is sent none, since their reasoning models
    reject `stop`.
  - **The cut:** `SpeakerCut` (`packages/engine/src/group.ts`) catches what the stop sequences
    miss, on every provider. It holds back the start of each line while it streams, and cuts her
    text before the first line that starts with another persona's name or short name, or the
    viewer's label, and `：` or `:`, case-blind. Nothing after the cut is shown or stored, and
    the mind's stream is dropped there, with any tool calls it held.
- **Mem0 stores only the viewer's lines and hers.** In her view, other personas' lines are `user`
  messages, so storing them would make what they said memories about the viewer: B says 我最喜欢猫,
  and A's Mem0 records that the viewer likes cats. So the engine hands Mem0 its own list, in
  `turn.metadata[MEM0_STORE_KEY]`: the viewer's lines, unlabelled, and hers, the last 60.
  `Mem0MemoryProvider` stores that list when it is there, and the context otherwise, so calls are
  unchanged.
- **A persona removed from the chat still counts for both,** since her lines stay in the view: the
  stop sequences and the cut include her, and Mem0 still gets its own list. Only the prefix's line
  drops her.
- **Recall runs on the latest line,** whoever wrote it, so another persona's question about a past
  stream recalls as the viewer's would.

### Costs

For each viewer line, at the default chain limit, the most it can cost is:
- 5 turns: 2 replies to the viewer, then 3 hops. Each turn is up to 4 mind calls, with its gate and
  recall as in a chat of one;
- 4 director calls: one for the viewer's line, and one before each of the 3 hops. The
  benchmark's 101 calls cost $0.0033 in all, about $0.00003 each, and took 413 ms at the median on
  a warm connection;
- a synthesis for each of those turns that answers in voice ([Voice costs](#voice-costs)).

The defaults keep a typical line at one or two replies. A chain limit of 6 allows 8 turns and 7
director calls.

### Calibrating

- **Every group decision is a `decision` event with its scores,** so real logs can become the
  labelled lines.
- **`bun run director-decisions`** asks Jev about every labelled line, for about $0.003, and exits
  non-zero when any is decided wrong.
- **`bun docs/benchmarks/2026-11-10-director/score.ts --cached`** replays the stored scores through
  the director for free, after a threshold or a label changes.

## Voice messages

A voice message is a recorded clip in the chat, not a live line: the viewer records one in the
composer, and a persona answers with one when her reply mode says so. Both are a `message` with
`modality: "voice"`, its audio as the first attachment in the chat's `files/`, and its transcript
in `text`. Every persona's view reads the transcript, so voice and text mix freely.

### The clients

`@eidolon/providers/speech-batch` makes or hears a whole message in one request, over `fetch`, and
reports what it used with `reportUsage`. It is not the call's speech, which streams through
pipedog; [providers.md](providers.md#voice-messages-batch-speech) has each provider's request.

- **`synthesize(selection, text, { voice? })`,** on her voice role: MP3, with its length from the
  provider or measured from the frames. Her text goes through `stripMarkup` for the model, as a
  call's does: Fish's `drama-3` reads her cues as written, and other models get what they can
  perform. The voice is `voiceOf(selection)`, as a call picks it, unless her voice-style tool
  switched it for this reply.
- **`transcribe(selection, { bytes, mime, durationMs? })`,** on a hearing role: the transcript,
  trimmed and possibly empty, and the clip's length from the provider, else the recorder's clock.
  The language hint is a call's (`STT_LANGUAGE`).
- **`speechSupport(selection)`** says which of the two a role's provider offers. Every voice
  provider in the catalog synthesizes, and every hearing provider transcribes.

The engine reaches them through `EngineDeps.speech` (`batchSpeech`), so tests stand in for both.

### Her reply mode

**Which mode a reply takes** (`replyModeFor`):
- the chat's `replyMode`, from its settings sheet (a `settings` event), for every persona in it;
- else her own `chat.replyMode` (`CHAT_REPLY_MODE`, [personas.md](personas.md#personayaml));
- else `auto`.

`voice` and `auto` become `text` while her voice role can't speak a voice message: no key, or a
provider without batch synthesis (`canSpeak`). An explicit `voice` turned to text that way is
logged.

**`auto`** lets the director choose, with `voice_moment`, asked once per decision while some
candidate is `auto`:
- she answers in voice when its score is `VOICE_THRESHOLD` (0.7) or more;
- the bar drops to `VOICE_THRESHOLD_AFTER_VOICE` (0.4) while the viewer's last line was a voice
  message, so she leans toward answering in kind, on the chain's hops too;
- with no score (no gate key, a timeout, a failure, or a fallback decision), `auto` is text.

**Both bars are placeholders.** The director benchmark has 24 `voice_moment` labels and no
scored run yet ([its README](benchmarks/2026-11-10-director/README.md#voice-moments)).

**In a chat of one,** the director sends one Decisions request per viewer line with only
`voice_moment`, while her mode is `auto`, her voice can speak and the gate role has a key. The
decision stays `single`, with its score. On a failure it warns, and she answers in text.

**She doesn't wait for it** (`answerWhileDeciding`, `packages/engine/src/chat.ts`): her turn starts
with the request, with her voice-style tool and its hint, since her reply may be spoken. Her words
stream in while the director weighs them, and the decision is awaited only once she has written
them, to choose whether her voice speaks them, so its up to 2 s never delays her first word. It is
stored just before her reply. A group's turns wait for theirs.

**A greeting** has no line to weigh, so it is a voice message only when her mode is `voice`.

### The viewer's voice messages

`hearVoiceMessage` hears a clip before anything is stored:
1. **Who hears it:** the hearing role of the chat's first current persona (`voiceHearer`), billed
   to the chat.
2. **Then the clip is saved,** so a clip that couldn't be heard leaves nothing behind.
3. **The message** is stored with the clip and its transcript, and the chat answers it as it
   answers a typed line.

**A clip heard as nothing** is stored with an empty transcript. Her view and the director read it
as `（听不清）`, and the page says no words could be heard in it.

### What fails, and what it does

| What | What happens |
| --- | --- |
| Her voice role has no key, or no batch synthesis | `voice` and `auto` replies are text; the chat's settings sheet says so |
| Synthesis or saving its audio fails | Her message is stored as text, then a `turn-failed` with `code: "voice-failed"`; the page shows a quiet **Sent as text** |
| She is interrupted while she is spoken | Her words are stored as interrupted text, with no audio |
| The director doesn't answer `voice_moment` within 2 s | `auto` replies are text |
| A chat of one is interrupted while the director weighs her reply | The request is aborted. Her words so far are stored as interrupted text, after a `single` decision for text with no scores; with no words yet, nothing is stored |
| The first persona's hearing role has no key | `POST voice` answers `409 missing-key`, and `GET chats/:id`'s `hearingRefusal` says why, which disables the microphone |
| Her hearing provider fails | `POST voice` answers `502 upstream-failed`, and nothing is stored, so the recording can be sent again |

### Voice costs

- **Each voice reply** is one synthesis, billed for what is spoken: Fish's `drama-3` at $50 per
  million UTF-8 bytes ($10 until 2026-11-30), about $0.005 for a 30-character Chinese reply.
- **Each viewer voice message** is one transcription: Soniox's async model at $0.10 an hour of
  audio, about $0.0003 for 10 s.
- **In a chat of one in `auto`,** every viewer line adds one director call, about $0.00003, as a
  group's do.

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
  streams it, as a voice message when her reply mode is `voice`. A group doesn't greet. Neither
  stores a `title`, so the name the page gives a chat follows who is in it: her name, or the
  group's short names.
- **New message:**
  1. It stops a running reply, and waits until what it said is stored as interrupted. The hops
     still to come are dropped.
  2. It stores the viewer's line.
  3. It starts the answer, `runChat`: each decision and each turn is stored, then streamed.

  The answer streams from the viewer's line on, so the viewer can step into a chain at any time.
- **New voice message:** as a new message, except that after the stop it hears the clip
  (`hearVoiceMessage`), and only then stores it with its transcript. One that can't be heard
  stores nothing.
- **A dropped connection** never stops a reply. It finishes and is stored, and `GET live` replays
  it. Only stop, a new message, `DELETE` and the server's shutdown abort one. Shutdown waits up to
  2 s for what was said to be stored.
- **A stop** waits its turn in the queue, so one that arrives while a send is still storing the
  viewer's line, or hearing the viewer's clip, stops the reply that send starts.
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
| `GET chats/:id?afterSeq=n` | | `{ header, events, lateTools, hearingRefusal }`: the events after `afterSeq`; the tools interrupted turns left running; and why a voice message can't be heard now, in `POST voice`'s words, or null |
| `POST chats/:id/messages` | `{ text }`, 1 to 4000 characters | NDJSON `ChatStreamLine`s from the viewer's line on: each decision as an `events` line, and each turn from `started` to `ended` |
| `POST chats/:id/voice?durationMs=n` | The recorded audio: `audio/webm`, `audio/ogg`, `audio/mp4` or `audio/mpeg`, codecs allowed, at most 10 MB; `durationMs` is the recorder's clock, 1 to 120000 | As `POST messages`, its first `events` line holding the stored voice message with its transcript. `415` for another type, `400` without `durationMs` or with an empty body, `413` past 2 minutes or 10 MB, `409 missing-key` while the hearing role can't hear, `502 upstream-failed` when hearing fails |
| `GET chats/:id/live` | | NDJSON of the running reply from its start, or `204` while none runs |
| `POST chats/:id/stop` | | `204` once the stopped reply's words are stored |
| `PATCH chats/:id` | `{ title }`, 1 to 80 characters on one line, `{ chainLimit }`, a whole number from 0 to 6, or `{ replyMode }`, `auto`, `text` or `voice`; one per request | Appends a `title`, or a `settings` that applies from the next viewer line |
| `POST chats/:id/participants` | `{ add?: [id], remove?: [id] }`, at least one persona, none in both | `200 { ok }` and a `participants` event; `400` when it adds one already there, removes one who isn't, or leaves fewer than 1 or more than 6 |
| `DELETE chats/:id` | | Stops any reply, then removes `chats/<id>/` and nothing else |
| `GET chats/:id/files/:name` | | The attachment: its type, `nosniff`, a sandbox CSP and `Cache-Control: private, max-age=31536000, immutable`; an `<img>` or `<audio>` reads it with the cookie alone. It answers `Range` requests with a `206` (Bun.serve's own, on a file) and sends `Accept-Ranges: bytes`, since Safari plays audio only from a server that takes ranges |

- **Text** is trimmed. A message may hold tabs and line breaks, but no other control character.
- **`missing-key`:** when a persona's mind role's provider takes a key and has none, `POST chats`,
  `POST messages` and `POST voice` answer `409 missing-key` before anything is written, in the
  words a call's preflight uses. In a group, the message names her (`<id>'s mind role has no
  key.`). `POST voice` also checks the first persona's hearing role, before it reads the body.
- **Every persona in the chat is checked,** whether or not the director would choose her. One deleted
  since is `404 unknown-persona`, until she is removed: `POST participants` looks up only the
  personas it adds.
- **`unknown-chat`:** a chat the store doesn't have is `404 unknown-chat`.
- **An `error` line** ends a stream only when a turn threw and even its `turn-failed` couldn't be
  stored, or when the answer threw outside any turn, as when reading the log fails.

**Checks:**
- `bun test --no-env-file packages/chat packages/engine packages/context apps/bot/test/local`.
- `bun apps/bot/scripts/local-smoke.ts --headful`. It walks three chats against its fake
  OpenAI-compatible server, which also answers the director's Decisions route and OpenAI's speech
  and transcriptions. It bills nothing.
  - **A chat of one:** New Chat and the greeting, a reply that streams in with its cue as a chip,
    after a decision that asked `voice_moment` alone, the history after a reload, Rename and
    Delete.
  - **A group,** with a second persona made from no template: no greeting, an @-mention the
    composer completes, the second persona's answer, the first's answer to her a hop later, and
    each line under its persona's name.
  - **Voice messages,** with her voice and hearing on an OpenAI account at the fake server: a
    message held on the microphone, through Chrome's fake microphone playing a WAV, its transcript
    and her text answer; then Voice in the chat's settings, her voice reply with its cue taken out
    of what was spoken, playing on its own to its end, its file served in ranges, and both
    roles' spend in the ledger.
- `bun run director-decisions` after changing the director's questions, state or thresholds
  ([Calibrating](#calibrating)).
- **By hand, billed:** a chat with milky-green on OpenRouter. Ask a recall question (it must call
  `recall_streams` or get archive context), and ask for a selfie, which must still show after
  `SELFIE_TTL_SECONDS`. Run Mem0 with `docker compose up qdrant`.
- **By hand, billed:** a group of two personas on OpenRouter. Its `decision` events must come
  from `mention` or `model` with scores, not `fallback`, and neither persona may write the other's
  lines.
- **By hand, billed:** a voice reply from milky-green on Fish `drama-3`, to a line that draws her
  cues, listened to: a direction or a tag spoken aloud is a leak. Then a voice message recorded in
  the browser, transcribed by her hearing role.

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
