# The TypeScript port

A Bun/TypeScript rewrite of the bot, built on [pipedog](https://github.com/polvallverdu/pipedog) (a
TypeScript port of Pipecat) and living beside the Python runtime in this repo. It has been the
production bot since 2026-11-04; the Python bot is kept, as `ghcr.io/laplace-live/eidolon-python`,
until it is retired. Its behavioral spec is the Python code: where the two disagree and no decision below says
otherwise, Python is right.

## Layout

Bun workspaces, one package per subsystem. Dependencies point down this list; nothing below
`runtime` imports pipedog, and `core` imports nothing.

| Package | Owns | Python counterpart |
| --- | --- | --- |
| `packages/core` | the extension contracts: `ContextProvider`, `LlmTool`, `ConversationContext` | — |
| `packages/config` | `.env` loading (python-dotenv rules), env readers (`env_int` rules), the logger, Python-compat helpers, paths, the persona clock | `env.py`, `openrouter.py` |
| `packages/access` | `loginSyncToken` validation, quotas, client IP, CORS, the `/api/offer` guard, audio quality | `user_context.py`, `rate_limit.py`, `offer_middleware.py`, `audio_quality.py` |
| `packages/turn` | Cloudflare TURN credentials, ICE plans, relay-only candidate rules | `bot.py`'s ICE code |
| `packages/retrieval` | the LanceDB read path: jieba (pure TS, same dictionary), hybrid search, RRF and the reranker, stream dates and the catalog | `retrieval.py`, `retriever.py`, `embeddings.py` |
| `packages/memory` | Mem0's engine over Qdrant: same payloads, same `history.db` | `mem0_local.py`, `memory_service.py` |
| `packages/context` | the retrieval gate, both RAG providers, the recall tool, the system instruction, the greeting | `retrieval_gate.py`, `stream_archive.py`, `persona_facts.py`, `bot.py` |
| `packages/tools`, `packages/imagegen` | `change_voice_style`, `take_selfie`, the selfie store | `voice_switching.py`, `image_generation.py` |
| `packages/runtime` | the only pipedog importer: the pipeline, adapters from `core` contracts to pipedog, WebRTC signalling | `bot.py` |
| `apps/bot` | `Bun.serve`, the routes, MCP, the entry point | `bot.py`, `mcp_server.py`, `memory_admin.py` |
| `apps/cli` | `laplace-search`, `laplace-eval-retrieval`, `laplace-generate-image`, the gate benchmark | `tools/` (query side only) |

A new context tier implements `ContextProvider`; a new LLM tool implements `LlmTool`. Neither
touches pipedog: `packages/runtime` adapts both. Clients (the `/ai` page today; Electron or Expo
later) talk to `apps/bot` over the same HTTP and RTVI contract the Python bot serves.

The offline chain (download, transcribe, refine, ingest) stays Python. Both runtimes read the
same `data/lancedb` and the same Qdrant collection. Mem0's `history.db` has the same schema, but
the compose `bot-ts` service keeps its own volume, so each runtime's change log records only its own events.

## Commands

```bash
bun install
bun run dev --port 7861               # watch mode, beside the Python bot on :7860
bun run start                         # no watch
bun run typecheck && bun run lint && bun run test
bun run laplace-search "奶绿最喜欢喝什么"
bun run laplace-eval-retrieval        # same flags and output as the Python CLI
bun run laplace-generate-image        # billed per image
bun run gate-decisions                # billed; rewrites decisions.json like decisions.py
docker compose --profile ts up --build   # bot-ts on :7861, beside bot and qdrant
```

CI publishes this image as `ghcr.io/laplace-live/eidolon`, and the Python bot's as
`ghcr.io/laplace-live/eidolon-python`, with the same tags (`edge`, `sha-…`, and `X.Y.Z`, `X.Y`, `X`
per release).

`bun apps/bot/scripts/e2e-call.ts --text` (or `--audio`) holds a real call through headless
Chrome and reports latency per stage; `--base-url` points it at either bot. On a Mac where
headless Chrome is killed after about 30 s, add `--headful`.

## What keeps it working

