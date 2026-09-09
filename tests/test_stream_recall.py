from __future__ import annotations

import asyncio
from datetime import date, timezone
from pathlib import Path
from typing import Any, cast

import pytest
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import AdapterType, ToolsSchema
from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import FunctionCallParams, LLMService

import laplace_eidolon.persona_facts as persona_facts
import laplace_eidolon.stream_archive as stream_archive
from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.retriever import LanceRetriever
from laplace_eidolon.stream_archive import RecallRequest, StreamArchiveService
from laplace_eidolon.stream_catalog import Broadcast, StreamCatalog
from laplace_eidolon.stream_recall import StreamRecall
from laplace_eidolon.stream_time import StreamScope

TODAY = date(2026, 9, 9)


def _broadcast(day: str, bv: str = "BV1abc", parts: int = 1) -> Broadcast:
    broadcast_id = f"{day}-{bv}"
    stream_ids = tuple(f"{broadcast_id}_p{index}" for index in range(1, parts + 1))
    return Broadcast(
        id=broadcast_id,
        stream_date=day,
        stream_ids=stream_ids,
        overview=f"{day} 聊了 ASMR、游戏和观众 SC。",
        source_chunk_ids=tuple(f"{part}::000" for part in stream_ids),
    )


class MemoryCatalog(StreamCatalog):
    def __init__(self, broadcasts: list[Broadcast]) -> None:
        self.items = sorted(broadcasts, key=lambda item: (item.stream_date, item.id), reverse=True)

    def broadcasts(self) -> list[Broadcast]:
        return list(self.items)


