# MCP retrieval server — design

- **Date:** 2026-05-31
- **Status:** Approved (brainstorming), pending implementation plan
- **Author:** brainstormed with Claude

## Context

`laplace-eidolon` is a self-hosted Pipecat voice bot for a streamer roleplay
persona, with hybrid RAG (vector + jieba-tokenized Chinese BM25) over two
LanceDB indexes:

- **persona facts** — hand-compiled atomic facts about the streamer
  ([`PersonaFactsService`](../../../laplace_eidolon/persona_facts.py)).
- **stream archive** — refined transcript chunks from past streams
  ([`StreamArchiveService`](../../../laplace_eidolon/stream_archive.py)).

Both services already expose a stateless `_search(query)` that the
[`laplace-search`](../../../laplace_eidolon/tools/search.py) CLI constructs
standalone (no pipeline, no FrameProcessor) and calls directly. That same
retrieval surface is what we want to expose as an MCP server.

The realtime voice pipeline (STT → LLM → TTS over WebRTC) is **not** exposed
over MCP — MCP is JSON-RPC request/response and cannot carry realtime audio.
Only the text retrieval layer maps to MCP.

## Goals

1. Expose the two existing retrieval indexes as MCP tools over a public,
   anonymously-accessible endpoint.
2. Rate-limit anonymous callers (per IP) to cap embedding + rerank spend.
3. Let a caller pass their existing `loginSyncToken` to receive a **higher**
   (but still finite) rate-limit ceiling. The token grants throughput, not
   data access.
4. Reuse existing building blocks — token validation, IP extraction, and the
   sliding-window quota — rather than reinventing them.

## Non-goals (YAGNI)

- No Mem0 / personalized memory tools. The token does **not** unlock any
  per-user data; anonymous and authenticated callers see identical tools over
  identical public data.
- No persona-as-resource / persona-as-prompt exposure.
- No MCP OAuth 2.1 authorization framework.
- No write/forget/mutating tools — read-only retrieval only.
- No distributed / multi-replica rate limiting (deployment is single-instance,
  matching the existing `rate_limit.py` posture).

## Architecture

### Topology & transport

- New module `laplace_eidolon/mcp_server.py` exposing `install_mcp(app)`,
  called once at startup in [`bot.py`](../../../laplace_eidolon/bot.py),
  mirroring [`install_memory_admin(app)`](../../../laplace_eidolon/memory_admin.py)
  and `install_offer_middleware(app)`.
- A FastMCP **Streamable HTTP** app is mounted at `/mcp` on the same FastAPI
  app the bot already runs. One process, one deploy.
- The two retrieval services are constructed **once** as module singletons at
  install time (standalone, exactly as the `laplace-search` CLI does). Their
  `__init__` opens the LanceDB tables; `_search` is stateless with respect to
  the pipeline, so a singleton is safe and avoids re-opening tables per call.

Rationale for mounting (vs a standalone process): idiomatic to the repo's
`install_X(app)` convention, single deploy unit, reuses the warm
`resolve_user_context` TTL cache and the existing IP-extraction logic, and fits
the single-instance VPS posture described in the README.

### Tool surface

Two separate, read-only tools — one thin wrapper per service. Kept separate
(rather than unified) so the calling LLM gets distinct, well-described tools
and each index keeps its native result shape; no cross-source score merging.

| Tool | Wraps | Key result fields |
| --- | --- | --- |
| `search_persona_facts(query: str, top_k?: int)` | `PersonaFactsService._search` | `date`, text, relevance score |
| `search_streams(query: str, top_k?: int)` | `StreamArchiveService._search` | `stream_date`, text, relevance score |

- `top_k` is optional; omitted → the service's existing default (8 for facts,
  3 for chunks).
- Both strip the bulky `vector` field before returning (the CLI already does
  `h.pop("vector", None)`).
- Results are returned as structured JSON content.
- If a LanceDB table is missing, the tool returns a clear "index not built"
  message rather than erroring — matching the services' existing graceful
  no-op when their table is absent.

### Auth — token → tier resolution

- The `/mcp` endpoint is **open at the protocol level** — no OAuth challenge.
  This is a deliberate divergence from MCP's formal auth framework, justified
  because the token grants throughput, not data access.
- An **optional** `Authorization: Bearer <loginSyncToken>` header is validated
  through the existing
  [`resolve_user_context`](../../../laplace_eidolon/user_context.py), reusing
  [`_extract_bearer_token`](../../../laplace_eidolon/memory_admin.py)'s parsing
  semantics.
  - Valid + logged in (has `.mid`) → **authenticated tier**.
  - Missing / blank / malformed / invalid / expired / logged-out → silently
    treated as **anonymous**. Never an error.

