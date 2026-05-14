"""Rate-limit anonymous WebRTC offers + expose a preflight endpoint +
normalize the offer body so downstream pipecat sees ``request_data`` +
push the per-session Opus bitrate from ``requestData.audioQuality``.

Four pieces of plumbing live here, all attached to the FastAPI app
Pipecat creates in ``pipecat.runner.run``:

1. A Starlette HTTP middleware on ``POST /api/offer``. Reads the body
   once, looks for ``requestData.loginSyncToken``, and either lets the
   request through (token *validated* as a logged-in Bilibili viewer)
   or consumes one slot from :data:`rate_limit.ANON_QUOTA` (anonymous
   viewer OR token present but didn't validate). If the slot would be
   the (N+1)th in the window, returns ``429`` with ``Retry-After``
   without ever spawning the WebRTC pipeline.

   The validation is intentional: an earlier trust-on-presence design
   let an attacker bypass the rate limit by sending any non-empty
   string as ``loginSyncToken``, spawning a full STT+LLM+TTS pipeline
   per probe. Validation now happens here against the Workers helper
   via :func:`user_context.resolve_user_context`, which keys an
   in-process TTL cache on the token hash — repeat probes with the
   same bad token cost roughly one Workers hit per cache window and
   the legit-user path is essentially free (bot() reuses the cache).

2. The same middleware also rewrites the body to copy ``requestData``
   to ``request_data`` (snake_case) before handing off to pipecat's
   route. Pipecat's ``SmallWebRTCRequest`` is a stdlib ``@dataclass``
   with a ``from_dict`` classmethod that handles both spellings, but
   FastAPI's auto-parsing uses Pydantic's TypeAdapter and ignores that
   classmethod, leaving ``request_data`` ``None`` whenever the client
   sends camelCase (which the JS SDK always does). The rewrite makes
   ``runner_args.body`` actually carry the ``loginSyncToken`` into
   ``bot()`` — without it the bot can never see the token, even when
   the middleware-level rate-limit bypass already saw it.

3. The same middleware also reads ``requestData.audioQuality`` (one
   of ``best`` / ``medium`` / ``low`` / ``lowest``) and pushes the
   matching Opus bitrate onto :data:`audio_quality.session_bitrate_bps`.
   That contextvar is read by the patched ``OpusEncoder.__init__``
   (see ``bot.py``) when aiortc lazily constructs the encoder for the
   outbound audio track. Because anyio's ``start_soon`` (used by
   ``BaseHTTPMiddleware.call_next`` and by ``asyncio.ensure_future``
   inside aiortc's connect/send chain) captures ``copy_context`` at
   task-creation time, a value set in this middleware propagates all
   the way down to the encoder without explicit threading.

4. A ``POST /api/offer/preflight`` route that performs the same
   anonymous quota *check* without consuming a slot. The frontend hits
   this before ``client.connect()`` because the small-webrtc transport
   silently swallows non-2xx responses from ``/api/offer`` and burns ~6s
   on internal reconnect retries before surfacing any error — by the
   time the catch fires on the browser the 429 context is gone. With
   the preflight, a rate-limited viewer sees the friendly Chinese
   message instantly. Preflight validates the token too, for the same
   reason as the main middleware — and the cached validation means
   preflight + real offer counts as a single Workers hit for legit
   viewers.

Why a Starlette ``BaseHTTPMiddleware`` is safe here
---------------------------------------------------
Reading the request body in middleware would normally exhaust the ASGI
``receive`` callable so the downstream Pipecat handler would hang on
``await request.json()``. Starlette's ``BaseHTTPMiddleware`` (which
backs ``@app.middleware("http")``) wraps the request in a
``_CachedRequest`` whose ``wrapped_receive`` re-emits the cached body
to downstream consumers — the FastAPI route handler that decodes
``SmallWebRTCRequest`` sees the same JSON we read here. Mutating
``request._body`` after that cache exists also propagates: the
``wrapped_receive`` source reads ``self._body`` directly, so a single
re-assign is enough to swap the downstream payload. See
``starlette/middleware/base.py`` (``_CachedRequest``).

IP resolution
-------------
``request.client.host`` is correct for direct binds but useless behind
Cloudflare / nginx / a load balancer (it'd be the proxy's IP). Set
``EIDOLON_REAL_IP_HEADER`` (e.g. ``cf-connecting-ip``,
``x-forwarded-for``, ``x-real-ip``) to opt into header-based resolution.
For ``X-Forwarded-For`` we take the first entry (the original client),
matching what most reverse proxies expect.
"""

