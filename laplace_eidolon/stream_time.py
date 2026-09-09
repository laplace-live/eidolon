"""Resolve common archive periods before the conversational model runs."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class StreamScope:
    start_date: date | None = None
    end_date: date | None = None
    latest: int | None = None
    stream_ids: tuple[str, ...] = ()
    label: str = ""


_NUMBER = r"(?:\d{1,3}|[一二三四五六七八九十两]{1,3})"
_MONTH = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
_DATE = re.compile(
    rf"(?<![\d/\-])(?:"
    r"(?P<iso_year>\d{4})[-/](?P<iso_month>\d{1,2})[-/](?P<iso_day>\d{1,2})(?!\d)"
    r"|(?:(?P<zh_year>\d{4}|\d{2})年\s*)?(?P<zh_month>\d{1,2})月\s*"
    r"(?P<zh_day>\d{1,2})(?:日|号)?(?!\d)"
    rf"|\b(?P<en_month>{_MONTH})\.?\s+(?P<en_day>\d{{1,2}})(?:st|nd|rd|th)?"
    r"(?:,?\s+(?P<en_year>\d{4}))?\b"
    rf"|\b(?P<day_first>\d{{1,2}})(?:st|nd|rd|th)?\s+(?P<month_last>{_MONTH})\.?"
    r"(?:,?\s+(?P<year_last>\d{4}))?\b)",
    re.IGNORECASE,
)
_RELATIVE = re.compile(
    rf"\b(?:this|last|previous)\s+(?:week|month)\b"
    rf"|\b(?:the\s+)?(?:past|last)\s+{_NUMBER}\s+days?\b"
    r"|\b(?:the\s+)?day before yesterday\b|\byesterday\b|\btoday\b"
    rf"|(?:过去|最近|近){_NUMBER}天"
    r"|上上周|上周|这周|本周|上星期|这星期|本星期|上个月|这个月|本月|上月"
    r"|大前天|前天|昨天|今天",
    re.IGNORECASE,
)
_LATEST = re.compile(
    r"\b(?:(?:second|2nd)[ -](?:last|latest|most recent)|last but one)\s+"
    r"(?:live\s*)?(?:stream|broadcast)\b"
    r"|\b(?:last|latest|most recent|previous)\s+(?:live\s*)?(?:stream|broadcast)\b"
    r"|(?:上上次|上上场|上次|上一场|上一次|最近一次|最后一次)(?:的)?(?:直播)?",
    re.IGNORECASE,
)
_FOLLOWUP = re.compile(
    r"\b(?:that|same)\s+(?:week|month|day|stream|broadcast)\b"
    r"|\b(?:the\s+)?week before that\b|(?:上次)?那(?:一)?(?:周|星期|个月|天|场(?:直播)?|次(?:直播)?)"
    r"|同一(?:周|天|场直播)|再前一周",
    re.IGNORECASE,
)
_ORDINAL_FOLLOWUP = re.compile(
    r"\b(?:the\s+)?(?P<en>first|second|third|\d+(?:st|nd|rd|th))\s+"
    r"(?:stream|broadcast)\b|第(?P<zh>[一二三四五六七八九十]|\d{1,2})(?:场|次)(?:直播)?",
    re.IGNORECASE,
)
_ELABORATION = re.compile(
    r"(?:please )?(?:tell me more|go on|elaborate)(?: please)?|"
    r"(?:请)?(?:展开(?:说说|讲讲)|再(?:说说|讲讲)|详细(?:说说|讲讲))(?:吧|呗)?",
    re.IGNORECASE,
)
_RANGE_JOIN = re.compile(r"\s*(?:到|至|—|–|~|～|-|to|through|until)\s*", re.IGNORECASE)
_YEAR_MONTH = re.compile(r"(?<!\d)(\d{4}|\d{2})年\s*(\d{1,2})月(?!\s*\d)")
_WEEKDAY = re.compile(
    r"\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|"
    r"sat(?:urday)?|sun(?:day)?)\b|(?:周|星期)[一二三四五六日天末]",
    re.IGNORECASE,
)
_MONTHS = {
    month: index
    for index, month in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"),
        start=1,
    )
}


def _number(text: str) -> int:
    if text.isdigit():
        return int(text)
    digits = dict(zip("一二三四五六七八九", range(1, 10))) | {"两": 2}
    if "十" in text:
        tens, units = text.split("十", 1)
        return digits.get(tens, 1) * 10 + digits.get(units, 0)
    return digits.get(text, 0)


def _date_parts(match: re.Match[str]) -> tuple[int | None, int, int]:
    if match["iso_year"]:
        return int(match["iso_year"]), int(match["iso_month"]), int(match["iso_day"])
    if match["zh_month"]:
        year = int(match["zh_year"]) if match["zh_year"] else None
        return (
            2000 + year if year is not None and year < 100 else year,
            int(match["zh_month"]),
            int(match["zh_day"]),
        )
    year = match["en_year"] or match["year_last"]
    month = match["en_month"] or match["month_last"]
    day = match["en_day"] or match["day_first"]
    return int(year) if year else None, _MONTHS[month[:3].lower()], int(day)


def _inferred_date(year: int | None, month: int, day: int, today: date) -> date:
    if year is not None:
        return date(year, month, day)
    inferred = date(today.year, month, day)
    if inferred > today:
        inferred = date(today.year - 1, month, day)
    return inferred


def _range(start: date, end: date) -> StreamScope:
    return StreamScope(start_date=start, end_date=end, label=f"{start} 至 {end - timedelta(days=1)}")


def _explicit_scope(query: str, today: date) -> tuple[bool, StreamScope | None]:
    matches = list(_DATE.finditer(query))
    months = list(_YEAR_MONTH.finditer(query))
    if not matches and len(months) == 1:
        year, month = (int(part) for part in months[0].groups())
        year = year + 2000 if year < 100 else year
        try:
            start = date(year, month, 1)
            end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        except (ValueError, OverflowError):
            return True, None
        remainder = _YEAR_MONTH.sub("", query)
        if re.search(r"\d+[年月/\-]|之前|以前|之后|以后|以来|左右|"
                     r"\b(?:since|before|after|until)\b",
                     remainder, re.IGNORECASE):
            return True, None
        return True, _range(start, end)
    remainder = _DATE.sub("", query)
    if re.search(r"\d{1,4}[/\-]\d{1,2}|\d+月\d|\d{2,4}年", remainder):
        return True, None
    if not matches:
        return False, None
    if re.search(r"去年|前年|今年|明年|\b(?:last|this|next) year\b", query, re.IGNORECASE):
        return True, None
    if re.search(r"\b(?:before|after|since|until|around|ending|starting)\s*$|"
                 r"(?:早于|晚于|自从|大约)\s*$",
                 query[:matches[0].start()], re.IGNORECASE):
        return True, None
    if re.match(r"\s*(?:之前|以前|之后|以后|左右|起|\bonward\b)",
                query[matches[-1].end():], re.IGNORECASE):
        return True, None
    parts = [_date_parts(match) for match in matches]
    if len(parts) == 1:
        trailing = query[matches[0].end():]
        short_end = re.match(r"\s*(?:到|至|—|–|~|～|-)\s*(\d{1,2})(?:日|号)(?!\d)", trailing)
        if short_end:
            year, month, _ = parts[0]
            parts.append((year, month, int(short_end[1])))
            if re.match(r"\s*(?:到|至|—|–|~|～|-)", trailing[short_end.end():]):
                return True, None
        elif re.match(r"\s*(?:到|至|—|–|~|～|-|\bto\b|\bthrough\b|\buntil\b)", trailing,
                      re.IGNORECASE):
            return True, None
    else:
        if len(parts) != 2:
            return True, None
        join = query[matches[0].end():matches[1].start()]
        between = re.search(r"\bbetween\s*$", query[:matches[0].start()], re.IGNORECASE)
        if not _RANGE_JOIN.fullmatch(join) and not (between and join.strip().lower() == "and"):
            return True, None
    try:
        if len(parts) == 1:
            start = _inferred_date(*parts[0], today)
            return True, _range(start, start + timedelta(days=1))
        start_year, start_month, start_day = parts[0]
        end_year, end_month, end_day = parts[1]
        crosses_year = start_month > end_month
        if start_year is not None and end_year is None:
            end_year = start_year + int(crosses_year)
        elif end_year is not None and start_year is None:
            start_year = end_year - int(crosses_year)
        elif start_year is None and end_year is None:
            end_year = _inferred_date(None, end_month, end_day, today).year
            start_year = end_year - int(crosses_year)
        start = date(start_year or today.year, start_month, start_day)
        end = date(end_year or today.year, end_month, end_day)
        if start > end or end - start > timedelta(days=366):
            return True, None
        return True, _range(start, end + timedelta(days=1))
    except (ValueError, OverflowError):
        return True, None


def _relative_scope(text: str, today: date) -> StreamScope | None:
    normalized = text.lower()
    if re.search(r"week|周|星期", normalized):
        weeks_back = 2 if text == "上上周" else int(
            bool(re.search(r"last|previous|上", normalized))
        )
        start = today - timedelta(days=today.weekday() + 7 * weeks_back)
        return _range(start, start + timedelta(days=7))
    if re.search(r"month|月", normalized):
        start = today.replace(day=1)
        if re.search(r"last|previous|上", normalized):
            return _range((start - timedelta(days=1)).replace(day=1), start)
        end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        return _range(start, end)
    number = re.search(_NUMBER, normalized)
    if number:
        days = _number(number[0])
        if 1 <= days <= 366:
            return _range(today - timedelta(days=days - 1), today + timedelta(days=1))
        return None
    days_back = {
        "today": 0, "今天": 0, "yesterday": 1, "昨天": 1, "前天": 2, "大前天": 3,
        "day before yesterday": 2, "the day before yesterday": 2,
    }.get(normalized)
    if days_back is not None:
        day = today - timedelta(days=days_back)
        return _range(day, day + timedelta(days=1))
    return None


def resolve_stream_scope(
    query: str, *, today: date, previous: StreamScope | None = None
) -> StreamScope | None:
    """Resolve a period, with exclusive end dates and a one-based latest broadcast ordinal."""
    if is_stream_elaboration(query):
        return previous
    explicit, scope = _explicit_scope(query, today)
    relative = list(_RELATIVE.finditer(query))
    followup = list(_FOLLOWUP.finditer(query))
    latest = [
        match for match in _LATEST.finditer(query)
        if not any(item.start() <= match.start() and match.end() <= item.end() for item in followup)
    ]
    ordinal_followup = list(_ORDINAL_FOLLOWUP.finditer(query))
    if _WEEKDAY.search(query) and (explicit or relative):
        return None
    if explicit:
        return scope if not (relative or latest or followup or ordinal_followup) else None
    if len(relative) + len(latest) + len(followup) + len(ordinal_followup) != 1:
        return None
    if relative:
        match = relative[0]
        if match.start() and query[match.start() - 1] in "上大":
            return None
        if re.match(r"[一二三四五六日天末]|\s+(?:of|before|after|until|through)\b",
                    query[match.end():], re.IGNORECASE):
            return None
        if re.match(r"(?:的)?(?:第一天|最后一天)", query[match.end():]):
            return None
        if re.search(r"\b(?:first|last) day of\s*$", query[:match.start()], re.IGNORECASE):
            return None
        if re.search(r"\b(?:before|after|since|until)\s*$|(?:截至|从)\s*$",
                     query[:match.start()], re.IGNORECASE):
            return None
        return _relative_scope(match[0], today)
    if latest:
        text = latest[0][0].lower()
        ordinal = 2 if re.search(r"second|2nd|but one|上上", text) else 1
        return StreamScope(latest=ordinal, label="最近一次直播" if ordinal == 1 else "上上次直播")
    if previous is None:
        return None
    if ordinal_followup:
        match = ordinal_followup[0]
        value = (match["en"] or match["zh"]).lower()
        ordinal = {"first": 1, "second": 2, "third": 3}.get(value)
        if ordinal is None:
            ordinal = _number(re.sub(r"(?:st|nd|rd|th)$", "", value))
        if not 1 <= ordinal <= len(previous.stream_ids):
            return None
        return StreamScope(
            stream_ids=(previous.stream_ids[ordinal - 1],),
            label=f"上次查询结果中的第{ordinal}场直播",
        )
    text = followup[0][0].lower()
    if re.search(r"week|周|星期", text):
        if previous.start_date is None or previous.end_date is None:
            return None
        week_start = previous.start_date - timedelta(days=previous.start_date.weekday())
        if previous.end_date > week_start + timedelta(days=7):
            return None
    if "before" in text or text == "再前一周":
        if previous.start_date is None:
            return None
        end = previous.start_date - timedelta(days=previous.start_date.weekday())
        return _range(end - timedelta(days=7), end)
    if re.search(r"week|周|星期", text):
        if previous.start_date is None:
            return None
        start = previous.start_date - timedelta(days=previous.start_date.weekday())
        return _range(start, start + timedelta(days=7))
    if re.search(r"month|月", text):
        if previous.start_date is None or previous.end_date is None:
            return None
        end = previous.end_date - timedelta(days=1)
        if (end.year, end.month) != (previous.start_date.year, previous.start_date.month):
            return None
        return _relative_scope("this month", previous.start_date)
    if re.search(r"day|天", text):
        if previous.start_date is None or previous.end_date != (
            previous.start_date + timedelta(days=1)
        ):
            return None
    elif previous.latest is None and len(previous.stream_ids) != 1:
        return None
    return previous


def is_stream_elaboration(query: str) -> bool:
    return bool(_ELABORATION.fullmatch(query.strip(" \t\n?!？！。.")))


def is_stream_followup(query: str) -> bool:
    return bool(
        _FOLLOWUP.search(query) or _ORDINAL_FOLLOWUP.search(query)
        or is_stream_elaboration(query)
    )


def has_stream_time_reference(query: str) -> bool:
    if any(pattern.search(query) for pattern in (
        _DATE, _YEAR_MONTH, _RELATIVE, _LATEST, _FOLLOWUP, _ORDINAL_FOLLOWUP, _WEEKDAY
    )):
        return True
    return bool(re.search(
        rf"\d{{1,4}}[/\-]\d{{1,2}}|\d+[年月日号]|去年|前年|今年|明年|"
        rf"\b(?:last|this|next|previous|past)\s+(?:\w+\s+)?(?:week|month|year|days?)\b|"
        rf"\b(?:week|month|year)\s+(?:before|after)\b|"
        rf"\b(?:in|during|from|to|since|until)\s+{_MONTH}\b|\b{_MONTH}\s+\d",
        query, re.IGNORECASE,
    ))


def is_stream_query(query: str) -> bool:
    if re.search(
        r"\b(?:streams?|streamed|streaming|broadcasts?|broadcasted|vods?)\b|直播|录播|"
        r"(?:上次|上周|这周|本周|昨天|前天|上个月|那周|那天).{0,12}(?:播了|播的|玩了|聊了)",
        query, re.IGNORECASE,
    ):
        return True
    temporal = _RELATIVE.search(query) or _DATE.search(query) or _FOLLOWUP.search(query)
    return bool(temporal and re.search(
        r"\b(?:you (?:say|said|talk|talked|play|played)|recap|summari[sz]e)\b|"
        r"(?:你|您)?.{0,4}(?:说了|聊了|讲了|播了|玩了)|总结|回顾",
        query, re.IGNORECASE,
    ))


def is_stream_overview(query: str) -> bool:
    text = query.lower().strip(" \t\n?!？！。.")
    for pattern in (_DATE, _YEAR_MONTH, _RELATIVE, _LATEST, _FOLLOWUP):
        text = pattern.sub(" ", text)
    text = re.sub(r"\s*'s\b", "", text)
    text = re.sub(r"\b(?:on|in|during|over|from|to|through)\b", "", text)
    text = re.sub(r"(?<=\s)(?:到|至|—|–|~|～|-)(?=\s)", "", text).strip()
    text = re.sub(r"\s+", " ", text)
    english = (
        r"(?:please |can you |could you )?"
        r"(?:what (?:did you (?:stream|broadcast|do)|have you (?:streamed|broadcast)|"
        r"was (?:your |the )?(?:stream(?:'s)? |broadcast(?:'s)? )?(?:content|about)|"
        r"were (?:your |the )?(?:streams|broadcasts) about)|"
        r"(?:summari[sz]e|recap) (?:(?:your|the|that|those) )?(?:streams?|broadcasts?)?|"
        r"(?:give me )?(?:a )?(?:summary|recap|overview)(?: of)?"
        r"(?: (?:(?:your|the|that|those) )?(?:streams?|broadcasts?))?|what about)"
    )
    chinese = (
        r"(?:请|能不能|可以)?(?:你|您)?\s*(?:的)?\s*(?:直播)?\s*"
        r"(?:(?:都|主要)?(?:播|播了|直播了|聊了|做了|讲了)(?:些)?(?:什么|啥)(?:内容)?|"
        r"(?:直播)?内容(?:是)?(?:什么|啥)|(?:有|有哪些)(?:什么)?直播|"
        r"(?:总结|回顾)(?:一下)?(?:你)?(?:的)?(?:直播)?|呢)"
    )
    return bool(re.fullmatch(english, text) or re.fullmatch(chinese, text.replace(" ", "")))
