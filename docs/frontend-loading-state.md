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

A turn with no words runs no LLM, so nothing would end the indicator. The final transcript
arrives before `UserStoppedSpeaking`, so start the indicator only for a turn that has one.
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

---

## Why this matters

The bot is a voice persona ([明前奶绿](../personas/milky-green/prompt.md)) that talks to viewers
over WebRTC. Each turn the user speaks → audio is streamed to the server → the pipeline runs:

```text
transport.input → STT → user_aggregator → RetrievalGate
    → Mem0 → StreamArchive → PersonaFacts → LLM → TTS → transport.output
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

**RTVI** (Real-Time Voice Interaction) is Pipecat's protocol for translating pipeline frames into
typed JSON messages over the WebRTC data channel, and pipedog, the TypeScript port of Pipecat the
bot is built on, implements it. `buildSession` (`packages/runtime/src/session/session.ts`) hands
pipedog's `PipelineWorker` a `LaplaceRTVIProcessor` (`packages/runtime/src/rtvi.ts`, which only
brands the `bot-ready` message's `about` as `laplace-eidolon`). The worker puts it at the head of
the pipeline, answers the client's `client-ready` with `bot-ready`, and attaches an `RTVIObserver`
with pipedog's default `RTVIObserverParams`, which emits every event listed below. **You don't
need to touch any bot code.**

Where the events come from (for reference only):

| RTVI wire message | Triggered by pipedog frame | Pushed when |
|---|---|---|
| `bot-llm-started` | `LLMFullResponseStartFrame` | The LLM service is about to send its request — *before* the HTTP call to OpenRouter |
| `bot-llm-stopped` | `LLMFullResponseEndFrame` | The stream closes, or the request fails |
| `bot-tts-started` | `TTSStartedFrame` | The TTS service starts synthesising the reply |
| `bot-tts-stopped` | `TTSStoppedFrame` | The TTS audio stream ends |
| `bot-started-speaking` | `BotStartedSpeakingFrame` | Audio actually starts flowing through the transport |
| `bot-stopped-speaking` | `BotStoppedSpeakingFrame` | Audio finishes playing |
| `bot-interrupted` | `InterruptionFrame` | The user barged in and the reply was cut off |
| `bot-output` | `AggregatedTextFrame` | The reply's text, sentence by sentence, as the output transport plays it |
| `user-started-speaking` | `UserStartedSpeakingFrame` | Silero VAD hears speech (or a transcript arrives first) |
| `user-stopped-speaking` | `UserStoppedSpeakingFrame` | Smart Turn judges the turn complete *and* a final transcript is in |
| `user-input`, `user-transcription` | `TranscriptionFrame` / `InterimTranscriptionFrame` | Soniox emits text |
| `server-message` | `RTVIServerMessageFrame`, or the RTVI processor itself | An LLM tool sends one, or a call inside a chat sends a line ([below](#custom-server-messages)) |
| `error` | `ErrorFrame` | A service or a context provider reports an error |

The bot also sends `bot-llm-text` (each chunk of the LLM's text), `bot-transcription` (the same,
a sentence at a time) and `bot-tts-text`, which client-js deprecates in favour of `bot-output`, as
it does `user-transcription` in favour of `user-input`.

**Key insight on `bot-llm-started`:** it fires *before* the request is dispatched. In pipedog's
`BaseOpenAILLMService` (`@pipedog/openai`), which the default OpenRouter service extends,
`processFrame` pushes `LLMFullResponseStartFrame` and only then calls `_processContext`, which
makes the HTTPS call; the Anthropic service pushes it ahead of its request too. So this event
captures the LLM's **time-to-first-token (TTFB)**, which is the period you actually want to
indicate. A failed request pushes `LLMFullResponseEndFrame` all the same, so an `error` from the
LLM comes with its `bot-llm-stopped`.

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

The simplest implementation — show one status while the pipeline is busy, hide it when audio
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
stage that may not be the actual bottleneck. The local web app's call page runs it: `Watchdog`
(`apps/web/src/features/call/watchdog.ts`), which `use-call.ts` arms on `UserStoppedSpeaking` and
on typed text, shows its thinking dots after `THINKING_DELAY_MS`, and clears on
`BotStartedSpeaking`, `UserStartedSpeaking`, `Error` and disconnect; `BotLlmStarted` cancels its
"stuck" warning.

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
`apps/web/src/lib/markup.ts` parses the full set.

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
| 11 | `BotOutput` / `BotTtsText` | `onBotOutput` / `onBotTtsText` | The reply's text as it is spoken | inline |
| 12 | `BotTtsStopped` | `onBotTtsStopped` | TTS finishes synthesis | — |
| 13 | `BotStoppedSpeaking` | `onBotStoppedSpeaking` | Last audio sample played | — |

Bold rows are the "LLM wait" window the original question was about.

The final transcript comes *before* `UserStoppedSpeaking`: the turn ends only once Smart Turn
judges it complete and a final transcript is in (pipedog's `TurnAnalyzerUserTurnStopStrategy`).
And the call opens with the bot's greeting: on `client-ready`, `installGreeting`
(`packages/runtime/src/session/session.ts`) runs the LLM once, so steps 5–13 happen once before
the user has said anything.

---

## Edge cases to handle

### Interruption (barge-in)

If the user starts talking while the bot is still speaking, pipedog cancels the in-flight LLM/TTS,
sends `bot-interrupted` (`RTVIEvent.BotInterrupted`) and starts a new turn. You'll see a new
`UserStartedSpeaking` before the previous turn's `BotStoppedSpeaking`. Reset your indicator state
on every `UserStartedSpeaking`.

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
`data.fatal` is always `false`, since pipedog doesn't port the flag: a session that ends arrives
as `Disconnected`, not as an error. Always handle `Error` — otherwise a stuck "thinking…"
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
recognise) runs no LLM: under pipedog's `EmptyUserTurnConfig`, as `buildSession` sets it, the bot
answers an empty turn only when it cut the bot off. A slow STT shows up earlier, as a late
`user-stopped-speaking`: the turn ends once the final transcript is in, or when the aggregator's
`userTurnStopTimeout` runs out. Log the timestamps and ping the backend team.

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
`run` gets `ToolEffects.sendServerMessage`, which `SessionTools`
(`packages/runtime/src/adapters/tools.ts`) pushes from the LLM as an `RTVIServerMessageFrame`.
`take_selfie` sends `{ type: "selfie", urls: [...] }` ([selfies.md](selfies.md)). A context
provider's `ContextTurn` has no such effect, so the bot sends no progress messages like "RAG
retrieving from stream archive…" or "checking long-term memory…" — flag it if you want them.

### A call inside a chat: `chat-line`

While the production chat endpoint is on (`EIDOLON_CHAT_SECRET`,
[chat.md](chat.md#production-the-browser-keeps-the-chat)), the browser
can call a persona from inside a chat it keeps. The offer's `requestData` carries the chat, as
`POST /api/chat/turn` takes it, and whom the call is to:

```ts
requestData: {
  loginSyncToken,             // as on any call
  chat: { header, events },   // the chat's newest events, the call's own call-started last
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
  viewer cut off has `interrupted: true`, and its `text` is what she said before it.
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
  `chat-line`. Its `requestData` is then logged whole for an anonymous viewer, so send `chat` only
  to a server whose chat routes answer.

---

## References

- [Pipecat client-js callbacks reference](https://docs.pipecat.ai/client/js/api-reference/callbacks)
  — canonical list of events and their data shapes
- [RTVI standard protocol](https://docs.pipecat.ai/client/rtvi-standard) — wire format
- pipedog's `RTVIObserver` (`@pipedog/core/processors/frameworks/rtvi/observer`) — which frames
  trigger which messages, and the defaults of `RTVIObserverParams`
- Project README: [`../README.md`](../README.md)
- [`../packages/runtime/src/session/session.ts`](../packages/runtime/src/session/session.ts) —
  `buildSession`, where RTVI is wired in, and `installGreeting`;
  [`../packages/runtime/src/rtvi.ts`](../packages/runtime/src/rtvi.ts) — `LaplaceRTVIProcessor`
- [`../apps/web/src/features/call/`](../apps/web/src/features/call/) — the local web app's call
  page: `use-call.ts` (its listeners), `watchdog.ts`, `transcript.ts`
