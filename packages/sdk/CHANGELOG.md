# @laplace.live/eidolon-sdk

## 0.4.0

### Minor Changes

- 9bbe563: Tune how far her 2D model turns her head in Appearance's new Motion tab
- 76f362e: Build moods from a 2D model's parameters; she nods and shakes without clips

## 0.3.0

### Minor Changes

- a4e22bc: Add the avatar entry, which draws a PSD2Live model and moves it with a call

## 0.2.0

### Minor Changes

- 096fb88: Send her images and text files in chats, in the app and through the SDK

## 0.1.2

### Patch Changes

- aba36d6: Show her words before a tool call, and give tool events their own window share

## 0.1.1

### Patch Changes

- 9aa9360: Show /api/memories refusals as the server's own message
- 9aa9360: Keep every mic toggle in step, with a new micEnabledUpdated event
- 9aa9360: Cap a voice message's claimed length at two minutes so the server accepts it
- 9a160a7: Keep a redialed call up when the attempt it replaced resumes late
- 9aa9360: Show a live mic swap's error only for the mic the viewer last picked
- 9aa9360: Render EidolonClientProvider and EidolonClientAudio in production React builds
- 9a160a7: Open the mic picked while a call is still starting
- 9aa9360: Reject connect() when a call drops before the bot is ready instead of hanging
- 9aa9360: Finalize short replies in realtime calls
- 9aa9360: Resolve the SDK's types under TypeScript's node module resolution
- 9aa9360: Mark the React entry as a client module so Next.js server components can import it
- 9aa9360: Keep the chosen mic when a picker remounts or a preference is applied mid-call
- 9aa9360: Keep her reply in one piece when a typed line interrupts it
- 9aa9360: Report a chat reply cut off mid-stream as a network ChatRequestError
- 4a2eee2: Reject connect on AudioWorklet setup failure, serialize mic swaps with hangup, reject truncated chat streams, and guard hook state across resets
- 9aa9360: Keep a realtime caller's late transcript with the turn she is answering

## 0.1.0

### Minor Changes

- Publish `@laplace.live/eidolon-sdk` for WebRTC calls and stateless chats
