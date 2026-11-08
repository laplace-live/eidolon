# The Python reference implementation

This is laplace-eidolon's original runtime: the Pipecat bot that ran production until 2026-11-04,
and the offline tools that built its indexes. The TypeScript bot in `apps/` and `packages/` has
replaced both. The Python stays as a reference implementation for anyone who wants to read or run
it, and CI still publishes it as `ghcr.io/laplace-live/eidolon-python`.

It is no longer developed. The project's coding agents never read, run or edit it (`AGENTS.md`,
"The Python"), so a change here is yours to make and to check. The only automated edit is the
release workflow's: `apps/bot/scripts/sync-version.ts` writes each release's version into
`pyproject.toml`, `uv.lock` and `bot.py`.

## Layout

```text
laplace_eidolon/
  bot.py                pipeline + Starlette app; the process entry point
  offer_middleware.py   rate limit, body normalization, preflight for /api/offer
  user_context.py       loginSyncToken → UserContext via the Workers helper API
  audio_quality.py      per-session Opus bitrate from the offer's audioQuality
  persona_facts.py      RAG FrameProcessor over hand-compiled fan facts
  stream_archive.py     RAG FrameProcessor over refined stream transcripts
  retriever.py          one LanceDB table: handle, stale-reopen, search
  retrieval.py          hybrid search — vector + jieba FTS + optional rerank
  retrieval_gate.py     Jev decides per turn whether both RAG services search
  embeddings.py         embedding client, LanceDB table access, disk cache
  voice_switching.py    the change_voice_style LLM tool and its styles
  image_generation.py   the take_selfie LLM tool, its prompt, and /api/selfie
  mcp_server.py         public read-only MCP server mounted at /mcp
  mem0_local.py         self-hosted Mem0 config — embedded engine over Qdrant
  memory_service.py     Mem0 subclass · memory_admin.py serves /api/memories
  rate_limit.py         per-IP sliding-window quota · env.py numeric env vars
  openrouter.py         attribution headers + usage-cost extraction
  tools/                the offline chain, one console script per stage
tests/                  pytest — no network, no LanceDB
```

The golden generators under `apps/*/test/fixtures/` and `packages/*/test/fixtures/` (`*.py`) and
the scripts beside some benchmarks in `docs/benchmarks/` are Python too. They printed the
fixtures and results the TypeScript was first checked against.

## Commands

```bash
uv sync                                # runtime deps
uv sync --extra tools                  # + faster-whisper, soniox (offline only)
uv run python -m laplace_eidolon.bot   # the Python bot on :7860 — NOT a console script

uv run ruff check .                    # lint — import sorting only, line length 100
uv run pyright                         # types
uv run pytest                          # tests
docker compose up --build              # Python bot + Qdrant; --profile ts adds the TS bot on :7861
```

The bot is deliberately not a `laplace-*` console script: Pipecat's runner discovers `bot()`
through `sys.modules["__main__"]`, which a generated launcher doesn't satisfy. Everything under
`tools/` is one, named like its TypeScript command (`uv run laplace-pipeline`, …). They default to
the checkout's `data/`, `streams/` and `vods/`, which no longer hold any sources, and read the
environment only, not the settings files. Two exist only in Python:

```bash
uv run laplace-export-mem0       # dump a pre-migration Mem0 cloud account to JSON
uv run laplace-import-mem0       # load that dump into a Qdrant; idempotent, resumable
```

The bot serves Pipecat's `/start` session API, and its bundled demo UI (`/`, `/client`) only with
`EIDOLON_PIPECAT_DEMO_ENABLED`. It allows every CORS origin, whatever `PIPECAT_ALLOWED_ORIGINS`
says, and reads each role's provider-named variables only (`SONIOX_MODEL`, `OPENROUTER_MODEL`, …).

## Which checks to run

| You changed | Run |
| --- | --- |
| any Python file | `uv run ruff check .` and `uv run pyright` |
| `mcp_server.py`, `rate_limit.py`, or `user_context.py` | `uv run pytest` — the suite covers the MCP mount and its quotas, nothing else |
| `image_generation.py` | `uv run laplace-generate-image` against a real reference — it shares `generate()` with the bot, so a successful render is the check. Billed per image |
| `retrieval_gate.py`'s questions, state, or threshold, or `RETRIEVAL_GATE_MODEL` | `uv run python docs/benchmarks/2026-09-19-retrieval-gate/decisions.py` — exits non-zero if any labeled turn that needs recall would be skipped |
| the persona prompt's 表演提示 markup, or `FISH_MODEL` | `uv run python docs/benchmarks/2026-10-17-drama-3-markup/render.py` (add `--model` for another model) — any `leaked` entry in its results means markup is read aloud. Billed per character |
| `mem0_local.py`, `memory_service.py`, or `memory_admin.py` | `docker compose up qdrant`, then round-trip a real store → search → delete. No test covers Mem0; it needs a live vector store and an embedding key |
| the bot's pipeline, the transport, or a monkey-patch | boot the bot and hold a real call (`bun apps/bot/scripts/e2e-call.ts --text`, or `--audio`) — none of this is unit-testable |

## Rules

Things you would break without being told.

### Runtime

- **Optional dependencies fail open, never loud.** Mem0, both RAG services, the reranker, the
  retrieval gate, and the LanceDB tables are each wrapped in a try/except that logs and continues.
  A new optional tier follows that shape or it breaks fresh checkouts.
