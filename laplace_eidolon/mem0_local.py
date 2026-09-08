"""Self-hosted Mem0 config: embedded ``Memory`` over Qdrant.

Mem0's cloud is not reachable by a self-hosted deployment, and its OSS
REST server is not a drop-in either: ``MemoryClient`` requires an API key
and validates it against ``GET /v1/ping/``, which only the platform
serves. So the self-hosted path runs the OSS engine in-process —
``Memory.from_config(local_config)`` — with Qdrant holding the vectors.

Fact extraction reuses the persona LLM through OpenRouter, and embeddings
reuse ``embeddings.py``'s model and dimension so one ``EMBED_MODEL`` /
``EMBED_DIM`` pair governs every vector this project writes. Qdrant pins
the collection's dimension at creation, so changing ``EMBED_DIM`` means
dropping ``MEM0_QDRANT_COLLECTION`` and letting viewers re-accumulate —
old memory vectors are not comparable to new ones.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .embeddings import DEFAULT_EMBED_BASE_URL, DEFAULT_EMBED_DIM, DEFAULT_EMBED_MODEL
from .env import env_int

DEFAULT_QDRANT_PORT = 6333
DEFAULT_COLLECTION = "eidolon_memories"
DEFAULT_HISTORY_DB_PATH = "data/mem0/history.db"
DEFAULT_LLM_MODEL = "~google/gemini-flash-latest"


def is_configured() -> bool:
    """True when a Qdrant host is set, which is what enables memory.

    Deliberately not a reachability check — Qdrant being down is handled
    where the client is built, so a restart ordering blip degrades the
    call instead of failing the boot.
    """
    return bool(qdrant_host())


def qdrant_host() -> str:
    """The Qdrant host, empty when memory is disabled."""
    return (os.getenv("MEM0_QDRANT_HOST") or "").strip()


def build_local_config() -> dict[str, Any]:
    """Assemble the ``local_config`` dict for ``Memory.from_config``.

    Raises:
        RuntimeError: If no embedding API key is available, which would
            otherwise surface as an opaque 401 on the first memory write.
    """
    embed_api_key = os.getenv("EMBED_API_KEY") or os.getenv("OPENROUTER_API_KEY")
    if not embed_api_key:
        raise RuntimeError(
            "Self-hosted Mem0 needs an embedding API key. Set OPENROUTER_API_KEY "
            "(reused from the LLM config) or EMBED_API_KEY for a different provider."
        )

    # sqlite3.connect raises rather than creating missing parents, and the
    # history DB lands under a mounted volume that starts empty.
    history_db_path = Path(os.getenv("MEM0_HISTORY_DB_PATH") or DEFAULT_HISTORY_DB_PATH)
    history_db_path.parent.mkdir(parents=True, exist_ok=True)

    return {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "host": qdrant_host(),
                "port": env_int("MEM0_QDRANT_PORT", DEFAULT_QDRANT_PORT),
                "collection_name": os.getenv("MEM0_QDRANT_COLLECTION") or DEFAULT_COLLECTION,
                "embedding_model_dims": DEFAULT_EMBED_DIM,
                # Vectors on disk rather than mmap'd into RAM: at 3072 dims
                # the resident set otherwise grows with every viewer, on a
                # box already running the bot itself.
                "on_disk": True,
            },
        },
        # mem0's OpenAI LLM routes through OpenRouter on its own whenever
        # OPENROUTER_API_KEY is in the environment, so only the slug is set
        # here. The embedder below has no such detection.
        "llm": {
            "provider": "openai",
            "config": {
                "model": os.getenv("MEM0_LLM_MODEL")
                or os.getenv("OPENROUTER_MODEL")
                or DEFAULT_LLM_MODEL,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": os.getenv("EMBED_MODEL") or DEFAULT_EMBED_MODEL,
                "api_key": embed_api_key,
                "openai_base_url": os.getenv("EMBED_BASE_URL") or DEFAULT_EMBED_BASE_URL,
                "embedding_dims": DEFAULT_EMBED_DIM,
            },
        },
        "history_db_path": str(history_db_path),
    }


__all__ = ["build_local_config", "is_configured", "qdrant_host"]
