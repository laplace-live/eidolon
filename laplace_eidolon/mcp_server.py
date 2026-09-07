"""Public, anonymously-accessible MCP server over the retrieval indexes.

Mounts an ``MCPServer`` Streamable HTTP app at /mcp on the bot's FastAPI app,
exposing two read-only tools — ``search_persona_facts`` and
``search_streams`` — over the same LanceDB indexes the voice pipeline uses.

Anonymous callers are rate-limited per client IP; a valid ``Authorization:
Bearer <loginSyncToken>`` raises the ceiling and keys the quota by Bilibili
UID instead. The token buys throughput only — both tiers see identical tools
over identical public data (no Mem0, no per-user content).
"""

from __future__ import annotations

import contextlib
import os
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI
from loguru import logger
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.types import Receive, Scope, Send

from . import persona_facts, stream_archive
from .embeddings import resolve_db_path
from .env import env_int
from .memory_admin import _extract_bearer_token
from .offer_middleware import _resolve_client_ip_from_scope
from .rate_limit import AnonymousIpQuota
from .retrieval import score_of
from .retriever import LanceRetriever
from .stream_archive import decode_topics
from .user_context import resolve_user_context

MOUNT_PATH = "/mcp"

# Per-hour defaults. Every search costs one embedding plus an optional Cohere
# rerank, so these cap spend; both tiers stay bounded. Tune via env.
_ANON_DEFAULT_PER_HOUR = 20
_AUTH_DEFAULT_PER_HOUR = 120
_DEFAULT_WINDOW_SEC = 3600


def _project_fact(hit: dict[str, Any]) -> dict[str, Any]:
    """Project a persona-facts row to the LLM-facing fields, dropping the
    embedding vector and internal bookkeeping."""
    return {
        "text": (hit.get("text") or "").strip(),
        "date": hit.get("date") or None,
        "score": score_of(hit),
    }


def _project_chunk(hit: dict[str, Any]) -> dict[str, Any]:
    """Project a stream-archive row, preferring the refined ``details`` over
    the v1 ``summary`` over the raw ``text`` — the same priority
    ``StreamArchiveService._format_chunks`` renders for the bot."""
    content = (hit.get("details") or hit.get("summary") or hit.get("text") or "").strip()
    return {
        "stream_date": hit.get("stream_date") or None,
        "content": content,
        "topics": decode_topics(hit),
        "score": score_of(hit),
    }


@dataclass(frozen=True)
class _CallerTier:
    """Which quota + key applies to the current request."""

    quota: AnonymousIpQuota
    key: str
    name: str  # "anonymous" | "authenticated" — used in the over-limit message


# Set once per HTTP request by _TierMiddleware; read inside the tools.
_caller: ContextVar[_CallerTier | None] = ContextVar("mcp_caller", default=None)


def _build_quota(per_hour_env: str, default_per_hour: int) -> AnonymousIpQuota:
    return AnonymousIpQuota(
        max_per_window=env_int(per_hour_env, default_per_hour),
        window_seconds=env_int("EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC", _DEFAULT_WINDOW_SEC),
    )


def _transport_security_from_env() -> TransportSecuritySettings:
    """Configure DNS-rebinding / Host-header protection.

    ``TransportSecuritySettings()`` defaults to protection on with an empty
    allowlist, which rejects every Host. Set
    ``EIDOLON_MCP_ALLOWED_HOSTS=host1,host2`` to the public domains a reverse
    proxy forwards; unset disables the check and leaves it to the proxy,
    keeping a fresh checkout runnable on localhost.

    Passing this explicitly also pins the behavior: ``streamable_http_app()``
    arms DNS-rebinding protection on its own when ``transport_security`` is
    ``None``.
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
    the window is exhausted. Runs at the top of every search tool, before any
    embedding spend."""
    tier = _caller.get()
    if tier is None:
        # Unreachable via the middleware; fail closed rather than unmetered.
        raise ToolError("Internal error: request tier was not resolved.")
    result = await tier.quota.try_consume(tier.key)
    if not result.allowed:
        raise ToolError(
            f"Rate limit exceeded for {tier.name} access. "
            f"Retry after {result.retry_after_seconds} seconds."
        )


