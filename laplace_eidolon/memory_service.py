"""Mem0 memory service that drops messages without string content.

Pipecat's universal aggregator emits ``{"role": "assistant",
"tool_calls": [...]}`` with no ``content`` field on every tool call.
That's OpenAI-spec-correct, but Mem0's cloud API 400s the whole
``messages`` array over it — and since the poisoned message stays in the
cumulative context, every later turn in the session 400s too, silently
ending long-term memory. Mem0 rejects empty arrays the same way, so a
batch that filters down to nothing skips the call entirely.
"""

from __future__ import annotations

from loguru import logger
from pipecat.processors.aggregators.llm_context import LLMStandardMessage
from pipecat.services.mem0.memory import Mem0MemoryService


class LaplaceMem0MemoryService(Mem0MemoryService):
    """Mem0 memory service that filters out non-string-content messages."""

    async def _store_messages(self, messages: list[LLMStandardMessage]) -> None:
        """Filter messages, then delegate to the parent.

        Pipecat already filters by role one layer up in ``process_frame``;
        repeating it here keeps the payload Mem0-safe for direct callers
        and survives a future refactor that drops the upstream filter.
        """
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
