"""Validate ``loginSyncToken`` against the Workers helper API.

``resolve_user_context`` POSTs the token to
``{WORKERS_BASE_URL}/bilibili/validate-login-sync-v2`` and parses the
Bilibili nav response into a ``UserContext``, which ``bot()`` turns into a
per-UID Mem0 namespace and a name prefixed onto the system prompt.

Results are cached for ``EIDOLON_VALIDATE_TTL_SEC`` (default 60s) keyed on
``sha256(token)`` — short enough to honor a Bilibili-side sign-out, long
enough to absorb WebRTC reconnect storms, and it keeps the raw token out
of long-lived process memory.

Everything fails open: network errors, malformed JSON, and ``code != 0``
all collapse to the anonymous context, logged at warning. A Workers outage
demotes every viewer to anonymous rather than taking the bot down.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx
from loguru import logger


@dataclass(frozen=True)
class UserContext:
    """Authenticated viewer identity, derived from a Bilibili nav response.

    Branch on ``is_logged_in``, never on individual field truthiness —
    ``face`` is legitimately absent for some logged-in users.
    """

    mid: int | None = None
    uname: str | None = None
    face: str | None = None
    is_logged_in: bool = False


# Shared instance for every "no token / can't validate / not logged in"
# case, so callers can identity-check it (`ctx is ANONYMOUS`).
ANONYMOUS = UserContext()


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            f"[user-context] {name}={raw!r} is not a valid int; using default {default}"
        )
        return default


_CACHE_TTL_SEC = _env_int("EIDOLON_VALIDATE_TTL_SEC", 60)
_HTTP_TIMEOUT_SEC = 10.0
_VALIDATE_PATH = "/bilibili/validate-login-sync-v2"

# Cache: sha256(token) -> (UserContext, monotonic_expiry).
_cache: dict[str, tuple[UserContext, float]] = {}
_cache_lock = asyncio.Lock()

# Built lazily so importing the bot without a running event loop doesn't
# construct a client; reused so keep-alive amortises validation cost.
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


def _default_headers() -> dict[str, str]:
    """Headers attached to every Workers request.

    ``CF_WAF_BYPASS_TOKEN`` rides along as ``x-laplace-cf-waf-bypass``:
    Cloudflare's WAF 403s server-to-server calls that lack a browser-like
    fingerprint, and the custom rule on the Workers side matches this
    header. The value must stay in sync with that rule. Read once at
    client construction, so rolling the token needs a bot restart.
    """
    headers: dict[str, str] = {}
    bypass = os.getenv("CF_WAF_BYPASS_TOKEN")
    if bypass:
        headers["x-laplace-cf-waf-bypass"] = bypass
    return headers


async def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is not None:
        return _client
    async with _client_lock:
        if _client is None:
            _client = httpx.AsyncClient(
                timeout=_HTTP_TIMEOUT_SEC,
                headers=_default_headers(),
            )
        return _client


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _parse_response(payload: Any) -> UserContext:
    """Coerce a validate-login-sync-v2 response into a ``UserContext``.

    Accepts ``data.mid`` (the canonical Bilibili nav field) or
    ``data.fetcher`` (the Workers wrapper's alias), since the laplace
    frontend reads ``fetcher`` — see ``login-sync-token-input.tsx``.
    """
    if not isinstance(payload, dict):
        return ANONYMOUS
    if payload.get("code") != 0:
        # -101 = not logged in, 404 = token unknown, anything else =
        # upstream error. The caller logs the raw code.
        return ANONYMOUS
    data = payload.get("data")
    if not isinstance(data, dict):
        return ANONYMOUS

    raw_mid = data.get("mid")
    if raw_mid is None:
        raw_mid = data.get("fetcher")
    try:
        mid = int(raw_mid) if raw_mid is not None else None
    except (TypeError, ValueError):
        mid = None

    uname = data.get("uname")
    face = data.get("face")
    if mid is None or not uname:
        # Nothing to personalize without both, and a half-populated
        # context is worse than an honest anonymous one.
        return ANONYMOUS
    return UserContext(
        mid=mid,
        uname=str(uname),
        face=str(face) if face else None,
        is_logged_in=True,
    )


async def resolve_user_context(token: str | None) -> UserContext:
    """Validate ``token`` and return the viewer's identity.

    Never raises and never returns ``None``. A failed refresh falls back
    to the stale cache entry when there is one, so a transient network
    blip can't flap a logged-in viewer to anonymous mid-call; otherwise
    it returns ``ANONYMOUS``.
    """
    if not token or not token.strip():
        logger.info("[user-context] No loginSyncToken; viewer is anonymous")
        return ANONYMOUS
    token = token.strip()

    base_url = (os.getenv("WORKERS_BASE_URL") or "").rstrip("/")
    if not base_url:
        logger.warning(
            "[user-context] WORKERS_BASE_URL not set; cannot validate token; treating viewer as anonymous"
        )
        return ANONYMOUS

    key = _hash_token(token)
    now = time.monotonic()

    cached = _cache.get(key)
    if cached is not None:
        ctx, expiry = cached
        if now < expiry:
            logger.info(
                f"[user-context] Cache hit (logged_in={ctx.is_logged_in}, "
                f"mid={ctx.mid}); skipping Workers call"
            )
            return ctx
        # Fall through to a refresh, but `cached` stays in scope as the
        # stale-on-failure fallback below.

    url = f"{base_url}{_VALIDATE_PATH}"
    logger.info(f"[user-context] Validating token against Workers at {url}")
    try:
        client = await _get_client()
        r = await client.post(url, json={"token": token})
        r.raise_for_status()
        payload = r.json()
    except httpx.HTTPError as e:
        logger.warning(
            f"[user-context] Workers validation request failed "
            f"({type(e).__name__}: {e}); falling back to "
            f"{'stale cache' if cached is not None else 'anonymous'}"
        )
        return cached[0] if cached is not None else ANONYMOUS
    except ValueError as e:  # json decode error from r.json()
        logger.warning(
            f"[user-context] Workers returned non-JSON ({e}); treating viewer as anonymous"
        )
        return ANONYMOUS

    ctx = _parse_response(payload)
    if ctx.is_logged_in:
        logger.info(f"[user-context] Resolved viewer mid={ctx.mid} uname={ctx.uname!r}")
    else:
        # The upstream code separates "wrong token" from "expired" from
        # "Workers returned a shape we don't understand".
        code = payload.get("code") if isinstance(payload, dict) else "?"
        logger.info(
            f"[user-context] Token did not resolve to a logged-in user (code={code})"
        )

    async with _cache_lock:
        _cache[key] = (ctx, now + _CACHE_TTL_SEC)
        # Opportunistic GC of entries expired for a further full TTL.
        cutoff = now - _CACHE_TTL_SEC
        for k, (_v, exp) in list(_cache.items()):
            if exp < cutoff:
                _cache.pop(k, None)
    return ctx
