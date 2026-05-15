"""Per-viewer Mem0 admin endpoints.

Exposes two HTTP routes on the same FastAPI app the bot runs on:

- ``GET  /api/memories``        — list everything Mem0 has stored under the
                                  caller's Bilibili UID (so the frontend can
                                  preview "what does the bot remember about
                                  me" before offering a delete).
- ``POST /api/memories/forget`` — bulk-delete every memory under the caller's
                                  UID. Idempotent: a second call after a
                                  successful first one is a no-op.

Auth
----
Both routes require an ``Authorization: Bearer <loginSyncToken>`` header
where ``<loginSyncToken>`` is the same token the JS client puts inside
``requestData.loginSyncToken`` of the WebRTC offer. We use a header here
(rather than the offer middleware's body-nested shape) because:

1. ``GET`` is body-less by HTTP convention; a header works identically
   for both verbs and avoids an asymmetric API.
2. The offer middleware only peeks inside ``requestData`` because the
   Pipecat JS SDK packs it that way. Endpoints we own from scratch can
   use the standard header.
3. ``Authorization: Bearer`` is conventionally redacted by reverse
   proxies' default access-log formats; query strings are not.

Validation goes through :func:`user_context.resolve_user_context`, which
shares its in-process TTL cache with the offer middleware. A user who
just connected and immediately hits ``/api/memories/forget`` pays zero
extra Workers calls — the cache is already warm.

Anonymous viewers are rejected with ``401`` even when ``MEM0_API_KEY``
is unset, so misconfiguration cannot accidentally leak the existence /
contents of any other viewer's memories.

In-flight session caveat
------------------------
``Mem0MemoryService`` runs inside the active WebRTC pipeline and
spawns a background ``_store_messages`` task on every turn. Wiping
memories mid-conversation removes everything stored *before* the
deletion, but new turns will keep accumulating until the pipeline
shuts down. The frontend should disconnect the WebRTC session
immediately after a successful ``/forget`` if the operator wants a
clean wipe — see ``docs/memory-admin.md``. The backend deliberately
does not force-disconnect: a user clicking "delete my memory" while
mid-conversation almost always wants the conversation to continue
without surprise audio drop.

Mem0 client lifetime
--------------------
``MemoryClient`` is a thin httpx wrapper. We construct it lazily on
first use and reuse the instance — same pattern as
``user_context._get_client``. The cloud client itself is thread-safe
for the read/delete calls we make (it serializes on its internal
httpx.Client).

Why ``asyncio.to_thread``
-------------------------
mem0ai's sync ``MemoryClient`` issues blocking httpx requests. Wrapping
in ``to_thread`` matches what ``Mem0MemoryService._store_messages``
already does for the same reason — keeps the FastAPI event loop
responsive during the (typically <500ms) round-trip to api.mem0.ai.

API-shape gotcha: ``get_all`` vs ``delete_all``
-----------------------------------------------
The two cloud endpoints disagree about how to pass ``user_id`` and the
mem0ai SDK forwards kwargs into the request without normalizing:

- ``get_all`` POSTs to ``/v2/memories/`` and **requires**
  ``filters={"user_id": "..."}``. Top-level ``user_id`` returns
  ``400 "Filters are required and cannot be empty"``.
- ``delete_all`` DELETEs ``/v1/memories/`` and **requires** top-level
  ``user_id``. ``filters={...}`` returns ``400 "At least one filter
  ... is required"``.

Both shapes verified empirically against api.mem0.ai with mem0ai 1.0.11.
This module uses each call's required shape; do not "normalize" them
to match each other or the wrong one will silently 502 to the FE.
"""

from __future__ import annotations

import asyncio
import os
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from loguru import logger

from .user_context import UserContext, resolve_user_context

if TYPE_CHECKING:
    # Imported only for type-checking. The runtime import below is the
    # one that decides whether the endpoints can do useful work.
    from mem0 import MemoryClient as _MemoryClientType

try:
    from mem0 import MemoryClient
except Exception as e:  # pragma: no cover — optional dep, mirrors bot.py
    MemoryClient = None  # type: ignore[assignment,misc]
    logger.debug(f"mem0 client unavailable for memory_admin: {e}")


LIST_PATH = "/api/memories"
FORGET_PATH = "/api/memories/forget"


_client: "_MemoryClientType | None" = None


