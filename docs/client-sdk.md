# Client SDK (`@laplace.live/eidolon-sdk`)

`@laplace.live/eidolon-sdk` (`packages/sdk`) is the browser TypeScript and React SDK for calling an
Eidolon bot over SmallWebRTC, running stateless browser-stored chats against `/api/chat/*`, and
drawing a persona's PSD2Live model that moves with the call.

Three entries ship in the npm package, licensed under `AGPL-3.0-only`:

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
- **`@laplace.live/eidolon-sdk/avatar`** (`./avatar`): `AvatarStage`, `loadPsd2liveModel`,
  `inspectPsd2liveRig`, `resolveSetup`, the direction reducer (`direct`, `directionOf`,
  `directionState`), the mood table (`moodTags`, `soundCueEffect`, `DEFAULT_MOOD_EXPRESSIONS`), the
  mouth (`MouthMeter`, `mouthCurve`), framing (`bustBox`, `companionBox`, `viewFor`, `panBox`,
  `zoomBox`) and the runtime's loader (`compilePsd2liveRuntime`, `psd2liveRuntimeUrl`). It
  includes PSD2Live's web player, ported, and ships its runtime: both are MIT
  ([Avatars](#avatars-eidolon-sdkavatar)).

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
- **The avatar entry stands alone.** `src/avatar/index.ts` is its only barrel, and nothing under
  `src/index.ts` or `src/react/` imports it: each entry is bundled whole, so an avatar module
  reached from another would carry the runtime's `new URL(…, import.meta.url)` into a folder with
  no runtime beside it. It has no React bindings of its own.
- **The local web app is a consumer.** `apps/web` calls through `EidolonClient` and takes the cue
  markup, the turn `Watchdog` and server-message parsing from the SDK, with no `@pipecat-ai/*`
  package of its own. Its call transcript, call phases and chat items stay in `apps/web`: they
  carry group calls' speakers, selfies by persona and the director's reasons, which
  `useEidolonConversation` and `eventItems` don't model.
- **A host app on another origin needs a bot that answers it.** A production-mode bot (`bun run
  dev`, `bun run start` or the image) allows every origin unless `PIPECAT_ALLOWED_ORIGINS` narrows
  it. The local app (`bun run app`, `bun run local`, `eidolon`, the desktop app) answers only its
  own pages until `EIDOLON_LOCAL_ALLOWED_ORIGINS` lists the host's origin, and then serves it the
  bot's API as a deployment would, never as the local viewer ([web-app.md](web-app.md#security)).
  The desktop app's server reads it from the environment the app gives it, on macOS the login
  shell's and never a `.env` ([desktop.md](desktop.md#the-environment)). Text chats also need
  `EIDOLON_CHAT_SECRET`; without it the probe reports `"off"`.

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

## Avatars (`eidolon-sdk/avatar`)

The entry draws a persona's PSD2Live model, a `.p2lrt` file, on a WebGL 1 canvas, and moves it with
a call: her mood from the cues she writes, her mouth from her voice, her gaze and gestures from the
call's turns. The local app's Studio previews a persona's models with it.

### The runtime

- **What runs:** PSD2Live's runtime, `src/avatar/psd2live/wasm/p2l_runtime.wasm`, vendored byte for
  byte from PSD2Live's committed build ([its README](../packages/sdk/src/avatar/psd2live/README.md)
  holds the commit, the SHA-256s and the refresh steps). It imports nothing and reaches nothing but
  its own memory.
- **How it loads:** `compilePsd2liveRuntime(source?)` fetches it and compiles it with
  `WebAssembly.compile` once per URL, never `compileStreaming`, which needs `application/wasm`. By
  default it is `psd2liveRuntimeUrl()`, `new URL("./wasm/p2l_runtime.wasm", import.meta.url)`, which
  Vite and webpack 5 resolve and ship. A host can pass a URL, the bytes or a compiled
  `WebAssembly.Module` instead; Node's `fetch` refuses `file:` URLs, so code on Node passes bytes.
- **One instance per model.** Each model gets a runtime instance of its own, so a trap ends only
  that model. An instance whose ABI isn't 1.x at 1.2 or later is refused (`AvatarError` `runtime`).
- **The page's CSP** must allow `'wasm-unsafe-eval'` in `script-src`, which permits compiling
  WebAssembly and nothing else; without it the load fails as `runtime`. The page runs no
  JavaScript that came with a model.

### Models

- **`loadPsd2liveModel(canvas, bytes, {runtime?})`** loads a rig, checking every chunk's CRC,
  uploads its texture pages and resolves to a `Psd2liveModel`, the stage's `AvatarModel`.
  `model.rig` reaches what the stage doesn't drive: poses, parameters and part opacity.
- **`inspectPsd2liveRig(bytes, {runtime?})`** reads the same file without WebGL into a
  `ModelInventory`: the runtime's version, the generator, the canvas, the clips (id, name, group,
  duration, looping), expressions, hit areas, parameters with their ranges, parts, pose groups,
  whether a parameter has the LipSync role, and how many texture pages. Numbers are the runtime's
  float32 values as read. The local server reads its own inventory from the same wasm, and a parity
  test holds the two equal.
