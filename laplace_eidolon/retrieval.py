"""Hybrid retrieval — vector search + Chinese FTS + optional reranker.

Shared by ``persona_facts.PersonaFactsService``,
``stream_archive.StreamArchiveService``, and the eval harness
(``tools/eval_retrieval.py``), so what we score offline is the path the
bot actually runs.
"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any

import jieba
from loguru import logger

# jieba's first cut() pays a one-shot ~260ms prefix-dict load. On the event
# loop that stalls all audio, so `warm_tokenizer` gets it done at startup.
_JIEBA_INITED = False


def _init_jieba() -> None:
    global _JIEBA_INITED
    if _JIEBA_INITED:
        return
    list(jieba.cut("init"))
    _JIEBA_INITED = True


def warm_tokenizer() -> None:
    """Load jieba's prefix dict now, off the first query's critical path.

    Call once at startup, ideally from a thread — it is pure CPU and
    idempotent.
    """
    _init_jieba()


# LanceDB 0.30.x ships no CJK tokenizer; pre-tokenizing at both ingest and
# query time is the official workaround.
# https://github.com/lancedb/lancedb/issues/2168
def tokenize_zh(text: str) -> str:
    """jieba-segment ``text`` into a whitespace-separated token string.

    Ingest-side tokenizer, populating the ``tokens`` column. Queries go
    through ``tokenize_zh_query`` instead.

    ``cut_for_search`` emits short sub-tokens *alongside* long words
    ("包租婆" → ``包租 包租婆``) so a partial query still matches, at
    negligible index cost for snippets this short. jieba leaves English
    alphanumerics as single tokens, so a BV-ID stays findable.
    """
    if not text:
        return ""
    _init_jieba()
    return " ".join(w for w in jieba.cut_for_search(text) if w.strip())


# Filtered out of FTS QUERIES only, never the index, or BM25 collapses onto
# them: "你怕什么" tokenizes to 你 / 怕 / 什么, where 你 and 什么 appear in tens
# of thousands of facts and 怕 in maybe 200. BM25 rewards the common tokens
# and swamps the rare meaningful one, so the top hits become unrelated
# chatter. Hand-rolled rather than HIT/hanlp: those strip negators ("不",
# "没") and adverbs ("很", "都") that carry the whole meaning of a short
# query. Content words ("人", "事", "话") stay for the same reason — they can
# be the point of the query ("我跟谁聊过").
_ZH_QUERY_STOPWORDS: frozenset[str] = frozenset(
    {
        # Pronouns
        "你", "我", "他", "她", "它", "您",
        "你们", "我们", "他们", "她们",
        "自己", "大家",
        # Demonstratives + interrogatives
        "这", "那", "什么", "哪", "哪个", "哪里", "哪些",
        "怎么", "怎样", "怎么样",
        "为什么", "为何", "为啥",
        "谁", "几", "多少",
        # Particles / aspect markers
        "的", "地", "得", "了", "着", "过",
        "吗", "呢", "吧", "啊", "呀", "嘛", "哦", "哈", "嗯",
        # Common copulas / function verbs
        "是", "在", "有", "把", "被", "让",
        # Common conjunctions / structural
        "和", "跟", "与", "或", "而", "但", "也", "都", "就", "还",
        "因为", "所以", "如果", "虽然", "但是",
        "啥",
        # Generic action / question helpers
        "要", "想", "会", "能", "可以", "应该", "需要",
        # Time stems jieba splits out of date phrases. The numbers stay;
        # the 年/月/日/号 markers are noise once the date pre-filter has
        # had its turn.
        "年", "月", "日", "号", "周", "天",
        # Whitespace that occasionally squeaks through
        " ", "\t",
    }
)


def tokenize_zh_query(text: str) -> str:
    """Tokenize ``text`` for the FTS half of a hybrid query.

    Like ``tokenize_zh`` but drops ``_ZH_QUERY_STOPWORDS``. A query that is
    all stopwords ("嗯吗") falls back to the unfiltered tokens — over-matching
    beats silently no-opping the FTS leg.
    """
    if not text:
        return ""
    _init_jieba()
    tokens = [w for w in jieba.cut_for_search(text) if w.strip()]
    filtered = [w for w in tokens if w not in _ZH_QUERY_STOPWORDS]
    if filtered:
        return " ".join(filtered)
    return " ".join(tokens)


def build_fts_index(table: Any, field: str = "tokens") -> None:
    """Create the FTS index hybrid search runs against ``field``.

    The tokenizer settings mirror ``tokenize_zh``: whitespace splitting and
    no stemming, so LanceDB honors jieba's boundaries instead of re-segmenting
    them. ``lower_case=False`` keeps BV-IDs and proper nouns case-distinct.

    ``config=FTS(...)`` selects native FTS, the only path this form builds —
    Tantivy's whitespace tokenizer ignored several of these knobs.
    """
    # create_fts_index() is deprecated and warns on every call.
    from lancedb.index import FTS

    table.create_index(
        field,
        replace=True,
        config=FTS(
            base_tokenizer="whitespace",
            stem=False,
            remove_stop_words=False,
            lower_case=False,
            with_position=False,
        ),
    )


# One client for the whole process — the Cohere SDK owns an httpx client
# internally, so sharing it across both services is correct.
_reranker_cache: Any = None
_reranker_inited: bool = False


def make_reranker(model: str | None = None) -> Any:
    """Return a Cohere reranker if ``COHERE_API_KEY`` is set, else None.

    Cached — the first call fixes which reranker the process uses.

    On ``None``, ``hybrid_search`` skips ``.rerank()`` and LanceDB's default
    RRF fusion blends the vector + FTS legs. RRF over stopword-filtered FTS
    queries beat ``LinearCombinationReranker`` throughout our eval at ~3k
    facts and ~30k chunks: its score normalisation ties the top results and
    randomises their order.

    ``rerank-v4.0-fast`` is a cross-encoder — it reads query and candidate
    together, so it catches intent that pure score combiners can't. Trial
    tier covers light prod use, ~$1/1000 reranks beyond it.
    """
    global _reranker_cache, _reranker_inited
    if _reranker_inited:
        return _reranker_cache
    _reranker_inited = True

    api_key = os.getenv("COHERE_API_KEY")
    if not api_key:
        logger.info(
            "COHERE_API_KEY not set — hybrid retrieval will use "
            "LanceDB's default RRF fusion (no cross-encoder rerank). "
            "For best precision at the current data scale, set "
            "COHERE_API_KEY in .env."
        )
        return None

    try:
        from lancedb.rerankers import CohereReranker

        model_name = (
            model or os.getenv("COHERE_RERANK_MODEL") or "rerank-v4.0-fast"
        )
        _reranker_cache = CohereReranker(api_key=api_key, model_name=model_name)
        logger.info(f"Cohere reranker enabled: model={model_name!r}")
    except Exception as e:  # noqa: BLE001 — keep retrieval alive on a bad key
        logger.warning(
            f"Cohere reranker init failed ({e}); falling back to "
            f"LanceDB default RRF fusion"
        )
        _reranker_cache = None
    return _reranker_cache


# Each pattern is paired into 4-digit and 2-digit year variants because
# conversational Chinese abbreviates the year ("26年3月24") and routinely
# drops the day marker (日/号). The lookahead `(?=\s*[日号]|\D|$)` accepts a
# marker, a non-digit boundary, or end-of-string, so "5月8" reads as a date
# but "5月8000元" doesn't. `(?<!\d)` blocks matches inside longer numbers —
# "20260524年" must not yield "2026年" out of the middle.

_DATE_FULL_RE = re.compile(
    r"(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)"
)
"""Full date, 4-digit year: '2026年5月9日', '2026年5月9'."""

_DATE_FULL_RE_SHORT = re.compile(
    r"(?<!\d)(\d{2})年\s*(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)"
)
"""Full date, 2-digit year: '26年3月24日', '26年3月24'."""

_DATE_YM_RE = re.compile(r"(?<!\d)(\d{4})年\s*(\d{1,2})月(?=\D|$)")
"""Year + month, 4-digit year: '2024年3月'."""

_DATE_YM_RE_SHORT = re.compile(r"(?<!\d)(\d{2})年\s*(\d{1,2})月(?=\D|$)")
"""Year + month, 2-digit year: '24年3月'."""

_DATE_MD_RE = re.compile(r"(?<!\d)(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)")
"""Month + day, no year: '5月9号', '5月9日', '5月9'. Matches any year."""


def _normalize_year(year_str: str) -> int:
    """Map a 2-digit year to 20YY; pass 4-digit through unchanged."""
    y = int(year_str)
    return 2000 + y if y < 100 else y


def extract_date_filter(query: str, *, column: str = "date") -> str | None:
    """Return a LanceDB SQL ``WHERE`` clause for dates in ``query``, else None.

    Scanned most- to least-specific: a full date becomes an exact match, a
    year+month becomes a half-open range, and a bare ``MM月DD`` matches that
    month-day in any year via ``LIKE '%-MM-DD'``. The result is meant for
    ``table.search(...).where(clause, prefilter=True)``.

    Args:
        column: Column to filter against. ``"date"`` fits the persona_facts
            schema; stream_chunks needs ``"stream_date"``.

    Year-only ("2024年发生什么") and month-only ("3月") are deliberately not
    filtered — too coarse to help, and vector + FTS handle them better.
    Relative refs ("上周", "昨天") would need today's date and the persona's
    timezone, which is bot state this module can't see.
    """
    if not query:
        return None

    for regex in (_DATE_FULL_RE, _DATE_FULL_RE_SHORT):
        m = regex.search(query)
        if m:
            y = _normalize_year(m.group(1))
            mo, d = int(m.group(2)), int(m.group(3))
            if not (1 <= mo <= 12 and 1 <= d <= 31):
                continue
            iso = f"{y:04d}-{mo:02d}-{d:02d}"
            return f"{column} = '{iso}'"

    for regex in (_DATE_YM_RE, _DATE_YM_RE_SHORT):
        m = regex.search(query)
        if m:
            y = _normalize_year(m.group(1))
            mo = int(m.group(2))
            if not (1 <= mo <= 12):
                continue
            start = f"{y:04d}-{mo:02d}-01"
            end_y, end_mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
            end = f"{end_y:04d}-{end_mo:02d}-01"
            return f"{column} >= '{start}' AND {column} < '{end}'"

    m = _DATE_MD_RE.search(query)
    if m:
        mo, d = (int(g) for g in m.groups())
        if not (1 <= mo <= 12 and 1 <= d <= 31):
            return None
        return f"{column} LIKE '%-{mo:02d}-{d:02d}'"

    return None


# Below this many chars we pull in prior turns: voice users say "嗯", "那呢",
# "再说说", and embedding those alone is hopeless.
_SHORT_QUERY_CHARS = 8


def build_query_text(
    messages: list[dict],
    *,
    max_user_turns: int = 3,
    short_threshold: int = _SHORT_QUERY_CHARS,
) -> str | None:
    """Assemble the search query from recent user turns.

    A latest message of ``short_threshold`` chars or more is used alone —
    extra turns only dilute it. Anything shorter gets up to
    ``max_user_turns`` of earlier user messages prepended, oldest first, so
    the embedding has some lexical surface to work with. ``None`` when
    there's no usable user content (bot-only kickoff, empty conversation).

    Assistant turns stay out even on short queries: the reply is what the
    user is reacting to, but its content drags retrieval toward whatever the
    model rambled about instead of what the user cares about.
    """
    if not messages:
        return None

    user_texts: list[str] = []
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if not isinstance(content, str):
            continue
        s = content.strip()
        if s:
            user_texts.append(s)
        if len(user_texts) >= max_user_turns:
            break

    if not user_texts:
        return None

    # Newest-first so far; flip below so the query reads chronologically.
    latest = user_texts[0]
    if len(latest) >= short_threshold or len(user_texts) == 1:
        return latest

    return " ".join(reversed(user_texts))


async def hybrid_search(
    table: Any,
    *,
    vector: list[float],
    query_text: str,
    candidates: int,
    where: str | None = None,
    final_k: int | None = None,
    rerank: bool = True,
    reranker: Any = None,
    fts_field: str = "tokens",
) -> list[dict[str, Any]]:
    """Run LanceDB hybrid search (vector + FTS) with optional reranker.

    Args:
        table: Open LanceDB table with a vector column and an FTS index on
            ``fts_field``.
        vector: Query embedding. Must match the table's vector dimension.
        query_text: Raw user input — tokenized internally for the FTS leg,
            so pass it through untouched.
        candidates: Candidates retrieved before reranking. More recall costs
            more reranker tokens; 30 suits facts, 15 the larger stream-chunk
            rows.
        where: Optional SQL filter, e.g. ``"date = '2026-05-09'"``.
            ``prefilter=True`` is forced — post-filtering silently returns
            fewer than top-k at our scale.
        final_k: Result count after reranking, defaulting to ``candidates``.
            Set it to the real top-k (e.g. 8) to size the output for the LLM.
        rerank: When True, use ``reranker`` if given, else the cached
            ``make_reranker()``. False skips reranking whatever the config,
            which is how the eval harness measures fusion-only quality.
        reranker: Explicit instance, overriding the module cache so
            ``laplace-eval-retrieval --rerank-models …`` can benchmark
            several head-to-head without poisoning the singleton.
        fts_field: Column to FTS over — the jieba-tokenized one both ingest
            scripts populate.

    Returns:
        Up to ``final_k`` rows, best first, each carrying the table's columns
        plus a ``_relevance_score`` (or ``_distance``, depending on whether
        reranking ran).
    """
    if final_k is None or final_k > candidates:
        final_k = candidates

    tokens = tokenize_zh_query(query_text) or query_text
    if rerank:
        active_reranker = reranker if reranker is not None else make_reranker()
    else:
        active_reranker = None

    def _query(use_reranker: bool) -> list[dict[str, Any]]:
        q = (
            table.search(query_type="hybrid")
            .vector(vector)
            .text(tokens)
            .limit(candidates)
        )
        if where:
            q = q.where(where, prefilter=True)
        if use_reranker:
            q = q.rerank(reranker=active_reranker)
        return q.to_list()[:final_k]

    def _run() -> list[dict[str, Any]]:
        if active_reranker is None:
            return _query(False)
        # The reranker is an optional tier, so a Cohere outage or a rejected
        # key must not take retrieval down with it: fall back to the same RRF
        # fusion we'd run with no COHERE_API_KEY at all. Reranking happens
        # inside to_list(), so this is the only place that failure surfaces.
        try:
            return _query(True)
        except Exception as e:
            logger.warning(f"Rerank failed ({e}); falling back to RRF fusion")
            return _query(False)

    return await asyncio.to_thread(_run)


def score_of(hit: dict[str, Any]) -> float | None:
    """Relevance score regardless of which retrieval path produced the hit.

    Reranked/hybrid hits carry ``_relevance_score`` (higher = better); the
    unreranked vector path carries ``_distance`` (lower = better), so the
    returned number is only comparable within one result set.
    """
    if hit.get("_relevance_score") is not None:
        return float(hit["_relevance_score"])
    if hit.get("_distance") is not None:
        return float(hit["_distance"])
    return None
