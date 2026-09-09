from __future__ import annotations

from datetime import date

import pytest

from laplace_eidolon.stream_time import (
    StreamScope,
    has_stream_time_reference,
    is_stream_elaboration,
    is_stream_followup,
    is_stream_overview,
    is_stream_query,
    resolve_stream_scope,
)

TODAY = date(2026, 9, 9)


@pytest.mark.parametrize(
    ("query", "start", "end"),
    [
        ("What did you stream last week?", "2026-08-31", "2026-09-07"),
        ("上周播了什么？", "2026-08-31", "2026-09-07"),
        ("上上周直播内容", "2026-08-24", "2026-08-31"),
        ("这周直播聊了哪些话题", "2026-09-07", "2026-09-14"),
        ("What did you stream this week?", "2026-09-07", "2026-09-14"),
        ("Summarize the past 7 days", "2026-09-03", "2026-09-10"),
        ("最近七天直播说了什么", "2026-09-03", "2026-09-10"),
        ("过去三十天直播聊了什么", "2026-08-11", "2026-09-10"),
        ("the last 1 day", "2026-09-09", "2026-09-10"),
        ("昨天直播", "2026-09-08", "2026-09-09"),
        ("前天播了什么", "2026-09-07", "2026-09-08"),
        ("the day before yesterday", "2026-09-07", "2026-09-08"),
        ("what happened today", "2026-09-09", "2026-09-10"),
        ("What did you stream last month?", "2026-08-01", "2026-09-01"),
        ("这个月直播总结", "2026-09-01", "2026-10-01"),
        ("2026年9月8日直播播了什么？", "2026-09-08", "2026-09-09"),
        ("25年3月24直播播了什么？", "2025-03-24", "2025-03-25"),
        ("2024年3月直播播了什么？", "2024-03-01", "2024-04-01"),
        ("24年3月直播播了什么？", "2024-03-01", "2024-04-01"),
        ("26年3月 24日直播", "2026-03-24", "2026-03-25"),
        ("9月8号直播", "2026-09-08", "2026-09-09"),
        ("2026-09-08", "2026-09-08", "2026-09-09"),
        ("2026/9/8 stream", "2026-09-08", "2026-09-09"),
        ("What did you stream on September 8?", "2026-09-08", "2026-09-09"),
        ("Sep. 8th, 2025", "2025-09-08", "2025-09-09"),
        ("8 September 2026", "2026-09-08", "2026-09-09"),
        ("9月1日到9月7日直播", "2026-09-01", "2026-09-08"),
        ("9月1日至7日直播", "2026-09-01", "2026-09-08"),
        ("2026-09-01 to 2026-09-07", "2026-09-01", "2026-09-08"),
        ("from September 1 through September 7", "2026-09-01", "2026-09-08"),
        ("between September 1 and September 7", "2026-09-01", "2026-09-08"),
        ("2025年12月30日至1月2日直播", "2025-12-30", "2026-01-03"),
        ("12月30日至2026年1月2日直播", "2025-12-30", "2026-01-03"),
        ("12月30日至1月2日直播", "2025-12-30", "2026-01-03"),
        ("Last week what did you say about ASMR?", "2026-08-31", "2026-09-07"),
        ("上周你说了什么关于ASMR的事情", "2026-08-31", "2026-09-07"),
    ],
)
def test_precise_periods(query: str, start: str, end: str) -> None:
    scope = resolve_stream_scope(query, today=TODAY)
    assert scope is not None
    assert scope.start_date == date.fromisoformat(start)
    assert scope.end_date == date.fromisoformat(end)
    assert scope.latest is None


@pytest.mark.parametrize(
    ("query", "today", "start", "end"),
    [
        ("last week", "2026-01-01", "2025-12-22", "2025-12-29"),
        ("this week", "2026-01-01", "2025-12-29", "2026-01-05"),
        ("last month", "2026-01-01", "2025-12-01", "2026-01-01"),
        ("this month", "2024-02-29", "2024-02-01", "2024-03-01"),
        ("December 31", "2026-01-01", "2025-12-31", "2026-01-01"),
        ("昨天", "2026-01-01", "2025-12-31", "2026-01-01"),
        ("本周", "2026-09-07", "2026-09-07", "2026-09-14"),
        ("2024年2月29日", "2026-09-09", "2024-02-29", "2024-03-01"),
    ],
)
def test_persona_local_calendar_boundaries(
    query: str, today: str, start: str, end: str
) -> None:
    scope = resolve_stream_scope(query, today=date.fromisoformat(today))
    assert scope is not None
    assert (scope.start_date, scope.end_date) == (
        date.fromisoformat(start), date.fromisoformat(end)
    )


