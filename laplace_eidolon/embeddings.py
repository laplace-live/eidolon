"""Shared embedding + LanceDB infra.

Used by every retrieval tier so they all embed with the same model + dim
(otherwise vectors written at ingest time wouldn't be comparable to vectors
queried at runtime). Specifically:

- ``stream_archive.StreamArchiveService``  (runtime RAG over transcripts)
- ``persona_facts.PersonaFactsService``    (runtime RAG over fan-compiled facts)
- ``tools.ingest_streams``                 (offline write of stream_chunks table)
- ``tools.ingest_facts``                   (offline write of persona_facts table)

What lives here:

- ``embed_texts()`` / ``embed_texts_with_usage()`` — call the OpenAI-compatible
  /v1/embeddings endpoint (default OpenRouter → Gemini), with quota-aware
  retries that handle the OpenRouter "200-with-error-body" quirk.
- ``EmbeddingUsage`` — token + USD cost accumulator
- ``EmbedCache`` — persistent disk cache for embedding vectors, used by both
  ingest scripts so a partial run can be resumed without re-paying for
  embeddings that already succeeded.
- ``open_table()`` — read-only LanceDB table opener (returns ``None`` if
  the table doesn't exist yet, so services can boot before ingest has run)
- ``DEFAULT_*`` config — provider URL, model, dim, DB path

What does *not* live here:

- Per-table schema / ingest logic (see ``tools/ingest_*.py``)
- Service-specific table names (``stream_chunks``, ``persona_facts``) —
  those live with their respective services.

Embedding provider: **OpenRouter** (OpenAI-compatible /v1/embeddings endpoint),
defaulting to ``google/gemini-embedding-2-preview`` at 3072-dim. We reuse the
``OPENROUTER_API_KEY`` you already set for the LLM — no separate OpenAI
account needed. Override per env var:

- ``EMBED_BASE_URL``  default ``https://openrouter.ai/api/v1``
- ``EMBED_API_KEY``   default falls back to ``OPENROUTER_API_KEY``
- ``EMBED_MODEL``     default ``google/gemini-embedding-2-preview``
- ``EMBED_DIM``       default ``3072`` (Gemini supports 128–3072 via MRL)

If you swap to a model with a different dimension, update ``EMBED_DIM``
**and** re-run both ingest scripts — the LanceDB schema is fixed-size,
and old vectors won't be comparable to new ones. The cache is keyed by
``(model, dim, text)`` so old entries are auto-invalidated; the file
just keeps growing until you delete it.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import random
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import lancedb
import numpy as np
from lancedb.table import Table
from loguru import logger
from openai import AsyncOpenAI

from .openrouter import extract_cost_usd, openrouter_headers

DEFAULT_DB_PATH = "data/lancedb"
DEFAULT_EMBED_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_EMBED_MODEL = "google/gemini-embedding-2-preview"
DEFAULT_EMBED_DIM = int(os.getenv("EMBED_DIM", "3072"))
"""Vector dimension. Read at module import so the LanceDB schemas in
``tools/ingest_streams.py`` and ``tools/ingest_facts.py`` match what
``embed_texts()`` will produce. To change, set the env var BEFORE
importing this module (i.e. in .env) and re-ingest both tables."""

# Fallback per-model embedding prices, USD per 1M tokens.
#
# Why this exists: OpenRouter does NOT surface ``cost_details`` on
# ``/v1/embeddings`` responses (verified 2026-05). On a BYOK key the
# response is literally ``{prompt_tokens, total_tokens, cost: 0}`` —
# real money is being spent upstream (Google AI Studio etc.) but
# OpenRouter passes back zero. Without a client-side estimate, ingest
# logs ``$0.000000`` per batch even on a 26k-chunk run. Prices below
# come from each provider's public pricing page; treat them as
# best-effort and update when prices change.
EMBED_PRICING_USD_PER_1M: dict[str, float] = {
    "google/gemini-embedding-2-preview": 0.15,
    "~google/gemini-embedding-2-preview": 0.15,
    "openai/text-embedding-3-small": 0.02,
    "openai/text-embedding-3-large": 0.13,
}

# Retries for the "200 OK with no `data` field" case. OpenRouter wraps
# upstream errors inside a 200 body (``{"error": {...}}``) instead of
# returning a real HTTP status, so the OpenAI SDK's built-in ``max_retries``
# ignores them. Two budgets, sized for two very different failure modes:
#
# - *Data* failures (transient upstream blips, malformed responses): short
#   exponential backoff, modest retry count. Handled in seconds.
# - *Quota* failures (HTTP 429 / RESOURCE_EXHAUSTED): fixed long delay
#   matching the typical 60s Vertex AI quota window, with more attempts
#   because the OpenRouter pool is shared and a busy minute can take
#   several windows to clear. Without this distinction, exponential
#   backoff exhausts in ~30s — never long enough for the quota to reset
#   — and the run dies on the first quota incident.
MAX_EMBED_DATA_RETRIES = 5
EMBED_RETRY_BASE_DELAY = 1.0
MAX_EMBED_QUOTA_RETRIES = 10
EMBED_QUOTA_BACKOFF = 60.0


def _is_quota_error(err_msg: str) -> bool:
    """True if ``err_msg`` looks like a rate-limit / quota error.

    OpenRouter forwards Vertex AI's RESOURCE_EXHAUSTED inside a 200 body,
    so we have to scan the message string rather than checking an HTTP
    status code. Matches conservatively — only on signals strong enough
    that fixed 60s backoff is the right response.
    """
    if not err_msg:
        return False
    msg_lower = err_msg.lower()
    return (
        "429" in err_msg
        or "resource_exhausted" in msg_lower
        or "quota exceeded" in msg_lower
        or "rate limit" in msg_lower
        or "rate-limit" in msg_lower
    )


_embed_client: AsyncOpenAI | None = None


def _get_embed_client() -> AsyncOpenAI:
    """Lazy singleton OpenAI-SDK client pointed at the embedding provider.

    Default provider is OpenRouter. The OpenAI Python SDK works against any
    OpenAI-compatible /v1/embeddings endpoint, so swapping providers is just
    a base_url change.
    """
    global _embed_client
    if _embed_client is None:
        base_url = os.getenv("EMBED_BASE_URL", DEFAULT_EMBED_BASE_URL)
        api_key = os.getenv("EMBED_API_KEY") or os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError(
                "Embeddings need an API key. Set OPENROUTER_API_KEY (reused "
                "from the LLM config) or EMBED_API_KEY for a different provider."
            )
        # max_retries=5 covers the genuine transient failures the SDK knows
        # about (429, 5xx, connection drops). The 200-with-no-data case is
        # handled by our own loop in ``embed_texts_with_usage``.
        _embed_client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            max_retries=5,
            default_headers=openrouter_headers(),
        )
    return _embed_client


@dataclass
class EmbeddingUsage:
    """Token + cost accumulator for embedding requests.

    OpenRouter surfaces ``usage.cost`` in USD on non-BYOK responses
    (1 credit = $1). On BYOK the response is ``cost: 0`` with no
    ``cost_details`` — the embedding endpoint, unlike chat, withholds
    the upstream cost entirely — so we fall back to multiplying tokens
    by a hardcoded per-model price (``EMBED_PRICING_USD_PER_1M``).

    ``cost_source`` distinguishes the three paths so callers can label
    output honestly:

    - ``"openrouter"`` — number came straight from the response. Trust it.
    - ``"estimate"``   — tokens × ``EMBED_PRICING_USD_PER_1M[model]``.
                         Best-effort; check the price table is current.
    - ``"unknown"``    — no token count or no price entry. ``cost_usd``
                         stays 0; caller should warn the user.
    """

    prompt_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    cost_source: str = "unknown"

    def add(self, other: "EmbeddingUsage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.total_tokens += other.total_tokens
        self.cost_usd += other.cost_usd
        # Promote "unknown" → anything else, and openrouter+estimate
        # mixes degrade to "mixed" so downstream summaries can flag
        # partial estimation (same pattern as refine.Usage).
        if self.cost_source == "unknown":
            self.cost_source = other.cost_source
        elif (
            other.cost_source != "unknown"
            and other.cost_source != self.cost_source
            and self.cost_source != "mixed"
        ):
            self.cost_source = "mixed"


async def embed_texts_with_usage(
    texts: list[str],
    model: str | None = None,
    dimensions: int | None = None,
) -> tuple[list[list[float]], EmbeddingUsage]:
    """Embed a batch of texts and return the OpenRouter-reported usage.

    Args:
        texts: Strings to embed.
        model: Override embedding model. Defaults to ``EMBED_MODEL``
            env var, then ``google/gemini-embedding-2-preview``.
        dimensions: Output vector dim. Defaults to ``DEFAULT_EMBED_DIM``
            (3072 for Gemini). Must match the LanceDB schema; mismatched
            dim at write vs. read time will fail at search time.

    Returns:
        ``(vectors, usage)`` where ``usage`` carries prompt/total token
        counts and (when the provider supports it, e.g. OpenRouter) the
        USD cost of this single API call.
    """
    if not texts:
        return [], EmbeddingUsage()
    model = model or os.getenv("EMBED_MODEL", DEFAULT_EMBED_MODEL)
    dimensions = dimensions or DEFAULT_EMBED_DIM
    client = _get_embed_client()
    # encoding_format="float" is *required* for non-OpenAI providers (e.g.
    # OpenRouter → Gemini). The OpenAI SDK silently defaults to "base64" for
    # wire efficiency and then base64-decodes the strings on parse; providers
    # that don't honour that exact contract round-trip an empty response and
    # the SDK raises "No embedding data received". Pinning float bypasses
    # the base64 path entirely.
    #
    # Retry loop: even with the float fix, OpenRouter regularly returns a
    # 200 OK whose body has no ``data`` field — either a transient upstream
    # blip or a quota error wrapped in the success envelope. We split the
    # two cases because they need very different backoff:
    #   * data error → short exponential (might just be flaky)
    #   * quota error → fixed 60s wait (must let the quota window reset)
    resp = None
    last_err = "unknown"
    data_failures = 0
    quota_failures = 0
    while True:
        candidate = await client.embeddings.create(
            model=model,
            input=texts,
            dimensions=dimensions,
            encoding_format="float",
            # OpenRouter now always returns usage.cost, but passing this is
            # harmless and matches how tools/refine.py opts in for chat.
            extra_body={"usage": {"include": True}},
        )
        if candidate.data:
            resp = candidate
            break

        candidate_dict = candidate.model_dump() if hasattr(candidate, "model_dump") else {}
        err = candidate_dict.get("error") if isinstance(candidate_dict, dict) else None
        if isinstance(err, dict) and err.get("message"):
            last_err = str(err["message"])
        elif isinstance(err, dict):
            last_err = str(err)
        else:
            last_err = "provider returned no embedding data"

        if _is_quota_error(last_err):
            quota_failures += 1
            if quota_failures > MAX_EMBED_QUOTA_RETRIES:
                break
            # Fixed long wait + jitter. The jitter spreads concurrent
            # OpenRouter clients out so we don't all retry at the same
            # instant the quota window resets.
            delay = EMBED_QUOTA_BACKOFF + random.uniform(0, 10)
            attempt_label = f"quota retry {quota_failures}/{MAX_EMBED_QUOTA_RETRIES}"
        else:
            data_failures += 1
            if data_failures > MAX_EMBED_DATA_RETRIES:
                break
            # Exponential backoff with jitter: 1, 2, 4, 8, 16s (+0-1s).
            delay = EMBED_RETRY_BASE_DELAY * (2 ** (data_failures - 1)) + random.uniform(0, 1)
            attempt_label = f"retry {data_failures}/{MAX_EMBED_DATA_RETRIES}"

        # Collapse multi-line JSON errors so each retry stays on one log line.
        compact_err = " ".join(last_err.split())[:240]
        logger.warning(
            f"Embedding {attempt_label} got no data ({compact_err}). "
            f"Retrying in {delay:.1f}s..."
        )
        await asyncio.sleep(delay)

    if resp is None or not resp.data:
        suggestions = ""
        if quota_failures > 0:
            suggestions = (
                "\n  Sustained quota error — options:"
                "\n    - Wait and re-run (cached batches will be skipped)"
                "\n    - Switch to a less rate-limited model: "
                "set EMBED_MODEL=openai/text-embedding-3-large (also 3072-dim)"
                "\n    - Submit a quota increase with the upstream provider"
            )
        attempts = data_failures + quota_failures
        raise RuntimeError(
            f"Embedding provider returned no data after {attempts} attempts "
            f"({data_failures} data, {quota_failures} quota). "
            f"Last error: {last_err}{suggestions}"
        )

    vectors = [d.embedding for d in resp.data]

    # The OpenAI SDK's typed response doesn't model OpenRouter's ``cost``
    # extra field. Round-trip through model_dump() so we can read it as a
    # plain dict, same trick refine.py uses.
    resp_dict = resp.model_dump() if hasattr(resp, "model_dump") else {}
    usage_raw = (resp_dict.get("usage") or {}) if isinstance(resp_dict, dict) else {}
    prompt_tokens = int(usage_raw.get("prompt_tokens", 0) or 0)
    total_tokens = int(usage_raw.get("total_tokens", prompt_tokens) or prompt_tokens)

    # Trust OpenRouter when it returns a positive cost (paid traffic or
    # BYOK on an endpoint that surfaces ``cost_details``).
    cost = extract_cost_usd(usage_raw)
    if cost is not None and cost > 0:
        return vectors, EmbeddingUsage(
            prompt_tokens=prompt_tokens,
            total_tokens=total_tokens,
            cost_usd=cost,
            cost_source="openrouter",
        )

    # Fall through: BYOK on the embedding endpoint. OpenRouter returns
    # ``cost: 0`` and no ``cost_details`` (verified 2026-05) — estimate
    # client-side from the token count so the ingest summary isn't $0.
    pricing = EMBED_PRICING_USD_PER_1M.get(model)
    if pricing is not None and total_tokens > 0:
        cost_est = total_tokens * pricing / 1_000_000
        return vectors, EmbeddingUsage(
            prompt_tokens=prompt_tokens,
            total_tokens=total_tokens,
            cost_usd=cost_est,
            cost_source="estimate",
        )

    return vectors, EmbeddingUsage(
        prompt_tokens=prompt_tokens,
        total_tokens=total_tokens,
        cost_usd=0.0,
        cost_source="unknown",
    )


async def embed_texts(
    texts: list[str],
    model: str | None = None,
    dimensions: int | None = None,
) -> list[list[float]]:
    """Embed a batch of texts. Used by both ingest and runtime search.

    Discards usage; call :func:`embed_texts_with_usage` if you want
    token + cost accounting.
    """
    vectors, _ = await embed_texts_with_usage(texts, model=model, dimensions=dimensions)
    return vectors


def open_table(
    db_path: str | os.PathLike[str],
    table_name: str,
) -> Table | None:
    """Open a LanceDB table by name. Returns ``None`` if the path or
    table doesn't exist yet (i.e. before the matching ingest has run).

    Read-only — callers should never create tables here. Use the
    appropriate ``tools/ingest_*.py`` script for that. Both args are
    required (no service-default) because this helper is shared across
    the stream archive and persona facts tables and there's no sensible
    default to bake in.
    """
    path = Path(db_path)
    if not path.exists():
        return None
    db = lancedb.connect(str(path))
    if table_name not in db.list_tables().tables:
        return None
    return db.open_table(table_name)


DEFAULT_EMBED_CACHE_PATH = "data/embed_cache.db"


class EmbedCache:
    """Persistent disk cache for embedding vectors.

    Why this exists: the ingest scripts churn through tens of thousands of
    chunks against an OpenRouter→Vertex AI endpoint that periodically 429s
    (shared upstream quota pool). When that crashes the run, every vector
    we already paid for is gone. Caching them to disk per batch turns
    "rerun loses 25 minutes" into "rerun finishes in seconds".

    Storage: SQLite (stdlib, atomic-on-commit, no extra deps) at
    ``data/embed_cache.db`` by default, sibling to the LanceDB dir.
    Vectors are float32 LE bytes — ~12KB per row at 3072 dim, ~370MB
    for 31k rows. Big but proportional, and the next ingest pays it back.

    Cache key is ``sha1(model || dim || text)``. Changing ``EMBED_MODEL``
    or ``EMBED_DIM`` makes every lookup miss naturally — old entries
    stay in the file but are never read; delete the file to reclaim the
    disk if you care.

    Not async-safe across processes (SQLite has its own locking but our
    single-writer pattern is enough) and not thread-safe by default. The
    ingest scripts are single-process, single-writer, so this is fine.
    """

    # SQLite's compiled-in default placeholder limit is 999; chunk well
    # under it for portability.
    _LOOKUP_CHUNK = 500

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False is safe here because asyncio shifts
        # callbacks across the event loop's single OS thread; the GIL
        # plus our serial-write pattern means there's no actual
        # concurrent access, but the SDK's asyncio plumbing trips the
        # default same-thread guard anyway.
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS embed_cache ("
            "  key TEXT PRIMARY KEY, "
            "  vector BLOB NOT NULL"
            ")"
        )
        # WAL mode lets readers continue while we commit. Negligible win
        # for our serial pattern but harmless and survives Ctrl-C better.
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.commit()

    @staticmethod
    def _key(model: str, dim: int, text: str) -> str:
        h = hashlib.sha1()
        h.update(f"{model}\0{dim}\0".encode("utf-8"))
        h.update(text.encode("utf-8"))
        return h.hexdigest()

    def get_many(
        self,
        model: str,
        dim: int,
        texts: list[str],
    ) -> dict[int, list[float]]:
        """Look up vectors for ``texts`` in one shot.

        Returns a dict mapping each text's index (in the input list) to
        its cached vector. Missing indices = cache misses, which the
        caller should embed fresh.
        """
        if not texts:
            return {}
        keys = [self._key(model, dim, t) for t in texts]
        by_key: dict[str, bytes] = {}
        for i in range(0, len(keys), self._LOOKUP_CHUNK):
            chunk = keys[i : i + self._LOOKUP_CHUNK]
            placeholders = ",".join("?" * len(chunk))
            query = f"SELECT key, vector FROM embed_cache WHERE key IN ({placeholders})"
            for k, v in self.conn.execute(query, chunk):
                by_key[k] = v
        out: dict[int, list[float]] = {}
        for i, k in enumerate(keys):
            blob = by_key.get(k)
            if blob is not None:
                out[i] = np.frombuffer(blob, dtype=np.float32).tolist()
        return out

    def put_many(
        self,
        model: str,
        dim: int,
        items: list[tuple[str, list[float]]],
    ) -> None:
        """Persist a batch of (text, vector) pairs and commit.

        Commits per call so a crash mid-batch only loses the in-flight
        embedding, never the previous one.
        """
        if not items:
            return
        rows = [
            (
                self._key(model, dim, text),
                np.asarray(vec, dtype=np.float32).tobytes(),
            )
            for text, vec in items
        ]
        self.conn.executemany(
            "INSERT OR REPLACE INTO embed_cache (key, vector) VALUES (?, ?)",
            rows,
        )
        self.conn.commit()

    def count(self) -> int:
        """Total cached vectors, across all (model, dim) keys."""
        row = self.conn.execute("SELECT COUNT(*) FROM embed_cache").fetchone()
        return int(row[0]) if row else 0

    def close(self) -> None:
        self.conn.close()