- **Clips are matched by group, then name, then id.** PSD2Live's editor exports name clips
  `modifier:m32:…` with the name and group `Idle`, so a lookup by id alone finds nothing.
- **An id a rig lacks changes nothing.** `play` with an unknown clip leaves the layer playing, and
  `setExpressions` with only unknown ids leaves the expressions playing, where the upstream
  player's `-1` stopped the clip or faded every expression out.
- **`resolveSetup(inventory, overrides?)`** turns a model's owner's choices into what the stage
  plays: each mood's expressions (the owner's, else `DEFAULT_MOOD_EXPRESSIONS`, kept to the ids the
  rig has, at most two) and each gesture's clip (`idle`, `talk`, `nod`, `shake`: the owner's clip,
  else the clip whose group, name or id is `Idle`, `Talk`, `Nod` or `Shake`).
- **Errors** are `AvatarError`s with a `code`: `runtime` (the runtime didn't load), `rig` (the file
  isn't a rig it reads, with the runtime's reason), `webgl` (no WebGL 1, or a mesh past 65,535
  vertices without `OES_element_index_uint`), `lost` (the browser took the context back) and
  `trap` (the runtime failed while running).

### The stage

`new AvatarStage(canvas, {maxPixelRatio?, fps?, reducedMotion?, onError?, clock?})` owns the frame
loop; the model has none of its own.

- **`show(model, setup)`** disposes the model shown before. `frame(box)` frames a region of the
  rig's canvas, filling the element whatever its size; until it is called the stage shows the
  whole canvas.
- **The loop** runs on animation frames (`clock`, which tests replace), at `fps` at most when it is
  above 0, stepping at most 0.1 s a frame. It pauses while the page is hidden, while an
  IntersectionObserver says the canvas is off screen, and after `pause()`. The device pixel ratio
  is capped at `maxPixelRatio` (2).
- **`direct(direction)`** sets what the next frame applies, the latest winning: `idle` loops on clip
  layer 0, `talk` plays on layer 1 while she speaks, each new gesture plays once on layer 2, and the
  expressions are her mood's and a cue's lent mood's, the lent one first, at most two.
- **`gaze(mode)`:** `"direction"` looks at the viewer while she listens, up and aside while she
  thinks, and around the viewer (within 0.15, every 2 to 5 s) otherwise; `"pointer"` follows the
  pointer; a pair `[x, y]` holds a point.
- **`mouth(source)`** reads a `MouthSource` once a frame; `wear(outfit)` shows an outfit's pose
  entries, holds its parameters and hides its parts.
- **`reducedMotion`** keeps her face, mouth and idle clip, and leaves out the talking and gesture
  clips and the wandering eyes.
- **Errors:** a model that throws, or a lost WebGL context, is disposed and reported to `onError`
  once, so the page can show her picture instead. `alphaAt(x, y)` resolves with the drawn alpha
  under a page point after the next draw, read before the page composites the frame.

### Direction

`direct(state, event)` is a pure reducer over the call's events, each with `at` in milliseconds;
`directionOf(state, persona?)` gives a `Direction` (mood, lent mood, speaking, listening,
thinking, where she looks, the latest gesture). Both are plain data, so they cross a `MessagePort`.

- **Events:** `user-started-speaking`, `user-stopped-speaking`, `user-words` (a transcript or a
  typed line), `bot-llm-started`, `bot-started-speaking`, `bot-stopped-speaking`,
  `bot-interrupted`, `bot-output` (`segment`, `text`, `status` and `spoken` from `botOutput`'s
  `segment_id`, `text`, `spoken_status` and `spoken_progress.accumulated_text`'s length),
  `function-call`, `speaker` (a group call), `tick` (send one every 100 ms or so), `reply` (a
  chat reply no voice says) and `reset`.
- **Her mood** comes from the `[direction]` a reply's first segment opens with, through
  `moodTags`; a reply that opens with none is neutral, and its later segments keep its mood. A
  reply starts at the first segment after the viewer's words (unless they came while she was still
  speaking), an interruption, or a group call's `speaker`.