@pytest.mark.parametrize(
    ("query", "ordinal"),
    [
        ("What was your last stream's content?", 1),
        ("your latest broadcast", 1),
        ("the most recent stream", 1),
        ("上次直播播了什么", 1),
        ("最近一次直播", 1),
        ("上上次直播聊了什么", 2),
        ("second latest stream", 2),
        ("second-last stream", 2),
    ],
)
def test_latest_ordinal(query: str, ordinal: int) -> None:
    scope = resolve_stream_scope(query, today=TODAY)
    assert scope is not None
    assert scope.latest == ordinal
    assert scope.start_date is None


@pytest.mark.parametrize(
    "query",
    [
        "When were you born?",
        "09/08 stream",
        "9-8 stream",
        "2026-09",
        "2026-13-08 stream",
        "2026年9月31日直播",
        "2025年2月29日直播",
        "2026年9月8日到2026年9月7日直播",
        "9月8日到7日直播",
        "9月8日到9月7日直播",
        "2026-09-08 to 9/10",
        "2026-09-08 to some other date",
        "September 1 and September 7",
        "last week or this week",
        "last week on September 1",
        "last week's latest stream",
        "last week Monday",
        "Monday last week",
        "last week's Monday",
        "last week of August",
        "What did you stream the first day of last week?",
        "What did you stream the last day of last week?",
        "你上周第一天直播播了什么",
        "你上周的最后一天直播播了什么",
        "上周二直播",
        "上周末直播",
        "上上上周直播",
        "上上个月直播",
        "before September 8",
        "around September 8",
        "the week ending September 8",
        "9月8日之前的直播",
        "2024年3月以前的直播内容",
        "2024年3月之后的直播内容",
        "9月1日至7日到8日直播",
        "since September 8",
        "从上周开始的直播",
        "since last week",
        "去年9月8日直播",
        "September 8 last year",
        "past 0 days",
        "past 999 days",
        "那周直播",
        "the week before that",
    ],
)
def test_ambiguous_or_invalid_periods_do_not_produce_partial_filters(query: str) -> None:
    assert resolve_stream_scope(query, today=TODAY) is None


def test_followup_scope() -> None:
    prior = StreamScope(start_date=date(2026, 8, 17), end_date=date(2026, 8, 24))
    same = resolve_stream_scope("那周玩了什么游戏", today=TODAY, previous=prior)
    assert same is not None
    assert (same.start_date, same.end_date) == (prior.start_date, prior.end_date)
    earlier = resolve_stream_scope("the week before that", today=TODAY, previous=prior)
    assert earlier is not None
    assert (earlier.start_date, earlier.end_date) == (date(2026, 8, 10), date(2026, 8, 17))
    assert resolve_stream_scope("that day", today=TODAY, previous=prior) is None
    assert resolve_stream_scope("that stream", today=TODAY, previous=prior) is None


def test_followup_broadcast_requires_an_identified_broadcast() -> None:
    prior = StreamScope(stream_ids=("BV1",), label="a selected broadcast")
    assert resolve_stream_scope("that stream", today=TODAY, previous=prior) == prior
    assert resolve_stream_scope("that week", today=TODAY, previous=prior) is None
    assert resolve_stream_scope("your birthday", today=TODAY, previous=prior) is None


@pytest.mark.parametrize("query", ["那场聊了什么", "那次呢", "上次那场", "那场直播"])
def test_short_broadcast_references(query: str) -> None:
    prior = StreamScope(stream_ids=("BV1",))
    assert is_stream_followup(query)
    assert resolve_stream_scope(query, today=TODAY, previous=prior) == prior


@pytest.mark.parametrize("query", ["the second stream", "第二场直播", "第2次"])
def test_ordinal_selects_displayed_broadcast_order(query: str) -> None:
    prior = StreamScope(stream_ids=("BV3", "BV2", "BV1"))
    assert is_stream_followup(query)
    scope = resolve_stream_scope(query, today=TODAY, previous=prior)
    assert scope is not None
    assert scope.stream_ids == ("BV2",)
    assert resolve_stream_scope(query, today=TODAY) is None


