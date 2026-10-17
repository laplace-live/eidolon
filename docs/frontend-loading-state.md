# Handover: Frontend loading-state indicators

**Audience:** frontend engineer working on the `laplace-eidolon` web client.
**Scope:** how to show the user that the backend is *doing something* (transcribing, thinking, synthesising speech) between the moment they stop talking and the moment they hear a reply.

This is a frontend-only task. The backend is already emitting every event you need — no Python changes required.

---

## TL;DR

The Pipecat backend already sends an RTVI `bot-llm-started` message the instant it dispatches the LLM request, and a matching `bot-llm-stopped` when the response stream ends. Listen for the corresponding JS events and toggle a "thinking…" indicator between them.

```ts
import { PipecatClient, RTVIEvent } from "@pipecat-ai/client-js";

pcClient.on(RTVIEvent.BotLlmStarted, () => setIsThinking(true));
pcClient.on(RTVIEvent.BotLlmStopped, () => setIsThinking(false));
```

That alone solves the "backend is taking too long, give me feedback" problem. If you want a richer status display (separate STT / LLM / TTS phases), use the [full event timeline](#full-per-turn-event-timeline) below.

---

## Why this matters

The bot is a voice persona ([明前奶绿](../persona.md)) that talks to viewers over WebRTC. Each turn the user speaks → audio is streamed to the server → the pipeline runs:

```
transport.input → STT → user_aggregator → [Mem0, PersonaFacts, StreamArchive]
                → LLM → TTS → transport.output
```

Every stage can stall:

- **STT** waits for Soniox to finalise (usually <300 ms after the user stops speaking).
- **LLM** waits for OpenRouter, which can take 1–5 s for first-token, longer with heavy RAG context. **This is the main source of perceived "lag".**
- **TTS** waits for Fish Audio to start streaming PCM.

Without UI feedback the silence after the user stops talking looks broken. The fix is to surface what the backend is doing.

---

## How the backend signals state

Pipecat ships a standard protocol called **RTVI** (Real-Time Voice Interaction) that translates internal pipeline frames into typed JSON messages over the WebRTC data channel. Our bot already enables this — `bot.py` constructs the pipeline with `rtvi_processor=LaplaceRTVIProcessor()`, and the matching `RTVIObserver` (auto-attached by `PipelineWorker`) emits every event listed below by default. **You don't need to touch any backend code.**

Where the events come from (for reference only):

| RTVI wire message | Triggered by Python frame | Pushed at |
|---|---|---|
| `bot-llm-started` | `LLMFullResponseStartFrame` | `pipecat/services/openai/base_llm.py:555` — *before* the HTTP call to OpenRouter |
| `bot-llm-stopped` | `LLMFullResponseEndFrame` | `pipecat/services/openai/base_llm.py:565` — after the stream closes |
| `bot-tts-started` | `TTSStartedFrame` | When TTS service starts producing audio |
| `bot-tts-stopped` | `TTSStoppedFrame` | When TTS audio stream ends |
| `bot-started-speaking` | `BotStartedSpeakingFrame` | When audio actually starts flowing through the transport |
| `bot-stopped-speaking` | `BotStoppedSpeakingFrame` | When audio finishes playing |
| `user-started-speaking` | `UserStartedSpeakingFrame` | Silero VAD detects voice |
| `user-stopped-speaking` | `UserStoppedSpeakingFrame` | Silero VAD detects end of utterance |
| `user-transcription` | `TranscriptionFrame` / `InterimTranscriptionFrame` | Soniox emits text |

**Key insight on `bot-llm-started`:** it fires *before* the LLM API call is dispatched (see `base_llm.py` lines 553-565 — the frame is pushed, then `_process_context` makes the HTTPS call). So this event correctly captures the LLM's **time-to-first-token (TTFB)**, which is the period you actually want to indicate.

---

## Implementation

### 1. Dependencies

You should already have these in the frontend's `package.json`:

```json
{
  "dependencies": {
    "@pipecat-ai/client-js": "^1.6.0",
    "@pipecat-ai/small-webrtc-transport": "^1.0.0"
  }
}
```

If not, install them:

```bash
npm install @pipecat-ai/client-js @pipecat-ai/small-webrtc-transport
```

### 2. Minimal: single "thinking…" indicator

The simplest implementation — show one status while the pipeline is busy, hide it when audio plays:

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

For better UX, gate the "thinking" UI on a watchdog so the indicator only appears if the wait actually feels long. This avoids a flicker for fast responses:

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

This is the pattern we recommend: it catches *any* source of slowness (slow STT, slow LLM TTFB, or slow TTS) in one indicator rather than coupling the UI to a specific stage that may not be the actual bottleneck.

### 4. Streaming partial text (optional)

If you want to render the LLM's reply as text *while* TTS is still synthesising it (chat-style transcript), listen for `onBotLlmText` (token deltas) or `onBotTranscript` (sentence-aggregated):

```ts
pcClient.on(RTVIEvent.BotLlmText, (data) => {
  // data.text is a token chunk; append to your transcript buffer.
  appendBotText(data.text);
});

pcClient.on(RTVIEvent.BotLlmStopped, () => {
  // Reply is fully generated; finalise the message bubble.
  commitBotMessage();
});
```

Note that the bot speaks Chinese — emotion tags like `[happy]` appear inline in the text stream; you may want to strip them with a regex before rendering.

---

## Full per-turn event timeline

These fire in roughly this order for each conversation turn. Use this table to design any UI state diagram you need:

| # | JS event | JS callback | Phase | Typical latency from previous step |
|---|---|---|---|---|
| 1 | `UserStartedSpeaking` | `onUserStartedSpeaking` | User is talking | — |
| 2 | `UserTranscript` (`final=false`) | `onUserTranscript` | Interim transcript streaming | — |
| 3 | `UserStoppedSpeaking` | `onUserStoppedSpeaking` | VAD detects end of utterance | — |
| 4 | `UserTranscript` (`final=true`) | `onUserTranscript` | Final transcript | ~100–300 ms |
| 5 | **`BotLlmStarted`** | **`onBotLlmStarted`** | **LLM request dispatched — wait period starts here** | ~50 ms (RAG retrieval) |
| 6 | `BotLlmText` (repeated) | `onBotLlmText` | Token deltas streaming in | 500 ms – 3 s for first token |
| 7 | `BotTranscript` | `onBotTranscript` | Sentence-aggregated text | inline |
| 8 | **`BotLlmStopped`** | **`onBotLlmStopped`** | LLM stream closed | ~1–4 s after step 5 |
| 9 | `BotTtsStarted` | `onBotTtsStarted` | Fish Audio TTS synthesis starts | overlaps with 6–8 (starts mid-stream) |
| 10 | `BotStartedSpeaking` | `onBotStartedSpeaking` | Audio is now playing on the user's speakers | ~200–500 ms after first TTS chunk |
| 11 | `BotTtsText` | `onBotTtsText` | Words as they're spoken | inline |
| 12 | `BotTtsStopped` | `onBotTtsStopped` | TTS finishes synthesis | — |
| 13 | `BotStoppedSpeaking` | `onBotStoppedSpeaking` | Last audio sample played | — |

Bold rows are the "LLM wait" window the original question was about.

---

## Edge cases to handle

### Interruption (barge-in)

If the user starts talking while the bot is still speaking, Pipecat cancels the in-flight LLM/TTS and starts a new turn. You'll see a new `UserStartedSpeaking` before the previous turn's `BotStoppedSpeaking`. Reset your indicator state on every `UserStartedSpeaking`.

```ts
pcClient.on(RTVIEvent.UserStartedSpeaking, () => {
  clearSlowTimer();
  setShowSlowHint(false);
  setPhase("user-speaking");
});
```

### Errors

If the LLM call times out or the TTS service errors, `RTVIEvent.Error` fires with a `RTVIMessage` whose `data.fatal` boolean tells you whether the session was terminated. Always handle this — otherwise a stuck "thinking…" indicator will sit on screen forever:

```ts
pcClient.on(RTVIEvent.Error, (msg) => {
  clearSlowTimer();
  setShowSlowHint(false);
  setPhase("error");
  if (msg.data?.fatal) {
    // Client will auto-disconnect; show a "reconnecting…" UI.
  }
});
```

### Disconnect

WebRTC disconnect (network drop, server restart) fires `Disconnected`. Tear down all timers and reset phase to `idle`.

### Pipeline takes >5s with no events

Shouldn't happen — even a slow LLM emits `bot-llm-started` immediately when the request is dispatched. If you see a long gap between `user-stopped-speaking` and *any* bot event, that points to a STT problem (Soniox not finalising). Log it and ping the backend team with the timestamp.

---

## Custom server messages (advanced, optional)

If we ever need to send *custom* status updates that aren't covered by the standard RTVI events (e.g. "RAG retrieving from stream archive…", "checking long-term memory…"), the backend can call `rtvi.send_server_message({ type: "...", data: {...} })` from inside any pipeline processor. These arrive on the frontend via `onServerMessage`:

```ts
pcClient.on(RTVIEvent.ServerMessage, (data) => {
  // data is whatever shape we agreed on with the backend.
});
```

This is not currently wired up — flag if you want it and the backend team can add it.

---

## References

- [Pipecat client-js callbacks reference](https://docs.pipecat.ai/client/js/api-reference/callbacks) — canonical list of events and their data shapes
- [RTVI standard protocol](https://docs.pipecat.ai/client/rtvi-standard) — wire format
- [Pipecat RTVI Observer (server)](https://docs.pipecat.ai/server/frameworks/rtvi/rtvi-observer) — which frames trigger which messages
- [Pipecat introduction](https://docs.pipecat.ai/) — overall architecture
- Project README: [`../README.md`](../README.md)
- Bot entry point: [`../laplace_eidolon/bot.py`](../laplace_eidolon/bot.py) — search for `LaplaceRTVIProcessor` to see how RTVI is wired in