class _TierMiddleware:
    """Pure-ASGI wrapper that resolves the rate-limit tier (anonymous-by-IP
    vs authenticated-by-UID) once per request, into the ``_caller`` contextvar.

    A missing, blank, invalid, or expired token is silently anonymous, never
    an error. ``resolve_user_context`` runs only when a token is present, so
    the handshake and anonymous calls cost zero Workers round-trips.
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
        # Safe without a reset: each ASGI request runs in its own task with a
        # freshly copied context, so the set cannot leak to another caller.
        _caller.set(tier)
        await self.app(scope, receive, send)


def install_mcp(
    app: FastAPI,
    *,
    db_path: str | os.PathLike[str] | None = None,
    persona_facts_retriever: LanceRetriever | None = None,
    stream_archive_retriever: LanceRetriever | None = None,
    anon_quota: AnonymousIpQuota | None = None,
    auth_quota: AnonymousIpQuota | None = None,
) -> None:
    """Mount the Streamable HTTP MCP server at ``/mcp/`` on ``app``.

    Call exactly once at startup, alongside ``install_offer_middleware`` and
    ``install_memory_admin``. Not idempotent: a second call wraps the lifespan
    again and ``session_manager.run()`` raises at startup on the second entry.
    The retriever and quota args are test seams; production passes ``db_path``.
    """
    path = db_path if db_path is not None else resolve_db_path()
    facts = persona_facts_retriever or persona_facts.build_retriever(path)
    streams = stream_archive_retriever or stream_archive.build_retriever(path)
    fact_params = persona_facts.PersonaFactsService.InputParams()
    chunk_params = stream_archive.StreamArchiveService.InputParams()
    anon = anon_quota or _build_quota("EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR", _ANON_DEFAULT_PER_HOUR)
    auth = auth_quota or _build_quota("EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR", _AUTH_DEFAULT_PER_HOUR)

    mcp = MCPServer(
        name="laplace-eidolon",
        instructions=(
            "Retrieval over the streamer 明前奶绿's hand-compiled persona facts "
            "and past live-stream transcripts. Read-only."
        ),
    )

    @mcp.tool()
    async def search_persona_facts(query: str) -> dict[str, Any]:
        """Search hand-compiled facts about the streamer 明前奶绿 — biography,
        character settings, preferences, recurring bits. Returns the most
        relevant facts with their source dates. Use for stable facts about who
        she is, not for recalling specific stream moments."""
        await _guard_rate_limit()
        if facts.table is None:
            return {"count": 0, "results": [], "note": "Persona-facts index is not built on this server."}
        hits = await facts.search(
            query, candidates=fact_params.candidates, top_k=fact_params.top_k
        )
        results = [_project_fact(h) for h in hits]
        return {"count": len(results), "results": results}

    @mcp.tool()
    async def search_streams(query: str) -> dict[str, Any]:
        """Search transcripts of 明前奶绿's past live streams. Returns the most
        relevant ~5-minute stream segments with their broadcast dates and
        topics. Use to recall what she said or did on a stream."""
        await _guard_rate_limit()
        if streams.table is None:
            return {"count": 0, "results": [], "note": "Stream-archive index is not built on this server."}
        hits = await streams.search(
            query, candidates=chunk_params.candidates, top_k=chunk_params.top_k
        )
        results = [_project_chunk(h) for h in hits]
        return {"count": len(results), "results": results}

    # MCP 2.0 moved transport configuration off the constructor onto here.
    inner = mcp.streamable_http_app(
        streamable_http_path="/",
        json_response=True,
        stateless_http=True,
        transport_security=_transport_security_from_env(),
    )
    app.mount(MOUNT_PATH, _TierMiddleware(inner, anon_quota=anon, auth_quota=auth))

    # The session manager runs in the sub-app's OWN lifespan, which a Mount
    # never executes. Folding it into the parent's lifespan is what gets
    # the session manager's task group running before requests arrive.
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
