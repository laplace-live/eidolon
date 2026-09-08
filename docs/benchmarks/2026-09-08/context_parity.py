"""Compare serial enrichment with parallel lookup and ordered injection using recorded results."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
from loguru import logger

load_dotenv(ROOT / ".env", override=True)
logger.remove()

from pipecat.processors.aggregators.llm_context import LLMContext

from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.retrieval import build_query_text
from laplace_eidolon.stream_archive import StreamArchiveService

Service = PersonaFactsService | StreamArchiveService
OUT = Path(__file__).resolve().parent / "retrieval-preserved"


def eligible_query(service: Service, context: LLMContext) -> str | None:
    query = build_query_text(
        cast(list[dict[str, Any]], context.get_messages()),
        max_user_turns=service._params.max_user_turns,
    )
    return query if query and len(query.strip()) >= service._params.min_query_chars else None


async def serial(services: list[Service], context: LLMContext) -> list[str]:
    errors: list[str] = []
    for service in services:
        query = eligible_query(service, context)
        if query:
            try:
                await service._enhance(context, query)
            except Exception as exc:
                errors.append(type(exc).__name__)
    return errors


async def parallel(services: list[Service], context: LLMContext) -> list[str]:
    plans = [(service, eligible_query(service, context)) for service in services]
    active = [
        (service, query) for service, query in plans if query and query != service._last_query
    ]
    results = await asyncio.gather(
        *(service._search(query) for service, query in active), return_exceptions=True
    )
    for (service, _), result in zip(active, results):
        service._search = (
            AsyncMock(side_effect=result)
            if isinstance(result, BaseException)
            else AsyncMock(return_value=result)
        )
    return await serial(services, context)


def digest(context: LLMContext) -> str:
    return hashlib.sha256(
        json.dumps(context.get_messages(), ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


async def main() -> None:
    fixtures = json.loads((OUT.parent / "retrieval-contexts.json").read_text())
    result: dict[str, Any] = {
        "boundary": "Offline scheduling prototype using the real _enhance methods and recorded "
        "live result rows. _search is substituted; this verifies queries, skips, error isolation, "
        "and exact context assembly. Live retrieval parity is measured separately.",
        "cases": [],
    }
    cases = [
        ("ordinary_and_followups", 3, 3, None),
        ("different_query_history_limits", 1, 3, None),
        ("facts_empty", 3, 3, "facts_empty"),
        ("archive_empty", 3, 3, "archive_empty"),
        ("both_empty", 3, 3, "both_empty"),
        ("facts_search_exception", 3, 3, "facts_error"),
        ("archive_search_exception", 3, 3, "archive_error"),
        ("facts_service_absent", 3, 3, "facts_absent"),
        ("archive_service_absent", 3, 3, "archive_absent"),
    ]
    utterances = [
        None,
        "嗯",
        "你梦想是什么",
        "你梦想是什么",
        "再说说",
        "你拔过智齿吗",
        "26年3月24直播内容",
        "26年3月24直播内容",
        "那呢",
        "",
        "你梦想是什么",
    ]
    for name, facts_history, archive_history, mode in cases:
        pairs: list[list[Service]] = [
            [
                PersonaFactsService(
                    params=PersonaFactsService.InputParams(max_user_turns=facts_history)
                ),
                StreamArchiveService(
                    params=StreamArchiveService.InputParams(max_user_turns=archive_history)
                ),
            ]
            for _ in range(2)
        ]
        if mode == "facts_absent":
            pairs = [services[1:] for services in pairs]
        elif mode == "archive_absent":
            pairs = [services[:1] for services in pairs]
        contexts = [LLMContext(), LLMContext()]
        case: dict[str, Any] = {"name": name, "turns": []}
        for turn, utterance in enumerate(utterances):
            fixture = fixtures[turn % len(fixtures)]
            search_mocks: list[list[AsyncMock]] = []
            for services, context in zip(pairs, contexts):
                if utterance is not None:
                    context.add_message({"role": "user", "content": utterance})
                mocks = []
                for service in services:
                    table = (
                        "persona_facts"
                        if isinstance(service, PersonaFactsService)
                        else "stream_chunks"
                    )
                    label = "facts" if isinstance(service, PersonaFactsService) else "archive"
                    if mode == f"{label}_error":
                        mock = AsyncMock(side_effect=RuntimeError("recorded search failure"))
                    elif mode in (f"{label}_empty", "both_empty"):
                        mock = AsyncMock(return_value=[])
                    else:
                        mock = AsyncMock(return_value=copy.deepcopy(fixture["rows"][table]))
                    service._search = mock
                    mocks.append(mock)
                search_mocks.append(mocks)
            serial_errors = await serial(pairs[0], contexts[0])
            parallel_errors = await parallel(pairs[1], contexts[1])
            calls = [[mock.call_args_list for mock in mocks] for mocks in search_mocks]
            assert calls[0] == calls[1], (name, turn, "different queries or skip behavior")
            assert serial_errors == parallel_errors, (name, turn, "different failures")
            assert contexts[0].get_messages() == contexts[1].get_messages(), (name, turn)
            assert [s._last_query for s in pairs[0]] == [s._last_query for s in pairs[1]]
            case["turns"].append(
                {
                    "turn": turn,
                    "utterance": utterance,
                    "exact_context_match": True,
                    "context_sha256": digest(contexts[0]),
                    "errors": serial_errors,
                    "queries": [
                        [call.args[0] for call in mock.call_args_list] for mock in search_mocks[0]
                    ],
                }
            )
            for context in contexts:
                context.add_message({"role": "assistant", "content": "好的，我知道啦。"})
        result["cases"].append(case)
    result["summary"] = {
        "cases": len(cases),
        "turn_comparisons": len(cases) * len(utterances),
        "exact_context_matches": len(cases) * len(utterances),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "context-parity.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(result["summary"]))


if __name__ == "__main__":
    asyncio.run(main())