def _get_mem0_client() -> "_MemoryClientType | None":
    """Return a process-wide ``MemoryClient``, lazy-constructing on first call.

    ``None`` when ``MEM0_API_KEY`` is unset or the ``mem0`` package
    failed to import — endpoint handlers translate that into a ``503``
    so a misconfigured deployment fails loudly with a clear message
    instead of stack-tracing.

    Not thread-safe construction-wise, but the FastAPI handlers run in
    the asyncio loop's main thread; the worst case under contention is
    constructing two clients and overwriting one — negligible cost
    (~one TCP cookie jar).
    """
    global _client
    if _client is not None:
        return _client
    api_key = os.getenv("MEM0_API_KEY")
    if not api_key or MemoryClient is None:
        return None
    _client = MemoryClient(api_key=api_key)
    return _client


def _extract_bearer_token(authorization: str | None) -> str | None:
    """Pull the token out of an ``Authorization: Bearer <token>`` header.

    Accepts the canonical ``Bearer <token>`` form (case-insensitive
    scheme) and tolerates extra whitespace. Returns ``None`` for
    missing, malformed, or non-Bearer schemes — the caller treats that
    as "no token, anonymous, reject".
    """
    if not authorization:
        return None
    parts = authorization.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


async def _resolve_caller(authorization: str | None) -> UserContext | None:
    """Validate the bearer token and return a logged-in :class:`UserContext`.

    Returns ``None`` when the caller is anonymous (no/blank/invalid
    token, or token validates to a non-logged-in user). Handlers map
    that to ``401``.
    """
    token = _extract_bearer_token(authorization)
    if token is None:
        return None
    user = await resolve_user_context(token)
    if not user.is_logged_in or user.mid is None:
        return None
    return user


def _memory_summary(raw: dict[str, Any]) -> dict[str, Any]:
    """Project a Mem0 memory dict down to the fields the FE actually needs.

    Mem0's response carries a lot of internal bookkeeping (hash, score,
    user_id, agent_id, metadata blob, immutable flag, …) — we only
    forward the user-visible bits so the FE doesn't accidentally
    surface an internal field.
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

    Call exactly once at startup, alongside :func:`install_offer_middleware`.
    Idempotency is the caller's responsibility — registering twice would
    raise FastAPI's "Duplicate operation ID" error at app boot.
    """
    logger.info(
        f"[memory-admin] Installed routes: GET {LIST_PATH}, POST {FORGET_PATH}"
    )

    @app.get(LIST_PATH)
    async def list_memories(
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Return every memory Mem0 has stored under the caller's UID.

        Response shape::

            {
              "user_id": "12345678",
              "uname": "明前奶绿粉丝",
              "count": 3,
              "memories": [
                {"id": "...", "memory": "...", "created_at": "...", ...},
                ...
              ]
            }

        Empty list (count=0) when the user has never had memories
        stored — same status code (200), no special-casing needed by
        the FE.
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
            # Mem0 cloud's GET-equivalent endpoint is POST /v2/memories/, which
            # rejects top-level entity IDs with 400 ("Filters are required and
            # cannot be empty") — the SDK kwargs are forwarded as-is into the
            # JSON body without auto-wrapping. Must pass `filters={"user_id":
            # ...}`. Note this is the OPPOSITE of `delete_all` below, which
            # POSTs to /v1/memories/ and rejects `filters=...` while accepting
            # top-level `user_id`. Verified empirically against api.mem0.ai
            # with mem0ai 1.0.11 (and matches Pipecat's
            # `Mem0MemoryService.get_memories`, which uses the same shape for
            # cloud `MemoryClient` instances).
            raw = await asyncio.to_thread(
                lambda: client.get_all(filters={"user_id": user_id})
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

        # Mem0's cloud client returns {"results": [...]} in v1.1 format;
        # `Mem0MemoryService.get_memories` already documents this shape.
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

        Idempotent — a second call right after a successful first one
        succeeds with the same shape (Mem0 returns the same OK
        response when the filtered set is empty).

        Response shape::

            {"ok": true, "user_id": "12345678"}
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
            # delete_all DELETEs /v1/memories/ and requires top-level
            # entity IDs as query params — passing `filters={...}` here
            # returns 400. This is the OPPOSITE shape from `list_memories`
            # above; see the module docstring "API-shape gotcha" section.
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