- **Cues** such as `[chuckling]` lend a mood for a moment and may nod (`soundCueEffect`). One before
  the segment's first word lands as the segment starts. The rest land as `spoken` passes them, for
  a voice with word timings; Fish reports only `new` and then `completed`, so there they land at
  her pace, 4.5 voiced letters a second from `new`, never later than `completed`.
- **Listening and thinking:** she watches the viewer while they speak, nods once their words are
  in, and thinks (looking away) until she speaks; `bot-llm-started` and `function-call` have her
  thinking too. Speaking comes only from `bot-started-speaking` and `bot-stopped-speaking`: a
  realtime model's `bot-output` arrives after its audio.
- **Group calls:** `speaker` routes the bot events after it to that persona; the viewer's events
  reach everyone. Word, token, backchannel and expression outputs are skipped.

### Moods

`moodTags(direction)` reads a direction such as `懒洋洋的，带点笑意` into at most two of
`MOOD_TAGS` (happy, gentle, lazy, pout, wry, shy, sad, angry, surprised, thinking, gloom), in a
fixed precedence: Chinese keywords match anywhere, except `哭` inside `哭笑不得`, and English ones
as whole words. `DEFAULT_MOOD_EXPRESSIONS` maps each to the standard expression ids PSD2Live gives
a generated rig (`smile`, `sleepy`, `angry`, `sad`, `shy`, `surprised`, `gloom`); lazy and happy
together show sleepy and smile. `soundCueEffect(name)` decides every cue in `CUE_EMOJI`.

### Mouth and framing

- **`mouthCurve(dbFrames, o?)`** turns loudness into a mouth opening: a loudness map from -40 to
  -10 dBFS, weighed against the last 0.25 s's peak and 0.12 s's dip so the mouth shuts between
  syllables, then an attack and release envelope (`MOUTH_CURVE`). Tuned on her Fish voice, it shut
  the mouth on 25% of voiced frames, 1.6 times a second, where the loudness map alone gave 0.46.
- **`new MouthMeter(trackOrStream, {context?, curve?})`** reads a track through an AnalyserNode
  that reaches no speaker, as float samples; the stage reads it each frame. An AudioContext made
  outside a click starts suspended, so make it in the click that starts the call.
- **Framing** works in the rig's canvas pixels: `bustBox(head, character)` (the head 42% of the
  height, its centre 40% down, 4:5), `companionBox(character)` (all of her with 4% around),
  `viewFor(box, rig, element)` (the player's view containing it), and `panBox` and `zoomBox` for
  an editor.

### Licenses and the pack

- **PSD2Live's player is ported, its runtime vendored, both MIT.** `src/avatar/psd2live/rig.ts`
  and `renderer.ts` are ported from PSD2Live's `p2l.js` and keep its MIT header; the SDK keeps
  `LICENSE-psd2live` and `THIRD_PARTY.md`, and `NOTICE` names the holder. The bundle drops
  comments, so the pack carries the license files whole. PSD2Live's editor is GPL-3.0 and none of
  it is here.
- **The pack** holds `dist/avatar/index.js` (one bundle, for browsers and Node alike),
  `dist/avatar/index.d.ts`, `dist/avatar/wasm/` (`p2l_runtime.wasm`, its `LICENSE` and
  `THIRD_PARTY_LICENSES.md`), and `LICENSE-psd2live` and `THIRD_PARTY.md` beside the AGPL
  `LICENSE`. Bun keeps the runtime's `new URL` as written and copies nothing, so the build copies
  `wasm/` beside the bundle, and `checkAssetUrls` fails a pack whose bundle names a file that
  isn't there.

---

## Building and releasing

```bash
bun run build:sdk     # bundles dist/index.js, dist/react/index.js, dist/avatar/index.js and its runtime + .d.ts into packages/sdk/pack/
bun run pack:sdk      # stages packages/sdk/pack/ and packs laplace.live-eidolon-sdk-<version>.tgz
```

`@laplace.live/eidolon-sdk` is versioned and tagged independently from the `laplace-eidolon` /
`@laplace.live/eidolon` fixed group ([releasing.md](releasing.md)). Name `@laplace.live/eidolon-sdk`
in a changeset whenever a change affects the published SDK.
