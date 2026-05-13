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
