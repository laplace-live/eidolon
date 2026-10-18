"""Mem0 memory service that drops messages without string content.

Pipecat's universal aggregator emits ``{"role": "assistant",
"tool_calls": [...]}`` with no ``content`` field on every tool call.
That's OpenAI-spec-correct, but Mem0 rejects the whole ``messages``
array over it — and since the poisoned message stays in the cumulative
context, every later turn in the session fails too, silently ending
long-term memory. Empty arrays are rejected the same way, so a batch
that filters down to nothing skips the call entirely.

Pipecat's ``get_memories`` returns the engine's default 20 in Qdrant
scroll order, which is by point id — a random UUID. The greeting quotes
the head of that list, so it would open every session with the same few
memories however many are stored since.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from loguru import logger
from pipecat.processors.aggregators.llm_context import LLMStandardMessage
from pipecat.services.mem0.memory import Mem0MemoryService

from .memory_admin import LIST_LIMIT


class LaplaceMem0MemoryService(Mem0MemoryService):
    """Mem0 memory service that drops content-less messages and lists newest first."""

    async def get_memories(self) -> list[dict[str, Any]]:
        """Return every memory in this service's scope, newest first."""
        filters = {
            name: value
            for name, value in (
                ("user_id", self.user_id),
                ("agent_id", self.agent_id),
                ("run_id", self.run_id),
            )
            if value is not None
        }
        result = await asyncio.to_thread(
            lambda: self.memory_client.get_all(filters=filters, top_k=LIST_LIMIT)
        )
        memories = result.get("results", [])
        # Cloud-imported memories carry -07:00 offsets, local writes +00:00,
        # so sorting the raw strings would misorder them.
        memories.sort(key=lambda m: datetime.fromisoformat(m["created_at"]), reverse=True)
        return memories

    async def _store_messages(self, messages: list[LLMStandardMessage]) -> None:
        """Filter messages, then delegate to the parent."""
        sanitized = [
            m
            for m in messages
            if m.get("role") in ("user", "assistant")
            and isinstance(content := m.get("content"), str)
            and content.strip()
        ]
        dropped = len(messages) - len(sanitized)

        if not sanitized:
            if dropped:
                logger.debug(
                    f"Mem0: skipping store — all {dropped} messages had "
                    f"non-string or empty content (likely tool_calls)"
                )
            return

        if dropped:
            logger.debug(
                f"Mem0: dropped {dropped} non-string-content message(s) "
                f"before storing {len(sanitized)} valid one(s)"
            )

        await super()._store_messages(sanitized)


__all__ = ["LaplaceMem0MemoryService"]
