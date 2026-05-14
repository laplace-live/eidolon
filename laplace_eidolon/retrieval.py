"""Hybrid retrieval — vector search + Chinese FTS + optional reranker.

Used by both ``persona_facts.PersonaFactsService`` and
``stream_archive.StreamArchiveService`` so they share one well-tuned
retrieval path. The eval harness (``tools/eval_retrieval.py``) calls the
same code so what we measure offline matches what the bot does at
runtime.

Why this exists separately from ``embeddings.py``: that module owns the
embedding HTTP client (write path). This one composes search-side
operations (read path). Keeping them split mirrors the
write-vectors / read-and-rank divide.

What lives here:

- :func:`tokenize_zh` — jieba-based tokenizer that produces a
  whitespace-separated string suitable for LanceDB's FTS index when
  built with ``base_tokenizer="whitespace"``. **LanceDB 0.30.x ships no
  CJK tokenizer**; pre-tokenization at both ingest + query time is the
  official workaround. See
  https://github.com/lancedb/lancedb/issues/2168 for status.
- :func:`build_fts_index` — wraps ``table.create_fts_index`` with the
  whitespace+no-stem settings that match how we tokenize. Both ingest
  scripts call this after writing rows.
- :func:`make_reranker` — builds a Cohere ``rerank-v4.0-fast``
  reranker if ``COHERE_API_KEY`` is set, else returns ``None`` (in
  which case hybrid search falls back to RRF fusion only).
- :func:`hybrid_search` — runs LanceDB's hybrid query (vector + FTS)
  with optional reranker. Threadpooled because LanceDB's Python API is
  sync.
- :func:`extract_date_filter` — detects Chinese date references in the
  query and returns a SQL WHERE clause for pre-filtering by the ``date``
  column. Used by persona-facts retrieval; stream-archive doesn't have
  a single ``date`` column on its rows so it skips this.
- :func:`build_query_text` — assembles the search query from the last
  N user turns so short voice utterances ("嗯, 那个？") get rescued by
  prior context.
"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any

import jieba
from loguru import logger

# ---------------------------------------------------------------------------
# Tokenization
# ---------------------------------------------------------------------------

# Pre-warm jieba's prefix dict at import so the first runtime query
# doesn't pay the ~200ms one-shot init cost. Cheap, and idempotent
# across processes (jieba writes a cache file under /tmp).
_JIEBA_INITED = False


def _init_jieba() -> None:
    global _JIEBA_INITED
    if _JIEBA_INITED:
        return
    # Calling cut() on a tiny string forces the prefix-dict load.
    list(jieba.cut("init"))
    _JIEBA_INITED = True


def tokenize_zh(text: str) -> str:
    """jieba-segment ``text`` into a whitespace-separated token string.

    Used at INGEST time to populate the ``tokens`` column. For QUERIES
    use :func:`tokenize_zh_query` instead — that variant filters
    high-frequency Chinese function words ("你", "什么", "了", …) that
    swamp BM25 scores at query time but should remain in the index so
    that targeted lookups for them still match.

    Uses ``cut_for_search`` mode — emits short sub-tokens *in addition*
    to long words ("包租婆" → ``包租 包租婆``) so a partial query like
    "包租" still matches. The extra index size is trivial vs. the recall
    win on the kind of short factual snippets we have.

    English alphanumerics and punctuation pass through cleanly because
    jieba treats them as their own tokens — so a query like
    "BV1mLd9BTEBV" still indexes as one token and FTS can find it.

    Empty input returns an empty string (not None) so the column always
    has a string value, which keeps the LanceDB schema clean.
    """
    if not text:
        return ""
    _init_jieba()
    return " ".join(w for w in jieba.cut_for_search(text) if w.strip())


# Chinese function words that have to be filtered from FTS QUERIES
# (not from the index) or BM25 scores collapse onto them.
#
# Symptom: query "你怕什么" tokenizes to ["你", "怕", "什么"]. "你" and
# "什么" appear in tens of thousands of facts; "怕" in maybe 200. BM25
# on the unfiltered query rewards documents containing the common
# tokens, swamping the rare-but-meaningful "怕". Result: top hits are
# "你的小鸟"-type chatter that has nothing to do with fear.
#
# The list is intentionally conservative — only function words,
# pronouns, and discourse particles. Content words ("人", "事", "话"
# etc.) stay even though they're frequent, because they CAN be the
# meaningful term of a query ("我跟谁聊过").
#
# We don't import a third-party stopword list because the canonical
# choice for Chinese (HIT, hanlp) is too aggressive — they include
# negators ("不", "没") and adverbs ("很", "都") that ARE meaningful in
# our short queries. This hand-curated list errs on the side of
# keeping too much.
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
        # Pure-time stems jieba spits out for date phrases (we keep
        # the numbers; the 年/月/日/号 markers are noise on their own
        # because the date pre-filter already handles dates).
        "年", "月", "日", "号", "周", "天",
        # Whitespace / punctuation that occasionally squeaks through
        " ", "\t",
    }
)


def tokenize_zh_query(text: str) -> str:
    """Tokenize ``text`` for the FTS half of a hybrid query.

    Same as :func:`tokenize_zh` but drops high-frequency Chinese
    function words to prevent them from dominating BM25 scores. See
    ``_ZH_QUERY_STOPWORDS`` for the rationale.

    If ALL tokens are stopwords (e.g. the user said just "嗯吗"),
    falls back to the unfiltered tokenization so FTS at least has
    something to match. Better to over-match than to silently no-op
    the FTS leg.
    """
    if not text:
        return ""
    _init_jieba()
    tokens = [w for w in jieba.cut_for_search(text) if w.strip()]
    filtered = [w for w in tokens if w not in _ZH_QUERY_STOPWORDS]
    if filtered:
        return " ".join(filtered)
    # Pathological all-stopword query — fall back so the FTS leg
    # doesn't go dark. The vector leg would still have done its work.
    return " ".join(tokens)


# ---------------------------------------------------------------------------
# FTS index construction
# ---------------------------------------------------------------------------


def build_fts_index(table: Any, field: str = "tokens") -> None:
    """Create the FTS index used by hybrid search on ``field``.

    Settings rationale:

    - ``base_tokenizer="whitespace"``: we already split with jieba, so
      we want LanceDB to honor those splits and not re-tokenize.
    - ``stem=False``: jieba already produces the right Chinese surface
      forms; English stemming would corrupt token-identity match.
    - ``remove_stop_words=False``: Chinese has no canonical stoplist
      and jieba's segmentation already filters most function-word noise.
    - ``lower_case=False``: BV-IDs and proper nouns are case-sensitive;
      lowering them would conflate ``BV1m`` with ``bv1m`` etc.
    - ``with_position=False``: we don't run phrase queries, only term
      queries, and skipping positions keeps the index smaller.
    - ``replace=True``: ingest scripts drop+recreate the table, so the
      FTS index is built fresh each time anyway.

    The native (Lance) FTS implementation is used (``use_tantivy=False``)
    because Tantivy's whitespace tokenizer in LanceDB 0.30.x ignores
    several of the tuning knobs above. Native FTS is the recommended
    path going forward and benefits from the 0.30 perf work
    (3-8x faster on long queries).
    """
    table.create_fts_index(
        field,
        use_tantivy=False,
        replace=True,
        base_tokenizer="whitespace",
        stem=False,
        remove_stop_words=False,
        lower_case=False,
        with_position=False,
    )


# ---------------------------------------------------------------------------
# Reranker
# ---------------------------------------------------------------------------

# Module-level cache so repeated make_reranker() calls reuse one client.
# Both PersonaFactsService and StreamArchiveService call this, and the
# Cohere SDK manages its own httpx client internally so reuse is correct.
_reranker_cache: Any = None
_reranker_inited: bool = False
_reranker_warned: bool = False


def make_reranker(model: str | None = None) -> Any:
    """Return a Cohere reranker if ``COHERE_API_KEY`` is set, else None.

    Cached. The first call decides which reranker is in effect for the
    process; subsequent calls are O(1).

    When ``None`` is returned, ``hybrid_search`` skips the
    ``.rerank()`` call entirely and lets LanceDB's default RRF
    (reciprocal rank fusion) blend the vector + FTS legs. RRF +
    stopword-filtered FTS queries (see ``tokenize_zh_query``)
    consistently outperforms ``LinearCombinationReranker`` in our
    eval — its score normalisation creates ties at the top that
    randomise the final ordering. Empirical observation; tested at
    ~3k facts and ~30k chunks.

    Cohere ``rerank-v4.0-fast`` is the recommended path at
    this data scale. It's a cross-encoder (reads query + candidate
    together), so it understands intent in a way pure score
    combiners can't. Trial tier covers light prod use; ~$1/1000
    reranks beyond that.
    """
    global _reranker_cache, _reranker_inited, _reranker_warned
    if _reranker_inited:
        return _reranker_cache
    _reranker_inited = True

    api_key = os.getenv("COHERE_API_KEY")
    if not api_key:
        if not _reranker_warned:
            logger.info(
                "COHERE_API_KEY not set — hybrid retrieval will use "
                "LanceDB's default RRF fusion (no cross-encoder rerank). "
                "For best precision at the current data scale, set "
                "COHERE_API_KEY in .env."
            )
            _reranker_warned = True
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


# ---------------------------------------------------------------------------
# Date detection in queries
# ---------------------------------------------------------------------------
#
# Each regex below is paired into a 4-digit-year and 2-digit-year
# variant. Conversational Chinese routinely abbreviates the year
# ("26年3月24" rather than "2026年3月24日"), and the day-marker
# (日/号) is also frequently omitted. The lookahead `(?=\s*[日号]|\D|$)`
# accepts either an explicit marker, a non-digit boundary, or
# end-of-string — so "5月8" matches as date but "5月8000元" doesn't,
# because the next char after "8" is another digit.
#
# `(?<!\d)` on the year/month entry prevents matches inside longer
# numbers (e.g. "20260524年" should not parse "2026年" out of the middle).

_DATE_FULL_RE = re.compile(
    r"(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)"
)
"""Fully-specified date with 4-digit year: '2026年5月9日', '2026年5月9'."""

_DATE_FULL_RE_SHORT = re.compile(
    r"(?<!\d)(\d{2})年\s*(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)"
)
"""Same as above but 2-digit year: '26年3月24日', '26年3月24'.
Year is normalised to 20YY by ``_normalize_year``."""

_DATE_YM_RE = re.compile(r"(?<!\d)(\d{4})年\s*(\d{1,2})月(?=\D|$)")
"""Year + month only: '2024年3月'."""

_DATE_YM_RE_SHORT = re.compile(r"(?<!\d)(\d{2})年\s*(\d{1,2})月(?=\D|$)")
"""Same as above but 2-digit year: '24年3月'."""

_DATE_MD_RE = re.compile(r"(?<!\d)(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)")
"""Month + day, no year: '5月9号', '5月9日', '5月9'."""


def _normalize_year(year_str: str) -> int:
    """Map a 2-digit year to 20YY; pass 4-digit through unchanged.

    All persona content lives in the 21st century so the assumption
    is safe. If we ever need 19YY (lore set in the 90s, etc.), make
    this configurable by the cutoff year.
    """
    y = int(year_str)
    return 2000 + y if y < 100 else y


def extract_date_filter(query: str, *, column: str = "date") -> str | None:
    """Return a LanceDB SQL ``WHERE`` clause for dates in ``query``.

    Returns ``None`` if no date reference is found, otherwise a string
    like ``"date = '2026-05-09'"`` suitable for passing to
    ``table.search(...).where(filter, prefilter=True)``.

    Args:
        query: The user's text. We scan it for date patterns from
            most- to least-specific.
        column: The LanceDB column to filter against. Defaults to
            ``"date"`` (persona_facts schema). For stream_chunks pass
            ``"stream_date"``.

    Handles, most-specific first:

    - ``YYYY年MM月DD[日|号]?`` → exact date match (column = 'YYYY-MM-DD')
    - ``YY年MM月DD[日|号]?`` → same, year normalised to 20YY
    - ``YYYY年MM月`` → month range (column >= 'YYYY-MM-01' AND column < next)
    - ``YY年MM月`` → same, year normalised
    - ``MM月DD[日|号]?`` (no year) → match that month-day in any year via
      ``column LIKE '%-MM-DD'``

    Year-only ("2024年发生什么") and month-only ("3月") are intentionally
    NOT filtered — too coarse to be useful, and the vector + FTS path
    handles them better. Same goes for relative refs like "上周" or
    "昨天" — resolving those needs today's date and the persona's
    timezone, which is bot-state we don't have here. If we add that
    later, this is the place for it.
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


