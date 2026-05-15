"""Mem0 memory service with tool-call-safe message filtering.

Wraps :class:`pipecat.services.mem0.memory.Mem0MemoryService` so the
storage path tolerates assistant messages without a string ``content``
field — the exact shape pipecat's universal aggregator emits whenever
the LLM calls a tool.

Why this exists
---------------
Pipecat's mem0 service filters context messages by ``role`` only::

    messages_to_store = [
        m for m in context_messages
        if m.get("role") in ("user", "assistant")
    ]

That's correct as far as it goes, but the universal aggregator emits
*two* assistant-flavored shapes for every tool call (see
``pipecat/processors/aggregators/llm_response_universal.py``)::

    # 1. The assistant-side tool_call announcement — NO content field:
    {"role": "assistant", "tool_calls": [{...}]}

    # 2. The tool result — role="tool", filtered out correctly above:
    {"role": "tool", "content": "...", "tool_call_id": "..."}

Shape #1 is OpenAI-spec-correct (``content`` is optional when
``tool_calls`` is present) but Mem0's cloud API rejects the entire
``messages`` array with::

    HTTP 400 {"messages":["Bad request. Please check memory creation
    docs: https://docs.mem0.ai/platform/quickstart#4-1-create-memories."]}

Once that happens, Mem0 stops accepting *any* further turn from this
session — every subsequent ``_store_messages`` call carries the same
poisoned message in the cumulative context, so the bot silently loses
its long-term memory for the rest of the conversation.

The voice-switching tool registered by ``voice_switching.py`` is the
trigger today (``change_voice_style``) but the same failure surfaces
for any future tool registered with the LLM. Subclassing once here
inoculates the whole pipeline.

Fix
---
Override ``_store_messages`` to drop messages whose ``content`` isn't
a non-empty string before delegating to the parent. Also skip the API
call entirely when nothing remains, since Mem0's API rejects empty
``messages`` arrays the same way.

Logging
-------
Filtering is logged at DEBUG with the count of dropped messages, so
the same kind of silent data-loss bug in a future pipecat version
would be diagnosable from a single grep instead of another mem0 400
hunt. The drop is intentional — those messages have no semantic
content to extract memories from anyway (a tool call is structured
metadata, not a conversational utterance).

Upstream
--------
This filter would be a one-line add to pipecat's ``_store_messages``
(restrict the existing role filter to ``isinstance(content, str) and
content.strip()``). Until that lands upstream, this subclass is the
fix for vendored pipecat installs.
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pipecat.services.mem0.memory import Mem0MemoryService


class LaplaceMem0MemoryService(Mem0MemoryService):
    """Mem0 memory service that filters out non-string-content messages.

    Behaves identically to :class:`Mem0MemoryService` for messages that
    Mem0 actually accepts (user/assistant turns with string content),
    and silently drops the assistant-side tool_call announcements that
    would otherwise 400 the entire batch.
    """

    async def _store_messages(self, messages: list[dict[str, Any]]) -> None:
        """Filter messages, then delegate to the parent.

        Keep only messages where ``role`` is ``user`` / ``assistant``
        *and* ``content`` is a non-empty string after stripping
        whitespace. Pipecat already filters by role one layer up
        (``process_frame``); we restate it here as defense-in-depth so
        a future pipecat refactor that drops the upstream filter — or
        any direct caller — still gets a Mem0-safe payload.

        The content check excludes:

        - Assistant tool_call announcements (``content`` field absent).
        - Multimodal user turns where ``content`` is a list of parts
          (Mem0's text-only extractor would reject those anyway).
        - Empty/whitespace-only strings the LLM occasionally produces
          mid-stream — they carry no signal for memory extraction.
        - Tool result messages (``role == "tool"``) — Mem0 only
          accepts user/assistant turns.
        """
        sanitized = [
            m
            for m in messages
            if m.get("role") in ("user", "assistant")
            and isinstance(m.get("content"), str)
            and m["content"].strip()
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
