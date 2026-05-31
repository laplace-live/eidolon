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
