# @laplace.live/eidolon-sdk

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
