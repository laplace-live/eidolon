# The voice engine

A call runs on eidolon's own loop around `@eidolon/engine`, so its turns run through the same
engine, log format and `viewOf` as a text chat. It replaced pipedog's frame pipeline as every
call's engine on <the G7 date>, and pipedog left the repository after 14 more days; clients needed
no change ([Differences from pipedog](#differences-from-pipedog)). [RTVI](#rtvi) lists what they
saw change, and [frontend-loading-state.md](frontend-loading-state.md) tells them.

```text
@eidolon/voice                  the loop; only packages/runtime imports it
  src/input/                    the Ear: Silero VAD, Smart Turn, the TurnDetector (ported from pipedog)
  src/output/                   the segmenter, the Mouth, the Speaker, what was heard
  src/rtvi/                     the RTVI messages, as pipedog's observer sent them
  src/call/                     the mailbox and the loop every call runs (kit.ts), the Floor, the
                                call log, runCascadeCall, runRealtimeCall (realtime.ts), a group
                                call's policy (group.ts)
  src/dsp/resampler/            pipedog's rubato resampler, vendored with its wasm
  models/                       Silero VAD's and Smart Turn v3.2's ONNX models, with their licenses
@eidolon/providers/stt          live speech recognition, one stream per call
@eidolon/providers/speech-stream   streaming speech, one stream per persona per call
@eidolon/providers/realtime   a realtime model's session, OpenAI's dialect or xAI's
@eidolon/webrtc                 a call's WebRTC on werift: signalling, the peer, its data channel and
                                audio, the werift patches; only packages/runtime imports it
@eidolon/engine                 runTurn in call mode (CallHooks)
packages/runtime/src/native/    the bridge: production's deps, a call's start, a call inside a chat
                                (binding.ts)
```

Code ported from pipedog keeps pipedog's BSD-2 header, then `Ported from pipedog <path>@ce8f8bc`.
pipedog is never followed past that commit.

## Starting a call

`createSignallingServer` (`packages/runtime`) answers every offer with a call on
`@eidolon/webrtc`'s peers ([The transport](#the-transport)). There is no switch: the
`EIDOLON_VOICE_ENGINE` the flip used is gone, and a value left in an env file is ignored. Rolling
back to pipedog means deploying an image built before it was deleted.

Every provider the catalog offers for hearing, voice and realtime has a client. A provider added
without one fails its calls as they start,
`Bot session failed: <provider> has no … in Eidolon yet`, and so do settings that can't be read.

A group call ([Group calls](#group-calls)) checks, as it starts, with `groupReason(host, personas)`,
that none of them talks through a realtime model (`realtimeIn`, which the local app's check shares)
and that the host is one of them; a call that fails the check fails as `Bot session failed: <why>`.

**Warm-up:** `warmAudioModels()` loads both models and the resampler before the server listens:
`models/silero_vad.onnx` and `models/smart-turn-v3.2-cpu.onnx` (`voiceModels()`, through
`@eidolon/config`'s `voiceModelsDir()`; the npm package ships them in `data/models/`), on the
pinned onnxruntime-node 1.30.0. `src/input/onnx.ts` turns ORT's telemetry off before ORT first
loads (`ORT_DISABLE_TELEMETRY`, set with libc's `setenv`, since ORT's `getenv` never sees Bun's
`process.env`): an upload in flight at exit crashed Bun (exit 134).

**Logs:** a call logs what the local app and the e2e notes read:
- the `[bot] Session start …` line and `Starting bot` (`logSessionStart`), a chat window in the
  request data logged by its size alone;
- `Client connected`, then `Client disconnected` or `Call ended: <reason>`;
- `Bot session failed: <why>` when it can't start, which `apps/bot/src/local/status.ts` parses;
- one `[voice] ttfb <stage> <ms>` line per stage per reply: `llm`, `text`, `speaking`.

Every change under `packages/` rebuilds `:edge` and restarts production, so merge in a quiet hour.

## The loop

```text
browser ══WebRTC══▶ CallTransport ─ @eidolon/webrtc (a werift peer)
                     ├─ audioIn (16 kHz mono, 20 ms) ─▶ Ear: STT ∥ VAD ─▶ Smart Turn ─▶ TurnDetector ─┐
                     ├─ messages (RTVI in) ──────────────────────────────────────────────────────────┤
                     └─ Speaker (24 kHz) ◀── pull(240) on the transport's drift-free 10 ms clock     │
                                                                                                    ▼
   replies: runTurn (call mode) ── lines ──▶ the call's mailbox ──▶ the Floor (never awaits)
   Mouth: segmenter ─▶ utterance (speech-stream) ─▶ resample ─▶ Speaker.enqueue
   the Speaker's cursor, async tool results, timers ──▶ mailbox
                                       the Floor ─▶ RtviEmitter ─▶ transport.send
                                       the Floor ─▶ CallLog (in memory, dropped at the call's end)
```

**The mailbox rule:** transport, provider and timer callbacks only post to the call's mailbox
(`CallKit`), and only the Floor changes call state. `Floor.handle` is synchronous: anything it needs
to wait on runs as a task that posts back.
- **Why:** `runVoiceCall` runs inside `withUsageScope({ source: "call", session: <call id> })`,
  and the mailbox's reader and every task it starts inherit that scope. werift's callbacks don't,
  so a billable request started from one would fall outside the call's usage.
- **Order:** the Floor sees each producer's events in the order it posted them. The engine's
  request for what was heard, and each tool effect, go through the mailbox too, behind the text the
  Floor has yet to speak.
- **Store first:** a reply's `events` line is appended to the call log before anything else is done
  with it. After a barge-in, the caller's next lines and any async results wait until the cut reply
  has stored what was heard, so her interrupted message stays before them.

**A call's log** is a chat log (`@eidolon/chat`): the caller's lines are `message`s with
`modality: "call"` (or `"text"` for `send-text`), and her turns store what the engine stores. Its
view is `viewOf`'s, with the text chat's 60-message window. Production keeps it in memory and drops
it when the call ends; a call inside a chat opens it on the chat
([below](#a-call-inside-a-chat)).

**Billing:** each reply runs with `usage` set to the call's scope, never `"chat"`. STT bills the
audio it is sent, speech the characters it is given, and both flush their meters when the call
closes them.

## The state machine

The Floor's state is three regions, plus counters:

| Region | States |
| --- | --- |
| CALL | `connecting` → `live` → `ended` |
| USER | `quiet` \| `speaking{interruptedBot}` |
| BOT | `idle` \| `thinking{reply}` \| `speaking{reply}` |

- **Counters:** `recoveries` (empty-turn recoveries in a row), `syncToolsRunning`, `followUps`
  (the personas owed a follow-up, each once, in the order their results came; a reply that isn't a
  follow-up clears it), and whether the reply is spoken (its last audio has come and the mind is
  done).
- **Idle** is USER quiet and BOT idle, pipedog's `waitingForUser`.

`floor.ts` numbers its transitions by this table. "Emit" is an RTVI message ([RTVI](#rtvi)).

| # | From | Event | Guard | Actions | To |
| --- | --- | --- | --- | --- | --- |
| 1 | CALL connecting | `client-ready` | — | an unparsable version or a major other than 2 gets `error-response`, and the call goes on; emit `bot-ready` with its id; CALL live; greet if the plan says so, which a group call never does | BOT thinking |
| 2 | USER quiet | ear `user-started` | — | emit `user-started-speaking`, then `bot-interrupted`; `interruptedBot` is BOT ≠ idle or a sync tool running; barge in if BOT ≠ idle | USER speaking |
| 3 | USER speaking | ear `interim` / `final` | — | emit `user-input`, then `user-transcription` | — |
| 4 | USER speaking | ear `user-stopped(text)` | text | emit `user-llm-text`, then `user-stopped-speaking`, as pipedog does; store the line; recoveries := 0; start a reply | USER quiet, BOT thinking |
| 5 | USER speaking | ear `user-stopped(null)` | interruptedBot, recoveries < 1, no sync tool | emit `user-stopped-speaking`; recoveries++; start a reply with `INTERRUPTED_EMPTY_TURN_PROMPT` | USER quiet, BOT thinking |
| 6 | USER speaking | ear `user-stopped(null)` | otherwise | emit `user-stopped-speaking`; start a follow-up owed while the caller spoke | USER quiet |
| 7 | live | `send-text{run_immediately:true}` | — | emit `bot-interrupted`; barge in if BOT ≠ idle; emit `user-input{chat}`, then `user-llm-text`; store the line; start a reply, spoken unless `audio_response` is false | BOT thinking |
| 8 | live | `send-text{run_immediately:false}` | — | emit `user-input{chat}`; store the line for her next turn; start no reply, as pipedog runs none | — |
| 9 | BOT ≠ idle | reply `mind started` | — | emit `bot-llm-started` | — |
| 10 | BOT ≠ idle | reply `delta` | — | emit `bot-llm-text`; push it to her speech | — |
| 11 | — | Mouth `segment` | — | emit `bot-transcription`; for a reply without audio, also its one `bot-output` "new", `will_be_spoken: false` | — |
| 12 | — | Mouth `tts-started` | the reply's first | emit `bot-tts-started` | — |
| 13 | BOT thinking | Speaker `reply-start` | this reply | in a group call, emit `server-message {type: "speaker"}` naming her; emit `bot-started-speaking` | BOT speaking |
| 14 | BOT speaking | Speaker `seg-start` / `words` / `seg-end` | — | emit `bot-output` new / in-progress / completed, the last with `bot-tts-text` | — |
| 15 | — | reply `mind ended(error?)` | — | emit `bot-llm-stopped`, and `error` on a failure; flush her speech | — |
| 16 | — | reply `tool running` | — | emit `llm-function-call-started`, and `-in-progress` once the round's `bot-llm-stopped` is out, as pipedog orders them; a sync tool counts | — |
| 17 | — | reply `tool done / failed / cancelled` | — | emit `llm-function-call-stopped{cancelled}`, after its `-in-progress` if that still waits (a call naming a tool she doesn't have ends before its round does); a sync tool uncounts | — |
| 18 | — | reply `notice`, or a `turn-failed` no mind request reported | — | emit `error` | — |
| 19 | — | Mouth `tts-stopped` | the reply's last utterance | emit `bot-tts-stopped`; the reply is spoken once the mind is done | — |
| 20 | BOT speaking | Speaker `drained` | spoken | emit `bot-stopped-speaking` | BOT thinking until `ended` |
| 21 | BOT speaking | Speaker `drained` | not spoken | arm 3 s; if the Speaker is still drained then, emit `bot-stopped-speaking` | — |
| 22 | BOT ≠ idle | reply `ended` | — | BOT idle; start an owed reply while the caller is quiet | BOT idle or thinking |
| 23 | — | async result | — | store it; start a reply if idle, else owe one | — |
| 24 | live | ear `stt-error` | fatal | emit `error`; end the call (`error`) | ended |
| 25 | live | Mouth `tts-error`, or 15 s without audio she owes: after a segment is said until some comes, and after her speech ends until its end does | — | emit `error`; drop her queued audio and cancel her speech; the reply goes on in text, storing what was heard | — |
| 26 | live | idle timer (300 s) | — | end the call (`idle`) | ended |
| 27 | live | `disconnect-bot` | — | start no more replies; end the call (`bot`) once her audio plays out, 10 s at most | ended |
| 28 | live | the transport closed | — | end the call (`client`) | ended |
| 29 | any | shutdown | — | end the call (`shutdown`) | ended |
| 30 | live | any other message | — | `client-message` is logged at debug; anything else gets `error-response` | — |

**The idle timer** restarts on the caller's speech (every 0.2 s while the VAD hears it), each
transcript, and her audio playing. `apps/web/src/features/call/phase.ts` counts on at least 285 s.

**A barge-in:**
1. the Speaker empties at once;
2. her speech freezes at what was heard;
3. her turn is aborted: her mind, her context providers and her sync tools stop, and async tools
   run on;
4. after row 2's two messages, emit `bot-llm-stopped`, `bot-tts-stopped` and
   `bot-stopped-speaking` for whichever was open, so a new `user-started-speaking` comes before the
   old `bot-stopped-speaking`, as [frontend-loading-state.md](frontend-loading-state.md) documents;
5. her turn stores her message, `interrupted`, with the heard text, then ends.

**Her mind** is made before anything connects, as pipedog's session made its LLM, so a mind role
with no key fails the call with `Bot session failed: …`. A turn that fails later before its mind
request (her key removed mid-call, her parts failing to build) reports its failure as `error`
(row 18), and the call goes on, as it did after any pipedog error.

**Ending a call** (`end(reason)`): cut the open reply silently, abort her async tools, close the
recognizer and her speech (their meters flush), wait at most 2 s for the cut reply to store what
was heard, flush the log, and, unless the client left, disconnect, which sends `peerLeft`.

## Hearing

The Ear sends each 20 ms frame to the recognizer at once (resampled to 24 kHz for OpenAI), and in
order through Silero and Smart Turn. On the VAD's quiet edge it asks the recognizer to finalize,
runs Smart Turn, and arms the deadline. Only the TurnDetector waits for Smart Turn.

The constants are pipedog's at ce8f8bc:

| What | Value |
| --- | --- |
| Silero window | 512 samples at 16 kHz with a 64-sample context; its state resets after 2 s quiet with the last 5 windows under 0.1 |
| Speech | confidence ≥ 0.7 and smoothed volume ≥ 0.6 (BS.1770 over 400 ms, −110 to −10 LUFS, smoothing 0.2) |
| Start, stop | 0.2 s each: 6 windows |
| A muted mic | no audio for 1 s while speaking forces the stop |
| Smart Turn | the last 8 s from 0.7 s before speech, zero-padded, 80×800 log-mel; complete when p > 0.5; 3 s of silence is complete without the model |
| Ending the turn | Smart Turn complete, the turn has finals, and the last final was finalized or the recognizer's p99 has passed since the stop (minus 0.2 s), or the finalize was acknowledged (below); never while the VAD hears speech |
| A final with no VAD stop | complete after max(0, p99 − 0.2 s) |
| Watchdog | the turn ends 5 s after the last VAD or STT event |
| Joining | the turn's finals with `joinSegments`: a space between two segments unless either side is CJK |

Each turn's end costs about 88 ms of main-thread work on an M4 Max, 52 ms of it Smart Turn's naive
DFT, as in pipedog.

**The acknowledgement** (U20) is eidolon's own; pipedog had no such rule. Soniox and Deepgram answer
every `finalize()`, words or none: Soniox with its `<fin>`, Deepgram with a `from_finalize` result.
A `<fin>` with no final words before it, or an empty `from_finalize` answering a finalize the
client sent (it counts them, so two stops before either answer get an answer each), is the bare
`finalized` event; one with words is the `final {finalized: true}` it always was.

- **Once the stop's finalize is acknowledged,** the turn ends as soon as Smart Turn says complete,
  with no wait for the p99. A turn with no words (a cough) ends then as an empty turn, so the
  Floor's empty-turn rules (the recovery prompt, D13) run at once, not after the 5 s watchdog.
- **The cap:** a recognizer that answers every `finalize()` (`acknowledgesFinalize`: Soniox,
  Deepgram) and has said nothing 1.91 s (`FINALIZE_ACK_CAP_MS`) after it counts as having answered
  it. That is Soniox's p99 of 0.91 s plus 1 s, measured in
  [`2026-11-10-finalize-ack`](benchmarks/2026-11-10-finalize-ack/README.md). ElevenLabs and
  OpenAI answer a commit with no words with nothing, and OpenAI's first words can come later than
  the cap with no interim before them (its p99 is 1.66 s from the end of speech), so they get no
  cap: their turns end on a final and its p99, or at the 5 s watchdog, as before U20.
- **What clears it:** an interim (words are coming: their final, or the watchdog, ends the turn,
  not the cap, whether the interim came before the stop or after it), and a VAD start, which drops
  a pending stop as before.
- **Which stop it answers:** the recognizer answers finalizes in order, so the TurnDetector counts
  the ones still owed an answer (a bare acknowledgement or a finalized final). An answer ends the
  turn only when it answers the last stop's: one that comes with answers still owed (a cough, then
  a word stopped before the cough's answer came) answered an earlier stop. A bare one is then
  ignored, and a finalized final is kept as a final like any other, which the last answer, the
  cap, the p99 or the watchdog ends. A bare acknowledgement that comes while the VAD hears speech
  again, or with an interim since the last final (words it can't be the answer for), answered an
  earlier stop too. The cap forgets answers still owed, which a reconnect loses.

## Speaking

**The segmenter** splits her text where pipedog's `SimpleTextAggregator` does, with three
differences (D7): it keeps closers (`”’」』）)】`) and repeated end punctuation with their sentence,
never splits inside an open `[`, and merges a segment with no letter or digit, once cues are
stripped, into the next. A reply's last segment goes out at each mind round's end.

**The Mouth** (one per persona per call) speaks a reply through one utterance at a time in the
current voice, resamples to 24 kHz where the provider's rate differs (Fish's 44.1 kHz), and queues
the audio on the Speaker, tagged with its reply and segment.

| Provider | Utterance | Where a segment's audio ends |
| --- | --- | --- |
| Fish | one session per utterance, its segments sent one at a time: each as `text` and `flush` once the one before it has had no audio for `FISH_SEGMENT_IDLE_MS` (100 ms), `stop` once the last is flushed, and `finish` marks the end of its audio | exact: that quiet, or the `finish` |
| MiniMax, OpenAI | one HTTP request per segment, two at most in flight, played in order | exact |
| ElevenLabs, Cartesia, Soniox | one context or stream per utterance | words timed by their letters and digits; a segment ends at its last word or the utterance's end |

**Fish's serial flushes** rest on [`2026-11-10-fish-flush`](benchmarks/2026-11-10-fish-flush/README.md):
on Fish's live socket each flush's audio came as one message, 0.5–1.9 s after it (947 ms at the
median), and nothing more until the next flush, so 100 ms of quiet is only the event loop's
margin. Projected at that value, sending one segment at a time adds no silence between
sentences: each one's audio arrives while the ones before it still play. A flush that brings no
audio for 15 s fails the utterance, as any speech that owes audio does, so no segment waits behind
it for ever; a barge-in drops the segments still waiting and sends nothing more on the session.

**The Speaker** is the call's one output queue. The transport's 10 ms clock pulls 240 samples,
silence when it is empty. As its cursor plays, it posts `reply-start`, each segment's start and end,
the words played, and `drained`. Clearing it takes effect at once.

**What was heard** (`heard()`), which her turn stores:
- the raw text, cues included, of every segment the cursor has passed the end of, plus the played
  words of the current one where the provider times words;
- joined with `joinSegments`;
- `complete` only when the reply drained without a barge-in.

With `audio_response: false`, a reply speaks nothing and keeps all of its text. Each of its
segments still goes out, as pipedog's did: its `bot-transcription`, and one `bot-output` "new" with
`will_be_spoken: false`, which nothing completes.

**A voice switch** (`change_voice_style`) flushes the segmenter, ends the utterance so its audio
plays out, and opens one in the new voice for the text after it.

## Tools and async results

In a call, the engine runs her turn in call mode (`CallHooks`, [chat.md](chat.md)):
- she has `change_voice_style` (unless a realtime model voices her), `take_selfie` and
  `recall_streams`, with their schemas unchanged;
- a sync tool runs, and its result is stored before her next round;
- `take_selfie` is async: its call is stored with a `started` result, the round goes on, and the
  selfie renders in the background. When it settles, its `final` or `cancelled` result is stored
  and starts a follow-up reply once the floor is free (rows 22–23). The call's end cancels it;
- `ASYNC_TOOL_INSTRUCTIONS` joins her system instruction while an async tool is registered, as
  pipedog's call prompt had it.

Her tools act on the call through effects: a voice switch reaches her speech, and a selfie's
`server-message` goes to the client.

## Realtime

A persona whose realtime role is on calls through one realtime model that hears, thinks and speaks
(`runRealtimeCall`, `src/call/realtime.ts`). The call keeps the mailbox, the Speaker, the RTVI
emitter and the call log; the server's VAD takes the Ear's place, and her audio goes straight onto
the Speaker, tagged with its item's id.

**The session** opens as the call starts, in the host's persona scope, on her parts' realtime
variant (`realtime: true`): her system instruction with the realtime delivery line and, while she
has an async tool, `ASYNC_TOOL_INSTRUCTIONS`; her selfie and recall tools, never the voice tool; her
realtime voice; and for OpenAI, transcription by `gpt-realtime-whisper` in `spokenLanguage()`.
The caller's 16 kHz audio is resampled to OpenAI's 24 kHz.

**The conversation it opens on** is her view of the log less her tool calls (`callSeed`), packed
as pipedog's realtime adapters pack a call's context (`_fromUniversalContextMessages`, ported with
its notice): nothing, a single user message as it is, or everything in one user item between the
adapter's intro and trailing text. A production call's log starts empty, so its greeting is just the
kickoff; a call bound to a chat opens on the chat.

**The greeting:** on `client-ready`, `prepareTurn` with the kickoff stores the kickoff and her
recall, then the conversation goes in and she is asked for a response. A call that doesn't greet
sends its conversation as the session opens.

| Server event | What the call does |
| --- | --- |
| `speech-started` | a barge-in: the Speaker empties, the item at the cursor is truncated at the ms the cursor had played (not pipedog's estimate), xAI also cancels the response; `user-started-speaking`, `bot-interrupted`, then the closes of a cascade barge-in |
| `speech-stopped` | `user-stopped-speaking` at once |
| `user-transcript` | `user-input` and `user-transcription`, cumulative; a final stores the caller's `call` line and runs `prepareTurn`, which the next `speech-started` stops, and its `context` events go to the session (E1). Recall trails by one turn |
| `response-started` | one `bot-llm-started` per response (E5) |
| `transcript-delta` | `bot-llm-text`; the segmenter's sentences become `bot-transcription`, and each sentence's `bot-output` "new" and "completed" go out as the cursor passes the audio queued by its last delta (E4) |
| first `audio` of a response | `bot-tts-started`; `bot-started-speaking` comes from the Speaker |
| `response-done` | `bot-tts-stopped`, `bot-llm-stopped`, an `error` if it failed, then her last sentence |
| `tool-call` | `runTool` from the engine (below) |
| `error`, or the socket closing | `error`, then the call ends (`error`, E8) |

- **Her line** is her transcript, stored once her audio has played; cut off, it is the deltas the
  cursor had passed, `interrupted`.
- **E4's hold:** after the caller stops, her `bot-output` and stored lines wait for the caller's
  final transcript, a second at most, so the caller's line comes first.
- **The caller's `user-llm-text`** goes out once the reply to that turn has played or been cut,
  where pipedog's realtime handoff flush wrote the line to her context.
- **Typed text** (`send-text`) cuts her off, the response included, goes in as the caller's item and
  asks for a response (E2), then runs `prepareTurn` as a final transcript does, unless it is blank;
  without `run_immediately`, it goes in for her next response, and runs nothing.
- **Tools:** a sync tool runs, and its result answers its call once the response has ended and
  played out and no other response runs; then she is asked for the response that reads it. A
  barge-in, spoken or typed, cancels every sync tool still running, whether or not its response has
  ended: its call is answered `CANCELLED`, and no response is asked for it. An async tool's call is
  answered with its placeholder (the started envelope), and its result goes in later as a system
  item carrying the final or cancelled envelope, with a follow-up response once the floor is free.
- **Her voice can't switch:** `switchVoice` throws, as it did on pipedog.
- **Metering** is the session's (`@eidolon/providers/realtime`): audio hours for a model priced by
  the hour, else each response's tokens.

## A call inside a chat

A call bound to a chat runs through a `CallBinding` ([chat.md](chat.md#the-binding),
`src/native/binding.ts`), which the local app's runner and production's `bindChatCall` make.
- **She runs as herself:** the whole call runs inside `withPersona(binding.persona)`, so her
  roles, not the active persona's, make the call, and settings of hers that can't be read fail it.
- **The seed opens the call's log:** the viewer's lines and hers as messages, a system or developer
  message as her context block where it stands. Her view is the seed, then the call, in the text
  chat's 60-line window, which counts the chat's lines too (D1). A realtime call packs that view
  into its history item ([Realtime](#realtime)).
- **The lines:** each message the call stores, the viewer's spoken or typed line or hers, goes to
  `onTranscript` as the log takes it. Hers is what was heard, `interrupted` when the viewer or a
  hang-up cut her off. The seed, the greeting's kickoff, the empty-turn prompt and an empty line
  aren't reported. A hook that throws is logged, and the call goes on.
- **Her photos:** each `server-message` the call sends its browser, a selfie's, reaches
  `onServerMessage` once sent, in order with the lines.
- **The browser:** every hook gets the call's one `CallClient`, whose `sendServerMessage` reaches
  the data channel until the browser hangs up or the call ends.
- **The end:** `onEnded` once, after the last line: `error` when the call couldn't start or ended on
  a fatal error, else `hangup`.
- **Mem0 stores only what is said on the call:** her Mem0 provider gets her view of the call's own
  events as the turn began (`MEM0_STORE_KEY`), since the chat's turns stored the seed already. So
  the greeting's turn stores nothing, where pipedog's stored the kickoff.

## Group calls

A group call has every persona in a chat on it at once, and answers each of the caller's lines as
the group chat does: the director chooses who answers, and the personas may answer each other
([chat.md](chat.md#group-chats)). Only the local app offers one
([chat.md](chat.md#a-call-in-the-local-app)).

- **Who hears and who speaks:** the host, the persona whose Call started it, hears the caller
  through her hearing role, the call's one Ear. Every persona has her own Mouth, opened in her
  persona scope with her own voice role, styles and markup, all on the call's one Speaker.
- **Each line's answer** is `runChat` in call mode (`group.ts`, CallChatRequest's `hooks`): the
  Floor runs it after each caller's line, spoken or typed, and each persona it chooses gets her own
  call hooks, her turn a reply of its own, on her Mouth.
- **One speaker at a time:** her turn ends only once her audio has played, since it awaits what was
  heard, so the director is asked about the next turn, and the next persona's mind, only after it.
  Nothing is generated ahead.
- **Her label:** as each persona's first sample plays, just before `bot-started-speaking`, the
  client gets `server-message {type: "speaker", persona, name}`, her id and her identity name; a
  reply in text alone (`audio_response` false) gets it just before its first `bot-output`. A
  selfie's `server-message` names her `persona` too.
- **A barge-in** cuts the persona speaking, who stores what was heard as interrupted, aborts the
  chain, and drops the turns still to come; one that comes while the director weighs the next turn
  stops it, and nothing more is stored. An empty turn that cut her off asks her alone to go on.
- **Her follow-up:** an async tool's result starts a turn of hers alone once the floor is free, as
  the director chose no one for it. Each persona whose result comes while the floor is taken gets
  hers, once, in the order the results came.
- **No greeting**, as a group chat has none.
- **The log** opens on the chat itself, its header and events, under the call's id: each turn
  stores her `call` message, and each answer its `decision`s.
- **Mem0** stores the viewer's lines on the call and hers, never another persona's, which would
  become memories of the viewer.
- **No realtime model joins one:** the local app refuses the call with `409 realtime-in-group`.

A group call's binding (`GroupCallBinding`, `src/native/binding.ts`) carries the chat as stored
instead of a seed, and reports each line and decision the call stores to `onEvents`, numbered as
the call's log numbers them; the local runner stores each decision against the line it answers as
the chat numbered it. Each persona's photo reaches `onServerMessage` with her `persona`.

## RTVI

The server stays at protocol 2.2.0; client-js 1.16.0 speaks 2.3.0 and accepts any server of the
same major. Every message is `{label: "rtvi-ai", type, id?, data?}` with snake_case keys and nulls
left out; `id` appears only on `bot-ready` and `error-response`.

| Message | Against pipedog's, before the flip |
| --- | --- |
| `bot-ready` | byte-identical, `capabilities.metrics: true` included, and always before her greeting |
| `user-started-speaking`, `user-stopped-speaking`, `bot-interrupted` | the same, in the same order |
| `user-input`, then `user-transcription` | the same; joined CJK-aware (D6); OpenAI's interims are cumulative (D8) |
| `user-llm-text` | the caller's lines and typed text only, no longer the greeting's prompt (D2) |
| `bot-llm-started` / `-stopped`, `bot-llm-text` | the same: one pair per mind round, stopped even on an error |
| `bot-transcription` | per segment of eidolon's segmenter (D7) |
| `bot-tts-started` / `-stopped` | stopped now always comes, per reply and on a barge-in (D4) |
| `bot-started-speaking` / `-stopped-speaking` | stopped comes at the audio's end, not seconds late (D5) |
| `bot-output`, `bot-tts-text` | the same shape; `segment_id` counts from 1 in each call |
| `server-message` | the same for selfies; a group call's also name her `persona`, and its `speaker` messages are new |
| `error {fatal: false}` | the same texts |
| `llm-function-call-started` / `-in-progress` / `-stopped` | the same |
| `metrics` | never sent (D3) |
| `error-response` | also for inbound types pipedog accepted and ignored (D9) |

What a client can count on:
- **I1:** `bot-ready` comes before any other `bot-*`, `user-*` or `llm-*` message.
- **I2:** a turn's final `user-input` and `user-transcription` come before its
  `user-stopped-speaking`.
- **I3:** `user-input` comes before `user-transcription` for the same text.
- **I4:** every `user-started-speaking` is followed at once by `bot-interrupted`.
- **I5:** every `bot-llm-started` has a later `bot-llm-stopped`, with no start between.
- **I6:** every `bot-tts-started` has a later `bot-tts-stopped`.
- **I7:** each `segment_id` is "new" before "in-progress" or "completed", and "completed" once
  unless interrupted or never to be spoken (`will_be_spoken: false`).
- **I8:** every `error` is `fatal: false`.
- **I9:** a turn with no final transcript starts no mind request unless it interrupted her.
- **I10:** after `bot-interrupted`, no `bot-llm-text` comes before the next `bot-llm-started`.

On a realtime call the server ends the caller's turn on its own VAD and answers before it has
transcribed it: I2 holds as "a turn's final transcript comes after its `user-started-speaking`",
and I9 doesn't apply.

## The transport

A call runs on `@eidolon/webrtc`: werift and libopus-wasm, with pipedog's SmallWebRTC transport
ported in, less its aiortc emulation, its aiortc-derived code and its video. What a client sees is
what pipedog's transport showed it:
- **HTTP** (`signalling.ts`): `POST` and `PATCH /api/offer` answer with the same JSON, status codes
  and error bodies, the guard first, and a pc_id of the same form. Each offer's peer is built from
  its own plan: its ICE servers, the relay-only rules for the offer and its PATCHes, and the Opus
  bitrate.
- **The peer** (`peer.ts`): the answer waits for ICE gathering; transceivers 0 and 1 send and
  receive and the rest only receive, her audio on mid 0; Opus 48k/2 with
  `minptime=10;useinbandfec=1`, VP8 and H264 listed so the camera sections are answered;
  max-bundle; a 1100-byte SCTP DATA chunk. 60 s in "connecting", or "failed", closes it. The werift
  patches are `patches.ts`'s.
- **`restart_pc`** answers on a new werift peer with a new pc_id and the original options, its DTLS
  close watched again; PATCHes to the old pc_id still reach it, and the call goes on.
- **The data channel** (`channel.ts`): JSON both ways, up to 50 messages queued until it opens and
  none once it has failed to open 10 s after the peer connected; the client's pings, read for
  liveness; the signalling envelope, its `trackStatus` read and ignored, and `peerLeft` sent when
  the bot hangs up.
- **The caller's audio** (`audio_in.ts`): reordered by pipedog's audio jitter buffer (60 ms; late
  and duplicate packets dropped, a jump of more than 0x1000 resyncs), a gap of up to 10 packets
  concealed (PLC, the last packet recovered from the next one's FEC), and decoded straight to
  16 kHz mono. Packets that come while the decoder loads wait, 50 at most.
- **Her audio** (`audio_out.ts`): the Speaker pulled every 10 ms on a clock counted from its start,
  so a stall catches up instead of drifting, and sent as 20 ms Opus at 24 kHz at the offer's
  bitrate (libopus's `voip`), RTP sequence +1 and timestamp +960 from random starts, every packet
  marked. Silence goes out while she says nothing, so the browser's track never mutes.

**The call's transport** (`peerCallTransport`), which the loop reads as its `CallTransport`:
- **On `connected`:** the caller's audio and hers start on the current werift peer.
- **On `disconnected`** (`restart_pc`, or ICE dropping): both stop, and the next `connected` takes
  up the new peer's. Her audio waits meanwhile, and while the peer sends no ping for 3 s, instead
  of playing to no one (D10).
- **App messages** reach the call; `connect()` delivers those that came first, `client-ready`
  among them.
- **`closed`** resolves when the peer closes, the server's shutdown included, but not after the
  call's own `disconnect()`, which sends `peerLeft` and closes the peer.

Messages go out as `JSON.stringify` writes them, where pipedog's transport wrote Python's
`json.dumps` form; clients parse both alike.

## Differences from pipedog

eidolon's engine replaced pipedog's pipeline on <the G7 date>, after the user signed off each
difference below, and what [frontend-loading-state.md](frontend-loading-state.md) tells clients of
them. Each fixed a defect with the trigger it names; code and docs cite them by id.

| Id | Difference | Trigger |
| --- | --- | --- |
| D1 | a call's view is the last 60 messages | a call longer than 60 lines, or a call inside a chat whose window and lines pass 60 together |
| D2 | no `user-llm-text` for the greeting or follow-ups | every call: pipedog sent the client the kickoff prompt |
| D3 | no `metrics` | no client reads them |
| D4 | `bot-tts-stopped` per reply and on a barge-in | pipedog's Fish never sent it: it waited for the 15 s context timeout |
| D5 | `bot-stopped-speaking` at the audio's end | pipedog's Fish: 2.75–3.9 s late in 16 of 16 measured replies |
| D6 | CJK-aware joins of the caller's and her segments | a pause Smart Turn judges incomplete got `我想问 你…` on pipedog |
| D7 | the segmenter keeps closers, merges cue-only segments, never splits inside `[` | `他说：“我不去。\|”然后…`; a lone `</whisper>` gets no audio from Fish |
| D8 | OpenAI's STT interims are cumulative | on pipedog the call page showed only the latest delta |
| D9 | unsupported inbound types get `error-response` | no client sends them |
| D10 | her audio pauses during `restart_pc` or a lost ping instead of being dropped | a reconnect mid-sentence |
| D11 | an interrupted message keeps the sentences heard whole, Fish's too; pipedog's Fish kept every sentence said once her audio had started | a barge-in before her last sentence has played |
| D12 | Fish's "completed" spread across the audio: each sentence new as its audio starts, completed as it ends, where pipedog reported all at her first audio | every Fish reply: anything said meanwhile lands among her reports, which keep their order, and a reply cut off reports fewer sentences, so the later ones' segment ordinals run behind |
| D13 | `interruptedBot` is exact | an empty turn within 3 s after Fish's audio ends |
| D14 | no 15 s hold on a second reply in one turn | a follow-up after a tool call |
| D15 | voices other than Fish keep her cues in the stored text | matches text chats; pipedog stored the filtered text |
| D16 | her parts (her LanceDB tables, the selfie tool) outlive the call, in the engine's cache of its last 32 chats | every call |

A realtime call's differences, each a fix of pipedog's realtime path:

| Id | Difference | Trigger |
| --- | --- | --- |
| E1 | her recall reaches the model: each block goes in as an item, and one a provider takes out is deleted | a realtime call with recall; pipedog sent none after the greeting |
| E2 | typed text is answered: it cuts her off, goes in as the caller's item and asks for a response | `send-text` on a realtime call; pipedog never sent it its model, and OpenAI's response ran on past the interruption |
| E3 | OpenAI's interim transcripts are cumulative | a turn transcribed in more than one delta |
| E4 | `bot-output` per sentence, "new" then "completed" as the cursor passes it, held for the caller's final transcript (1 s at most) | every realtime reply: pipedog sent each transcript delta as a "new" never to be spoken |
| E5 | one `bot-llm-started` and one `bot-llm-stopped` per response | every realtime response: pipedog started one as it asked and again per item announced, and stopped a cut one twice |
| E8 | a fatal error, or the socket closing, ends the call | a server's fatal error; pipedog's call went on without its model |

## Tests

| Where | What |
| --- | --- |
| `packages/voice/test/` | each leaf on its own, with the upstream tests ported with it; the Floor row by row on a fake engine and clock; the real `runTurn` with a scripted mind; whole calls on a fake transport with the real hearing models; a realtime call on a scripted session, with the real `prepareTurn` and `runTool`; a group call's floor on the real `runChat` with a scripted director (`group.test.ts`); the ORT pin and its telemetry off (`input/onnx.test.ts`) |
| `packages/runtime/test/native/` | the server's peers, a call's start, a call inside a chat reporting its lines, photos and end (once over `@eidolon/webrtc`), and a group call's binding (`group.test.ts`) |
| `packages/webrtc/test/` | pipedog's transport tests, ported (`rtc_media`, `test_smallwebrtc_request_handler`); the caller's audio and hers against libopus; a call's transport on a fake peer, and against a real werift client: both ways, liveness, a hang-up from either side, `restart_pc` |
| `packages/runtime/test/{signalling,loopback,werift,opus}.test.ts` | the signalling server with its peers' negotiation stood in for (`transports.ts`), a real werift client over this machine's interfaces, the werift patches loading once, and the Opus bitrate |
| `apps/bot/test/{chat,local}/native_call.test.ts` | production's `bindChatCall` and the local runner's binding on a call |
| `apps/bot/test/local/group_call.test.ts` | the local offer route's group checks, and the runner storing a group call's lines and decisions |
| `apps/bot/test/e2e-invariants.test.ts` | I1–I10 (`apps/bot/scripts/e2e/invariants.ts`) on made-up sequences |

A change to the loop or its transport also needs real calls ([below](#real-calls)); they are
billed.

### Real calls

`apps/bot/scripts/e2e-call.ts` scores one real call through Chrome and client-js: `--text`,
`--audio`, or `--barge-in`, which types the question and talks over her reply. It records the
bot's RTVI messages off the data channel as sent, and checks I1–I10 on them (`--engine` labels the
run; `--engine pipedog`, for a bot from before the flip, leaves I6 out).
`apps/bot/scripts/e2e-compare.ts` compares runs, a baseline's against a candidate's, mode by mode:
their checks, event sequences, `stagesMs`, `latencyMs` and audible spans, then the pass bar:
- every check passes and I1–I10 hold;
- question end → first reply audio, TTS start → `bot-started-speaking`, and the gap between
  sentences (0 when her audio has none), each no worse than the baseline's median + 100 ms;
- `bot-stopped-speaking` from 0.1 s before her last audible audio ends (a level sample's window)
  to 0.5 s after, and `bot-tts-stopped` in every turn: a reply cut off by the barge-in stops
  once the server hears the caller, so its stops count until the caller's turn ends.

```bash
bun run dev                                            # the change, on :7860
bun apps/bot/scripts/e2e-call.ts --barge-in --headful --out b1.json
bun apps/bot/scripts/e2e-compare.ts a1.json a2.json … --vs b1.json b2.json …   # a*: a baseline
```