- **The retrieval gate may cancel a search, never delay one.** `unless_skipped` starts the search
  at once and drops it only if Jev answers "skip" first. Awaiting the gate before searching would
  add its ~0.5 s to every recall turn, and its whole timeout to every turn while Jev is down.
- **`load_dotenv(override=True)` runs before any other import that reads `os.getenv`.**
  Module-level constants evaluate at import time, so a deferred load pins them to their
  fallbacks. This is why `bot.py` has imports below statements, and why it is exempt from
  `from __future__ import annotations`.
- **An empty env var is not unset.** python-dotenv parses `KEY=` as `""`, so
  `int(os.getenv("X", "60"))` crashes on a plain `.env.example` copy. Every numeric env read goes
  through `env.env_int` / `env.env_float`; for strings use `os.getenv("X") or "default"`.
- **Pure ASGI middleware, never `BaseHTTPMiddleware`.** Starlette's version doesn't catch
  `BaseException`, so a client disconnect surfaces as a 500, and its response hard-codes
  `background = None`, silently dropping the background task that actually starts the bot.
  `repro_no_response.py`, at the repository root, reproduces both.
- **Pipecat exposes no seam for ICE servers or Opus bitrate**, so `bot.py` monkey-patches
  `SmallWebRTCConnection.__init__` and `OpusEncoder.__init__` at import. Both are load-bearing;
  the per-session bitrate reaches the encoder through a `ContextVar` set in the offer middleware.
- **With TURN configured, the server gathers relay candidates only** — a third monkey-patch, on
  `aiortc.rtcicetransport.connection_kwargs`. It keeps the origin's IP out of every SDP, which
  the Cloudflare proxy cannot do because media never traverses it. `TransportPolicy.RELAY`
  suppresses only the host candidate, so the patch also drops the STUN server; restoring it
  re-exposes the origin through a server-reflexive candidate.
- **`install_mcp` is not idempotent** — it wraps the app lifespan, and a second call makes
  `session_manager.run()` raise at startup. Same for `install_offer_middleware`,
  `install_memory_admin`, and `install_selfie_route`: once each, at startup.
- **`OpenRouterImageGenService` must never go in the pipeline.** The `ImageGenService` base it
  inherits generates an image from every `TextFrame` it sees, and this pipeline streams one per
  sentence into TTS — adding it to `Pipeline([...])` bills an image per sentence spoken. The
  `take_selfie` handler calls `run_image_gen` directly instead.
- **The persona's reference images are mutually exclusive outfits — exactly one reaches a
  render.** Hand the model two and it draws two of her. `select_outfit` picks one by the hour,
  behind `reference_sources`, the choke point the bot and `laplace-generate-image` share.

### Identity and quotas

- **Never trust token presence — always `resolve_user_context`.** An unvalidated string would let
  anyone skip the anonymous quota and spawn a full STT+LLM+TTS pipeline per probe. Validation
  fails open to anonymous, and every caller shares one 60s TTL cache.
- **Branch on `UserContext.is_logged_in`, never on field truthiness.** `face` is legitimately
  absent for some logged-in viewers.
- **Mem0 is self-hosted and runs embedded, not as a service.** `MemoryClient` cannot reach it: it
  demands a cloud key and validates it against a `/v1/ping/` only the platform serves. Every
  caller — the pipeline and `/api/memories` alike — builds its engine from
  `mem0_local.build_local_config()`, so a new one does too.

### Retrieval and the persona

- **FTS runs over the jieba-tokenized `tokens` column, never raw text**, and every query goes
  through `retrieval.tokenize_zh_query`. Stopwords are stripped from queries only.
- **`retrieval.py` is the one search path.** The bot, the MCP server, and the eval all go through
  it. The first two reach it via `retriever.LanceRetriever`, which adds only the table handle and
  the stale-reopen retry — never scoring.
- **`_build_persona_prefix` layers only per-session facts** on top of the persona's prompt —
  current date, viewer name, recent stream dates, available voice styles.
- **`change_voice_style` is named once, as `_TOOL_NAME` in `voice_switching.py`.** It reaches the
  prompt through `persona_prefix_hint` — rename it in that one place.
- **`@mcp.tool()` docstrings and `Field(description=...)` strings are live API surface** —
  FastMCP ships them to the model. Editing one changes runtime behavior.

### Style

- `from __future__ import annotations` at the top of every module. The exceptions are `bot.py`
  and the two `__init__.py` files.
- PEP 604/585 syntax: `str | None`, `dict[str, Any]`, `list[float]`.
- Type hints on everything. They carry the load that docstrings otherwise would.
- Line length 100. Ruff enforces import sorting and pyflakes (`select = ["I", "F"]`) and nothing
  else, so the rest is on you.

### Comments and docstrings

The comment policy is the repository's ([`docs/comments.md`](../docs/comments.md)); what is
particular to Python:

- **Docstrings:** a one-line summary. Add `Args:`/`Returns:` only for a parameter whose contract
  isn't obvious from its name and type; self-evident functions get none. Plain prose,
  Google-style sections; double-backtick literals are fine. Pydantic attribute docstrings are
  inert (`use_attribute_docstrings` is off), so trim them like any other comment.
- **Never touch** `# type: ignore`, `# noqa`, `# pragma: no cover`, `TODO`/`FIXME`, or license
  headers. No RST section headers or Sphinx roles: nothing here builds Sphinx docs.
- **Verify a comment-only sweep:** parse each file before and after, strip every bare
  string-literal statement, and compare `ast.dump()`. Comments never enter the AST, so an
  identical tree means only prose moved. It will not catch the `@mcp.tool()` docstrings above,
  which are real API surface.
