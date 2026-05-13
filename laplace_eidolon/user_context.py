"""Validate ``loginSyncToken`` against the Workers helper API and surface
the viewer's Bilibili profile to the bot.

Flow
----
1. ``bot()`` extracts ``loginSyncToken`` from ``runner_args.body`` (the
   ``requestData`` field of the WebRTC offer, set by the frontend).
2. :func:`resolve_user_context` POSTs to
   ``{WORKERS_BASE_URL}/bilibili/validate-login-sync-v2`` and parses the
   Bilibili nav response. Results are cached for
   ``EIDOLON_VALIDATE_TTL_SEC`` seconds (default 60s) keyed on a hash of
   the token — short enough to honor a sign-out / role change on
   Bilibili's side, long enough to absorb WebRTC reconnect storms
   without re-hitting Workers.
3. The returned :class:`UserContext` drives two pipeline knobs in
   :mod:`bot`:

   - **Mem0 user_id** — one private namespace per Bilibili UID (vs. a
     single shared ``default-user`` bucket).
   - **Persona prefix** — a short Chinese line prepended to the system
     prompt so the LLM knows who's on the other end.

Fail-open
---------
Network errors, malformed JSON, or a ``code != 0`` response collapse to
an anonymous :class:`UserContext`. A Workers outage shouldn't take the
voice bot down — the worst case is everyone temporarily becomes
"anonymous" (no Mem0, no name injection) until Workers recovers.
Logged as a warning so it surfaces in operational monitoring.

Cache & privacy
---------------
The cache is keyed on ``sha256(token)`` so the raw token never lingers
in process memory beyond the single validation call. Map size is
bounded by the number of distinct tokens that hit the bot inside one
TTL window — a handful of KB in practice, GC'd lazily on each write.
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

    The anonymous case is an instance with all profile fields ``None``
    and :attr:`is_logged_in` ``False``. Code that consumes this should
    branch on :attr:`is_logged_in`, not on individual field truthiness
    — a logged-in user CAN have a missing ``face`` (rare, but legal in
    the upstream response) without ceasing to be logged-in.
    """

    mid: int | None = None
    uname: str | None = None
    face: str | None = None
    is_logged_in: bool = False


# Returned for every "no token / can't validate / not logged in" case so
# callers can do an identity check (`ctx is ANONYMOUS`) if they need to
# distinguish the sentinel from a copy.
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

# Shared httpx.AsyncClient. Constructed lazily on first use so a bot
# import without an event loop doesn't try to build a client. Reused
# across calls so connection keep-alive amortises validation cost.
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


def _default_headers() -> dict[str, str]:
    """Headers attached to every Workers request through ``_get_client``.

    Currently carries ``CF_WAF_BYPASS_TOKEN`` (as the
    ``x-laplace-cf-waf-bypass`` header) so server-to-server validation
    calls don't get 403'd by the Cloudflare WAF rules that block
    traffic without a browser-like fingerprint. Match this value to
    the custom WAF rule on the Workers side — Workers reads the same
    header and waves the request through.

    Read at client-construction time, not per-call: changing the env
    var and rolling the token requires a bot restart, which is the
    same posture as every other env knob in this codebase.
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
    """Coerce a validate-login-sync-v2 response into a :class:`UserContext`.

    Accepts either ``data.mid`` (canonical Bilibili nav field) or
    ``data.fetcher`` (the Workers wrapper's alias) — the laplace
    frontend reads ``fetcher`` (see ``login-sync-token-input.tsx``), so
    we mirror that liberality here.
    """
    if not isinstance(payload, dict):
        return ANONYMOUS
    if payload.get("code") != 0:
        # -101 = not logged in, 404 = token unknown, others = upstream
        # errors. All collapse to "anonymous"; the caller logs the raw
        # code for observability.
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
        # Without a usable UID + name we can't personalize anything;
        # treat as anonymous rather than emit half-populated context.
        return ANONYMOUS
    return UserContext(
        mid=mid,
        uname=str(uname),
        face=str(face) if face else None,
        is_logged_in=True,
    )


async def resolve_user_context(token: str | None) -> UserContext:
    """Validate ``token`` and return the viewer's identity.

    Always returns a :class:`UserContext` — never raises and never
    returns ``None``. Callers branch on :attr:`UserContext.is_logged_in`.

    Cache semantics:

    - Hit within TTL: returns cached value, no I/O.
    - Miss or expired: refresh against Workers.
    - Refresh failure with stale value present: returns the stale value
      (stale-on-failure). A transient network blip shouldn't flap a
      logged-in viewer to anonymous mid-call.
    - Refresh failure with no stale value: returns :data:`ANONYMOUS`.
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
        # Stale; fall through to refresh, but keep `cached` in scope so
        # we can use it as a stale-on-failure fallback below.

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
        # Surface the upstream code so an admin can tell "wrong token"
        # from "token expired" from "Workers returned weird shape".
        code = payload.get("code") if isinstance(payload, dict) else "?"
        logger.info(
            f"[user-context] Token did not resolve to a logged-in user (code={code})"
        )

    async with _cache_lock:
        _cache[key] = (ctx, now + _CACHE_TTL_SEC)
        # Opportunistic GC: drop entries that have been expired for at
        # least another full TTL window. Bounded work per call.
        cutoff = now - _CACHE_TTL_SEC
        for k, (_v, exp) in list(_cache.items()):
            if exp < cutoff:
                _cache.pop(k, None)
    return ctx
