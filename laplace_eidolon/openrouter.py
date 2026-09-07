"""Shared OpenRouter attribution and routing headers.

OpenRouter reads ``HTTP-Referer`` / ``X-Title`` to attribute traffic to a
named app on its dashboard; without them calls land in an anonymous
bucket. Every OpenAI-compatible provider we've pointed ``EMBED_BASE_URL``
or ``REFINE_BASE_URL`` at ignores the headers harmlessly.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

PROJECT_NAME = os.getenv("OPENROUTER_APP_NAME", "LAPLACE Live!")
"""App name on the OpenRouter dashboard. Read at import, so ``.env`` has
to load before this module does."""

PROJECT_URL = os.getenv("OPENROUTER_APP_URL", "https://laplace.live/ai")
"""App URL on the OpenRouter dashboard. Same import-time semantics."""

# Sent as ``X-OpenRouter-Categories``, nudging OpenRouter toward providers
# whose content policy permits roleplay traffic.
_CATEGORY = "roleplay"


def openrouter_headers() -> dict[str, str]:
    """A fresh dict of attribution + routing headers, safe to mutate."""
    return {
        "HTTP-Referer": PROJECT_URL,
        "X-Title": PROJECT_NAME,
        "X-OpenRouter-Title": PROJECT_NAME,
        "X-OpenRouter-Categories": _CATEGORY,
    }


def extract_cost_usd(usage: Mapping[str, Any] | None) -> float | None:
    """Pick the best USD cost out of an OpenRouter ``usage`` block.

    ``usage.cost`` is what OpenRouter billed, and is always ``0`` on BYOK
    requests since OpenRouter takes no cut of the inference.
    ``usage.cost_details.upstream_inference_cost`` carries what the
    provider actually charged, but only on BYOK chat requests — the
    embeddings endpoint reports ``cost: 0`` and nothing else, so embedding
    callers must fall back to client-side token estimation when this
    returns ``0.0``.

    ``None`` means no cost data at all, which some non-OpenRouter
    providers return.
    """
    if not isinstance(usage, Mapping):
        return None

    def _as_float(value: Any) -> float | None:
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    cost = _as_float(usage.get("cost"))
    if cost is not None and cost > 0:
        return cost

    # ``cost_details`` also carries upstream_inference_prompt_cost and
    # upstream_inference_completions_cost; we want the total.
    details = usage.get("cost_details")
    if isinstance(details, Mapping):
        upstream = _as_float(details.get("upstream_inference_cost"))
        if upstream is not None:
            return upstream

    return cost
