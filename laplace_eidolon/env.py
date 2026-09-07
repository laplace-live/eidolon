"""Numeric env-var parsing, shared by every module that reads one.

python-dotenv parses ``KEY=`` as ``""``, so ``int(os.getenv("X", "60"))``
raises on a plain ``.env.example`` copy. These treat empty as unset.
"""

from __future__ import annotations

import os

from loguru import logger


def env_int(name: str, default: int) -> int:
    """Parse an int env var, treating an empty value as unset."""
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning(f"{name}={raw!r} is not a valid int; using default {default}")
        return default


def env_float(name: str, default: float) -> float:
    """Parse a float env var, treating an empty value as unset."""
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning(f"{name}={raw!r} is not a valid float; using default {default}")
        return default
