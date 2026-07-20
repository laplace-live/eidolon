"""Shared embedding client and LanceDB table access.

Both runtime services (``persona_facts``, ``stream_archive``) and both
offline ingest scripts embed through here, so ingest-time and query-time
vectors stay comparable.

Any OpenAI-compatible ``/v1/embeddings`` endpoint works. The default is
OpenRouter → ``google/gemini-embedding-2-preview`` at 3072-dim, reusing the
``OPENROUTER_API_KEY`` already set for the LLM; ``EMBED_BASE_URL``,
``EMBED_API_KEY``, ``EMBED_MODEL``, and ``EMBED_DIM`` override each piece
(Gemini supports 128–3072 via MRL).

Moving to a model of a different dimension means changing ``EMBED_DIM``
**and** re-running both ingest scripts: the LanceDB schema is fixed-size and
old vectors aren't comparable to new ones. Cache entries key on
``(model, dim, text)`` so stale ones miss rather than mislead, but the file
grows until deleted.
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
"""Vector dimension, read once at import — both ingest scripts build their
LanceDB schemas from it, so set ``EMBED_DIM`` in .env, never after import."""

# Fallback per-model embedding prices, USD per 1M tokens.
#
# OpenRouter doesn't surface ``cost_details`` on ``/v1/embeddings``. On a BYOK
# key the response is literally ``{prompt_tokens, total_tokens, cost: 0}`` —
# real money is spent upstream (Google AI Studio etc.) and reported as zero,
# so without a client-side estimate a 26k-chunk ingest logs ``$0.000000`` per
# batch. Prices come from each provider's public pricing page; best-effort,
# update them when they move.
EMBED_PRICING_USD_PER_1M: dict[str, float] = {
    "google/gemini-embedding-2-preview": 0.15,
    "~google/gemini-embedding-2-preview": 0.15,
    "openai/text-embedding-3-small": 0.02,
    "openai/text-embedding-3-large": 0.13,
}

# Retries for the "200 OK with no `data` field" case: OpenRouter wraps
# upstream errors inside a 200 body (``{"error": {...}}``) rather than
# returning a real status, so the OpenAI SDK's ``max_retries`` never sees
# them. Two budgets, because the failure modes need opposite backoff. Data
# failures (transient blips, malformed responses) clear in seconds under
# short exponential backoff. Quota failures (429 / RESOURCE_EXHAUSTED) need
# the ~60s Vertex AI quota window to reset, and often several of them since
# the OpenRouter pool is shared — exponential backoff alone exhausts in ~30s
# and kills the run on the first quota incident.
MAX_EMBED_DATA_RETRIES = 5
EMBED_RETRY_BASE_DELAY = 1.0
MAX_EMBED_QUOTA_RETRIES = 10
EMBED_QUOTA_BACKOFF = 60.0


def _is_quota_error(err_msg: str) -> bool:
    """True if ``err_msg`` looks like a rate-limit / quota error.

    String-matched because the status code is always 200. Conservative — a
    hit commits the caller to a fixed 60s wait.
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
    """Lazy singleton OpenAI-SDK client pointed at the embedding provider."""
    global _embed_client
    if _embed_client is None:
        base_url = os.getenv("EMBED_BASE_URL", DEFAULT_EMBED_BASE_URL)
        api_key = os.getenv("EMBED_API_KEY") or os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError(
                "Embeddings need an API key. Set OPENROUTER_API_KEY (reused "
                "from the LLM config) or EMBED_API_KEY for a different provider."
            )
        # Covers the transient failures the SDK recognises (429, 5xx, dropped
        # connections); the 200-with-no-data case needs our own loop in
        # ``embed_texts_with_usage``.
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

    OpenRouter reports ``usage.cost`` in USD on non-BYOK responses (1 credit
    = $1); on BYOK the embeddings endpoint, unlike chat, withholds it
    entirely, so cost falls back to an estimate. ``cost_source`` keeps the
    two apart so callers can label output honestly: ``"openrouter"`` came
    from the response, ``"estimate"`` is tokens × ``EMBED_PRICING_USD_PER_1M``,
    and ``"unknown"`` means ``cost_usd`` is 0 for lack of tokens or a price
    entry — worth warning the user about.
    """

    prompt_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    cost_source: str = "unknown"

    def add(self, other: "EmbeddingUsage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.total_tokens += other.total_tokens
        self.cost_usd += other.cost_usd
        # "unknown" promotes to anything; a genuine openrouter+estimate mix
        # degrades to "mixed" so summaries can flag partial estimation.
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
    """Embed a batch of texts and return the provider-reported usage.

    Args:
        dimensions: Output vector dim, defaulting to ``DEFAULT_EMBED_DIM``.
            Must match the LanceDB schema — a write/read mismatch fails at
            search time.

    Returns:
        ``(vectors, usage)``, where ``usage`` carries token counts and, when
        the provider reports it, the USD cost of this one call.
    """
    if not texts:
        return [], EmbeddingUsage()
    model = model or os.getenv("EMBED_MODEL", DEFAULT_EMBED_MODEL)
    dimensions = dimensions or DEFAULT_EMBED_DIM
    client = _get_embed_client()
    # encoding_format="float" is *required* for non-OpenAI providers (e.g.
    # OpenRouter → Gemini): the SDK silently defaults to "base64" for wire
    # efficiency and base64-decodes on parse, and providers that don't honour
    # that exact contract round-trip an empty response, surfacing as the SDK's
    # "No embedding data received". Pinning float skips the base64 path.
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
            # Redundant now that OpenRouter always returns usage.cost, but
            # harmless, and it matches how refine.py opts in for chat.
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
            # Jitter spreads concurrent clients out so they don't all retry
            # the instant the quota window resets.
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

    # The SDK's typed response doesn't model OpenRouter's ``cost`` extra
    # field, so read it off a model_dump() dict — same trick as refine.py.
    resp_dict = resp.model_dump() if hasattr(resp, "model_dump") else {}
    usage_raw = (resp_dict.get("usage") or {}) if isinstance(resp_dict, dict) else {}
    prompt_tokens = int(usage_raw.get("prompt_tokens", 0) or 0)
    total_tokens = int(usage_raw.get("total_tokens", prompt_tokens) or prompt_tokens)

    # A positive cost means paid traffic, or BYOK on an endpoint that does
    # surface ``cost_details`` — trust it.
    cost = extract_cost_usd(usage_raw)
    if cost is not None and cost > 0:
        return vectors, EmbeddingUsage(
            prompt_tokens=prompt_tokens,
            total_tokens=total_tokens,
            cost_usd=cost,
            cost_source="openrouter",
        )

    # BYOK: cost comes back 0, so estimate from tokens rather than report an
    # ingest summary of $0.
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

    Discards usage; call ``embed_texts_with_usage`` for token + cost
    accounting.
    """
    vectors, _ = await embed_texts_with_usage(texts, model=model, dimensions=dimensions)
    return vectors


