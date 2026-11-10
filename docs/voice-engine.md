# The native voice engine

Calls run on pipedog's frame pipeline today. The native engine is eidolon's own loop around
`@eidolon/engine`, so a call's turns run through the same engine, log format and `viewOf` as a text
chat. It is experimental and off by default: `EIDOLON_VOICE_ENGINE=native` turns it on
([The switch](#the-switch)). Clients need no change on either engine.

```text
@eidolon/voice                  the loop: no pipedog, and only packages/runtime imports it
  src/input/                    the Ear: Silero VAD, Smart Turn, the TurnDetector (ported from pipedog)
  src/output/                   the segmenter, the Mouth, the Speaker, what was heard
  src/rtvi/                     the RTVI messages pipedog's observer sends
  src/call/                     the mailbox (kit.ts), the Floor, the call log, runCascadeCall
  src/dsp/resampler/            pipedog's rubato resampler, vendored with its wasm
@eidolon/providers/stt          live speech recognition, one stream per call
@eidolon/providers/speech-stream   streaming speech, one stream per persona per call
@eidolon/engine                 runTurn in call mode (CallHooks)
packages/runtime/src/native/    the bridge: the switch, the transport over pipedog's connection, deps
```

Code ported from pipedog keeps pipedog's BSD-2 header, then `Ported from pipedog <path>@ce8f8bc`.
pipedog is never followed past that commit.

## The switch

**`EIDOLON_VOICE_ENGINE`** is `pipedog`, the default, or `native` (`.env.example`).
- `createSignallingServer` reads it once, when the server is made, through `envStr`, so blank is
  unset. Any other value logs one warning and runs pipedog.
- It has no settings row: only the environment sets it.
- **Under `pipedog`, an offer starts exactly the session it started before the switch existed.**
  `sessionStarter` hands back pipedog's starter itself, and a test pins that.

**Under `native`, each offer asks `nativeCanRun()`** in its persona's scope. It sends the call to
pipedog, with one info line, `[voice] This call runs on pipedog: <why>`, when:
- it is a call inside a chat, which carries a `CallBinding` ([chat.md](chat.md#the-binding)):
  only pipedog's session takes one, and bound calls are native from G4. Its persona's settings
  aren't read;
- her realtime role is on: realtime calls are native from G3;
- her hearing or voice role names a provider with no native client. None does today: every
  provider the catalog offers for either has one, and a test walks the catalog;
- her settings can't be read. pipedog then fails the call exactly as it does today.

**Warm-up:** under `native`, `warmAudioModels()` loads the native Ear's models as well as
pipedog's, since some calls still go to pipedog. Both engines load the same two `.onnx` files, from
pipedog's packages (`voiceModels()`), on the same pinned onnxruntime-node.

**Logs:** a native call logs what the local app and the e2e notes read from pipedog's:
- the `[bot] Session start …` line and `Starting bot`, from pipedog's own `logSessionStart`, so a
  chat window in the request data is logged by its size alone;
- `Client connected`, then `Client disconnected` or `Call ended: <reason>`;
- `Bot session failed: <why>` when it can't start, which `apps/bot/src/local/status.ts` parses;
- one `[voice] ttfb <stage> <ms>` line per stage per reply: `llm`, `text`, `speaking`.

### Rolling it out

1. **Local:** `EIDOLON_VOICE_ENGINE=native bun run local`, or `bun run dev`.
2. **Canary:** set it in the server's `eidolon.env` and restart. Run the production e2e and
   compare it with the last recorded run on pipedog. Rsync an index once and check that a recall
   question still works, since the engine keeps a call's LanceDB handles after it ends (D16).
   **Rollback:** unset it and restart; no image rollback.
3. **The flip:** after 7 days of canary with no regression, the default becomes `native`, and
   `pipedog` stays the rollback.
4. **Deleting pipedog:** after another 14 days.

Every change under `packages/` rebuilds `:edge` and restarts production, so merge in a quiet hour.
The native code stays dormant there until the variable is set.

## The loop

```text
browser ══WebRTC══▶ CallTransport ─ runtime/native/transport_pipedog.ts (pipedog's connection)
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
it when the call ends.

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

- **Counters:** `recoveries` (empty-turn recoveries in a row), `syncToolsRunning`, `followUpOwed`,
  and whether the reply is spoken (its last audio has come and the mind is done).
- **Idle** is USER quiet and BOT idle, pipedog's `waitingForUser`.

`floor.ts` numbers its transitions by this table. "Emit" is an RTVI message ([RTVI](#rtvi)).

| # | From | Event | Guard | Actions | To |
| --- | --- | --- | --- | --- | --- |
| 1 | CALL connecting | `client-ready` | — | an unparsable version or a major other than 2 gets `error-response`, and the call goes on; emit `bot-ready` with its id; CALL live; greet if the plan says so | BOT thinking |
| 2 | USER quiet | ear `user-started` | — | emit `user-started-speaking`, then `bot-interrupted`; `interruptedBot` is BOT ≠ idle or a sync tool running; barge in if BOT ≠ idle | USER speaking |
| 3 | USER speaking | ear `interim` / `final` | — | emit `user-input`, then `user-transcription` | — |
| 4 | USER speaking | ear `user-stopped(text)` | text | emit `user-llm-text`, then `user-stopped-speaking`, as pipedog does; store the line; recoveries := 0; start a reply | USER quiet, BOT thinking |
| 5 | USER speaking | ear `user-stopped(null)` | interruptedBot, recoveries < 1, no sync tool | emit `user-stopped-speaking`; recoveries++; start a reply with `INTERRUPTED_EMPTY_TURN_PROMPT` | USER quiet, BOT thinking |
| 6 | USER speaking | ear `user-stopped(null)` | otherwise | emit `user-stopped-speaking`; start a follow-up owed while the caller spoke | USER quiet |
| 7 | live | `send-text{run_immediately:true}` | — | emit `bot-interrupted`; barge in if BOT ≠ idle; emit `user-input{chat}`, then `user-llm-text`; store the line; start a reply, spoken unless `audio_response` is false | BOT thinking |
| 8 | live | `send-text{run_immediately:false}` | — | emit `user-input{chat}`; store the line; start a reply if idle, else owe one | — |
| 9 | BOT ≠ idle | reply `mind started` | — | emit `bot-llm-started` | — |
| 10 | BOT ≠ idle | reply `delta` | — | emit `bot-llm-text`; push it to her speech | — |
| 11 | — | Mouth `segment` | — | emit `bot-transcription` | — |
| 12 | — | Mouth `tts-started` | the reply's first | emit `bot-tts-started` | — |
| 13 | BOT thinking | Speaker `reply-start` | this reply | emit `bot-started-speaking` | BOT speaking |
| 14 | BOT speaking | Speaker `seg-start` / `words` / `seg-end` | — | emit `bot-output` new / in-progress / completed, the last with `bot-tts-text` | — |
| 15 | — | reply `mind ended(error?)` | — | emit `bot-llm-stopped`, and `error` on a failure; flush her speech | — |
| 16 | — | reply `tool running` | — | emit `llm-function-call-started`, and `-in-progress` once the round's `bot-llm-stopped` is out, as pipedog orders them; a sync tool counts | — |
| 17 | — | reply `tool done / failed / cancelled` | — | emit `llm-function-call-stopped{cancelled}`; a sync tool uncounts | — |
| 18 | — | reply `notice` | — | emit `error` | — |
| 19 | — | Mouth `tts-stopped` | the reply's last utterance | emit `bot-tts-stopped`; the reply is spoken once the mind is done | — |
| 20 | BOT speaking | Speaker `drained` | spoken | emit `bot-stopped-speaking` | BOT thinking until `ended` |
| 21 | BOT speaking | Speaker `drained` | not spoken | arm 3 s; if the Speaker is still drained then, emit `bot-stopped-speaking` | — |
| 22 | BOT ≠ idle | reply `ended` | — | BOT idle; start an owed reply while the caller is quiet | BOT idle or thinking |
| 23 | — | async result | — | store it; start a reply if idle, else owe one | — |
| 24 | live | ear `stt-error` | fatal | emit `error`; end the call (`error`) | ended |
| 25 | live | Mouth `tts-error`, or no audio 15 s after a segment | — | emit `error`; drop her queued audio and cancel her speech; the reply goes on in text, storing what was heard | — |
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
| Ending the turn | Smart Turn complete, the turn has finals, and the last final was finalized or the recognizer's p99 has passed since the stop (minus 0.2 s); never while the VAD hears speech |
| A final with no VAD stop | complete after max(0, p99 − 0.2 s) |
| Watchdog | the turn ends 5 s after the last VAD or STT event |
| Joining | the turn's finals with `joinSegments`: a space between two segments unless either side is CJK |

Each turn's end costs about 88 ms of main-thread work on an M4 Max, 52 ms of it Smart Turn's naive
DFT, as in pipedog.

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
| Fish | one session per utterance; each segment is sent as `text` and `flush` at once, `stop` at the end, and `finish` marks the end of its audio | unmarked: a segment counts as heard once said and the utterance has started playing, which is pipedog's behavior |
| MiniMax, OpenAI | one HTTP request per segment, two at most in flight, played in order | exact |
| ElevenLabs, Cartesia, Soniox | one context or stream per utterance | words timed by their letters and digits; a segment ends at its last word or the utterance's end |

**The Speaker** is the call's one output queue. The transport's 10 ms clock pulls 240 samples,
silence when it is empty. As its cursor plays, it posts `reply-start`, each segment's start and end,
the words played, and `drained`. Clearing it takes effect at once.

**What was heard** (`heard()`), which her turn stores:
- the raw text, cues included, of every segment the cursor has passed the end of, plus the played
  words of the current one where the provider times words;
- joined with `joinSegments`;
- `complete` only when the reply drained without a barge-in.

With `audio_response: false`, a reply speaks nothing and keeps all of its text.

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
  pipedog's call prompt has it.

Her tools act on the call through effects: a voice switch reaches her speech, and a selfie's
`server-message` goes to the client.

## RTVI

The server stays at protocol 2.2.0; client-js 1.16.0 speaks 2.3.0 and accepts any server of the
same major. Every message is `{label: "rtvi-ai", type, id?, data?}` with snake_case keys and nulls
left out; `id` appears only on `bot-ready` and `error-response`.

| Message | Native, against pipedog's |
| --- | --- |
| `bot-ready` | byte-identical, `capabilities.metrics: true` included, and always before her greeting |
| `user-started-speaking`, `user-stopped-speaking`, `bot-interrupted` | the same, in the same order |
| `user-input`, then `user-transcription` | the same; joined CJK-aware (D6); OpenAI's interims are cumulative (D8) |
| `user-llm-text` | the caller's lines and typed text only, no longer the greeting's prompt (D2) |
| `bot-llm-started` / `-stopped`, `bot-llm-text` | the same: one pair per mind round, stopped even on an error |
| `bot-transcription` | per segment of the native segmenter (D7) |
| `bot-tts-started` / `-stopped` | stopped now always comes, per reply and on a barge-in (D4) |
| `bot-started-speaking` / `-stopped-speaking` | stopped comes at the audio's end, not seconds late (D5) |
| `bot-output`, `bot-tts-text` | the same shape; `segment_id` counts from 1 in each call |
| `server-message` | the same for selfies |
| `error {fatal: false}` | the same texts |
| `llm-function-call-started` / `-in-progress` / `-stopped` | the same |
| `metrics` | never sent (D3) |
| `error-response` | also for inbound types pipedog accepted and ignored (D9) |

What a client must be able to count on, on both engines:
- **I1:** `bot-ready` comes before any other `bot-*`, `user-*` or `llm-*` message.
- **I2:** a turn's final `user-input` and `user-transcription` come before its
  `user-stopped-speaking`.
- **I3:** `user-input` comes before `user-transcription` for the same text.
- **I4:** every `user-started-speaking` is followed at once by `bot-interrupted`.
- **I5:** every `bot-llm-started` has a later `bot-llm-stopped`, with no start between.
- **I6 (native):** every `bot-tts-started` has a later `bot-tts-stopped`.
- **I7:** each `segment_id` is "new" before "in-progress" or "completed", and "completed" once
  unless interrupted.
- **I8:** every `error` is `fatal: false`.
- **I9:** a turn with no final transcript starts no mind request unless it interrupted her.
- **I10:** after `bot-interrupted`, no `bot-llm-text` comes before the next `bot-llm-started`.

## The transport

**Phase 1** (`packages/runtime/src/native/transport_pipedog.ts`) takes over the
`SmallWebRTCConnection` pipedog's signalling built for the offer, where pipedog's client would. So
HTTP, SDP, ICE, the data channel, `restart_pc` and the werift patches are the same code on both
engines.
- **On `connected`:** the input track decodes straight to 16 kHz mono, the camera and screen
  receivers are switched off unread, as pipedog's client leaves them, and a `SpeakerTrack`
  (pipedog's `RawAudioTrack` clock, its samples pulled from the Speaker) replaces the output track.
- **On `disconnected`** (`restart_pc`, or ICE dropping): both tracks are dropped, and the next
  `connected` takes up the new peer's. Her audio waits meanwhile, and while the peer sends no ping
  for 3 s, instead of playing to no one (D10).
- **App messages** reach the call; `connect()` delivers those that came first, `client-ready`
  among them.
- **`closed`** resolves when the peer closes, the server's shutdown included, but not after the
  call's own `disconnect()`, which sends `peerLeft` and closes the peer.

**Phase 2** (G6) replaces it with `@eidolon/webrtc` on werift directly.

## Allowed differences

Every difference between the engines must be one of these, each with what triggers it:

| Id | Difference | Trigger |
| --- | --- | --- |
| D1 | a call's view is the last 60 messages | a call longer than 60 lines |
| D2 | no `user-llm-text` for the greeting or follow-ups | every call: today the kickoff prompt reaches the client |
| D3 | no `metrics` | no client reads them |
| D4 | `bot-tts-stopped` per reply and on a barge-in | Fish never sends it today: it waits for the 15 s context timeout |
| D5 | `bot-stopped-speaking` at the audio's end | Fish today: 2.75–3.9 s late in 16 of 16 measured replies |
| D6 | CJK-aware joins of the caller's and her segments | a pause Smart Turn judges incomplete gets `我想问 你…` today |
| D7 | the segmenter keeps closers, merges cue-only segments, never splits inside `[` | `他说：“我不去。\|”然后…`; a lone `</whisper>` gets no audio from Fish |
| D8 | OpenAI's STT interims are cumulative | today the call page shows only the latest delta |
| D9 | unsupported inbound types get `error-response` | no client sends them |
| D10 | her audio pauses during `restart_pc` or a lost ping instead of being dropped | a reconnect mid-sentence |
| D11 | an interrupted message keeps the heard text: per utterance for Fish, per segment for the others | a barge-in |
| D12 | Fish's "completed" spread across the audio (from G5) | any Fish reply of several sentences |
| D13 | `interruptedBot` is exact | an empty turn within 3 s after Fish's audio ends |
| D14 | no 15 s hold on a second reply in one turn | a follow-up after a tool call |
| D15 | voices other than Fish keep her cues in the stored text | matches text chats; today the filtered text is stored |
| D16 | her parts (her LanceDB tables, the selfie tool) outlive the call, in the engine's cache of its last 32 chats | every native call |

## Parity tests

| Where | What |
| --- | --- |
| `packages/runtime/test/parity/` | the ported leaves against the installed pipedog: VAD and Smart Turn probabilities, loudness, the segmenter on every reply production recorded, RTVI messages against pipedog's observer, the async envelopes. The only tests that import both engines |
| `packages/runtime/test/parity/twin.ts` | the twin harness: one scripted call on each engine ([below](#the-twin-harness)) |
| `packages/voice/test/` | each leaf on its own; the Floor row by row on a fake engine and clock; the real `runTurn` with a scripted mind; whole calls on a fake transport with the real hearing models |
| `packages/runtime/test/native/` | the switch, `nativeCanRun`, a native call's start, and the transport against a real werift peer |
| `packages/runtime/test/native_boundaries.test.ts` | under `src/native/`, only the transport imports pipedog |

`bun test --no-env-file packages/runtime/test/parity` runs the first; with `EIDOLON_TWIN=1` it runs
the twin harness's scenarios too, about seven minutes of real-time calls. A change to the loop or its
transport also needs real calls on each engine ([Real calls](#real-calls)); they are billed.

### The twin harness

Each scenario (`scenarios/*.test.ts`) runs once on pipedog and once on the native engine, each
against fresh fakes that speak the providers' wire protocols (`fakes/`):
- **the mind:** a chat completions API over server-sent events, scripted reply by reply, text or
  tool calls, with OpenRouter's usage;
- **her voice:** Fish's live socket: a tone as long as each flushed text, `finish` after `stop`;
- **her hearing:** Soniox's socket, each `finalize` answered by the next scripted line;
- **the caller:** a real werift peer offering to the signalling server as a browser does, pinging,
  and saying synthetic speech through its mic as Opus.

The persona's roles are accounts at the fakes, in the test data home's `credentials.json`. The
native engine reaches them through those accounts; pipedog's Soniox and Fish services get the
fakes' URLs set on production's instances. Both start through `sessionStarter`, as production does.

**What is compared**, after normalizing (no ids, timestamps or metric values; segment ids as
ordinals; a mind round's `bot-llm-text` as one message; mind requests as JSON with sorted keys, the
prompt's clock line masked):
- the RTVI messages the caller received;
- every mind request body, the Fish handshakes and `start` messages and the text flushed, the
  Soniox handshake and config;
- the usage ledger's records (role, provider, model, units; a recognizer's audio seconds only as
  more than none, since they follow the call's length);
- what she would see next: pipedog's final context against `viewOf` the native call's log.

**Every difference must match a rule in `allowed.ts`** (the table [above](#allowed-differences)),
each with its id, what it allows, its trigger and a predicate that matches nothing else, and both
runs must keep I1–I10 (`invariants.ts`). Rules are added only with a trigger, never to quiet a
scenario: a difference no rule explains is a native bug to fix, or a skipped scenario with its
reason, for the user to decide.

**The scenarios:** the greeting; typed text while she is idle and while she speaks; a spoken
question and a two-sentence reply; a barge-in mid-sentence and before her first audio; an empty
turn while idle, after cutting her off, and just after her audio ended (D13); `change_voice_style`;
a mind request that fails; the recognizer's socket dropping and reconnecting; a call longer than
the 60-line window (D1). Two are skipped, each with its difference noted where it is written: a
`send-text` without `run_immediately`, which pipedog leaves for the next turn and native answers,
and a reply with `audio_response: false`, whose sentences pipedog still reports and native
doesn't. `scenarios/checks.test.ts` tests the harness itself on made-up sequences, and runs
without the variable.

### Real calls

`apps/bot/scripts/e2e-call.ts` scores one real call through Chrome and client-js: `--text`,
`--audio`, or `--barge-in`, which types the question and talks over her reply. It records the
bot's RTVI messages off the data channel as sent, and checks I1–I10 on them (`--engine native`
adds I6). `apps/bot/scripts/e2e-compare.ts` compares runs of two engines, a baseline's against a
candidate's, mode by mode: their checks, event sequences, `stagesMs`, `latencyMs` and audible
spans, then the pass bar:
- every check passes and I1–I10 hold;
- question end → first reply audio, TTS start → `bot-started-speaking`, and the gap between
  sentences, each no worse than the baseline's median + 100 ms;
- `bot-stopped-speaking` within 0.5 s of her last audible audio, and `bot-tts-stopped` in every
  turn.

```bash
bun run dev                                            # pipedog, on :7860
EIDOLON_VOICE_ENGINE=native bun run dev --port 7861    # native
bun apps/bot/scripts/e2e-call.ts --barge-in --headful --engine pipedog --out a1.json
bun apps/bot/scripts/e2e-call.ts --barge-in --headful --engine native \
  --base-url http://localhost:7861 --out b1.json
bun apps/bot/scripts/e2e-compare.ts a1.json a2.json … --vs b1.json b2.json …
```

## Not yet native

- **Realtime personas** (G3): their calls go to pipedog.
- **Calls bound to a chat, and group calls** (G4).
- **Fish's exact segment ends** (G5): serial flushes, once measured.
- **The transport** (G6): `@eidolon/webrtc`.
