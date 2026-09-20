from __future__ import annotations

import asyncio
import json
from datetime import timezone
from typing import Any, cast

import httpx
import pytest
from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection

import laplace_eidolon.persona_facts as persona_facts
import laplace_eidolon.retrieval_gate as retrieval_gate
import laplace_eidolon.stream_archive as stream_archive
from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.retrieval_gate import (
    GATE_FRAME_KEY,
    RetrievalGate,
    gate_state,
    unless_skipped,
)
from laplace_eidolon.retriever import LanceRetriever
from laplace_eidolon.stream_archive import StreamArchiveService
from laplace_eidolon.stream_catalog import Broadcast, StreamCatalog
from laplace_eidolon.stream_recall import StreamRecall

HIT = [{"text": "喜欢奶茶", "date": "2026-09-01", "stream_date": "2026-09-01"}]


class SlowSearch:
    def __init__(self) -> None:
        self.started = False
        self.cancelled = False
        self.release = asyncio.Event()

    async def __call__(self) -> list[dict[str, Any]]:
        self.started = True
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return HIT


class FakeRetriever:
    def __init__(self) -> None:
        self.table: object | None = object()
        self.queries: list[str] = []

    async def search(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        self.queries.append(query)
        return HIT

    def row_count(self) -> int:
        return len(HIT)


class EmptyCatalog(StreamCatalog):
    def __init__(self) -> None:
        pass

    def broadcasts(self) -> list[Broadcast]:
        return []


def _decided(verdict: bool | None) -> asyncio.Future[bool]:
    future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
    future.set_result(cast(bool, verdict))
    return future


async def _sink(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
    pass


async def _ticks() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


def test_skip_before_the_search_finishes_cancels_it() -> None:
    async def run() -> None:
        search = SlowSearch()
        decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        pending = asyncio.ensure_future(unless_skipped(decision, search))
        await _ticks()
        assert search.started
        decision.set_result(False)
        assert await pending == []
        await _ticks()
        assert search.cancelled

    asyncio.run(run())


def test_search_that_beats_the_gate_is_kept() -> None:
    async def run() -> None:
        decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

        async def search() -> list[dict[str, Any]]:
            return HIT

        assert await unless_skipped(decision, search) == HIT

    asyncio.run(run())


def test_settled_skip_never_starts_the_search() -> None:
    async def run() -> None:
        search = SlowSearch()
        assert await unless_skipped(_decided(False), search) == []
        assert not search.started

    asyncio.run(run())


@pytest.mark.parametrize("verdict", [True, None])
def test_retrieve_or_a_swallowed_failure_waits_for_the_search(verdict: bool | None) -> None:
    async def run() -> None:
        search = SlowSearch()
        decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        pending = asyncio.ensure_future(unless_skipped(decision, search))
        await _ticks()
        decision.set_result(cast(bool, verdict))
        await _ticks()
        assert not pending.done()
        search.release.set()
        assert await pending == HIT

    asyncio.run(run())


def test_state_is_the_latest_user_line_and_the_exchange_before_it() -> None:
    messages: list[Any] = [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "你好呀"},
        {"role": "system", "content": "你过去在直播里说过 / 设定过的相关事实"},
        {"role": "user", "content": "你家有宠物吗？"},
        {"role": "assistant", "content": "有只猫叫坚果。"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "x"}]},
        {"role": "user", "content": " 它几岁了？ "},
    ]
    state = gate_state(messages)
    assert state is not None
    assert state["viewer_latest_message"] == "它几岁了？"
    assert state["earlier_turns"] == [
        {"speaker": "viewer", "text": "你家有宠物吗？"},
        {"speaker": "streamer", "text": "有只猫叫坚果。"},
    ]
    assert gate_state([{"role": "system", "content": "x"}]) is None


def _gate(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> tuple[RetrievalGate, list[Frame]]:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(retrieval_gate, "_client", client)
    gate = RetrievalGate(api_key="test")
    pushed: list[Frame] = []

    async def push(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        pushed.append(frame)

    def create_task(coroutine: Any, name: str | None = None) -> asyncio.Task[Any]:
        return asyncio.ensure_future(coroutine)

    monkeypatch.setattr(gate, "push_frame", push)
    monkeypatch.setattr(gate, "create_task", create_task)
    return gate, pushed


def test_gate_asks_once_per_user_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        score = 0.9 if "坚果" in body["state"]["viewer_latest_message"] else 0.05
        return httpx.Response(200, json={"answers": {
            name: {"type": "noul", "noul": score} for name in body["questions"]
        }})

    gate, pushed = _gate(monkeypatch, handler)
    context = LLMContext([{"role": "user", "content": "哈哈哈哈"}])

    async def run() -> list[bool]:
        await gate.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        await gate.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        context.add_message({"role": "assistant", "content": "嘿嘿"})
        context.add_message({"role": "user", "content": "坚果几岁了？"})
        await gate.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        decisions = [frame.metadata[GATE_FRAME_KEY] for frame in pushed]
        assert decisions[0] is decisions[1]
        return [await decision for decision in decisions]

    assert asyncio.run(run()) == [False, False, True]
    assert len(bodies) == 2
    assert bodies[0]["model"] == retrieval_gate.DEFAULT_MODEL


def test_gate_fails_open_when_the_decision_route_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    gate, pushed = _gate(monkeypatch, lambda request: httpx.Response(503))
    context = LLMContext([{"role": "user", "content": "哈哈哈哈"}])

    async def run() -> bool:
        await gate.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        return await pushed[0].metadata[GATE_FRAME_KEY]

    assert asyncio.run(run()) is True


def test_both_tiers_search_only_turns_the_gate_lets_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    facts_retriever, archive_retriever = FakeRetriever(), FakeRetriever()
    monkeypatch.setattr(persona_facts, "build_retriever", lambda *a, **k: facts_retriever)
    monkeypatch.setattr(stream_archive, "build_retriever", lambda *a, **k: archive_retriever)
    facts = PersonaFactsService()
    archive = StreamArchiveService()
    archive.recall = StreamRecall(
        cast(LanceRetriever, archive_retriever), EmptyCatalog(), timezone=timezone.utc
    )
    async def route(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        await facts.process_frame(frame, direction)

    monkeypatch.setattr(archive, "push_frame", route)
    monkeypatch.setattr(facts, "push_frame", _sink)

    async def run() -> None:
        for text, verdict in (("我今天加班好累啊。", False), ("你最喜欢吃什么呀？", True)):
            frame = LLMContextFrame(LLMContext([{"role": "user", "content": text}]))
            frame.metadata[GATE_FRAME_KEY] = _decided(verdict)
            await archive.process_frame(frame, FrameDirection.DOWNSTREAM)

    asyncio.run(run())
    assert facts_retriever.queries == ["你最喜欢吃什么呀？"]
    assert archive_retriever.queries == ["你最喜欢吃什么呀？"]