def open_table(
    db_path: str | os.PathLike[str],
    table_name: str,
) -> Table | None:
    """Open a LanceDB table by name, or ``None`` if the path or table doesn't
    exist yet — services boot before their ingest has ever run.

    Read-only. Tables are created by the matching ``tools/ingest_*.py``.
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

    Ingest churns tens of thousands of chunks against an OpenRouter → Vertex
    AI endpoint that periodically 429s on a shared quota pool, and a crash
    without this loses every vector already paid for — the difference between
    a rerun costing 25 minutes and one costing seconds.

    SQLite at ``data/embed_cache.db``, sibling to the LanceDB dir, holding
    float32 LE bytes: ~12KB per row at 3072 dim, ~370MB for 31k rows. Keyed
    by ``sha1(model || dim || text)``, so changing ``EMBED_MODEL`` or
    ``EMBED_DIM`` misses naturally instead of returning stale vectors; the
    old entries linger in the file until it's deleted.

    Assumes the ingest scripts' single-process, single-writer pattern.
    """

    # SQLite's compiled-in default placeholder limit is 999.
    _LOOKUP_CHUNK = 500

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS embed_cache ("
            "  key TEXT PRIMARY KEY, "
            "  vector BLOB NOT NULL"
            ")"
        )
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

        Keys of the returned dict are indices into ``texts``; an absent index
        is a cache miss the caller should embed fresh.
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

        Commits per call, so a crash mid-run only loses the in-flight batch.
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
