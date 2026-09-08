"""Reproduce retained RAG context growth using saved live retrieval results, without API calls."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
sys.path.insert(0, str(ROOT))
from loguru import logger
from pipecat.processors.aggregators.llm_context import LLMContext

from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.stream_archive import StreamArchiveService

logger.remove()


async def main() -> None:
    rows = json.loads((OUT / "retrieval-contexts.json").read_text())[:2]
    facts = PersonaFactsService()
    archive = StreamArchiveService()
    context = LLMContext()
    result: dict[str, Any] = {
        "boundary": "Local reproduction using actual _enhance implementations and successful live retrieved rows. Only _search is substituted (AsyncMock) to alternate two measured query result sets without more provider calls. No LLM requests: character counts demonstrate context growth, not a measured TTFT impact.",
        "queries": [r["query"] for r in rows],
        "checkpoints": [],
    }
    for turn in range(1, 21):
        sample = rows[(turn - 1) % 2]
        query = sample["query"]
        context.add_message({"role": "user", "content": query})
        facts._search = AsyncMock(return_value=sample["rows"]["persona_facts"])
        archive._search = AsyncMock(return_value=sample["rows"]["stream_chunks"])
        await facts._enhance(context, query)
        await archive._enhance(context, query)
        context.add_message({"role": "assistant", "content": "好的，我知道啦。"})
        if turn in [1, 2, 5, 10, 20]:
            messages = cast(list[dict[str, Any]], context.get_messages())
            system = [m for m in messages if m.get("role") == "system"]
            result["checkpoints"].append(
                {
                    "turn": turn,
                    "messages": len(messages),
                    "rag_messages": len(system),
                    "rag_chars": sum(len(m["content"]) for m in system),
                    "total_context_chars": sum(len(m.get("content", "")) for m in messages),
                }
            )
    (OUT / "call-context-growth.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