### Rate limiting — two tiers

Reuses the sliding-window quota from
[`rate_limit.py`](../../../laplace_eidolon/rate_limit.py) (already a generic
string-keyed window), instantiated twice:

| Tier | Quota key | Env var | Default |
| --- | --- | --- | --- |
| Anonymous | client IP | `EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR` | 20 / hour |
| Authenticated | Bilibili UID | `EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR` | 120 / hour |

- Window length reuses the existing `EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC` knob
  pattern (a new `EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC`, default 3600).
- Defaults are starting estimates; each search costs one embedding + an
  optional Cohere rerank (~$1/1000 reranks), so these cap spend and are meant
  to be tuned in production.
- Over-limit → the tool returns a **structured MCP tool error** (`isError`)
  whose message includes `retry_after` seconds — not a raw HTTP 429, which MCP
  clients handle poorly.
- Unlike the WebRTC `/api/offer` path (where a valid token bypasses limiting
  entirely), the authenticated MCP tier is still bounded — just higher.

### Request flow

1. A thin Starlette middleware wraps the mounted `/mcp` ASGI app. Once per HTTP
   request it extracts the client IP (reusing the X-Forwarded-For handling in
   [`offer_middleware.py`](../../../laplace_eidolon/offer_middleware.py)) and
   the optional bearer token, resolves the tier, and stores
   `(tier, quota_key)` in a `contextvar`.
2. The MCP handshake calls (`initialize`, `tools/list`) touch no quota.
3. Each search tool handler reads the `contextvar`, calls the matching quota's
   `try_consume`, and either runs the search or returns the rate-limit tool
   error.

This separates "who is this caller" (middleware, per HTTP request) from
"should this specific expensive call proceed" (tool handler, per tool call).
ContextVars set in the outer ASGI layer propagate into the tool handler because
the Streamable-HTTP tool call executes within the same request task.

## Error handling & edge cases

| Condition | Behavior |
| --- | --- |
| LanceDB table missing | Tool returns "index not built" message (no error) |
| No / malformed / invalid / expired token | Treated as anonymous; lower tier |
| Anonymous over IP limit | Tool error with `retry_after` seconds |
| Authenticated over UID limit | Tool error with `retry_after` seconds |
| `resolve_user_context` upstream failure (Workers) | Degrade to the anonymous tier (most restrictive quota); do not 500 the call |

## New files / dependencies / config

- **New file:** `laplace_eidolon/mcp_server.py` (`install_mcp(app)` + tool
  definitions + the two quota singletons + the tier-resolving middleware).
- **Dependency:** add `mcp` (official Python SDK, includes FastMCP) to
  `pyproject.toml` runtime `dependencies`. Not currently in the tree —
  Pipecat's installed extras do not pull it.
- **Config:** add `EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR`,
  `EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR`, and
  `EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC` to `.env.example`.
- **Docs:** add a `/mcp` row to the README endpoint table and a short
  "Public MCP server" subsection.
- **Wiring:** call `install_mcp(app)` in `bot.py` next to the other installers.

## Testing

- **Unit:** tier resolution (anonymous vs valid token vs expired/logged-out
  token); two-tier quota keying (IP key vs UID key, independent windows);
  over-limit produces a tool error carrying `retry_after`.
- **Integration:** FastMCP in-memory client performs `initialize` +
  `tools/list` + a call to each search tool; asserts result shape, the
  `vector` field is stripped, and the index-missing path returns the no-op
  message rather than raising.

## Risks / to verify during planning

- **Reading the HTTP request inside FastMCP.** The chosen mechanism (Starlette
  middleware → `contextvar` → tool handler) is robust regardless of FastMCP
  internals, but the exact mount wiring and contextvar propagation through the
  Streamable-HTTP transport must be verified against the installed `mcp`
  version. FastMCP's own request-context accessor (e.g. a `Context` parameter
  or `get_http_request()`) may simplify this if available.
- **Quota class reuse.** `rate_limit.py`'s class is named `AnonymousIpQuota`
  but is a generic string-keyed window. Confirm reusing it for the UID-keyed
  authenticated tier reads cleanly, or rename/generalize to
  `SlidingWindowQuota` with a back-compat alias.

## References

- [Pipecat docs](https://docs.pipecat.ai/)
- MCP Streamable HTTP transport (official Python SDK / FastMCP)
- Existing surfaces reused: `resolve_user_context`, `_extract_bearer_token`,
  `AnonymousIpQuota`, `StreamArchiveService._search`,
  `PersonaFactsService._search`, `offer_middleware` IP extraction.
