from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock, call

import pytest
from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection

import laplace_eidolon.retriever as retriever_module
from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.retriever import (
    QUERY_EMBEDDING_CACHE_KEY,
    LanceRetriever,
    QueryEmbeddingCache,
)
from laplace_eidolon.stream_archive import StreamArchiveService

QUERY = "2026年5月9日你怎么拔的智齿"
VECTOR = [0.25, 0.75]
FACTS: list[dict[str, Any]] = [
    {"text": " 拔了两颗智齿 ", "date": "2026-05-09", "_relevance_score": 0.91},
    {"text": "喜欢喝奶茶", "_relevance_score": 0.82},
]
CHUNKS: list[dict[str, Any]] = [
    {
        "stream_date": "2026-05-09",
        "heading": "近况",
        "topics": '["智齿"]',
        "details": " 聊了拔牙后的恢复 ",
        "_relevance_score": 0.88,
    },
    {"stream_date": "2026-05-09", "text": "原始片段", "_relevance_score": 0.76},
]
FACTS_MESSAGE = {
    "role": "system",
    "content": "Facts:\n\n- [2026-05-09] 拔了两颗智齿\n- 喜欢喝奶茶\n",
}
ARCHIVE_MESSAGE = {
    "role": "system",
    "content": (
        "Archive:\n\n[1] 2026-05-09 — 智齿 — 近况\n聊了拔牙后的恢复\n\n[2] 2026-05-09\n原始片段\n"
    ),
}


@dataclass(eq=False)
class FakeTable:
    name: str

    def count_rows(self) -> int:
        return 2


@dataclass
class SearchMocks:
    embed: AsyncMock
    hybrid: AsyncMock
    open_table: Mock
    tables: dict[str, FakeTable | None]


@pytest.fixture
def searches(monkeypatch: pytest.MonkeyPatch) -> SearchMocks:
    tables: dict[str, FakeTable | None] = {
        "persona_facts": FakeTable("persona_facts"),
        "stream_chunks": FakeTable("stream_chunks"),
    }

    def open_table(path: Path, name: str) -> FakeTable | None:
        return tables[name]

    async def hybrid(table: FakeTable, **kwargs: Any) -> list[dict[str, Any]]:
        return FACTS if table.name == "persona_facts" else CHUNKS

    mocks = SearchMocks(
        AsyncMock(return_value=[VECTOR]),
        AsyncMock(side_effect=hybrid),
        Mock(side_effect=open_table),
        tables,
    )
    monkeypatch.setenv("EMBED_MODEL", "test-embedding")
    monkeypatch.setattr(retriever_module, "open_table", mocks.open_table)
    monkeypatch.setattr(retriever_module, "embed_texts", mocks.embed)
    monkeypatch.setattr(retriever_module, "hybrid_search", mocks.hybrid)
    return mocks


@dataclass
class ServicePair:
    facts: PersonaFactsService
    archive: StreamArchiveService
    pushed: AsyncMock
    errors: AsyncMock

    async def process(self, frame: LLMContextFrame) -> None:
        await self.facts.process_frame(frame, FrameDirection.DOWNSTREAM)
        self.pushed.assert_awaited_with(frame)
        self.errors.assert_not_awaited()


