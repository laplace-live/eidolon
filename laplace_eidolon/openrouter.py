"""OpenRouter request-header utility, shared by every caller that hits
OpenRouter's API.

Why this module exists
----------------------
Three independent code paths in this repo make OpenRouter calls:

- ``bot.py``           — chat LLM via Pipecat's ``OpenRouterLLMService``
- ``embeddings.py``    — ``/v1/embeddings`` via the OpenAI SDK
- ``tools/refine.py``  — chat completions via the OpenAI SDK (batch refine)

OpenRouter uses ``HTTP-Referer`` and ``X-Title`` to attribute traffic to a
named "app" on its analytics dashboard, plus the ``X-OpenRouter-*``
hints for backend routing. Without these, every call shows up as
anonymous and bunched into the default category. Centralising them here
keeps the four headers in sync across all three callers — drift used to
silently demote some traffic to anonymous on the dashboard.

The headers are also safe pass-through when ``EMBED_BASE_URL`` or
``REFINE_BASE_URL`` points at a non-OpenRouter provider — unknown
headers are ignored by every OpenAI-compatible provider we've tried.

Override the project identity per-deployment via env vars:

- ``OPENROUTER_APP_NAME`` — defaults to ``laplace-eidolon``
- ``OPENROUTER_APP_URL``  — defaults to the upstream GitHub repo
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

PROJECT_NAME = os.getenv("OPENROUTER_APP_NAME", "LAPLACE Live!")
"""App name shown on the OpenRouter dashboard. Read at import time so a
later mutation of ``os.environ`` doesn't take effect; load ``.env``
before importing this module if you need a custom value."""

PROJECT_URL = os.getenv("OPENROUTER_APP_URL", "https://laplace.live/ai")
"""App URL shown on the OpenRouter dashboard. Same import-time semantics
as ``PROJECT_NAME``."""

# Content-category hint passed through ``X-OpenRouter-Categories``. The
# bot is a roleplay persona; this nudges OpenRouter to route to providers
# whose content policy allows that kind of traffic.
_CATEGORY = "roleplay"


def openrouter_headers() -> dict[str, str]:
    """Return the standard OpenRouter attribution + routing headers.

    Spread into any request that hits ``openrouter.ai/api/v1``:

    - For the OpenAI SDK::

          AsyncOpenAI(..., default_headers=openrouter_headers())

    - For Pipecat's ``OpenRouterLLMService``::

          OpenRouterLLMService(..., default_headers=openrouter_headers())

    A fresh dict is returned on each call so callers can mutate it
    (e.g. add per-request override headers) without polluting the
    shared identity.
    """
    return {
        "HTTP-Referer": PROJECT_URL,
        "X-Title": PROJECT_NAME,
        "X-OpenRouter-Title": PROJECT_NAME,
        "X-OpenRouter-Categories": _CATEGORY,
    }


def extract_cost_usd(usage: Mapping[str, Any] | None) -> float | None:
    """Pick the best USD cost out of an OpenRouter ``usage`` block.

    OpenRouter's response shape (verified live against the production
    API, 2026-05) carries cost in one of two places:

    - ``usage.cost`` — what OpenRouter billed the account. Always
      reported as ``0`` for BYOK requests because OpenRouter doesn't
      take a cut of the inference itself.
    - ``usage.cost_details.upstream_inference_cost`` — what the upstream
      provider (Google AI Studio, OpenAI, Anthropic, …) actually
      charged. Only present on BYOK requests on the chat endpoint.

      .. note::
         OpenRouter does **not** surface ``cost_details`` on the
         ``/v1/embeddings`` endpoint as of 2026-05, even on BYOK. The
         embeddings response is ``{prompt_tokens, total_tokens,
         cost: 0}`` with nothing else — callers must fall back to
         client-side token-count estimation when this helper returns
         ``0.0`` for an embedding response.

    Prefer ``cost`` when it's positive; otherwise fall back to
    ``cost_details.upstream_inference_cost``; otherwise return whatever
    ``cost`` parsed to. ``None`` means "no cost data at all" (some
    non-OpenRouter providers); ``0.0`` means "OpenRouter responded with
    zero" (genuinely free or BYOK on an endpoint that withholds the
    upstream amount).

    The historical ``usage.byok_usage_inference`` name is **not** an
    OpenRouter API field — it doesn't appear in any response and isn't
    in the docs. Don't add it back.
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

    # BYOK fallback. OpenRouter packs three sub-fields into
    # ``cost_details``: upstream_inference_cost (total),
    # upstream_inference_prompt_cost, upstream_inference_completions_cost.
    # We want the total.
    details = usage.get("cost_details")
    if isinstance(details, Mapping):
        upstream = _as_float(details.get("upstream_inference_cost"))
        if upstream is not None:
            return upstream

    return cost