from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from loguru import logger

from .audio_quality import (
    DEFAULT_BITRATE_BPS,
    quality_choices,
    resolve_quality_bitrate,
    session_bitrate_bps,
)
from .rate_limit import ANON_QUOTA, AnonymousIpQuota
from .user_context import resolve_user_context

# Shared with `bot.py`'s @pipecat_app.get registration so the path lives
# in exactly one place.
OFFER_PATH = "/api/offer"
PREFLIGHT_PATH = "/api/offer/preflight"


def _resolve_client_ip(request: Request) -> str:
    """Pick the most-trusted client IP based on env config.

    Returns the literal string ``"unknown"`` only when the request has
    no ``client`` (e.g. ASGI test clients without a transport) — that
    bucket is shared across all callers, which intentionally throttles
    bot-driven traffic harder than real viewers.
    """
    header_name = (os.getenv("EIDOLON_REAL_IP_HEADER") or "").strip().lower()
    if header_name:
        raw = request.headers.get(header_name) or ""
        # X-Forwarded-For convention: "client, proxy1, proxy2". The
        # left-most entry is the original client; the rest are the hops
        # we're behind. Single-IP headers like CF-Connecting-IP also
        # split safely (no comma → returns the whole value).
        first = raw.split(",")[0].strip()
        if first:
            return first
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _parse_offer_body(body_bytes: bytes) -> dict[str, Any] | None:
    """Decode the offer JSON body into a dict, or ``None`` on failure.

    The middleware treats ``None`` as "malformed / anonymous viewer",
    so probes and junk fall under the rate limit by default — a real
    client never sends junk.
    """
    if not body_bytes:
        return None
    try:
        body: Any = json.loads(body_bytes.decode("utf-8", errors="replace"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(body, dict):
        return None
    return body


def _extract_login_sync_token(body: dict[str, Any] | None) -> str | None:
    """Pull ``requestData.loginSyncToken`` (or snake_case fallback) out
    of a parsed body dict. ``None`` on missing / empty / wrong shape.
    """
    if not body:
        return None
    # Pipecat's `SmallWebRTCRequest.from_dict` accepts both `requestData`
    # (camelCase, what the JS transport sends) and `request_data`
    # (snake_case). Mirror that liberality so an out-of-band caller using
    # snake_case still gets rate-limit-bypassed when authenticated.
    nested = body.get("requestData")
    if not isinstance(nested, dict):
        nested = body.get("request_data")
    if not isinstance(nested, dict):
        return None
    token = nested.get("loginSyncToken")
    if isinstance(token, str) and token.strip():
        return token.strip()
    return None


def _extract_audio_quality(body: dict[str, Any] | None) -> Any:
    """Pull the raw ``requestData.audioQuality`` value (snake_case fallback).

    Mirrors :func:`_extract_login_sync_token` for the
    ``audioQuality`` knob: tries ``requestData`` first, falls back to
    ``request_data``. Returns whatever was put under that key — usually
    a string, but could be anything since the frontend body is
    user-controlled. Validation happens in
    :func:`audio_quality.resolve_quality_bitrate`.
    """
    if not body:
        return None
    nested = body.get("requestData")
    if not isinstance(nested, dict):
        nested = body.get("request_data")
    if not isinstance(nested, dict):
        return None
    return nested.get("audioQuality")


def _apply_session_audio_quality(body: dict[str, Any] | None) -> None:
    """Push the per-session Opus bitrate onto :data:`session_bitrate_bps`.

    Called from the offer middleware *before* ``call_next``, so the
    contextvar is set in the request task's context. ``call_next``
    spawns the FastAPI route handler in a child task that inherits this
    context (anyio's ``start_soon`` captures ``copy_context``), and so
    do all downstream tasks — including aiortc's ``__connect`` →
    ``RTCRtpSender.send`` → ``_run_rtp`` chain that lazily constructs
    the ``OpusEncoder``. The patched ``OpusEncoder.__init__`` in
    ``bot.py`` then reads the contextvar and pins ``codec.bit_rate``
    to the chosen preset.

    No-op (leaves the contextvar at its default) when:

    * the body has no ``audioQuality`` field — older client, fall
      through to ``DEFAULT_BITRATE_BPS`` silently
    * the value is missing/empty — same as above
    * the value isn't one of the known presets — log a warning so a
      mistyped frontend constant is diagnosable, then fall through

    We deliberately don't accept arbitrary integer bitrates here. The
    presets bound the worst case (a malicious client can't pin 1 Mbps
    per session and saturate uplink) and keep the protocol simple.
    """
    raw = _extract_audio_quality(body)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return
    bitrate = resolve_quality_bitrate(raw)
    if bitrate is None:
        logger.warning(
            f"[offer-middleware] Unknown audioQuality={raw!r}; "
            f"valid choices: {quality_choices()}. "
            f"Falling back to default {DEFAULT_BITRATE_BPS // 1000} kbps."
        )
        return
    session_bitrate_bps.set(bitrate)
    logger.info(
        f"[offer-middleware] audioQuality={str(raw).strip().lower()!r} "
        f"→ Opus bitrate {bitrate // 1000} kbps for this session"
    )


def _normalize_request_data_alias(request: Request, body: dict[str, Any]) -> bool:
    """Copy ``requestData`` → ``request_data`` on the cached body bytes.

    Returns True when the request payload was mutated (so callers can
    log this happened); False when no change was needed. Mutates
    ``request._body`` directly because Starlette's ``_CachedRequest``
    keys downstream ``wrapped_receive`` off that attribute — see the
    module docstring for the citation.

    No-op when the body already has ``request_data`` (somebody else
    fixed it) or has no ``requestData`` (anonymous viewer, no payload
    to forward). The empty / mistyped cases collapse to no-op too —
    the goal is to fix the common JS-SDK shape, not to be a general
    schema migrator.
    """
    nested = body.get("requestData")
    if not isinstance(nested, dict):
        return False
    if "request_data" in body:
        return False
    body["request_data"] = nested
    request._body = json.dumps(body).encode("utf-8")  # type: ignore[attr-defined]
    return True


def install_offer_middleware(
    app: FastAPI,
    *,
    quota: AnonymousIpQuota | None = None,
) -> None:
    """Wire offer rate limiting + preflight endpoint onto ``app``.

    Call exactly once per process, ideally as soon as ``app`` is in
    scope so the middleware wraps every subsequent request — including
    Pipecat's own ``/api/offer`` route registered later by the runner.
    Idempotency is the caller's responsibility (calling twice would
    register two middlewares and double-consume the quota).
    """
    quota = quota or ANON_QUOTA
    logger.info(
        f"[offer-middleware] Installed on {OFFER_PATH} "
        f"(anonymous quota: {quota.max_per_window}/{quota.window_seconds}s)"
    )

    @app.middleware("http")
    async def offer_rate_limit(
        request: Request,
        call_next: Callable[[Request], Awaitable[Any]],
    ) -> Any:
        # Only gate the actual offer POST. PATCH /api/offer (trickled
        # ICE candidates) reuses the same path but has no business
        # being throttled: it only follows a successful POST. The
        # preflight route below has its own peek-only logic. Everything
        # else (e.g. /api/ice-servers, /start) passes through untouched.
        if request.method != "POST" or request.url.path != OFFER_PATH:
            return await call_next(request)

        # Reading the body here is safe because Starlette's
        # BaseHTTPMiddleware wraps `request` in a `_CachedRequest` whose
        # `wrapped_receive` re-emits the cached bytes to the downstream
        # FastAPI route. See module docstring for citations.
        body_bytes = await request.body()
        body = _parse_offer_body(body_bytes)
        # Normalize requestData → request_data before pipecat's route
        # parses the body — see module docstring for the parsing-bug
        # explanation. No-op when there's no requestData payload.
        rewrote = False
        if body is not None:
            rewrote = _normalize_request_data_alias(request, body)
        # Pin the per-session Opus bitrate from requestData.audioQuality
        # *before* call_next so the offer handler (and the aiortc tasks
        # it spawns to encode outbound audio) all inherit the contextvar.
        # Done unconditionally — works the same for logged-in viewers
        # (who bypass the rate limit below) and rate-limited anonymous
        # ones, and the contextvar is request-scoped so it can't leak.
        _apply_session_audio_quality(body)
        token = _extract_login_sync_token(body)
        if token:
            # Validate the token before bypassing the quota. Trust-on-
            # presence would let any non-empty string spawn a full
            # WebRTC pipeline (STT + LLM + TTS) without consuming a
            # slot — see module docstring. ``resolve_user_context``
            # caches both successes and failures for
            # ``EIDOLON_VALIDATE_TTL_SEC`` so probes from the same bad
            # token only cost one Workers hit per cache window, and
            # bot()'s subsequent call hits the same cache.
            user = await resolve_user_context(token)
            if user.is_logged_in:
                logger.info(
                    f"[offer-middleware] Logged-in offer (validated "
                    f"mid={user.mid}, len={len(token)}, "
                    f"body_rewritten={rewrote}); bypassing rate limit"
                )
                return await call_next(request)
            # Token present but didn't validate: revoked, malformed,
            # or forged. Don't tell the caller specifically — fall
            # through to the same anonymous quota path a probe with
            # no token at all would take. The 429 message stays
            # identical so we don't leak whether a token was a
            # near-miss.
            logger.info(
                f"[offer-middleware] Token present but did not validate "
                f"(len={len(token)}); falling through to anonymous quota"
            )

        ip = _resolve_client_ip(request)
        result = await quota.try_consume(ip)
        if not result.allowed:
            logger.info(
                f"[offer-rate-limit] Anonymous quota exhausted for ip={ip}; "
                f"rejecting offer (retry_after={result.retry_after_seconds}s, "
                f"window={quota.window_seconds}s, max={quota.max_per_window})"
            )
            return JSONResponse(
                status_code=429,
                content={
                    "error": "匿名用户每小时通话次数已达上限，请登录后再试",
                    "retry_after": result.retry_after_seconds,
                },
                headers={"Retry-After": str(result.retry_after_seconds)},
            )
        logger.debug(
            f"[offer-rate-limit] Anonymous offer allowed for ip={ip}; "
            f"remaining={result.remaining}/{quota.max_per_window}"
        )
        return await call_next(request)

    @app.post(PREFLIGHT_PATH)
    async def offer_preflight(request: Request) -> JSONResponse:
        """Dry-run rate-limit check the frontend calls before connect.

        Body shape mirrors the real offer body — ``{requestData:
        {loginSyncToken?: string}}`` — so the frontend can reuse one
        ``requestData`` object for both calls without rebuilding it.

        Returns ``200`` for both "logged-in viewer" and "anonymous with
        slots remaining"; ``429`` with ``Retry-After`` when the
        anonymous quota is exhausted. Crucially, this NEVER consumes a
        slot — successful preflight + actual offer counts as ONE
        attempt, not two.
        """
        body_bytes = await request.body()
        body = _parse_offer_body(body_bytes)
        token = _extract_login_sync_token(body)
        if token:
            # Match the main middleware: validate before declaring
            # the viewer logged-in. ``resolve_user_context`` shares
            # the cache used by the real /api/offer path, so this
            # preflight + the real offer count as a single Workers
            # round-trip for legit viewers.
            user = await resolve_user_context(token)
            if user.is_logged_in:
                return JSONResponse(content={"ok": True, "anonymous": False})
            # Bad token: fall through and report the anonymous quota
            # state. We deliberately don't differentiate "no token"
            # from "bad token" in the response shape.

        ip = _resolve_client_ip(request)
        result = await quota.peek(ip)
        if result.allowed:
            return JSONResponse(
                content={
                    "ok": True,
                    "anonymous": True,
                    "remaining": result.remaining,
                }
            )
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "anonymous": True,
                "error": "匿名用户每小时通话次数已达上限，请登录后再试",
                "retry_after": result.retry_after_seconds,
            },
            headers={"Retry-After": str(result.retry_after_seconds)},
        )