def test_ordinal_cannot_select_unlisted_broadcast() -> None:
    prior = StreamScope(stream_ids=("BV1",))
    assert resolve_stream_scope("the second stream", today=TODAY, previous=prior) is None


def test_week_reference_to_multiple_weeks_is_ambiguous() -> None:
    prior = StreamScope(start_date=date(2026, 8, 1), end_date=date(2026, 9, 1))
    assert resolve_stream_scope("that week", today=TODAY, previous=prior) is None
    assert resolve_stream_scope("week before that", today=TODAY, previous=prior) is None


@pytest.mark.parametrize(
    "query", ["那周呢", "what about that week", "tell me more about that stream"]
)
def test_explicit_temporal_followups(query: str) -> None:
    assert is_stream_followup(query)


@pytest.mark.parametrize("query", ["my birthday is Sept 8", "你生日是9月8日吗", "你好"])
def test_biography_does_not_inherit_archive_context(query: str) -> None:
    assert not is_stream_followup(query)


@pytest.mark.parametrize("query", ["Tell me more", "展开说说", "Please elaborate."])
def test_elaboration_is_scoped_to_previous_selection(query: str) -> None:
    prior = StreamScope(stream_ids=("BV1",))
    assert is_stream_elaboration(query)
    assert is_stream_followup(query)
    assert resolve_stream_scope(query, today=TODAY, previous=prior) == prior
    assert resolve_stream_scope(query, today=TODAY) is None
    assert not is_stream_overview(query)


@pytest.mark.parametrize("query", ["Tell me more about your birthday", "展开说说你的生日"])
def test_specific_new_topics_are_not_elaboration_only(query: str) -> None:
    assert not is_stream_elaboration(query)
    assert not is_stream_followup(query)


@pytest.mark.parametrize(
    "query",
    [
        "那周呢", "the second stream", "9/8 stream", "去年直播", "2024年3月的直播",
        "last Thursday", "last year", "the week before last", "streams in September",
    ],
)
def test_unresolved_time_references_can_use_the_tool(query: str) -> None:
    assert has_stream_time_reference(query)


@pytest.mark.parametrize("query", ["直播说过ASMR吗", "What did you say about ASMR?", "May I ask?"])
def test_topic_only_questions_need_no_time_resolution(query: str) -> None:
    assert not has_stream_time_reference(query)


@pytest.mark.parametrize(
    "query",
    [
        "What was your last stream's content?",
        "What did you stream last week?",
        "What was your stream about last week?",
        "what did you stream on September 8?",
        "Summarize your streams last week",
        "recap last week",
        "What about that week?",
        "你上次直播播了什么？",
        "上周播了什么？",
        "你这周播了啥？",
        "上周直播内容是什么？",
        "9月8日直播播了什么？",
        "9月1日到9月7日直播播了什么？",
        "回顾一下上周的直播",
        "上个月呢？",
    ],
)
def test_overview_questions(query: str) -> None:
    assert is_stream_overview(query)


@pytest.mark.parametrize(
    "query",
    [
        "Last week what did you say about ASMR?",
        "What games did you play that week?",
        "Summarize the ASMR discussion last week",
        "Tell me more about that stream",
        "上周你说了什么关于ASMR的事情",
        "上周玩了什么游戏？",
        "你上周直播为什么哭了？",
        "9月8日直播提到了谁？",
        "回顾一下昨天聊到的相亲经历",
        "What's your birthday?",
    ],
)
def test_detail_questions_are_not_overviews(query: str) -> None:
    assert not is_stream_overview(query)


@pytest.mark.parametrize(
    "query",
    [
        "What was your last stream's content?",
        "What did you stream last week?",
        "Last week what did you say about ASMR?",
        "What games did you play that week?",
        "上周你说了什么关于ASMR的事情",
        "昨天玩了什么游戏",
        "9月8日直播提到了谁",
    ],
)
def test_archive_intent(query: str) -> None:
    assert is_stream_query(query)


@pytest.mark.parametrize("query", ["Were you born on September 8?", "你生日是9月8日吗", "你好"])
def test_unrelated_temporal_questions(query: str) -> None:
    assert not is_stream_query(query)