def make_pair(
    monkeypatch: pytest.MonkeyPatch,
    *,
    facts_max_user_turns: int = 3,
    archive_max_user_turns: int = 3,
) -> ServicePair:
    facts = PersonaFactsService(
        params=PersonaFactsService.InputParams(
            candidates=7,
            top_k=2,
            system_prompt="Facts:\n",
            max_user_turns=facts_max_user_turns,
        )
    )
    archive = StreamArchiveService(
        params=StreamArchiveService.InputParams(
            candidates=5,
            top_k=2,
            system_prompt="Archive:\n",
            max_user_turns=archive_max_user_turns,
        )
    )
    pushed, errors = AsyncMock(), AsyncMock()

    async def forward(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        await archive.process_frame(frame, direction)

    monkeypatch.setattr(facts, "push_frame", forward)
    monkeypatch.setattr(archive, "push_frame", pushed)
    monkeypatch.setattr(facts, "push_error", errors)
    monkeypatch.setattr(archive, "push_error", errors)
    return ServicePair(facts, archive, pushed, errors)


def make_frame(query: str = QUERY) -> LLMContextFrame:
    return LLMContextFrame(
        LLMContext(
            messages=[
                {"role": "system", "content": "Identity"},
                {"role": "user", "content": query},
            ]
        )
    )


def make_retriever(model: str | None = None) -> LanceRetriever:
    return LanceRetriever(
        "unused", "persona_facts", date_column="date", label="Facts", embed_model=model
    )


def test_services_share_embedding_preserving_search_options_and_context(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch
) -> None:
    pair = make_pair(monkeypatch)
    frame = make_frame()

    asyncio.run(pair.process(frame))

    searches.embed.assert_awaited_once_with([QUERY], model=None)
    assert searches.hybrid.await_args_list == [
        call(
            searches.tables["persona_facts"],
            vector=VECTOR,
            query_text=QUERY,
            candidates=7,
            where="date = '2026-05-09'",
            final_k=2,
            rerank=True,
        ),
        call(
            searches.tables["stream_chunks"],
            vector=VECTOR,
            query_text=QUERY,
            candidates=5,
            where="stream_date = '2026-05-09'",
            final_k=2,
            rerank=True,
        ),
    ]
    assert frame.context.get_messages() == [
        {"role": "system", "content": "Identity"},
        {"role": "user", "content": QUERY},
        ARCHIVE_MESSAGE,
        FACTS_MESSAGE,
    ]


def test_new_frames_do_not_reuse_old_embeddings_from_the_same_context(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch
) -> None:
    pair = make_pair(monkeypatch)
    first = make_frame()
    context = first.context

    async def run() -> tuple[LLMContextFrame, LLMContextFrame]:
        await pair.process(first)
        context.add_message({"role": "user", "content": "你现在最喜欢玩的游戏是什么呀"})
        second = LLMContextFrame(context)
        await pair.process(second)
        context.add_message({"role": "user", "content": QUERY})
        third = LLMContextFrame(context)
        await pair.process(third)
        return second, third

    second, third = asyncio.run(run())

    assert searches.embed.await_count == 3
    caches = [frame.metadata[QUERY_EMBEDDING_CACHE_KEY] for frame in (first, second, third)]
    assert len({id(cache) for cache in caches}) == 3


def test_direct_search_without_cache_still_embeds_each_call(searches: SearchMocks) -> None:
    retriever = make_retriever()

    async def run() -> None:
        for _ in range(2):
            assert await retriever.search(QUERY, candidates=7, top_k=2) == FACTS

    asyncio.run(run())

    assert searches.embed.await_count == 2
    assert searches.hybrid.await_count == 2


def test_default_and_explicit_same_model_share_an_embedding(searches: SearchMocks) -> None:
    cache: QueryEmbeddingCache = {}

    async def run() -> None:
        for model in (None, "test-embedding"):
            assert (
                await make_retriever(model).search(
                    QUERY, candidates=7, top_k=2, embedding_cache=cache
                )
                == FACTS
            )

    asyncio.run(run())

    assert searches.embed.await_count == 1
    assert searches.hybrid.await_count == 2


@pytest.mark.parametrize("changed", ["query", "model", "dimension"])
def test_different_embedding_inputs_do_not_share_cached_vectors(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch, changed: str
) -> None:
    cache: QueryEmbeddingCache = {}
    first = make_retriever()

    async def run() -> None:
        await first.search(QUERY, candidates=7, top_k=2, embedding_cache=cache)
        query, model = QUERY, None
        if changed == "query":
            query = QUERY + "？"
        elif changed == "model":
            model = "another-embedding"
        else:
            monkeypatch.setattr(
                retriever_module, "DEFAULT_EMBED_DIM", retriever_module.DEFAULT_EMBED_DIM + 1
            )
        await make_retriever(model).search(query, candidates=7, top_k=2, embedding_cache=cache)

    asyncio.run(run())

    assert searches.embed.await_count == 2
    assert len(cache) == 2


def test_different_followup_queries_each_get_their_own_embedding(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch
) -> None:
    pair = make_pair(monkeypatch, facts_max_user_turns=1)
    frame = make_frame()
    frame.context.add_message({"role": "user", "content": "后来怎么样"})

    asyncio.run(pair.process(frame))

    assert searches.embed.await_args_list == [
        call(["后来怎么样"], model=None),
        call([f"{QUERY} 后来怎么样"], model=None),
    ]


@pytest.mark.parametrize("failed_embedding", [RuntimeError("provider failed"), []])
def test_failed_embedding_leaves_archive_an_independent_retry(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch, failed_embedding: Any
) -> None:
    searches.embed.side_effect = [failed_embedding, [VECTOR]]
    pair = make_pair(monkeypatch)
    frame = make_frame()

    asyncio.run(pair.process(frame))

    assert searches.embed.await_count == 2
    searches.hybrid.assert_awaited_once()
    assert searches.hybrid.await_args is not None
    assert searches.hybrid.await_args.args[0] is searches.tables["stream_chunks"]
    assert frame.context.get_messages()[2:] == [ARCHIVE_MESSAGE]


def test_empty_vector_is_not_reused_by_the_archive(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch
) -> None:
    searches.embed.side_effect = [[[]], [VECTOR]]
    searches.hybrid.side_effect = [RuntimeError("invalid vector dimension"), CHUNKS]
    pair = make_pair(monkeypatch)
    frame = make_frame()

    asyncio.run(pair.process(frame))

    assert searches.embed.await_count == 2
    assert searches.hybrid.await_args_list[0].kwargs["vector"] == []
    assert searches.hybrid.await_args_list[1].kwargs["vector"] == VECTOR
    assert frame.context.get_messages()[2:] == [ARCHIVE_MESSAGE]


def test_facts_search_failure_keeps_successful_embedding_for_archive(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch
) -> None:
    searches.hybrid.side_effect = [RuntimeError("search unavailable"), CHUNKS]
    pair = make_pair(monkeypatch)
    frame = make_frame()

    asyncio.run(pair.process(frame))

    searches.embed.assert_awaited_once()
    assert searches.hybrid.await_count == 2
    assert frame.context.get_messages()[2:] == [ARCHIVE_MESSAGE]


def test_stale_table_retry_and_archive_reuse_the_successful_embedding(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch
) -> None:
    pair = make_pair(monkeypatch)
    stale_table = searches.tables["persona_facts"]
    reopened_table = FakeTable("persona_facts")
    searches.tables["persona_facts"] = reopened_table
    searches.hybrid.side_effect = [RuntimeError("Not found: data file"), FACTS, CHUNKS]

    asyncio.run(pair.process(make_frame()))

    searches.embed.assert_awaited_once()
    assert searches.open_table.call_count == 3
    assert [args.args[0] for args in searches.hybrid.await_args_list] == [
        stale_table,
        reopened_table,
        searches.tables["stream_chunks"],
    ]


def test_short_and_repeated_queries_continue_to_skip_retrieval(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch
) -> None:
    pair = make_pair(monkeypatch)
    short = make_frame("嗯")
    normal = make_frame()

    async def run() -> None:
        await pair.process(short)
        searches.embed.assert_not_awaited()
        await pair.process(normal)
        await pair.process(LLMContextFrame(normal.context))

    asyncio.run(run())

    assert QUERY_EMBEDDING_CACHE_KEY not in short.metadata
    searches.embed.assert_awaited_once()
    assert searches.hybrid.await_count == 2


@pytest.mark.parametrize("missing", ["persona_facts", "stream_chunks", "both"])
def test_missing_tables_skip_embedding_work(
    searches: SearchMocks, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    for name in searches.tables:
        if missing in (name, "both"):
            searches.tables[name] = None
    pair = make_pair(monkeypatch)
    frame = make_frame()

    asyncio.run(pair.process(frame))

    expected_calls = 0 if missing == "both" else 1
    assert searches.embed.await_count == expected_calls
    assert searches.hybrid.await_count == expected_calls
    assert len(frame.metadata[QUERY_EMBEDDING_CACHE_KEY]) == expected_calls