# ---------------------------------------------------------------------------
# Conversation-aware query building
# ---------------------------------------------------------------------------

# Rough char threshold below which we pull in prior turns. Voice users
# often say "嗯", "那呢", "再说说" — embedding those alone is hopeless.
_SHORT_QUERY_CHARS = 8


def build_query_text(
    messages: list[dict],
    *,
    max_user_turns: int = 3,
    short_threshold: int = _SHORT_QUERY_CHARS,
) -> str | None:
    """Assemble the search query from recent conversation history.

    Strategy:

    - If the latest user message is "long enough" (≥ ``short_threshold``
      chars after stripping), use it alone — long enough to embed/FTS
      meaningfully on its own, and pulling extra turns just dilutes it.
    - Otherwise, concatenate up to ``max_user_turns`` most-recent user
      messages (oldest first) so the embedding sees enough lexical
      surface area to find a match.

    We don't include assistant turns even on short queries — the
    assistant's reply is what the user is reacting to, but its content
    can drag retrieval into whatever the model rambled about (long
    descriptions, emotion tags, etc.) instead of what the user actually
    cares about. User turns are higher-signal.

    Returns the assembled query string, or ``None`` if there's no usable
    user content (empty conversation, bot-only kickoff, etc.).
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

    # user_texts is newest-first; flip so the assembled query reads
    # chronologically (older context first, latest utterance last).
    latest = user_texts[0]
    if len(latest) >= short_threshold or len(user_texts) == 1:
        return latest

    return " ".join(reversed(user_texts))


# ---------------------------------------------------------------------------
# Hybrid search
# ---------------------------------------------------------------------------


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
        table: An open LanceDB table with both a vector column and an
            FTS index on ``fts_field``.
        vector: The query embedding vector. Must match the table's
            vector dimension.
        query_text: The raw query string. Will be jieba-tokenized
            internally before the FTS leg runs, so callers should pass
            in untouched user input.
        candidates: Total candidates to retrieve before reranking.
            Larger = better recall but more reranker tokens spent.
            Reasonable values: 30 for facts (small rows), 15 for
            stream chunks (large rows).
        where: Optional SQL pre-filter (e.g. ``"date = '2026-05-09'"``)
            applied before vector + FTS scoring. ``prefilter=True`` is
            forced — post-filter behaviour at our scale would silently
            return fewer than top-k results.
        final_k: Final result count after reranking. Defaults to
            ``candidates`` (no truncation). Set this to your real top-k
            (e.g. 8) so reranker output is the right size for the LLM.
        rerank: When True (default), apply a reranker to the
            candidate list. The specific reranker is resolved as:
            (a) ``reranker`` argument if provided, else (b) the
            module-level ``make_reranker()`` (Cohere if
            ``COHERE_API_KEY`` is set, else None → RRF fusion).
            Pass False to skip reranking entirely regardless of
            configuration (useful for the eval harness measuring
            fusion-only quality).
        reranker: Explicit reranker instance to use. Overrides the
            cached module default. Pass this from
            ``laplace-eval-retrieval --rerank-models …`` so each
            model can be benchmarked head-to-head without poisoning
            the singleton cache.
        fts_field: Column to FTS over. Defaults to ``tokens``, the
            jieba-tokenized column both ingest scripts populate.

    Returns:
        Up to ``final_k`` row dicts, ordered by relevance (best first).
        Each row carries the table's columns plus a ``_relevance_score``
        (or ``_distance``, depending on whether reranking ran).

    Synchronous LanceDB call is dispatched to a thread because both
    services intercept Pipecat frames inside an asyncio event loop and
    blocking it stalls the whole pipeline (audio frames, TTS, etc).
    """
    if final_k is None or final_k > candidates:
        final_k = candidates

    # Stopword-filtered tokens for FTS — see ``tokenize_zh_query`` for
    # why we don't pass the raw query through to BM25.
    tokens = tokenize_zh_query(query_text) or query_text
    if rerank:
        active_reranker = reranker if reranker is not None else make_reranker()
    else:
        active_reranker = None

    def _run() -> list[dict[str, Any]]:
        q = (
            table.search(query_type="hybrid")
            .vector(vector)
            .text(tokens)
            .limit(candidates)
        )
        if where:
            # prefilter=True applies the SQL filter BEFORE the vector +
            # FTS scoring. Without it, LanceDB would score the whole
            # corpus and then filter the top-k, often returning zero
            # rows when the filter is selective (e.g. one specific date).
            q = q.where(where, prefilter=True)
        if active_reranker is not None:
            q = q.rerank(reranker=active_reranker)
        rows = q.to_list()
        return rows[:final_k]

    return await asyncio.to_thread(_run)