class FakeRetriever:
    def __init__(self) -> None:
        self.table: object | None = object()
        self.calls: list[dict[str, Any]] = []
        self.hits = [{"id": "hit-1", "summary": "聊了 ASMR。", "stream_date": "2026-09-08"}]

    async def search(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        self.calls.append({"query": query, **kwargs})
        return self.hits

    def row_count(self) -> int:
        return len(self.hits)


class FakeLLM:
    def __init__(self) -> None:
        self.functions: dict[str, Any] = {}

    def register_function(self, name: str, handler: Any, **kwargs: Any) -> None:
        self.functions[name] = handler


def _recall(broadcasts: list[Broadcast]) -> tuple[StreamRecall, FakeRetriever]:
    retriever = FakeRetriever()
    recall = StreamRecall(
        cast(LanceRetriever, retriever),
        MemoryCatalog(broadcasts),
        timezone=timezone.utc,
        today=lambda: TODAY,
    )
    return recall, retriever


def _service(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[Broadcast]
) -> tuple[StreamArchiveService, FakeRetriever]:
    retriever = FakeRetriever()
    monkeypatch.setattr(stream_archive, "build_retriever", lambda *args, **kwargs: retriever)
    service = StreamArchiveService()
    service.recall = StreamRecall(
        cast(LanceRetriever, retriever),
        MemoryCatalog(broadcasts),
        timezone=timezone.utc,
        today=lambda: TODAY,
    )
    return service, retriever


def _install_tools(service: StreamArchiveService) -> tuple[FakeLLM, ToolsSchema]:
    llm = FakeLLM()
    voice = FunctionSchema(
        name="change_voice_style", description="Change voice", properties={}, required=[]
    )
    custom = {AdapterType.OPENAI: [{"type": "web_search"}]}
    tools = service.install_tool(
        cast(LLMService[Any], llm), ToolsSchema(standard_tools=[voice], custom_tools=custom)
    )
    assert tools is not None
    return llm, tools


async def _tool_call(
    service: StreamArchiveService,
    llm: FakeLLM,
    context: LLMContext,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    responses: list[dict[str, Any]] = []

    async def callback(result: Any, **kwargs: Any) -> None:
        responses.append(result)

    params = FunctionCallParams(
        function_name=stream_archive.RECALL_TOOL_NAME,
        tool_call_id="test-call",
        arguments=arguments,
        llm=cast(LLMService[Any], llm),
        pipeline_worker=cast(Any, None),
        context=context,
        result_callback=callback,
    )
    await service._handle_tool(params)
    assert len(responses) == 1
    return responses[0]


def test_weekly_recap_reads_every_matching_broadcast_without_search() -> None:
    first = _broadcast("2026-09-01", parts=2)
    second = _broadcast("2026-09-06")
    recall, retriever = _recall([first, second, _broadcast("2026-09-08")])
    query = "What did you stream last week?"
    result = asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert result.overview
    assert {broadcast.id for broadcast in result.broadcasts} == {first.id, second.id}
    assert not result.chunks
    assert retriever.calls == []


def test_date_details_cover_recording_parts_with_exact_date_boundaries() -> None:
    broadcast = _broadcast("2026-09-08", parts=2)
    recall, retriever = _recall([broadcast, _broadcast("2026-09-06")])
    query = "What did you say about ASMR on September 8?"
    result = asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert not result.overview
    assert result.chunks == retriever.hits
    assert result.broadcasts[0].stream_ids == broadcast.stream_ids
    assert retriever.calls == [{
        "query": query,
        "candidates": 15,
        "top_k": 3,
        "date_prefilter": False,
        "where": "stream_date >= '2026-09-08' AND stream_date < '2026-09-09'",
    }]


def test_missing_catalog_uses_exact_dates_for_details_but_never_guesses_latest() -> None:
    recall, retriever = _recall([])
    query = "What did you say about ASMR on September 8?"
    asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert retriever.calls[-1]["where"] == (
        "stream_date >= '2026-09-08' AND stream_date < '2026-09-09'"
    )
    retriever.calls.clear()
    query = "What did you say about ASMR in your last stream?"
    result = asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert retriever.calls == []
    assert result.note
    query = "What did you stream last week?"
    result = asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert result.note and not result.broadcasts
    assert retriever.calls == []


def test_date_absent_from_stale_catalog_still_searches_table_with_exact_date() -> None:
    recall, retriever = _recall([_broadcast("2026-09-08")])
    query = "What did you say about ASMR on September 7?"
    result = asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert retriever.calls[-1]["where"] == (
        "stream_date >= '2026-09-07' AND stream_date < '2026-09-08'"
    )
    assert result.chunks == retriever.hits
    assert not result.broadcasts


def test_latest_same_day_broadcasts_are_kept_together_without_invented_order() -> None:
    first = _broadcast("2026-09-08", "BV1abc")
    second = _broadcast("2026-09-08", "BV2def")
    recall, retriever = _recall([first, second, _broadcast("2026-09-06")])
    query = "What was your last stream's content?"
    result = asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert {broadcast.id for broadcast in result.broadcasts} == {first.id, second.id}
    assert retriever.calls == []
    assert result.note


def test_same_day_order_warning_survives_missing_details() -> None:
    recall, retriever = _recall([
        _broadcast("2026-09-08", "BV1abc"), _broadcast("2026-09-08", "BV2def"),
    ])
    retriever.hits = []
    query = "What did you say about ASMR in your last stream?"
    result = asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert "先后" in result.note
    assert "没有找到" in result.note


def test_latest_recall_keeps_dates_for_followup_week() -> None:
    latest = _broadcast("2026-09-08")
    same_week = _broadcast("2026-09-07")
    recall, retriever = _recall([latest, same_week, _broadcast("2026-09-06")])
    query = "What was your last stream's content?"
    asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    query = "What did you play that week?"
    scope = recall.resolve(query)
    assert scope is not None
    result = asyncio.run(recall.lookup(query, scope=scope))
    assert {broadcast.id for broadcast in result.broadcasts} == {latest.id, same_week.id}
    assert retriever.calls[-1]["where"] == (
        "stream_date >= '2026-09-07' AND stream_date < '2026-09-14'"
    )


def test_followup_details_stay_in_previously_selected_week() -> None:
    first = _broadcast("2026-09-01")
    second = _broadcast("2026-09-06")
    recall, retriever = _recall([first, second, _broadcast("2026-09-08")])
    query = "What did you stream last week?"
    asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    query = "What did you say about ASMR that week?"
    asyncio.run(recall.lookup(query, scope=recall.resolve(query)))
    assert retriever.calls[-1]["where"] == (
        "stream_date >= '2026-08-31' AND stream_date < '2026-09-07'"
    )


def test_arbitrary_biographical_date_does_not_reuse_archive_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, retriever = _service(monkeypatch, [_broadcast("2026-09-08")])
    context = LLMContext([{"role": "user", "content": "What was your last stream's content?"}])
    asyncio.run(service._enhance(context, "What was your last stream's content?"))
    retriever.calls.clear()
    query = "I was born on September 8."
    context.add_message({"role": "user", "content": query})
    asyncio.run(service._enhance(context, query))
    assert all(call.get("where") is None for call in retriever.calls)
    assert not any(
        "查询范围" in str(message.get("content", ""))
        for message in context.get_messages()
        if isinstance(message, dict)
    )


def test_short_chinese_followup_resolves_latest_turn_without_history_conflict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, retriever = _service(
        monkeypatch, [_broadcast("2026-09-08"), _broadcast("2026-09-01")]
    )
    pushed: list[Frame] = []

    async def push(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        pushed.append(frame)

    monkeypatch.setattr(service, "push_frame", push)
    context = LLMContext([{"role": "user", "content": "你2026年9月8日直播播了什么？"}])

    async def run() -> None:
        await service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        context.add_message({"role": "assistant", "content": "聊了 ASMR 和游戏。"})
        context.add_message({"role": "user", "content": "那周呢？"})
        await service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)

    asyncio.run(run())
    assert len(pushed) == 2
    assert retriever.calls == []
    assert service.recall.selected_scope is not None
    assert service.recall.selected_scope.start_date == date(2026, 9, 7)
    assert service.recall.selected_scope.end_date == date(2026, 9, 14)


def test_same_text_new_user_turn_retrieves_again_without_accumulating_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, retriever = _service(monkeypatch, [_broadcast("2026-09-08")])
    query = "What did you say about ASMR on September 8?"
    context = LLMContext([{"role": "system", "content": "Keep persona rules"},
                          {"role": "user", "content": query}])
    pushed: list[Frame] = []

    async def push(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        pushed.append(frame)

    monkeypatch.setattr(service, "push_frame", push)

    async def run() -> None:
        await service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        await service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        assert len(retriever.calls) == 1
        context.add_message({"role": "assistant", "content": "聊了 ASMR。"})
        context.add_message({"role": "user", "content": query})
        await service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)

    asyncio.run(run())
    assert len(retriever.calls) == 2
    contents = [
        str(message.get("content", ""))
        for message in context.get_messages() if isinstance(message, dict)
    ]
    assert sum(content.startswith("最近已归档的直播概览：") for content in contents) == 1
    assert sum(content.startswith("本次直播回忆查询：") for content in contents) == 1
    assert "Keep persona rules" in contents


@pytest.mark.parametrize(
    "arguments",
    [
        {"query": "", "mode": "overview", "period": "latest"},
        {"query": "x", "mode": "invent", "period": "latest"},
        {"query": "x", "mode": "overview", "period": "past_days", "days": 367},
        {"query": "x", "mode": "overview", "period": "latest", "sql": "DROP TABLE"},
    ],
)
def test_tool_rejects_invalid_requests_without_retrieval(
    monkeypatch: pytest.MonkeyPatch, arguments: dict[str, Any]
) -> None:
    service, retriever = _service(monkeypatch, [_broadcast("2026-09-08")])
    llm, tools = _install_tools(service)
    context = LLMContext([{"role": "user", "content": "Recall a stream"}], tools=tools)
    result = asyncio.run(_tool_call(service, llm, context, arguments))
    assert "error" in result
    assert retriever.calls == []


@pytest.mark.parametrize(
    "fields",
    [
        {"period": "selected"},
        {"period": "date_range"},
        {"period": "date_range", "start_date": "2026-09-09", "end_date": "2026-09-08"},
    ],
)
def test_tool_scope_requires_available_selection_or_valid_dates(
    monkeypatch: pytest.MonkeyPatch, fields: dict[str, Any]
) -> None:
    service, _ = _service(monkeypatch, [])
    request = RecallRequest.model_validate({"query": "recap", "mode": "overview", **fields})
    with pytest.raises(ValueError):
        service._tool_scope(request)


def test_tool_budget_retains_voice_and_custom_tools_then_resets_next_user_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, retriever = _service(monkeypatch, [_broadcast("2026-09-08")])
    llm, tools = _install_tools(service)
    context = LLMContext([{"role": "user", "content": "Recall a stream"}], tools=tools)
    args = {"query": "recap", "mode": "overview", "period": "latest"}

    async def run() -> None:
        assert "content" in await _tool_call(service, llm, context, args)
        assert "content" in await _tool_call(service, llm, context, args)
        assert "error" in await _tool_call(service, llm, context, args)
        limited = cast(ToolsSchema, context.tools)
        assert [tool.name for tool in limited.standard_tools] == ["change_voice_style"]
        assert limited.custom_tools == tools.custom_tools
        context.add_message({"role": "assistant", "content": "聊了 ASMR。"})
        context.add_message({"role": "user", "content": "Recall a stream"})
        assert "content" in await _tool_call(service, llm, context, args)
        restored = cast(ToolsSchema, context.tools)
        assert {tool.name for tool in restored.standard_tools} == {
            "change_voice_style", stream_archive.RECALL_TOOL_NAME,
        }

    asyncio.run(run())
    assert retriever.calls == []
    assert stream_archive.RECALL_TOOL_NAME in llm.functions


def test_tool_selected_scope_cannot_widen_details_to_other_dates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    selected = _broadcast("2026-09-01", parts=2)
    service, retriever = _service(monkeypatch, [selected, _broadcast("2026-09-08")])
    service.recall.selected_scope = StreamScope(stream_ids=(selected.id,), label="selected")
    llm, tools = _install_tools(service)
    context = LLMContext([{"role": "user", "content": "Tell me about ASMR"}], tools=tools)
    args = {"query": "ASMR", "mode": "details", "period": "selected"}
    result = asyncio.run(_tool_call(service, llm, context, args))
    assert "content" in result
    assert retriever.calls[-1]["where"] == (
        "stream_id IN ('2026-09-01-BV1abc_p1', '2026-09-01-BV1abc_p2')"
    )


def test_tool_is_not_advertised_without_catalog_or_archive_table(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    service, retriever = _service(monkeypatch, [])
    service.recall.catalog = StreamCatalog(tmp_path)
    retriever.table = None
    llm = FakeLLM()
    assert service.install_tool(cast(LLMService[Any], llm), None) is None
    assert llm.functions == {}


def test_tool_broadcast_selection_rejects_any_unknown_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broadcast = _broadcast("2026-09-08", parts=2)
    service, retriever = _service(monkeypatch, [broadcast])
    llm, tools = _install_tools(service)
    context = LLMContext([{"role": "user", "content": "Tell me about that broadcast"}], tools=tools)

    async def run() -> None:
        args = {
            "query": "ASMR", "mode": "details", "period": "broadcasts",
            "broadcast_ids": [broadcast.id, "invented-broadcast"],
        }
        assert "error" in await _tool_call(service, llm, context, args)
        assert retriever.calls == []
        args["broadcast_ids"] = [broadcast.id]
        response = await _tool_call(service, llm, context, args)
        assert response["broadcast_ids"] == [broadcast.id]
        assert retriever.calls[-1]["where"] == (
            "stream_id IN ('2026-09-08-BV1abc_p1', '2026-09-08-BV1abc_p2')"
        )

    asyncio.run(run())


@pytest.mark.parametrize("query", ["Tell me more", "展开说说"])
def test_elaboration_followup_never_searches_global_archive(
    monkeypatch: pytest.MonkeyPatch, query: str,
) -> None:
    broadcast = _broadcast("2026-09-08", parts=2)
    service, retriever = _service(monkeypatch, [broadcast, _broadcast("2026-09-01")])
    _, tools = _install_tools(service)
    initial = "What was your last stream's content?"
    context = LLMContext([{"role": "user", "content": initial}], tools=tools)

    async def run() -> None:
        await service._enhance(context, initial)
        context.add_message({"role": "assistant", "content": "聊了 ASMR 和游戏。"})
        context.add_message({"role": "user", "content": query})
        await service._enhance(context, query)

    asyncio.run(run())
    for call in retriever.calls:
        assert call.get("where") == (
            "stream_id IN ('2026-09-08-BV1abc_p1', '2026-09-08-BV1abc_p2')"
        )


def test_recap_pipeline_skips_facts_on_first_pass_and_tool_continuation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive, archive_retriever = _service(monkeypatch, [_broadcast("2026-09-08")])
    facts_retriever = FakeRetriever()
    facts_retriever.hits = [{"text": "喜欢奶茶", "date": "2026-09-01"}]
    monkeypatch.setattr(persona_facts, "build_retriever", lambda *args, **kwargs: facts_retriever)
    facts = PersonaFactsService()
    pushed: list[Frame] = []

    async def route(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        await facts.process_frame(frame, direction)

    async def sink(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        pushed.append(frame)

    monkeypatch.setattr(archive, "push_frame", route)
    monkeypatch.setattr(facts, "push_frame", sink)
    context = LLMContext([{"role": "user", "content": "What was your last stream's content?"}])

    async def run() -> None:
        await archive.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        assert archive_retriever.calls == []
        assert facts_retriever.calls == []
        context.add_message({"role": "assistant", "content": "", "tool_calls": [{
            "id": "recall-1", "type": "function", "function": {
                "name": stream_archive.RECALL_TOOL_NAME,
                "arguments": '{"query":"ASMR","mode":"details","period":"selected"}',
            },
        }]})
        context.add_message({"role": "tool", "tool_call_id": "recall-1",
                             "content": "聊了喜欢的 ASMR。"})
        await archive.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
        assert archive_retriever.calls == []
        assert facts_retriever.calls == []
        context.add_message({"role": "user", "content": "What is your favorite food?"})
        await archive.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)

    asyncio.run(run())
    assert len(pushed) == 3
    assert len(facts_retriever.calls) == 1
    assert facts_retriever.calls[0]["query"] == "What is your favorite food?"


def test_elaboration_after_unrelated_birthday_does_not_reopen_archive_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, retriever = _service(monkeypatch, [_broadcast("2026-09-08")])
    _, tools = _install_tools(service)
    first = "What was your last stream's content?"
    context = LLMContext([{"role": "user", "content": first}], tools=tools)

    async def run() -> None:
        await service._enhance(context, first)
        context.add_message({"role": "assistant", "content": "聊了 ASMR。"})
        unrelated = "My birthday is on September 8."
        context.add_message({"role": "user", "content": unrelated})
        await service._enhance(context, unrelated)
        context.add_message({"role": "assistant", "content": "那时候一起庆祝生日吧。"})
        query = "Tell me more"
        context.add_message({"role": "user", "content": query})
        retriever.calls.clear()
        await service._enhance(context, query)

    asyncio.run(run())
    assert all(call.get("where") is None for call in retriever.calls)
    assert not any(
        "查询范围" in str(message.get("content", ""))
        for message in context.get_messages() if isinstance(message, dict)
    )


def test_cancelled_recall_tool_does_not_replace_selected_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, retriever = _service(
        monkeypatch, [_broadcast("2026-09-08"), _broadcast("2026-09-01")]
    )
    previous = StreamScope(stream_ids=("2026-09-01-BV1abc",), label="previous selection")
    service.recall.selected_scope = previous
    llm, tools = _install_tools(service)
    context = LLMContext([{"role": "user", "content": "ASMR in the latest stream"}], tools=tools)

    async def run() -> None:
        started = asyncio.Event()

        async def blocked_search(query: str, **kwargs: Any) -> list[dict[str, Any]]:
            started.set()
            await asyncio.Event().wait()
            return []

        monkeypatch.setattr(retriever, "search", blocked_search)
        task = asyncio.create_task(_tool_call(service, llm, context, {
            "query": "ASMR", "mode": "details", "period": "latest",
        }))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert service.recall.selected_scope == previous


def test_ambiguous_broadcast_followup_requests_tool_selection_without_global_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, retriever = _service(
        monkeypatch, [_broadcast("2026-09-01"), _broadcast("2026-09-06")]
    )
    _, tools = _install_tools(service)
    first = "你上周直播播了什么？"
    context = LLMContext([{"role": "user", "content": first}], tools=tools)

    async def run() -> None:
        await service._enhance(context, first)
        assert service.recall.selected_scope is not None
        assert len(service.recall.selected_scope.stream_ids) == 2
        context.add_message({"role": "assistant", "content": "有两场，聊了 ASMR 和游戏。"})
        query = "那场再多说一点"
        context.add_message({"role": "user", "content": query})
        await service._enhance(context, query)

    asyncio.run(run())
    assert retriever.calls == []
    recall_blocks = [
        str(message.get("content")) for message in context.get_messages()
        if isinstance(message, dict)
        and str(message.get("content", "")).startswith("本次直播回忆查询：")
    ]
    assert len(recall_blocks) == 1
    assert stream_archive.RECALL_TOOL_NAME in recall_blocks[0]
