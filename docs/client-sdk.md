# Client SDK (`@laplace.live/eidolon-sdk`)

`@laplace.live/eidolon-sdk` (`packages/sdk`) is the browser TypeScript and React SDK for calling an
Eidolon bot over SmallWebRTC and running stateless browser-stored chats against `/api/chat/*`.

Two entries ship in the npm package, licensed under `AGPL-3.0-only`:

- **`@laplace.live/eidolon-sdk`** (`.`): framework-agnostic `EidolonClient`, RTVI and offer payload
  contracts, `/api/ice-servers`, `/api/memories`, stateless chat protocol/client/session/view
  helpers, the files a line carries (`prepareChatFile`), `BrowserChatStore<TRecord>`, inline
  delivery-cue markup parser (`parseMarkup`, `parseMarkupWithState`, `stripCues`,
  `trimTrailingPartialCue`), and `Watchdog`.
- **`@laplace.live/eidolon-sdk/react`** (`./react`, optional peer `react >= 18`):
  `EidolonClientProvider`, `EidolonClientAudio`, `useEidolonClient`, `useEidolonEvent`,
  `useEidolonTransportState`, `useEidolonMicControl`, `useEidolonMediaState`,
  `useEidolonMediaTrack`, `useEidolonNetworkInfo`, `useEidolonWatchdog`, `useEidolonConversation`,
  `useEidolonAudioLevel`, and `useEidolonMicDevices`.

The SDK sits on top of `@pipecat-ai/client-js` and `@pipecat-ai/small-webrtc-transport` (exact
versions in `packages/sdk/package.json`) and hides their transport quirks so downstream apps import
zero `@pipecat-ai/*` packages directly.

---

## Boundaries

`packages/sdk` is a standalone browser package:

- **`packages/sdk/src/` imports no `@eidolon/*`, `node:*`, or `bun:*` modules.** Biome enforces
  this, and `packages/sdk/scripts/build.ts` verifies that `dist/` inlines zero `node_modules`
  packages and imports only declared `dependencies` and `peerDependencies`.
- **The server never imports `@laplace.live/eidolon-sdk`.** Biome forbids it across `apps/bot`,
  `apps/cli`, `apps/eidolon`, and the server `packages/*`, and `apps/bot/Dockerfile` installs with
  `--filter '!@laplace.live/eidolon-sdk'`, so none of the SDK's dependencies reach the image.
  `docker.yml` ignores `packages/sdk/**`.
- **Protocol parity is tested, not imported.** `packages/sdk/test/parity.test.ts` checks the SDK's
  constants (`CHAT_FORMAT`, window budgets, chain limits, voice limits, `AUDIO_QUALITIES`) against
  `@eidolon/chat`, `@eidolon/access`, `@eidolon/runtime`, and `apps/bot/src/chat`. It also runs
  generated logs through `buildWindow` and the server's `windowOf`, which must keep the same
  events.
- **The local web app is a consumer.** `apps/web` calls through `EidolonClient` and takes the cue
  markup, the turn `Watchdog` and server-message parsing from the SDK, with no `@pipecat-ai/*`
  package of its own. Its call transcript, call phases and chat items stay in `apps/web`: they
  carry group calls' speakers, selfies by persona and the director's reasons, which
  `useEidolonConversation` and `eventItems` don't model.
