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
  /v1/embeddings endpoint (default OpenRouter → Gemini)
- ``EmbeddingUsage`` — token + USD cost accumulator
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
and old vectors won't be comparable to new ones.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import lancedb
from lancedb.table import Table
from openai import AsyncOpenAI

DEFAULT_DB_PATH = "data/lancedb"
DEFAULT_EMBED_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_EMBED_MODEL = "google/gemini-embedding-2-preview"
DEFAULT_EMBED_DIM = int(os.getenv("EMBED_DIM", "3072"))
"""Vector dimension. Read at module import so the LanceDB schemas in
``tools/ingest_streams.py`` and ``tools/ingest_facts.py`` match what
``embed_texts()`` will produce. To change, set the env var BEFORE
importing this module (i.e. in .env) and re-ingest both tables."""


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
        _embed_client = AsyncOpenAI(base_url=base_url, api_key=api_key)
    return _embed_client


@dataclass
class EmbeddingUsage:
    """Token + cost accumulator for embedding requests.

    OpenRouter surfaces ``usage.cost`` in USD on every response (1 credit
    = $1). Other OpenAI-compatible providers may not, in which case
    ``cost_source`` stays "unknown" and ``cost_usd`` is 0.

    Unlike ``tools.refine.Usage`` we don't carry an "estimate" fallback —
    embedding pricing isn't in any hardcoded table here, so we either
    trust OpenRouter's number or report tokens-only.
    """

    prompt_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    cost_source: str = "unknown"  # "openrouter" if from response, "unknown" otherwise

    def add(self, other: "EmbeddingUsage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.total_tokens += other.total_tokens
        self.cost_usd += other.cost_usd
        if self.cost_source == "unknown":
            self.cost_source = other.cost_source


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
    resp = await client.embeddings.create(
        model=model,
        input=texts,
        dimensions=dimensions,
        encoding_format="float",
        # OpenRouter now always returns usage.cost, but passing this is
        # harmless and matches how tools/refine.py opts in for chat.
        extra_body={"usage": {"include": True}},
    )
    vectors = [d.embedding for d in resp.data]

    # The OpenAI SDK's typed response doesn't model OpenRouter's ``cost``
    # extra field. Round-trip through model_dump() so we can read it as a
    # plain dict, same trick refine.py uses.
    resp_dict = resp.model_dump() if hasattr(resp, "model_dump") else {}
    usage_raw = (resp_dict.get("usage") or {}) if isinstance(resp_dict, dict) else {}
    prompt_tokens = int(usage_raw.get("prompt_tokens", 0) or 0)
    total_tokens = int(usage_raw.get("total_tokens", prompt_tokens) or prompt_tokens)
    cost = usage_raw.get("cost")
    if cost is not None:
        try:
            return vectors, EmbeddingUsage(
                prompt_tokens=prompt_tokens,
                total_tokens=total_tokens,
                cost_usd=float(cost),
                cost_source="openrouter",
            )
        except (TypeError, ValueError):
            pass

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
