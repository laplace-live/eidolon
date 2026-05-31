# MCP Retrieval Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the project's two existing LanceDB retrieval indexes (persona facts + stream archive) as a public, anonymously-accessible MCP server, where an optional `loginSyncToken` raises the caller's rate-limit ceiling.

**Architecture:** A FastMCP **Streamable HTTP** app is mounted at `/mcp` on the bot's existing FastAPI app via `install_mcp(app)` (mirroring `install_memory_admin`). Two read-only async tools wrap the services' existing `_search()`. A pure-ASGI middleware wrapping the mount resolves a rate-limit tier (anonymous-by-IP vs authenticated-by-UID) once per HTTP request and stores it in a `contextvar` the tools read. FastMCP's session-manager lifespan is folded into the parent app's lifespan (a Mount does not run a sub-app's lifespan).

**Tech Stack:** Python 3.10+, `mcp` SDK 1.27.x (FastMCP), FastAPI/Starlette (via Pipecat), LanceDB, `pytest`, Starlette `TestClient`.

**Design spec:** [docs/superpowers/specs/2026-05-31-mcp-retrieval-server-design.md](../specs/2026-05-31-mcp-retrieval-server-design.md)

---

## Verified facts this plan relies on (already checked against the installed code/SDK)

- `mcp==1.27.2` is installed. `FastMCP(name, *, stateless_http, json_response, streamable_http_path, transport_security, instructions)`; `@mcp.tool()` decorates async funcs; return-type `dict[str, Any]` populates `structuredContent` directly; `raise ToolError(msg)` → result `isError: true` with text `"Error executing tool <name>: <msg>"`.
- `mcp.streamable_http_app() -> Starlette` builds a `Route(streamable_http_path, ...)` and runs the session manager via its **own** lifespan `lambda app: self.session_manager.run()`. `handle_request()` raises if that task group never started — **even in stateless mode** — so the parent app must run `mcp.session_manager.run()`.
- DNS-rebinding/Host protection is **on by default with an empty allowlist** (rejects every Host → `421`). Must be configured or disabled.
- Mounting the streamable app at `/mcp` with `streamable_http_path="/"` serves a clean `200` at **`/mcp/`** (and `/mcp` → `307` → `/mcp/`). `Mount("/mcp")` isolates routing; mounting at `""` would shadow Pipecat's routes (rejected).
- A `contextvar` set in an outer ASGI middleware **is readable inside the tool handler** (stateless tool dispatch runs in the request task). Verified end-to-end.
- Pipecat's runner combines lifespans via `_add_lifespan_to_app`, so wrapping `app.router.lifespan_context` at bot import time coexists with Pipecat's WebRTC lifespan.
- Reusable existing symbols: `PersonaFactsService` / `StreamArchiveService` (`__init__(*, db_path=DEFAULT_DB_PATH, table_name=..., params=None)`, `async _search(query) -> list[dict]`, `_table` is `None` when the index is missing); `DEFAULT_DB_PATH = "data/lancedb"` (`embeddings.py`); `resolve_user_context(token) -> UserContext(mid, uname, face, is_logged_in)` (`user_context.py`); `_extract_bearer_token(auth_header)` (`memory_admin.py`); `_resolve_client_ip_from_scope(scope)` (`offer_middleware.py`); `AnonymousIpQuota(max_per_window, window_seconds)` + `async try_consume(key) -> RateLimitResult(allowed, remaining, retry_after_seconds)` + `_env_int(name, default)` (`rate_limit.py`).
- Persona-fact hit fields: `text`, `date`, `source`, `_relevance_score`/`_distance`, `vector`. Stream-chunk hit fields: `stream_date`, `details`, `summary`, `text`, `topics` (JSON string), `_relevance_score`/`_distance`, `vector`.
- `bot.py`: `from pipecat.runner.run import app as pipecat_app`; installers called at module load (`install_offer_middleware(pipecat_app)` line 364, `install_memory_admin(pipecat_app)` line 371).

## File Structure

- **Create** `laplace_eidolon/mcp_server.py` — the entire MCP server: projections, tier middleware, quotas, the two tools, and `install_mcp(app)`. One responsibility (expose retrieval over MCP); ~210 lines.
- **Create** `tests/test_mcp_server.py` — projection unit tests + `TestClient` integration tests.
- **Modify** `pyproject.toml` — add `mcp` runtime dep, `pytest` dev dep, `[tool.pytest.ini_options]`.
- **Modify** `laplace_eidolon/bot.py` — import + call `install_mcp(pipecat_app)`.
- **Modify** `.env.example` — four `EIDOLON_MCP_*` vars.
- **Modify** `README.md` — `/mcp` endpoint row + a "Public MCP server" subsection.

---

## Task 1: Dependencies + pytest config

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: Add the `mcp` runtime dependency**

In `pyproject.toml`, find the end of `[project].dependencies`:

```toml
    "cohere>=5.13.0",
]
```

Replace with:

```toml
    "cohere>=5.13.0",
    # Official Model Context Protocol SDK (includes FastMCP). Powers the
    # public Streamable HTTP retrieval server mounted at /mcp.
    "mcp>=1.27.2",
]
```

- [ ] **Step 2: Add `pytest` to the dev group and configure test discovery**

Find:

```toml
dev = [
    "pyright>=1.1.404,<2",
    "ruff>=0.12.11,<1",
]
```

Replace with:

```toml
dev = [
    "pyright>=1.1.404,<2",
    "pytest>=8.0,<9",
    "ruff>=0.12.11,<1",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 3: Sync the environment**

Run: `uv sync`
Expected: resolves and installs `mcp` and `pytest` (and updates `uv.lock`), exit 0.

- [ ] **Step 4: Verify the toolchain imports**

Run: `uv run python -c "import mcp, pytest; from mcp.server.fastmcp import FastMCP; from mcp.server.fastmcp.exceptions import ToolError; print('ok')"`
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "build: add mcp SDK + pytest for the MCP retrieval server"
```

---

## Task 2: Projection helpers + unit tests

Pure functions that turn raw LanceDB hits into compact, LLM-facing dicts (dropping the embedding `vector` and internal bookkeeping). Created first so the rest of the module builds on a tested base.

**Files:**
- Create: `laplace_eidolon/mcp_server.py`
- Create: `tests/test_mcp_server.py`

- [ ] **Step 1: Write the failing projection tests**

Create `tests/test_mcp_server.py`:

```python
"""Tests for the public MCP retrieval server.

Integration tests drive the mounted Streamable HTTP app through Starlette's
TestClient (synchronous — it runs the ASGI app + lifespan in a background
portal, so no pytest-asyncio is needed). Fake services + tiny quotas are
injected via install_mcp's keyword args, so tests need neither LanceDB nor
the network.
"""

from __future__ import annotations

import json
from typing import Any

from laplace_eidolon.mcp_server import _project_chunk, _project_fact

FACT_HIT = {
    "text": "她喜欢喝奶茶",
    "date": "2025-05-09",
    "source": "设定集",
    "_relevance_score": 0.92,
    "vector": [0.1, 0.2],
}
CHUNK_HIT = {
    "stream_date": "2025-05-09",
    "details": "聊了新游戏",
    "summary": "游戏",
    "text": "raw transcript",
    "topics": json.dumps(["游戏", "杂谈"]),
    "_relevance_score": 0.81,
    "vector": [0.3],
}


def test_project_fact_keeps_text_date_score_and_drops_vector():
    out = _project_fact(FACT_HIT)
    assert out == {"text": "她喜欢喝奶茶", "date": "2025-05-09", "score": 0.92}
    assert "vector" not in out


def test_project_chunk_prefers_details_and_decodes_topics():
    out = _project_chunk(CHUNK_HIT)
    assert out["stream_date"] == "2025-05-09"
    assert out["content"] == "聊了新游戏"  # details beats summary/text
    assert out["topics"] == ["游戏", "杂谈"]
    assert out["score"] == 0.81
    assert "vector" not in out


def test_project_chunk_falls_back_to_summary_then_text():
    assert _project_chunk({"summary": "s", "text": "t"})["content"] == "s"
    assert _project_chunk({"text": "t"})["content"] == "t"
    assert _project_chunk({"text": "t"})["topics"] == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_mcp_server.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'laplace_eidolon.mcp_server'`.

- [ ] **Step 3: Create the module with the projection helpers**

Create `laplace_eidolon/mcp_server.py`:

```python
"""Public, anonymously-accessible MCP server over the retrieval indexes.

Mounts a FastMCP Streamable HTTP app at /mcp on the bot's FastAPI app,
exposing two read-only tools — ``search_persona_facts`` and
``search_streams`` — over the same LanceDB indexes the voice pipeline uses.

Anonymous callers are rate-limited per client IP. A caller presenting a valid
``Authorization: Bearer <loginSyncToken>`` is rate-limited per Bilibili UID at
a higher ceiling. The token grants throughput only — both tiers see identical
tools over identical public data (no Mem0, no per-user content).

Why mounted (not a standalone process): reuses ``resolve_user_context``'s warm
TTL cache, the offer middleware's IP extraction, and the single-instance
deployment posture. ``install_mcp(app)`` mirrors ``install_memory_admin(app)``.
"""

from __future__ import annotations

import json
from typing import Any


def _score_of(hit: dict[str, Any]) -> float | None:
    """Relevance score regardless of which retrieval path produced the hit.

    Reranked/hybrid hits carry ``_relevance_score`` (higher = better); the
    unreranked vector path carries ``_distance`` (lower = better). Returns
    ``None`` when neither is present.
    """
    if hit.get("_relevance_score") is not None:
        return float(hit["_relevance_score"])
    if hit.get("_distance") is not None:
        return float(hit["_distance"])
    return None


def _project_fact(hit: dict[str, Any]) -> dict[str, Any]:
    """Project a persona-facts row to the LLM-facing fields, dropping the
    embedding vector and internal bookkeeping."""
    return {
        "text": (hit.get("text") or "").strip(),
        "date": hit.get("date") or None,
        "score": _score_of(hit),
    }


def _project_chunk(hit: dict[str, Any]) -> dict[str, Any]:
    """Project a stream-archive row. Content prefers the refined narrative
    (``details``) over the v1 ``summary`` over the raw ``text`` — the same
    priority ``StreamArchiveService._format_chunks`` renders for the bot."""
    content = (hit.get("details") or hit.get("summary") or hit.get("text") or "").strip()
    topics: list[str] = []
    topics_raw = hit.get("topics") or ""
    if topics_raw:
        try:
            decoded = json.loads(topics_raw)
            if isinstance(decoded, list):
                topics = [str(t) for t in decoded]
        except json.JSONDecodeError:
            topics = []
    return {
        "stream_date": hit.get("stream_date") or None,
        "content": content,
        "topics": topics,
        "score": _score_of(hit),
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_mcp_server.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add laplace_eidolon/mcp_server.py tests/test_mcp_server.py
git commit -m "feat(mcp): add LanceDB hit projection helpers with tests"
```

---

## Task 3: Server assembly (tools, tier middleware, quotas, install_mcp) + integration tests

**Files:**
- Modify: `laplace_eidolon/mcp_server.py`
- Modify: `tests/test_mcp_server.py`

- [ ] **Step 1: Write the failing integration tests**

Append to `tests/test_mcp_server.py`:

```python
import laplace_eidolon.mcp_server as mcp_server
from laplace_eidolon.mcp_server import install_mcp
from laplace_eidolon.rate_limit import AnonymousIpQuota
from laplace_eidolon.user_context import UserContext
from fastapi import FastAPI
from starlette.testclient import TestClient

ACCEPT = "application/json, text/event-stream"


class FakeService:
    """Stand-in for PersonaFactsService / StreamArchiveService. ``_table``
    None mimics a missing index; otherwise ``_search`` returns canned hits."""

    def __init__(self, hits: list[dict[str, Any]], *, has_table: bool = True):
        self._table = object() if has_table else None
        self._hits = hits

    async def _search(self, query: str) -> list[dict[str, Any]]:
        return self._hits


def _build_client(*, anon_max=5, auth_max=50, facts=None, streams=None) -> TestClient:
    app = FastAPI()
    install_mcp(
        app,
        persona_facts=facts if facts is not None else FakeService([FACT_HIT]),
        stream_archive=streams if streams is not None else FakeService([CHUNK_HIT]),
        anon_quota=AnonymousIpQuota(anon_max, 3600),
        auth_quota=AnonymousIpQuota(auth_max, 3600),
    )
    return TestClient(app)


def _rpc(client, method, params=None, _id=1, token=None):
    headers = {"Content-Type": "application/json", "Accept": ACCEPT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        body["params"] = params
    if _id is not None:
        body["id"] = _id
    # Mount is at /mcp with streamable_http_path="/", so the clean 200 path
    # is "/mcp/" ("/mcp" 307-redirects to it).
    return client.post("/mcp/", json=body, headers=headers)


def _call_tool(client, name, arguments=None, *, token=None, _id=1):
    return _rpc(
        client, "tools/call", {"name": name, "arguments": arguments or {}}, _id=_id, token=token
    )


def test_tools_list_exposes_both_search_tools():
    with _build_client() as client:
        r = _rpc(client, "tools/list", {})
        names = {t["name"] for t in r.json()["result"]["tools"]}
        assert names == {"search_persona_facts", "search_streams"}


def test_search_persona_facts_returns_projected_results():
    with _build_client() as client:
        result = _call_tool(client, "search_persona_facts", {"query": "奶茶"}).json()["result"]
        assert result["isError"] is False
        sc = result["structuredContent"]
        assert sc["count"] == 1
        assert sc["results"][0] == {"text": "她喜欢喝奶茶", "date": "2025-05-09", "score": 0.92}


def test_search_streams_returns_projected_chunks():
    with _build_client() as client:
        result = _call_tool(client, "search_streams", {"query": "游戏"}).json()["result"]
        sc = result["structuredContent"]
        assert sc["count"] == 1
        assert sc["results"][0]["content"] == "聊了新游戏"
        assert sc["results"][0]["topics"] == ["游戏", "杂谈"]


def test_missing_index_returns_note_not_error():
    with _build_client(facts=FakeService([], has_table=False)) as client:
        result = _call_tool(client, "search_persona_facts", {"query": "x"}).json()["result"]
        assert result["isError"] is False
        assert result["structuredContent"]["count"] == 0
        assert "not built" in result["structuredContent"]["note"]


def test_anonymous_rate_limit_blocks_after_quota():
    with _build_client(anon_max=2) as client:
        assert _call_tool(client, "search_streams", {"query": "a"}, _id=1).json()["result"]["isError"] is False
        assert _call_tool(client, "search_streams", {"query": "b"}, _id=2).json()["result"]["isError"] is False
        blocked = _call_tool(client, "search_streams", {"query": "c"}, _id=3).json()["result"]
        assert blocked["isError"] is True
        assert "Rate limit exceeded for anonymous" in blocked["content"][0]["text"]


def test_valid_token_uses_higher_authenticated_tier(monkeypatch):
    async def fake_resolve(token):
        return UserContext(mid=12345678, uname="奶绿粉丝", is_logged_in=True)

    monkeypatch.setattr(mcp_server, "resolve_user_context", fake_resolve)
    # anon quota is 2, auth quota is 50: five token-bearing calls all succeed.
    with _build_client(anon_max=2, auth_max=50) as client:
        for i in range(5):
            result = _call_tool(
                client, "search_streams", {"query": f"q{i}"}, token="good-token", _id=i + 1
            ).json()["result"]
            assert result["isError"] is False
```

- [ ] **Step 2: Run the integration tests to verify they fail**

Run: `uv run pytest tests/test_mcp_server.py -q`
Expected: FAIL — `ImportError: cannot import name 'install_mcp'` (projection tests still pass).

- [ ] **Step 3: Add imports and constants to the module**

In `laplace_eidolon/mcp_server.py`, replace the import block:

```python
from __future__ import annotations

import json
from typing import Any
```

with:

```python
from __future__ import annotations

import contextlib
import json
import os
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI
from loguru import logger
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.types import Receive, Scope, Send

# These underscore-prefixed helpers are reused as the single source of truth
# for IP extraction, bearer parsing, and env-int parsing — duplicating them
# would risk drift. All live in the same package.
from .embeddings import DEFAULT_DB_PATH
from .memory_admin import _extract_bearer_token
from .offer_middleware import _resolve_client_ip_from_scope
from .persona_facts import PersonaFactsService
from .rate_limit import AnonymousIpQuota, _env_int
from .stream_archive import StreamArchiveService
from .user_context import resolve_user_context

MOUNT_PATH = "/mcp"

# Rate-limit defaults (per hour). Each search costs one embedding + an optional
# Cohere rerank, so these cap spend; tune via env in production. Authenticated
# callers get a higher ceiling but are still bounded (unlike the WebRTC path).
_ANON_DEFAULT_PER_HOUR = 20
_AUTH_DEFAULT_PER_HOUR = 120
_DEFAULT_WINDOW_SEC = 3600
```

- [ ] **Step 4: Append the tier plumbing, quotas, transport security, and `install_mcp`**

Append to the end of `laplace_eidolon/mcp_server.py`:

```python
@dataclass(frozen=True)
class _CallerTier:
    """Which quota + key applies to the current request. Set by the
    middleware, read by the rate-limit guard inside each tool."""

    quota: AnonymousIpQuota
    key: str
    name: str  # "anonymous" | "authenticated" — used in the over-limit message


# Resolved once per HTTP request by _TierMiddleware; read inside the tools.
_caller: ContextVar[_CallerTier | None] = ContextVar("mcp_caller", default=None)


def _build_quota(per_hour_env: str, default_per_hour: int) -> AnonymousIpQuota:
    return AnonymousIpQuota(
        max_per_window=_env_int(per_hour_env, default_per_hour),
        window_seconds=_env_int("EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC", _DEFAULT_WINDOW_SEC),
    )


def _transport_security_from_env() -> TransportSecuritySettings:
    """Configure DNS-rebinding / Host-header protection.

    FastMCP enables it by default with an empty allowlist (rejects every
    Host). Behind a TLS-terminating reverse proxy the Host is the public
    domain, so set ``EIDOLON_MCP_ALLOWED_HOSTS=host1,host2`` to allow them.
    Unset → protection disabled (rely on the proxy), which keeps a fresh
    checkout runnable on localhost.
    """
    raw = (os.getenv("EIDOLON_MCP_ALLOWED_HOSTS") or "").strip()
    if not raw:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)
    hosts = [h.strip() for h in raw.split(",") if h.strip()]
    origins = [f"https://{h}" for h in hosts] + [f"http://{h}" for h in hosts]
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=hosts,
        allowed_origins=origins,
    )


def _authorization_from_scope(scope: Scope) -> str | None:
    """Pull the raw Authorization header value out of an ASGI scope."""
    for k, v in scope.get("headers", []):
        if k == b"authorization":
            return v.decode("latin-1")
    return None


async def _guard_rate_limit() -> None:
    """Consume one token from the caller's tier quota; raise ToolError when
    the window is exhausted. Called at the top of every search tool, before
    any embedding spend."""
    tier = _caller.get()
    if tier is None:
        # The middleware sets this for every HTTP request before the tool
        # runs. If it is somehow unset, fail closed rather than serve unmetered.
        raise ToolError("Internal error: request tier was not resolved.")
    result = await tier.quota.try_consume(tier.key)
    if not result.allowed:
        raise ToolError(
            f"Rate limit exceeded for {tier.name} access. "
            f"Retry after {result.retry_after_seconds} seconds."
        )


class _TierMiddleware:
    """Pure-ASGI wrapper around the mounted MCP app. Resolves the rate-limit
    tier (anonymous-by-IP vs authenticated-by-UID) once per HTTP request and
    stashes it in the ``_caller`` contextvar for the tool handler.

    A missing/blank/invalid/expired token is silently anonymous — never an
    error. ``resolve_user_context`` is only called when a token is actually
    present (mirrors ``memory_admin._resolve_caller``), so the handshake and
    anonymous calls cost zero Workers round-trips.
    """

    def __init__(
        self, app: Any, *, anon_quota: AnonymousIpQuota, auth_quota: AnonymousIpQuota
    ) -> None:
        self.app = app
        self._anon = anon_quota
        self._auth = auth_quota

    def _anon_tier(self, scope: Scope) -> _CallerTier:
        return _CallerTier(self._anon, _resolve_client_ip_from_scope(scope), "anonymous")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        token = _extract_bearer_token(_authorization_from_scope(scope))
        if token is None:
            tier = self._anon_tier(scope)
        else:
            user = await resolve_user_context(token)
            if user.is_logged_in and user.mid is not None:
                tier = _CallerTier(self._auth, str(user.mid), "authenticated")
            else:
                tier = self._anon_tier(scope)
        # Each ASGI request runs in its own task with a fresh copied context,
        # so this set does not leak across requests.
        _caller.set(tier)
        await self.app(scope, receive, send)


def install_mcp(
    app: FastAPI,
    *,
    persona_facts: PersonaFactsService | None = None,
    stream_archive: StreamArchiveService | None = None,
    anon_quota: AnonymousIpQuota | None = None,
    auth_quota: AnonymousIpQuota | None = None,
) -> None:
    """Mount the Streamable HTTP MCP server at /mcp on ``app``.

    Call exactly once at startup, alongside ``install_offer_middleware`` and
    ``install_memory_admin``. The keyword args exist for tests (inject fakes /
    tiny quotas); production passes none and gets singletons built from the
    default DB path and env-configured limits.

    The endpoint serves at ``/mcp/`` (``/mcp`` 307-redirects to it).
    """
    facts = persona_facts or PersonaFactsService(db_path=DEFAULT_DB_PATH)
    streams = stream_archive or StreamArchiveService(db_path=DEFAULT_DB_PATH)
    anon = anon_quota or _build_quota("EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR", _ANON_DEFAULT_PER_HOUR)
    auth = auth_quota or _build_quota("EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR", _AUTH_DEFAULT_PER_HOUR)

    mcp = FastMCP(
        name="laplace-eidolon",
        instructions=(
            "Retrieval over the streamer 明前奶绿's hand-compiled persona facts "
            "and past live-stream transcripts. Read-only."
        ),
        stateless_http=True,
        json_response=True,
        streamable_http_path="/",
        transport_security=_transport_security_from_env(),
    )

    @mcp.tool()
    async def search_persona_facts(query: str) -> dict[str, Any]:
        """Search hand-compiled facts about the streamer 明前奶绿 — biography,
        character settings, preferences, recurring bits. Returns the most
        relevant facts with their source dates. Use for stable facts about who
        she is, not for recalling specific stream moments."""
        await _guard_rate_limit()
        if facts._table is None:
            return {"count": 0, "results": [], "note": "Persona-facts index is not built on this server."}
        hits = await facts._search(query)
        results = [_project_fact(h) for h in hits]
        return {"count": len(results), "results": results}

    @mcp.tool()
    async def search_streams(query: str) -> dict[str, Any]:
        """Search transcripts of 明前奶绿's past live streams. Returns the most
        relevant ~5-minute stream segments with their broadcast dates and
        topics. Use to recall what she said or did on a stream."""
        await _guard_rate_limit()
        if streams._table is None:
            return {"count": 0, "results": [], "note": "Stream-archive index is not built on this server."}
        hits = await streams._search(query)
        results = [_project_chunk(h) for h in hits]
        return {"count": len(results), "results": results}

    inner = mcp.streamable_http_app()
    app.mount(MOUNT_PATH, _TierMiddleware(inner, anon_quota=anon, auth_quota=auth))

    # FastMCP runs its session manager in the sub-app's OWN lifespan, which a
    # Mount does not execute. Fold it into the parent app's lifespan so the
    # session manager's task group is running when requests arrive. Pipecat's
    # runner combines lifespans the same way (_add_lifespan_to_app), so this
    # composes cleanly with the WebRTC lifespan added later.
    original_lifespan = app.router.lifespan_context

    @contextlib.asynccontextmanager
    async def lifespan_with_mcp(app_: FastAPI):
        async with mcp.session_manager.run():
            async with original_lifespan(app_):
                yield

    app.router.lifespan_context = lifespan_with_mcp

    logger.info(
        f"[mcp] Streamable HTTP server mounted at {MOUNT_PATH}/ "
        f"(anon {anon.max_per_window}/{anon.window_seconds}s, "
        f"auth {auth.max_per_window}/{auth.window_seconds}s)"
    )
```

- [ ] **Step 5: Run the full test file to verify it passes**

Run: `uv run pytest tests/test_mcp_server.py -q`
Expected: PASS (10 passed).

- [ ] **Step 6: Lint and type-check the new module**

Run: `uv run ruff check laplace_eidolon/mcp_server.py tests/test_mcp_server.py`
Expected: `All checks passed!`

Run: `uv run pyright laplace_eidolon/mcp_server.py`
Expected: 0 errors. (If pyright flags `facts._table` / `_search` access on the injected fake, that is expected only in tests — the production types are `PersonaFactsService`/`StreamArchiveService` which define both.)

- [ ] **Step 7: Commit**

```bash
git add laplace_eidolon/mcp_server.py tests/test_mcp_server.py
git commit -m "feat(mcp): add tools, tier middleware, quotas, and install_mcp"
```

---

## Task 4: Wire into the bot

**Files:**
- Modify: `laplace_eidolon/bot.py`

- [ ] **Step 1: Add the import**

In `laplace_eidolon/bot.py`, find:

```python
from .memory_admin import install_memory_admin
from .offer_middleware import install_offer_middleware
```

Replace with (keeps the relative-import block alphabetically sorted — `mcp_server` < `memory_admin`):

```python
from .mcp_server import install_mcp
from .memory_admin import install_memory_admin
from .offer_middleware import install_offer_middleware
```

- [ ] **Step 2: Add the install call**

Find:

```python
install_memory_admin(pipecat_app)
```

Replace with:

```python
install_memory_admin(pipecat_app)


# Public MCP server (Streamable HTTP at /mcp): read-only retrieval tools over
# the persona-facts + stream-archive indexes. Anonymous callers are rate
# limited per IP; a valid loginSyncToken raises the ceiling (per UID). Mounted
# here so it shares resolve_user_context's cache and the single-instance
# deployment. See mcp_server.py for the combined-lifespan rationale.
install_mcp(pipecat_app)
```

- [ ] **Step 3: Lint + type-check the edited file**

Run: `uv run ruff check laplace_eidolon/bot.py`
Expected: `All checks passed!`

Run: `uv run pyright laplace_eidolon/bot.py`
Expected: no NEW errors introduced by these two edits (the import resolves; `install_mcp(pipecat_app)` type-checks).

- [ ] **Step 4: Smoke-test the mounted endpoint against the real bot app**

This boots the bot's FastAPI app in-process (no WebRTC connection, no API keys needed for the MCP surface) and confirms `/mcp` is wired and the combined lifespan runs.

Run:

```bash
uv run python - <<'PY'
from starlette.testclient import TestClient
from pipecat.runner.run import app
import laplace_eidolon.bot  # noqa: F401  — import side effect calls install_mcp(app)

H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "smoke", "version": "1"}}}
with TestClient(app) as c:
    r = c.post("/mcp/", json=init, headers=H)
    print("initialize:", r.status_code, r.headers.get("content-type"))
    assert r.status_code == 200, r.text
    tl = c.post("/mcp/", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, headers=H)
    names = sorted(t["name"] for t in tl.json()["result"]["tools"])
    print("tools:", names)
    assert names == ["search_persona_facts", "search_streams"]
    print("SMOKE OK")
PY
```

Expected: prints `initialize: 200 application/json`, `tools: ['search_persona_facts', 'search_streams']`, `SMOKE OK`.

> If importing `laplace_eidolon.bot` fails because the module reads required env at import time, run the smoke test with a minimal env (`cp .env.example .env` and fill placeholders, or prefix dummy values), since this only exercises the MCP surface. The integration tests in Task 3 already prove the MCP behavior independently of the bot import.

- [ ] **Step 5: Commit**

```bash
git add laplace_eidolon/bot.py
git commit -m "feat(mcp): mount the MCP server on the bot app at /mcp"
```

---

## Task 5: Docs + env example

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add the MCP env vars to `.env.example`**

Append to `.env.example`:

```bash
# --- Public MCP server (Streamable HTTP at /mcp) ---
# Read-only retrieval tools over the persona-facts + stream-archive indexes.
# Anonymous callers are rate-limited per client IP; callers presenting a valid
# loginSyncToken are limited per Bilibili UID at a higher ceiling.
EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR=20
EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR=120
EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC=3600
# Comma-separated Host allowlist for DNS-rebinding protection. Set to your
# public domain(s) behind the reverse proxy (e.g. eidolon.example.com). Leave
# empty to disable the Host check and rely on the proxy.
EIDOLON_MCP_ALLOWED_HOSTS=
```

- [ ] **Step 2: Add the `/mcp` row to the README endpoint table**

In `README.md`, find:

```markdown
| `POST /api/memories/forget`                 | Wipe the caller's Mem0 memories (auth req.) |
```

Replace with:

```markdown
| `POST /api/memories/forget`                 | Wipe the caller's Mem0 memories (auth req.) |
| `POST /mcp/`                                | Public MCP server (Streamable HTTP, read-only) |
```

- [ ] **Step 3: Add a "Public MCP server" subsection**

In `README.md`, find the memory-admin doc reference paragraph:

```markdown
See [`docs/memory-admin.md`](docs/memory-admin.md) for the per-viewer Mem0
admin endpoints (`GET /api/memories`, `POST /api/memories/forget`) — both
authenticated with the same `loginSyncToken` the WebRTC offer carries, both
scoped to the caller's own Bilibili UID.
```

Insert immediately after it:

```markdown
### Public MCP server

The bot also serves a read-only [Model Context Protocol](https://modelcontextprotocol.io)
endpoint (Streamable HTTP) at `POST /mcp/`, exposing two tools over the same
RAG indexes the voice pipeline uses:

| Tool                   | What it searches                                  |
| ---------------------- | ------------------------------------------------- |
| `search_persona_facts` | Hand-compiled facts about the streamer            |
| `search_streams`       | Refined transcripts of past streams               |

Point any MCP client at `https://<your-host>/mcp` (the server canonicalizes to
`/mcp/`; clients that don't follow 307 redirects should use the trailing slash
directly). Access is anonymous by default and rate-limited per client IP
(`EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR`, default 20/h). Send the same
`loginSyncToken` the WebRTC client uses as an `Authorization: Bearer <token>`
header to be rate-limited per Bilibili UID at a higher ceiling
(`EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR`, default 120/h) — the token raises your
throughput only; it unlocks no private data. Both tools no-op gracefully (an
empty result with a `note`) when their LanceDB index hasn't been built.

