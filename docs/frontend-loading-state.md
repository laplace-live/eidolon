# Handover: Frontend loading-state indicators

**Audience:** frontend engineers on a client of the bot: the `laplace` web client, or the local
web app's call page (`apps/web/src/features/call/`).
**Scope:** how to show the user that the bot is *doing something* (transcribing, thinking,
synthesising speech) between the moment they stop talking and the moment they hear a reply.

This is a frontend-only task. The bot already emits every event you need; nothing in `packages/`
or `apps/bot` changes.

---

## TL;DR

The bot sends an RTVI `user-stopped-speaking` message the moment the user's turn ends, and
`bot-llm-stopped` when the reply's LLM stream ends. Listen for the corresponding JS events and
toggle a "thinking…" indicator between them. Start it on the turn's end rather than on
`BotLlmStarted`, which fires only after the context providers' searches, so a slow retrieval
would show nothing.

A turn with no words runs no LLM unless it cut her off, so nothing would end the indicator. The
final transcript arrives before `UserStoppedSpeaking` (not on a realtime model's call,
[below](#full-per-turn-event-timeline)), so start the indicator only for a turn that has one.
Clear it when the next turn starts or the call ends.

```ts
import { PipecatClient, RTVIEvent } from "@pipecat-ai/client-js";

let heard = false;
pcClient.on(RTVIEvent.UserStartedSpeaking, () => {
  heard = false;
  setIsThinking(false);
});
pcClient.on(RTVIEvent.UserTranscript, (data) => {
  if (data.final && data.text.trim()) heard = true;
});
pcClient.on(RTVIEvent.UserStoppedSpeaking, () => setIsThinking(heard));
pcClient.on(RTVIEvent.BotLlmStopped, () => setIsThinking(false));
pcClient.on(RTVIEvent.Disconnected, () => setIsThinking(false));
```

That alone solves the "backend is taking too long, give me feedback" problem. If you want a richer
status display (separate STT / LLM / TTS phases), use the
[full event timeline](#full-per-turn-event-timeline) below.

What a client sees differently since the bot's own voice engine replaced pipedog's pipeline is
[below](#what-the-voice-engine-changed); none of it changes the code above.

---

## Why this matters

The bot is a voice persona ([明前奶绿](../personas/milky-green/prompt.md)) that talks to viewers
over WebRTC. Each turn the user speaks → audio is streamed to the server → the call's loop runs
([voice-engine.md](voice-engine.md)):

```text
webrtc in → STT ∥ VAD → Smart Turn → runTurn: RetrievalGate ∥ Mem0, StreamArchive,
    PersonaFacts → LLM → segmenter → TTS → Speaker → webrtc out
```

Every stage can stall (the services named are the defaults; [providers.md](providers.md) lists the
others):

- **STT** waits for Soniox to finalise (usually <300 ms after the user stops speaking). The turn
  doesn't end until it has.
- **Retrieval**: Mem0 and the RAG indexes, where configured, are searched before the LLM sees the
  turn.
- **LLM** waits for OpenRouter, which can take 1–5 s for first-token, longer with heavy RAG
  context. **This is the main source of perceived "lag".**
- **TTS** waits for Fish Audio to start streaming PCM.

Without UI feedback the silence after the user stops talking looks broken. The fix is to surface
what the bot is doing.

---

## How the bot signals state

**RTVI** (Real-Time Voice Interaction) is Pipecat's protocol for a voice bot's state, as typed JSON
messages over the WebRTC data channel; the bot speaks protocol 2.2.0. A call's Floor
(`packages/voice/src/call/floor.ts`) sends every message below through its `RtviEmitter`
(`packages/voice/src/rtvi/emitter.ts`), in the shapes pipedog's `RTVIObserver` sent, and answers
the client's `client-ready` with `bot-ready`, whose `about` names `laplace-eidolon`
(`packages/runtime/src/rtvi.ts`). **You don't need to touch any bot code.**

Where the events come from (for reference only; [voice-engine.md](voice-engine.md#rtvi) has the
whole table):

| RTVI wire message | Pushed when |
|---|---|
| `bot-llm-started` | A round of her reply is about to send its request, after the context providers' searches — *before* the HTTP call to OpenRouter; once per round, so a reply that calls a tool has two |
| `bot-llm-stopped` | The round's stream closes, or the request fails |
| `bot-tts-started` | Her voice starts synthesising the reply |
| `bot-tts-stopped` | Her voice has synthesised the reply's last sentence, or a barge-in cut it off |
| `bot-started-speaking` | Her first audio sample plays on the call |
| `bot-stopped-speaking` | Her last audio sample has played, or a barge-in cut her off |
| `bot-interrupted` | Right after every `user-started-speaking`, and on typed text sent to run at once; a reply in progress is cut off |
| `bot-output` | Each sentence of the reply: "new" as its audio starts, "completed" as it ends ([below](#what-the-voice-engine-changed)) |
| `user-started-speaking` | Silero VAD hears speech (or a transcript arrives first) |
| `user-stopped-speaking` | Smart Turn judges the turn complete *and* a final transcript is in |
| `user-input`, `user-transcription` | The recognizer (Soniox by default) emits text |
| `server-message` | A tool sends one, a call inside a chat sends a line, or a group call names who speaks ([below](#custom-server-messages)) |
| `error` | Her mind, her voice, the recognizer or a context provider reports an error |

The bot also sends `bot-llm-text` (each chunk of the LLM's text), `bot-transcription` (the same,
a sentence at a time) and `bot-tts-text`, which client-js deprecates in favour of `bot-output`, as
it does `user-transcription` in favour of `user-input`. It sends no `metrics`.

**Key insight on `bot-llm-started`:** it fires *before* the request is dispatched. The turn engine
(`runTurn`, `packages/engine/src/turn.ts`) reports each mind request's start once her context
providers have searched, and only then streams from her mind, which makes the HTTPS call. So this
event captures the LLM's **time-to-first-token (TTFB)**, which is the period you actually want to
indicate. A failed request still sends its `bot-llm-stopped`, then an `error`.

---

## What the voice engine changed

The bot's own voice engine replaced pipedog's pipeline, which answered calls before it. These are
the places a client sees it behave differently from pipedog, each id a row of
[voice-engine.md](voice-engine.md#differences-from-pipedog)'s differences from pipedog.

- **`bot-tts-stopped` now arrives** (D4): once per reply, when her voice has synthesised its last
  sentence, usually before the audio has played out; and on a barge-in
  ([below](#interruption-barge-in)). pipedog's Fish service waited for a 15 s context timeout, by
  which time the call had moved on.
- **`bot-stopped-speaking` comes at the audio's end** (D5): when her last sample has played, where
  pipedog's came 2.75–3.9 s later. A reply that falls silent while her mind is still working (a
  tool call between two rounds) sends it after 3 s of silence, and a new `bot-started-speaking`
  when her audio resumes.
- **No `metrics` messages** (D3). `bot-ready` still lists `capabilities.metrics: true`, as
  client-js expects.
- **`user-llm-text` no longer carries the greeting** (D2): only the user's spoken lines and typed
  text, never the kickoff prompt her greeting runs on, nor the prompt of her follow-up after a
  selfie.
- **`bot-output` follows her audio sentence by sentence** (D12): each sentence is "new" as its
  audio starts, "in-progress" as its words play where her voice times words (ElevenLabs, Cartesia,
  Soniox), and "completed", with its `bot-tts-text`, as its audio ends, so the "completed"
  messages spread across the reply. pipedog reported every Fish sentence at once, at her first
  audio. A reply cut off reports only the sentences that had started; `segment_id` counts from 1
  in each call and skips the sentences a barge-in cut before they started.
- **`bot-transcription` splits a little differently** (D7): a closing quote or bracket and repeated
  end punctuation stay with their sentence, a bracketed direction is never split, and a piece with
  no letter or digit once its cues are stripped joins the next sentence.
- **Transcripts join Chinese without stray spaces** (D6): a pause mid-sentence no longer gives
  `我想问 你…`. OpenAI's interim transcripts are cumulative (D8): each interim `user-input` holds the
  turn so far, not its latest delta.
- **A reply cut off keeps what the user heard** (D11): its `chat-line`, `interrupted`, holds the
  sentences that played whole and, where her voice times words, the words played of the one cut.
  pipedog's Fish kept every sentence said once her audio had started.
- **An empty turn just after her audio ends gets no reply** (D13): only a turn that cut her off
  has her ask again. On pipedog, one within 3 s of her Fish audio's end counted as cutting her off.
- **A second reply in one turn isn't held** (D14): a follow-up after a tool call comes at once,
  not 15 s later.
- **Her audio waits during a reconnect** (D10): during `restart_pc`, or while the client sends no
  ping for 3 s, instead of playing to no one.
- **An inbound RTVI type the bot doesn't take gets `error-response`** (D9), where pipedog accepted
  and ignored it. `client-message` is still ignored.
- **A group call names each speaker** with a `server-message` of its own
  ([below](#a-group-call-speaker)), in the local web app only.

On a call to a persona who talks through a realtime model:
- **`bot-output` comes per sentence** (E4): "new" then "completed" as her audio passes it, held
  until the user's final transcript is in (1 s at most). pipedog sent each transcript delta as a
  "new" never to be spoken.
- **One `bot-llm-started` and one `bot-llm-stopped` per response** (E5).
- **Typed text is answered** (E2): it cuts her off and she replies to it.
- **Interim transcripts are cumulative** (E3).
- **A fatal error from the model ends the call** (E8): its `error`, then `Disconnected`.

---

## Implementation

### 1. Dependencies

The client needs `@pipecat-ai/client-js` and `@pipecat-ai/small-webrtc-transport`.
`apps/web/package.json` has the versions the local web app's call page runs on; `bot-output` and
`user-input` need a client-js that has `onBotOutput` and `onUserInput`.

```bash
npm install @pipecat-ai/client-js @pipecat-ai/small-webrtc-transport
```

### 2. Minimal: single "thinking…" indicator

The simplest implementation — show one status while the bot is busy, hide it when audio
plays:

```ts
import { PipecatClient, RTVIEvent } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const pcClient = new PipecatClient({
  transport: new SmallWebRTCTransport({ /* ... */ }),
  callbacks: {
    onUserStoppedSpeaking: () => setStatus("listening"),
    onBotLlmStarted:       () => setStatus("thinking"),
    onBotTtsStarted:       () => setStatus("speaking"),
    onBotStoppedSpeaking:  () => setStatus("idle"),
  },
});
```

UI mapping:

| `status` | What to show |
|---|---|
| `idle` | Nothing, or a subtle "ready" cue |
| `listening` | "Processing your message…" or a typing-dots animation |
| `thinking` | "Thinking…" (this is the one the user specifically asked for) |
| `speaking` | Waveform / equaliser visual (the bot is now actually talking) |

### 3. Richer: state machine with watchdog timer

For better UX, gate the "thinking" UI on a watchdog so the indicator only appears if the wait
actually feels long. This avoids a flicker for fast responses:

```ts
const SLOW_THRESHOLD_MS = 800;

let slowTimer: ReturnType<typeof setTimeout> | null = null;

function clearSlowTimer() {
  if (slowTimer) {
    clearTimeout(slowTimer);
    slowTimer = null;
  }
}

pcClient.on(RTVIEvent.UserStoppedSpeaking, () => {
  setPhase("processing");
  clearSlowTimer();
  slowTimer = setTimeout(() => setShowSlowHint(true), SLOW_THRESHOLD_MS);
});

pcClient.on(RTVIEvent.BotStartedSpeaking, () => {
  clearSlowTimer();
  setShowSlowHint(false);
  setPhase("speaking");
});

pcClient.on(RTVIEvent.BotStoppedSpeaking, () => {
  setPhase("idle");
});

// Also clear on disconnect / error so we don't get a stuck indicator.
pcClient.on(RTVIEvent.Disconnected, () => {
  clearSlowTimer();
  setShowSlowHint(false);
  setPhase("idle");
});
```

This is the pattern we recommend: it catches every source of slowness after the turn ends
(retrieval, slow LLM TTFB, or slow TTS) in one indicator rather than coupling the UI to a specific
stage that may not be the actual bottleneck. The local web app's call page runs it: the SDK's
`Watchdog` (`packages/sdk/src/watchdog.ts`), which `use-call.ts` arms on typed text and on
`UserStoppedSpeaking` after a final transcript with words (`turn-wait.ts`), shows its thinking
dots after `THINKING_DELAY_MS`, and clears on `BotStartedSpeaking`, `UserStartedSpeaking`, `Error`
and disconnect; `BotLlmStarted` cancels its "stuck" warning.

### 4. Streaming partial text (optional)

To render the reply as text (a chat-style transcript), listen for `onBotOutput`. The bot sends its
reply a sentence at a time as it speaks it:

```ts
pcClient.on(RTVIEvent.BotOutput, (data) => {
  // A sentence's first message carries its text; later ones with the same segment_id report,
  // in spoken_status and spoken_progress, how much of it has been said.
  upsertBotSentence(data.segment_id, data.text, data.spoken_status);
});

pcClient.on(RTVIEvent.BotInterrupted, () => {
  // The rest of this reply won't be spoken; the next sentence starts a new one.
  closeBotMessage();
});
```

`apps/web/src/features/call/transcript.ts` builds the call page's transcript this way, with
`onUserInput` for the viewer's side. The deprecated `onBotLlmText` (token deltas, as the LLM
writes them) and `onBotTranscript` still fire, if you want the text ahead of the voice.

Note that the bot speaks Chinese, and its delivery cues for the TTS appear inline in the text
stream: bracketed directions and sounds like `[懒洋洋的，带点笑意]` and `[chuckling]`, and the tag
pairs `<emphasis>…</emphasis>` and `<whisper>…</whisper>`. Strip both kinds before rendering;
the SDK's `parseMarkup` (`packages/sdk/src/markup.ts`) parses the full set.

---

## Full per-turn event timeline

These fire in roughly this order for each conversation turn. Use this table to design any UI state
diagram you need:

| # | JS event | JS callback | Phase | Typical latency from previous step |
|---|---|---|---|---|
| 1 | `UserStartedSpeaking` | `onUserStartedSpeaking` | User is talking | — |
| 2 | `UserInput` / `UserTranscript` (`final=false`) | `onUserInput` / `onUserTranscript` | Interim transcript streaming | — |
| 3 | `UserInput` / `UserTranscript` (`final=true`) | `onUserInput` / `onUserTranscript` | Final transcript | ~100–300 ms after the user stops talking |
| 4 | `UserStoppedSpeaking` | `onUserStoppedSpeaking` | Turn over: Smart Turn judged it complete and the final transcript is in | — |
| 5 | **`BotLlmStarted`** | **`onBotLlmStarted`** | **LLM request dispatched — wait period starts here** | the context providers' searches (Mem0, archive, facts) |
| 6 | `BotLlmText` (repeated) | `onBotLlmText` | Token deltas streaming in (deprecated) | 500 ms – 3 s for first token |
| 7 | `BotTranscript` | `onBotTranscript` | Sentence-aggregated text (deprecated) | inline |
| 8 | **`BotLlmStopped`** | **`onBotLlmStopped`** | LLM stream closed | ~1–4 s after step 5 |
| 9 | `BotTtsStarted` | `onBotTtsStarted` | Fish Audio TTS synthesis starts | overlaps with 6–8 (starts mid-stream) |
| 10 | `BotStartedSpeaking` | `onBotStartedSpeaking` | Audio is now playing on the user's speakers | ~200–500 ms after first TTS chunk |
| 11 | `BotOutput` / `BotTtsText` | `onBotOutput` / `onBotTtsText` | The reply's text as it is spoken: each sentence "new" as its audio starts, "completed" (with `BotTtsText`) as it ends | spread across the audio |
| 12 | `BotTtsStopped` | `onBotTtsStopped` | TTS finishes synthesising the reply | usually before the audio has played out |
| 13 | `BotStoppedSpeaking` | `onBotStoppedSpeaking` | Last audio sample played | at the audio's end |

Bold rows are the "LLM wait" window the original question was about.

The final transcript comes *before* `UserStoppedSpeaking`: the turn ends only once Smart Turn
judges it complete and a final transcript is in (the TurnDetector,
`packages/voice/src/input/turn.ts`). And the call opens with the bot's greeting: on `client-ready`,
after `bot-ready`, she answers a kickoff prompt, which never reaches the client as `user-llm-text`,
so steps 5–13 happen once before the user has said anything. A group call doesn't greet.

On a call to a persona who talks through a realtime model, the model's own VAD starts and ends
the user's turn, not Silero and Smart Turn, and it answers before it has transcribed the turn:
`UserStoppedSpeaking` comes as it hears the user stop, and the final transcript after it. The
TL;DR's indicator, which waits for that transcript, doesn't start on such a call.

---

## Edge cases to handle

### Interruption (barge-in)

If the user starts talking while the bot is still speaking, the bot cancels the in-flight LLM and
TTS, sends `bot-interrupted` (`RTVIEvent.BotInterrupted`), then closes whichever of
`bot-llm-stopped`, `bot-tts-stopped` and `bot-stopped-speaking` was open, in that order, and starts
a new turn. You'll see a new `UserStartedSpeaking` before the previous turn's
`BotStoppedSpeaking`. Reset your indicator state on every `UserStartedSpeaking`.

```ts
pcClient.on(RTVIEvent.UserStartedSpeaking, () => {
  clearSlowTimer();
  setShowSlowHint(false);
  setPhase("user-speaking");
});
```

### Errors

If the LLM call fails or times out, the TTS service errors, or a context provider fails,
`RTVIEvent.Error` fires with an `RTVIMessage` whose `data.error` is the bot's message. Its
`data.fatal` is always `false`: a call that can't go on (her hearing failing for good, a realtime
model's fatal error) sends its `error`, then ends, which arrives as `Disconnected`. A voice that
fails or stalls for 15 s sends an `error` too, and the reply goes on in text. That text arrives
only as `bot-llm-text`: the reply sends no more `bot-output` or `bot-transcription`, so a client
that shows her words from `onBotOutput` should show the reply's `bot-llm-text` after such an
`error` until its `bot-llm-stopped`. Always handle `Error` — otherwise a stuck "thinking…"
indicator will sit on screen forever:

```ts
pcClient.on(RTVIEvent.Error, (msg) => {
  clearSlowTimer();
  setShowSlowHint(false);
  setPhase("error");
  showErrorNotice(msg.data?.error);
});
```

### Disconnect

WebRTC disconnect (network drop, server restart) fires `Disconnected`. Tear down all timers and
reset phase to `idle`.

### A turn ends and no `bot-llm-started` follows

A slow LLM can't cause this: `bot-llm-started` goes out before its request does. Between
`user-stopped-speaking` and `bot-llm-started` the turn waits for the context providers' searches
(Mem0, the stream archive, persona facts), so a long gap that does end in `bot-llm-started` points
at them. A turn that ends with no transcript at all (a cough, noise, speech the STT couldn't
recognise) runs no LLM: the bot answers an empty turn only when that turn cut her off, once in a
row, asking the user to say it again. A slow STT shows up earlier, as a late
`user-stopped-speaking`: the turn ends once the final transcript is in, or when the TurnDetector's
watchdog runs out, 5 s after the last speech or transcript. Log the timestamps and ping the
backend team.

---

## Custom server messages

Status updates the standard events don't cover arrive as RTVI `server-message`s, through
`onServerMessage`; the handler receives the message's `data`:

```ts
pcClient.on(RTVIEvent.ServerMessage, (data) => {
  // data is whatever shape the bot sent; branch on data.type.
});
```

Of the extension contracts in `packages/core/src/index.ts`, only an LLM tool can send one: its
`run` gets `ToolEffects.sendServerMessage`, which the call sends its browser as it is.
`take_selfie` sends `{ type: "selfie", urls: [...] }` ([selfies.md](selfies.md)), with her
`persona` too on a group call. A context provider's `ContextTurn` has no such effect, so the bot
sends no progress messages like "RAG retrieving from stream archive…" or "checking long-term
memory…" — flag it if you want them.

### A call inside a chat: `chat-line`

While the production chat endpoint is on (`EIDOLON_CHAT_SECRET`,
[chat.md](chat.md#production-the-browser-keeps-the-chat)), the browser
can call a persona from inside a chat it keeps. The offer's `requestData` carries the chat, as
`POST /api/chat/turn` takes it, and whom the call is to:

```ts
requestData: {
  loginSyncToken,             // as on any call
  chat: { header, events },   // as POST /api/chat/turn takes it, the call's own call-started last
  persona: "milky-green",     // one of the chat's personas, served by the endpoint
}
```

She answers as that persona, opening on her view of the chat: the viewer's messages, and the
events the server signed whose `sig` still verifies, less her tool calls. Each finished line of the
call, the viewer's and hers, arrives as a server message for the browser to store as it is:

```ts
pcClient.on(RTVIEvent.ServerMessage, (data) => {
  if (data.type === "chat-line") appendToChat(chatId, data.event);
});
```

- **`event`** is a `message` with `modality: "call"`, from the viewer or from her. A reply the
  viewer cut off has `interrupted: true`, and its `text` is what the viewer heard of it.
- **A selfie she takes** arrives as her `message` with `text: ""` and the images in
  `attachments`, in its place among the lines. Fetch each from `/api/chat/files/<name>` as a chat
  turn's, before it expires. The call's `selfie` server message still comes first, to show at
  once; the `chat-line` is the one to keep.
- **Its `seq`** follows the newest `seq` in the offer's window, kept or not, then each line the one
  before. So the browser stores the call's `call-started` before it offers, and sends it in the
  window, and sends no turn in that chat until it hangs up. It stores `call-ended` after the last
  line it got.
- **Her lines carry `sig`;** the viewer's don't, and neither do the browser's own `call-started`
  and `call-ended`. All of them go back in the next window unchanged.
- **A line said as the call ends,** such as her reply cut off by the hang-up, never arrives.
- **A chat that won't do** is refused before any call starts, in the chat routes' words
  (`{ error: { code, message } }`): `400 bad-request` for a window that isn't a chat's, or a
  `persona` missing or not in it, and `403 persona-not-served`.
- **With the endpoint off,** `chat` is ignored and the call is an ordinary one that sends no
  `chat-line`. The session's log line for an anonymous viewer, which carries `requestData`, holds
  the chat as its size alone, `<chat: N events>`.

### A group call: `speaker`

A group call puts every persona in a chat on the call at once; only the local web app offers one
([chat.md](chat.md#a-call-in-the-local-app)). Each reply is one persona's, and the client learns
whose before it hears her:

```ts
pcClient.on(RTVIEvent.ServerMessage, (data) => {
  if (data.type === "speaker") setSpeaker(data.persona, data.name);
});
```

- **`persona`** is her id, and **`name`** her identity name.
- **It comes just before her `bot-started-speaking`,** as her first sample plays, so it names
  whoever the user hears. A reply in text alone (`audio_response: false`) gets it just before its
  first `bot-output`.
- **The floor can pass with no line from the user between two replies:** the director may choose
  another persona to answer the one before. A `speaker` naming someone else starts a new reply.
  The call page labels its transcript this way: `speakerOf` and the `speaker` event in
  `apps/web/src/features/call/transcript.ts`.
- **A group call doesn't greet:** nothing comes until the user speaks, so don't show it waiting
  for an answer. The local web app counts it answered at `bot-ready` and asks the user to speak
  first.
- **A call to one persona never sends `speaker`.**

---

## References

- [Pipecat client-js callbacks reference](https://docs.pipecat.ai/client/js/api-reference/callbacks)
  — canonical list of events and their data shapes
- [RTVI standard protocol](https://docs.pipecat.ai/client/rtvi-standard) — wire format
- [voice-engine.md](voice-engine.md#rtvi) — every message the bot sends, what a client can
  count on (I1–I10), and its [differences from pipedog](voice-engine.md#differences-from-pipedog)
- Project README: [`../README.md`](../README.md)
- [`../packages/voice/src/call/floor.ts`](../packages/voice/src/call/floor.ts) — when each message
  goes out; [`../packages/voice/src/rtvi/emitter.ts`](../packages/voice/src/rtvi/emitter.ts) — its
  shape
- [`../apps/web/src/features/call/`](../apps/web/src/features/call/) — the local web app's call
  page: `use-call.ts` (its listeners), `watchdog.ts`, `transcript.ts`
