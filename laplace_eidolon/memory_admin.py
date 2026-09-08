"""Per-viewer Mem0 admin endpoints on the bot's FastAPI app.

``GET /api/memories`` lists what Mem0 has stored under the caller's Bilibili
UID; ``POST /api/memories/forget`` bulk-deletes it. Both authenticate with
``Authorization: Bearer <loginSyncToken>`` — the same token the JS client
nests in ``requestData.loginSyncToken`` — through ``resolve_user_context``,
which shares its TTL cache with the offer middleware. Anonymous callers get
``401`` even when Mem0 is unconfigured, so a misconfigured deployment
cannot leak the existence of anyone's memories.

Forgetting mid-call only wipes what was already stored: the live pipeline's
``Mem0MemoryService`` keeps writing new turns until it shuts down, so the
frontend has to disconnect for a clean wipe (``docs/memory-admin.md``). The
backend deliberately does not force-disconnect.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from loguru import logger

from . import mem0_local
from .user_context import UserContext, resolve_user_context

if TYPE_CHECKING:
    from mem0 import Memory as _MemoryType

try:
    from mem0 import Memory
except Exception as e:  # pragma: no cover — optional dep, mirrors bot.py
    Memory = None  # type: ignore[assignment,misc]
    logger.debug(f"mem0 engine unavailable for memory_admin: {e}")


LIST_PATH = "/api/memories"
FORGET_PATH = "/api/memories/forget"

# The embedded engine's ``get_all`` defaults to ``top_k=20`` where the cloud
# client paginated; without an explicit cap this endpoint would silently
# claim a chatty viewer owns 20 memories.
LIST_LIMIT = 1000


_client: "_MemoryType | None" = None


def _get_mem0_client() -> "_MemoryType | None":
    """Return a process-wide ``Memory``, lazy-constructing on first call.

    Returns ``None`` when Mem0 is unconfigured, ``mem0`` failed to import,
    or Qdrant is unreachable; handlers turn that into a ``503``. Unlike the
    pipeline's per-session engine this one is cached for the life of the
    process, because ``Memory`` re-runs its history-table migration on every
    construction. Construction races benignly — the loser is discarded.
    """
    global _client
    if _client is not None:
        return _client
    if not mem0_local.is_configured() or Memory is None:
        return None
    try:
        _client = Memory.from_config(mem0_local.build_local_config())
    except Exception as e:
        logger.error(f"[memory-admin] Could not reach the Mem0 vector store: {e}")
        return None
    return _client


def _extract_bearer_token(authorization: str | None) -> str | None:
    """Pull the token out of an ``Authorization: Bearer <token>`` header.

    Scheme match is case-insensitive. Returns ``None`` for a missing,
    malformed, or non-Bearer header — callers read that as anonymous.
    """
    if not authorization:
        return None
    parts = authorization.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


async def _resolve_caller(authorization: str | None) -> UserContext | None:
    """Validate the bearer token and return a logged-in ``UserContext``.

    ``None`` for anonymous callers — missing, blank, invalid, or a token
    that resolves to a non-logged-in user. Handlers map that to ``401``.
    """
    token = _extract_bearer_token(authorization)
    if token is None:
        return None
    user = await resolve_user_context(token)
    if not user.is_logged_in or user.mid is None:
        return None
    return user


def _memory_summary(raw: dict[str, Any]) -> dict[str, Any]:
    """Project a Mem0 memory dict down to the user-visible fields.

    Mem0 also returns internal bookkeeping (hash, score, user_id, agent_id,
    metadata blob, immutable flag) that the frontend must never surface.
    """
    return {
        "id": raw.get("id"),
        "memory": raw.get("memory"),
        "created_at": raw.get("created_at"),
        "updated_at": raw.get("updated_at"),
        "categories": raw.get("categories"),
    }


def install_memory_admin(app: FastAPI) -> None:
    """Wire the memory-admin endpoints onto ``app``.

    Call exactly once at startup, alongside ``install_offer_middleware``.
    Not idempotent — registering twice raises FastAPI's "Duplicate operation
    ID" error at boot.
    """
    logger.info(
        f"[memory-admin] Installed routes: GET {LIST_PATH}, POST {FORGET_PATH}"
    )

    @app.get(LIST_PATH)
    async def list_memories(
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Return every memory Mem0 has stored under the caller's UID.

        A user with no memories gets a plain 200 with ``count`` 0, so the
        frontend needs no special case.
        """
        user = await _resolve_caller(authorization)
        if user is None:
            return JSONResponse(
                status_code=401,
                content={"error": "需要登录后才能查看记忆"},
            )

        client = _get_mem0_client()
        if client is None:
            return JSONResponse(
                status_code=503,
                content={"error": "Mem0 service unavailable"},
            )

        user_id = str(user.mid)
        try:
            # get_all takes the user id ONLY inside filters — passing it
            # top-level raises ValueError. delete_all below wants the exact
            # opposite. Don't normalize the two call shapes to match.
            raw = await asyncio.to_thread(
                lambda: client.get_all(filters={"user_id": user_id}, top_k=LIST_LIMIT)
            )
        except Exception as e:
            logger.error(
                f"[memory-admin] get_all failed for mid={user_id}: "
                f"{type(e).__name__}: {e}"
            )
            return JSONResponse(
                status_code=502,
                content={"error": "Failed to load memories"},
            )

        # Mem0 wraps rows in {"results": [...]} in v1.1 format.
        results = raw.get("results", []) if isinstance(raw, dict) else (raw or [])
        memories = [_memory_summary(m) for m in results if isinstance(m, dict)]

        logger.info(
            f"[memory-admin] Listed {len(memories)} memories for mid={user_id} "
            f"({user.uname!r})"
        )
        return JSONResponse(
            content={
                "user_id": user_id,
                "uname": user.uname,
                "count": len(memories),
                "memories": memories,
            }
        )

    @app.post(FORGET_PATH)
    async def forget_memories(
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Bulk-delete every memory stored under the caller's UID.

        Idempotent — Mem0 returns the same OK response when the filtered
        set is already empty.
        """
        user = await _resolve_caller(authorization)
        if user is None:
            return JSONResponse(
                status_code=401,
                content={"error": "需要登录后才能管理记忆"},
            )

        client = _get_mem0_client()
        if client is None:
            return JSONResponse(
                status_code=503,
                content={"error": "Mem0 service unavailable"},
            )

        user_id = str(user.mid)
        try:
            # delete_all requires a top-level user_id; filters={...} 400s
            # "At least one filter ... is required". Opposite of get_all
            # in list_memories above.
            await asyncio.to_thread(lambda: client.delete_all(user_id=user_id))
        except Exception as e:
            logger.error(
                f"[memory-admin] delete_all failed for mid={user_id}: "
                f"{type(e).__name__}: {e}"
            )
            return JSONResponse(
                status_code=502,
                content={"error": "Failed to delete memories"},
            )

        logger.info(
            f"[memory-admin] Wiped Mem0 memories for mid={user_id} ({user.uname!r})"
        )
        return JSONResponse(content={"ok": True, "user_id": user_id})
