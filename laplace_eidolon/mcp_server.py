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