Behind a reverse proxy, set `EIDOLON_MCP_ALLOWED_HOSTS` to your public
domain(s) so the SDK's DNS-rebinding Host check accepts requests; the proxy
must pass `POST /mcp/` through unbuffered, like `/api/offer`.
```

- [ ] **Step 4: Verify the docs render and nothing else broke**

Run: `uv run pytest -q`
Expected: PASS (10 passed) — confirms no regression.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md
git commit -m "docs(mcp): document the public MCP server + env vars"
```

---

## Final verification

- [ ] **Run the full suite**

Run: `uv run pytest -q`
Expected: 10 passed.

- [ ] **Lint + type-check the whole change**

Run: `uv run ruff check laplace_eidolon tests`
Expected: `All checks passed!`

Run: `uv run pyright laplace_eidolon/mcp_server.py laplace_eidolon/bot.py`
Expected: 0 errors.

---

## Self-review notes (for the implementer)

- **Per-call `top_k` was intentionally omitted** (the user asked to keep it simple). Each tool uses the service's tuned default (8 facts / 3 chunks). Adding `top_k` later means threading an override into `_search`'s `final_k`; out of scope here.
- **Reused private helpers** (`_extract_bearer_token`, `_resolve_client_ip_from_scope`, `_env_int`) are the single source of truth for their logic; importing them avoids drift. If a future refactor makes them public, update the imports.
- **`facts._table` / `_search` access** mirrors the existing `laplace-search` CLI, which constructs the services standalone and calls `_search` directly — the sanctioned pattern in this codebase.
- **Mem0 / personalized memory is explicitly excluded** per the design — the token is a throughput tier signal only.
- **Workers-failure degradation** (spec error table) is already handled inside `resolve_user_context`, which is documented to never raise and to fall back to stale-cache-or-`ANONYMOUS` on any HTTP/JSON failure. The middleware therefore needs no `try/except` — an `ANONYMOUS` return lands in the `else` branch and yields the anonymous tier. This matches how `memory_admin` calls it.