- **A host app on another origin needs a bot that answers it.** A production-mode bot (`bun run
  dev`, `bun run start` or the image) allows every origin unless `PIPECAT_ALLOWED_ORIGINS` narrows
  it. The local app (`bun run app`, `bun run local`, `eidolon`) answers only its own pages until
  `EIDOLON_LOCAL_ALLOWED_ORIGINS` lists the host's origin, and then serves it the bot's API as a
  deployment would, never as the local viewer ([web-app.md](web-app.md#security)). Text chats
  also need `EIDOLON_CHAT_SECRET`; without it the probe reports `"off"`.

---

## WebRTC calls (`EidolonClient`)

`EidolonClient` wraps `PipecatClient` + `SmallWebRTCTransport` with `WavMediaManager` (camera
disabled, mic enabled by default):

```ts
import { EidolonClient } from "@laplace.live/eidolon-sdk";

const client = new EidolonClient();
await client.refreshIceServers("https://eidolon.example.com");
await client.applyMicPreference(persistedMicId);
await client.connect({
  endpoint: "https://eidolon.example.com/api/offer",
  requestData: {
    audioQuality: "best",
    loginSyncToken,
  },
});
```

### Upstream `WavMediaManager` bridges inside `EidolonClient`

`EidolonClient` configures `SmallWebRTCTransport` with `WavMediaManager` (raw 24 kHz PCM capture so
Chromium's WebRTC APM does not clip quiet syllables) and closes three upstream gaps:

1. **Missing `replaceTrack` on live mic swap.** Passing a custom `mediaManager` skips
   `SmallWebRTCTransport`'s default `DailyMediaManager` callback that swaps the outbound RTP track.
   `EidolonClient` intercepts local audio `TrackStarted` events and forwards `sender.replaceTrack`
   on the audio transceiver.
2. **`mediaState.mic.state` stuck at `"uninitialized"`.** `WavMediaManager` never fires
   `onMicUpdated` on initial capture, leaving `PipecatClient.mediaState.mic` at `"uninitialized"`
   throughout a live call. `EidolonClient.mediaState` promotes `"uninitialized"` to `"granted"`
   while connected or ready and re-emits `mediaStateUpdated` on transport transitions.
3. **Unawaited `PipecatClient.updateMic`.** `PipecatClient.updateMic` drops the underlying promise,
   racing `connect()` against an in-flight recorder swap. `EidolonClient.applyMicPreference`
   verifies the device is enumerated, skips `"default"`, and awaits `SmallWebRTCTransport.updateMic`
   directly; `selectLiveMic` swaps only during an active call so settings dialogs never open the
   microphone early.

### Typed RTVI events

`client.on(event, handler)` and `useEidolonEvent(event, handler)` narrow payloads automatically:

- `"serverMessage"` delivers a discriminated `EidolonServerMessage` (`"selfie"` with validated
  root-relative `/api/selfie/...` paths, which a page on another origin resolves against the bot's
  base URL, `"chat-line"` with a validated `WireEvent`, `"speaker"` on local group calls, or
  `"unknown"`).
- `"botReady"` delivers `EidolonBotReadyData` (`about.library === "laplace-eidolon"`, parsed
  `capabilities`).
- `"micEnabledUpdated"` fires whenever `enableMic` turns the mic on or off (pipecat has no such
  event), so every `useEidolonMicControl` stays in step.
- `"error"` delivers `EidolonErrorMessage` (`data.error`, `data.fatal`).

---

## Stateless browser chats

Production's chat endpoint (`apps/bot/src/chat`, [chat.md](chat.md#production-the-browser-keeps-the-chat))
stores nothing on disk: the browser keeps the log and sends a bounded `ChatWindow` on every turn or
in-chat call.

The SDK owns the wire format, NDJSON stream parser, cross-tab Web Locks (`withChatLock`,
`holdChatLock`), window builder (`buildWindow`), session orchestrator (`createChat`,
`sendChatTurn`, `startChatCall`, `closeDanglingCall`, `downloadMissingFiles`), and pure
`chatViewReducer`, while leaving IndexedDB storage to the host app through
`BrowserChatStore<TRecord>`:

```ts
import {
  type BrowserChatStore,
  createChat,
  sendChatTurn,
  startChatCall,
} from "@laplace.live/eidolon-sdk";
```

### The window

`buildWindow` cuts a turn's window by the server's own rule ([chat.md](chat.md#the-window)):

- **What it reads:** the log's newest `CHAT_WINDOW_EVENTS` (180) events that aren't `NEVER_SENT`,
  newest first.
- **Two shares,** each closing at its first event that doesn't fit, so a call never goes while its
  result stays behind (a call cut off has none):
  - tool calls and results: `CHAT_WINDOW_TOOL_EVENTS` (60) and `CHAT_WINDOW_TOOL_BYTES` (128 KB of
    JSON);
  - every other event: the other 120 and `CHAT_WINDOW_BYTES` (256 KB).

  Once the second closes, full or at an event that doesn't fit, the window ends there: no older
  tool event goes.
- **State:** every `STATE_EVENT_TYPES` event goes too, however old.
- **As stored:** each event goes whole, in log order, or not at all. A signed event changed in any
  way fails its signature, and the server drops it: a tool result shortened to fit would read to
  her as a call that never returned.

**A store's `window()`** passes `buildWindow` the whole log, or no less of it than its newest
`CHAT_WINDOW_EVENTS` events that aren't `NEVER_SENT` and every state event older than them, oldest
first. Both give the same window. laplace's store reads exactly that bound, through the SDK's
`CHAT_WINDOW_EVENTS`, so it reads what each SDK version needs with no change of its own.

### Files with a line

A viewer can send images and text files with a line ([chat.md](chat.md#the-viewers-files)):

```ts
import { prepareChatFile, sendChatTurn } from "@laplace.live/eidolon-sdk";

const files = await Promise.all(picked.map(prepareChatFile)); // rejects with ChatFileError
await sendChatTurn(options, { chatId, text: "看看这个", files });
```

- **`prepareChatFile(file)`** makes a picked, pasted or dropped `File` ready in the browser, so it
  goes small: a picture the browser opens is drawn upright at no more than `MAX_IMAGE_PIXELS`
  (2048²) and a `MAX_IMAGE_EDGE` (2576 px) edge, without what its camera wrote in it, as JPEG at
  quality 0.85, 0.75 or 0.6, whichever fits `MAX_IMAGE_BYTES` (3.5 MB) first, or as WebP (PNG on
  Safari) where it has transparency; a PNG or WebP that already fits goes as it is. A text file
  (any `text/` type or a known extension, which `CHAT_FILE_ACCEPT` lists for a file input) must be
  UTF-8, at most `MAX_TEXT_FILE_BYTES` (1 MB). Anything else, an SVG or a PDF included, is a
  `ChatFileError` with `code` `unsupported` or `too-large`. `chatFileKind(file)` says
  beforehand which kind a file is.
- **The server makes each image ready again** with sharp, as the local app does every image it is
  sent ([chat.md](chat.md#the-viewers-files)): upright, stripped and in sRGB, before her mind sees
  it. It takes one `prepareChatFile` drew as it is, since it fits the same bounds, rounded down
  alike, and makes again a PNG or WebP the SDK sent as it was when anything is written in it. It
  refuses an image past `MAX_IMAGE_PIXELS` or `MAX_IMAGE_BYTES` (`413`), or one that isn't a
  whole PNG, JPEG or WebP (`415`): a host that sends files without `prepareChatFile` fits them
  itself.
- **`sendChatTurn({ files })`** sends up to `MAX_LINE_FILES` (8) with the line as a multipart turn,
  `text` optional; a turn with no file to send, its own or an earlier one, goes as JSON. Once the
  first `events` line is stored, it keeps each file's Blob under the name the stored message gives
  it (`putFile`), its content's SHA-256; one that couldn't be kept is reported through
  `onMissingFiles`.
- **Earlier files:** the server keeps none of them, so each turn, voice messages included, also
  sends the files of the window's lines that the store holds, newest first, each once, up to 4
  and 4 MB (`seen`), and `MAX_TURN_FILE_BYTES` (12 MB) with the line's own. Her view reads any
  older one as a note.
- **`eventItems`** lists a message's text files as `files`, beside its `images`.

### Her words before a tool call

When a round of a text turn of hers ends in tool calls, the words she wrote before them are stored
on the round's first call as `said` ([chat.md](chat.md#the-format)), and her message holds only her
last round:

- **`eventItems`** shows a call's `said` as her `message` item at the call's seq, so her words read
  in the order she said them.
- **`chatViewReducer`** clears a live turn's streamed text once its call with `said` is stored, so
  the words show once and her next round streams on below them. A call already in the view clears
  nothing, so a reload can't take what streamed since.

**Version skew:** production's calls carry `said` as soon as a bot that writes it is deployed, which
a push to `master` does, while a new SDK reaches npm only with its version PR. Until a host takes
an SDK that renders `said`, it shows those words while they stream and loses them once her message
is stored. Its store keeps the events as received, so the words come back once it updates.

---

## Building and releasing

```bash
bun run build:sdk     # bundles dist/index.js + dist/react/index.js + .d.ts into packages/sdk/pack/
bun run pack:sdk      # stages packages/sdk/pack/ and packs laplace.live-eidolon-sdk-<version>.tgz
```

`@laplace.live/eidolon-sdk` is versioned and tagged independently from the `laplace-eidolon` /
`@laplace.live/eidolon` fixed group ([releasing.md](releasing.md)). Name `@laplace.live/eidolon-sdk`
in a changeset whenever a change affects the published SDK.