- **Only `packages/runtime` imports `@pipedog/*`.** Biome's `noRestrictedImports` enforces it.
  Every other package is testable without a pipeline and reusable by another runtime.
- **`bunfig.toml` turns Bun's own `.env` loader off.** `load-env.ts`, the first import of each
  entry point, is the only reader, with python-dotenv's rules. Bun's loader would expand bare
  `$VAR` and read `.env.local`, which the Python bot never did. Tests run with `--no-env-file`.
- **No module reads env at import.** Everything reads at call time, so the order of imports
  against the `.env` load cannot pin a fallback.
- **werift needs four corrections, all in `packages/runtime/src/webrtc/handler.ts`.**
  1. It queries `stun.l.google.com` when no STUN server is configured. That put the origin's
     public IP in every non-relay answer and, where UDP to Google is blocked, stalled every
     answer by its 5 s STUN timeout. It now queries only a server the plan names.
  2. It derives the connection state from ICE alone, so a browser hanging up (a DTLS
     close_notify) went unnoticed until ICE consent expired about 30 s later, with the session
     and its STT/TTS sockets still running. It now disconnects once every DTLS transport closes,
     as aiortc does.
  3. Relay-only uses werift's `"relay"` policy, which gathers nothing but the relay candidate.
  4. werift fills a relay candidate's `raddr` with the TURN server's XOR-MAPPED-ADDRESS, which
     is this host's public IP, so every answer is scrubbed to `raddr 0.0.0.0 rport 0`.
- **ICE servers and the Opus bitrate are set per connection without a pipedog seam.** The
  handler assigns them right before `handleWebRequest`, which builds the connection before its
  first await. The interleaved-offer test locks that ordering in; rerun it on every pipedog bump.
- **Golden fixtures pin the Python behavior.** They were produced by running the Python code
  on the same inputs. A test that fails against one means the port drifted, not the fixture.

## Accepted differences

Deliberate, and not worth matching:

- `PATCH /api/offer` with a malformed body answers 400, where FastAPI answered 422.
- `/`, `/client` and `/start` (the Pipecat demo and its session API) are not served.
- `GET /mcp` answers 405 instead of opening an idle SSE stream; MCP clients fall back.
- JSON key order in MCP envelopes, and some error wording (`JSON Parse error` texts, Bun's
  network error messages), differ.
- The async-tool instructions in the system prompt are pipedog's, which track a newer Pipecat
  than 1.12: a finished `take_selfie` result may be delivered on its own once everything the
  viewer said has been answered.
- Every response, 500s included, carries CORS headers.

## Verified before cutover

On 2026-11-03, against the Python bot on the same machine and the same day:

- **Calls.** Text and audio calls through Chrome pass the same checks as Python (0% CER on the
  spoken question), from the host and from the `bot-ts` compose container.
- **Retrieval.** `laplace-eval-retrieval`'s metrics are identical to Python's, field for field.
- **Retrieval gate.** Same model on the same day: 93/93 recall turns kept and 68/92 chit-chat
  turns skipped by both, with a mean score difference of 0.009.
- **Mem0.** A round trip on a fresh collection in each direction: Python writes and TS reads,
  TS writes and Python reads and searches, TS forgets and Python sees nothing.
- **Relay-only.** Against a real TURN server (coturn), the answer carries only `typ relay`
  candidates with `raddr 0.0.0.0 rport 0`.

In production on 2026-11-04, a text call to eidolon.vrp.moe over Cloudflare TURN passed the same
checks, relay-only (the browser's 12 LAN, CGNAT, Tailscale and ULA candidates dropped), with
offer→connected at 2.8 s.

Still open:

- A logged-in call from the production host, which also confirms that Workers validation
  accepts Bun's User-Agent.
- 2 of 13 local audio calls took about 4 s longer to connect. The browser's ICE connected at
  once, but werift's own ICE reported connected about 4 s later. It never reproduced with
  tracing on, so the cause is unknown. Watch offer→connected on the Cloudflare TURN call, where
  relay-only leaves far fewer candidate pairs than a multi-interface dev machine.
