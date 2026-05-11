# laplace-avatar — frontend

Minimal React + Vite UI for the laplace-avatar Pipecat bot. Uses
`@pipecat-ai/client-react` + `@pipecat-ai/small-webrtc-transport` to
hit the bot's `/api/offer` SDP signaling endpoint directly.

## Dev

```bash
cd frontend
pnpm install
pnpm dev
```

Then in another terminal, run the bot:

```bash
cd ../server
uv run bot.py            # listens on http://localhost:7860
```

Open http://localhost:5173. The Vite dev server proxies `/api`,
`/start`, and `/sessions` to `:7860` (see `vite.config.ts`), so the
client speaks to the bot as same-origin requests — no CORS dance.

## Build

```bash
pnpm build      # → dist/
pnpm preview    # serve the dist for a quick smoke test
```

For production, set `VITE_PIPECAT_BOT_URL` at build time if the
frontend and bot are served from different origins; leave it blank if
they share one (recommended — the reverse proxy fronts both and you
get a single TLS cert with no CORS to manage).

## Files of interest

| File | What it does |
|---|---|
| `src/App.tsx` | Constructs the `PipecatClient` once, wires `SmallWebRTCTransport`, mounts `<PipecatClientProvider>` and `<PipecatClientAudio />`. |
| `src/VoiceBot.tsx` | All UI: connect/disconnect, mic mute, status pill, live transcript via `usePipecatConversation`. |
| `vite.config.ts` | Dev proxy → `localhost:7860`. |

## Customizing

- **Different bot URL**: set `VITE_PIPECAT_BOT_URL=http://192.168.1.50:7860` in `.env` (dev override) or as a build-time env var (production).
- **TURN servers**: edit `iceServers` in `App.tsx`. The default is Google's public STUN, which is fine for testing on the same LAN but won't traverse symmetric NATs. Add your TURN URLs + creds for production.
- **System / kickoff messages**: the bot's `persona.md` and `bot.py` `on_client_ready` handler control the greeting. Don't try to inject a system prompt from the client.

## References

- [Pipecat React SDK overview](https://docs.pipecat.ai/api-reference/client/react/overview)
- [Pipecat React hooks](https://docs.pipecat.ai/api-reference/client/react/hooks)
- [`@pipecat-ai/small-webrtc-transport` README](https://github.com/pipecat-ai/pipecat-client-web-transports/tree/main/transports/small-webrtc-transport)
