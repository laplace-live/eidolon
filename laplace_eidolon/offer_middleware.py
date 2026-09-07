"""Rate limiting, body normalization, and preflight for ``POST /api/offer``.

Attaches to the FastAPI app Pipecat creates in ``pipecat.runner.run``.
On each offer the middleware validates ``requestData.loginSyncToken``,
charges anonymous callers one slot from ``rate_limit.ANON_QUOTA``, and
429s before any WebRTC pipeline spawns. Token presence alone is never
enough — an unvalidated string would let anyone skip the quota and spawn
a full STT+LLM+TTS pipeline per probe.

Three framework constraints shape the implementation:

- **Pure ASGI, never ``BaseHTTPMiddleware``.** Starlette's version
  catches ``Exception`` but not ``BaseException``, so a client
  disconnect's ``CancelledError`` escapes and ``call_next`` raises
  ``RuntimeError("No response returned.")``, surfacing as a 500. It also
  returns a ``_StreamingResponse`` that hard-codes ``background = None``,
  silently dropping the ``add_task(bot_module.bot, …)`` that Pipecat's
  own handler queues — the bot never runs even when the offer succeeds.
  ``repro_no_response.py`` reproduces both.
- **Bodies must be buffered and replayed.** Reading the body here would
  exhaust the ASGI ``receive``, hanging the downstream handler on
  ``await request.json()``. ``wrapped_receive`` replays the rewritten
  body once, then defers to the original for ``http.disconnect``.
- **``requestData`` must be copied to ``request_data``.** Pipecat's
  ``SmallWebRTCRequest.from_dict`` accepts both spellings, but FastAPI
  parses through Pydantic's TypeAdapter, which ignores that classmethod
  and leaves ``request_data`` ``None`` for the camelCase the JS SDK
  always sends.

``POST /api/offer/preflight`` checks the same quota without consuming a
slot. The frontend calls it before ``client.connect()`` because the
small-webrtc transport swallows non-2xx from ``/api/offer`` and burns
~6s on reconnect retries first, by which point the 429 context is lost.

Set ``EIDOLON_REAL_IP_HEADER`` (``cf-connecting-ip``, ``x-forwarded-for``,
``x-real-ip``) behind a proxy; ``request.client.host`` would otherwise
resolve to the proxy itself.
"""

from __future__ import annotations

import json
import os
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from loguru import logger
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .audio_quality import (
    DEFAULT_BITRATE_BPS,
    quality_choices,
    resolve_quality_bitrate,
    session_bitrate_bps,
)
from .rate_limit import ANON_QUOTA, AnonymousIpQuota
from .user_context import resolve_user_context

OFFER_PATH = "/api/offer"
PREFLIGHT_PATH = "/api/offer/preflight"


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


def _request_data(body: dict[str, Any] | None) -> dict[str, Any] | None:
    """The offer's ``requestData`` block, accepting both spellings.

    Pipecat's ``SmallWebRTCRequest.from_dict`` takes either, so an
    out-of-band snake_case caller still authenticates.
    """
    if not body:
        return None
    nested = body.get("requestData")
    if not isinstance(nested, dict):
        nested = body.get("request_data")
    return nested if isinstance(nested, dict) else None


def _extract_login_sync_token(body: dict[str, Any] | None) -> str | None:
    """Pull ``requestData.loginSyncToken`` out of a parsed body dict.
    ``None`` on missing / empty / wrong shape.
    """
    nested = _request_data(body)
    if nested is None:
        return None
    token = nested.get("loginSyncToken")
    if isinstance(token, str) and token.strip():
        return token.strip()
    return None


def _extract_audio_quality(body: dict[str, Any] | None) -> Any:
    """Pull the raw ``requestData.audioQuality`` value.

    Returns the value unvalidated — the body is user-controlled, so
    ``audio_quality.resolve_quality_bitrate`` does the checking.
    """
    nested = _request_data(body)
    return nested.get("audioQuality") if nested is not None else None


def _apply_session_audio_quality(body: dict[str, Any] | None) -> None:
    """Push the per-session Opus bitrate onto ``session_bitrate_bps``.

    Missing, empty, or unrecognized values leave the contextvar at
    ``DEFAULT_BITRATE_BPS``. Only named presets are accepted — arbitrary
    integers would let a client pin 1 Mbps per session and saturate uplink.
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


def _normalize_request_data_alias(
    body: dict[str, Any], body_bytes: bytes
) -> tuple[bool, bytes]:
    """Copy ``requestData`` → ``request_data`` and return new body bytes.

    Returns ``(was_rewritten, new_body_bytes)``. When the body already
    has ``request_data`` (somebody else fixed it) or has no
    ``requestData`` (anonymous viewer, no payload to forward), returns
    ``(False, body_bytes)`` unchanged. The empty / mistyped cases
    collapse to no-op too — the goal is to fix the common JS-SDK shape,
    not to be a general schema migrator.

    Pure function — does not mutate ASGI scope, receive, or any
    Request object. The caller (the pure-ASGI middleware) is responsible
    for replaying ``new_body_bytes`` to downstream via a wrapped
    ``receive`` callable so pipecat's FastAPI handler parses the
    rewritten payload.
    """
    nested = body.get("requestData")
    if not isinstance(nested, dict):
        return False, body_bytes
    if "request_data" in body:
        return False, body_bytes
    body["request_data"] = nested
    return True, json.dumps(body).encode("utf-8")


class OfferRateLimitMiddleware:
    """Pure-ASGI middleware: rate-limit anonymous ``POST /api/offer``,
    validate logged-in tokens, normalize ``requestData`` to
    ``request_data``, and pin per-session Opus bitrate.

    Stateless apart from a reference to the shared ``AnonymousIpQuota``.
    """

    def __init__(self, app: ASGIApp, quota: AnonymousIpQuota | None = None) -> None:
        self.app = app
        self.quota = quota or ANON_QUOTA

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Gate only the offer POST. PATCH /api/offer (trickled ICE
        # candidates) shares the path but can only follow a successful
        # POST, so throttling it would punish an already-admitted caller.
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope["method"] != "POST" or scope["path"] != OFFER_PATH:
            await self.app(scope, receive, send)
            return

        # Pure ASGI gives us no _CachedRequest, so buffer explicitly:
        # parsing here would otherwise exhaust receive() downstream.
        body_bytes = await _read_body(receive)
        body = _parse_offer_body(body_bytes)
        rewrote = False
        if body is not None:
            rewrote, body_bytes = _normalize_request_data_alias(body, body_bytes)
        # Must happen before dispatch so the offer handler and the aiortc
        # encode tasks it spawns all inherit the contextvar.
        _apply_session_audio_quality(body)
        token = _extract_login_sync_token(body)
        if token:
            # resolve_user_context caches failures as well as successes for
            # EIDOLON_VALIDATE_TTL_SEC, so a flood of probes bearing the same
            # bad token costs one Workers hit per window.
            user = await resolve_user_context(token)
            if user.is_logged_in:
                logger.info(
                    f"[offer-middleware] Logged-in offer (validated "
                    f"mid={user.mid}, len={len(token)}, "
                    f"body_rewritten={rewrote}); bypassing rate limit"
                )
                await self.app(scope, _replay_body(receive, body_bytes), send)
                return
            # Revoked, malformed, or forged — all fall through to the plain
            # anonymous path with an identical 429, so the response never
            # reveals whether a token was a near-miss.
            logger.info(
                f"[offer-middleware] Token present but did not validate "
                f"(len={len(token)}); falling through to anonymous quota"
            )

        ip = _resolve_client_ip_from_scope(scope)
        result = await self.quota.try_consume(ip)
        if not result.allowed:
            logger.info(
                f"[offer-rate-limit] Anonymous quota exhausted for ip={ip}; "
                f"rejecting offer (retry_after={result.retry_after_seconds}s, "
                f"window={self.quota.window_seconds}s, max={self.quota.max_per_window})"
            )
            await _send_json(
                send,
                status_code=429,
                content={
                    "error": "匿名用户每小时通话次数已达上限，请登录后再试",
                    "retry_after": result.retry_after_seconds,
                },
                headers={"Retry-After": str(result.retry_after_seconds)},
            )
            return
        logger.debug(
            f"[offer-rate-limit] Anonymous offer allowed for ip={ip}; "
            f"remaining={result.remaining}/{self.quota.max_per_window}"
        )
        await self.app(scope, _replay_body(receive, body_bytes), send)


async def _read_body(receive: Receive) -> bytes:
    """Drain ``http.request`` chunks from the ASGI receive callable.

    An early disconnect yields an empty or partial body; the downstream
    parser fails validation on its own and surfaces a 422 / 400.
    """
    body = b""
    while True:
        msg = await receive()
        if msg["type"] != "http.request":
            break
        body += msg.get("body", b"") or b""
        if not msg.get("more_body", False):
            break
    return body


def _replay_body(original_receive: Receive, body: bytes) -> Receive:
    """Wrap ``receive`` so the downstream app sees ``body`` once.

    Emits the buffered body as one ``http.request``, then defers to
    ``original_receive``. FastAPI's body parser always calls once more to
    confirm no further chunks, and the passthrough lets a handler observe
    ``http.disconnect``.
    """
    replayed = False

    async def wrapped_receive() -> Message:
        nonlocal replayed
        if not replayed:
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await original_receive()

    return wrapped_receive


async def _send_json(
    send: Send,
    *,
    status_code: int,
    content: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> None:
    """Send a small JSON response via the raw ASGI ``send`` callable."""
    body = json.dumps(content, ensure_ascii=False).encode("utf-8")
    raw_headers: list[tuple[bytes, bytes]] = [
        (b"content-type", b"application/json; charset=utf-8"),
        (b"content-length", str(len(body)).encode("ascii")),
    ]
    for k, v in (headers or {}).items():
        raw_headers.append((k.encode("ascii"), v.encode("ascii")))
    await send(
        {
            "type": "http.response.start",
            "status": status_code,
            "headers": raw_headers,
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})


def _resolve_client_ip_from_scope(scope: Scope) -> str:
    """Pick the most-trusted client IP: env-configured header, then
    ``scope['client']``, then the shared ``"unknown"`` bucket.

    That bucket catches requests with no transport (ASGI test clients),
    and is shared across all such callers — which throttles bot-driven
    traffic harder than real viewers.
    """
    header_name = (os.getenv("EIDOLON_REAL_IP_HEADER") or "").strip().lower()
    if header_name:
        target = header_name.encode("latin-1")
        for k, v in scope.get("headers", []):
            if k.lower() == target:
                # Left-most X-Forwarded-For entry is the original client.
                first = v.decode("latin-1").split(",")[0].strip()
                if first:
                    return first
                break
    client = scope.get("client")
    if client and client[0]:
        return client[0]
    return "unknown"


def install_offer_middleware(
    app: FastAPI,
    *,
    quota: AnonymousIpQuota | None = None,
) -> None:
    """Wire offer rate limiting + preflight endpoint onto ``app``.

    Call once per process, as early as ``app`` is in scope so the
    middleware wraps Pipecat's ``/api/offer`` route registered later by
    the runner. Not idempotent — a second call double-consumes the quota.
    """
    quota = quota or ANON_QUOTA
    logger.info(
        f"[offer-middleware] Installed on {OFFER_PATH} "
        f"(anonymous quota: {quota.max_per_window}/{quota.window_seconds}s)"
    )

    app.add_middleware(OfferRateLimitMiddleware, quota=quota)

    @app.post(PREFLIGHT_PATH)
    async def offer_preflight(request: Request) -> JSONResponse:
        """Dry-run rate-limit check the frontend calls before connect.

        Takes the same body shape as the real offer so the frontend can
        reuse one ``requestData`` object. Never consumes a slot —
        preflight plus the real offer counts as one attempt.
        """
        body_bytes = await request.body()
        body = _parse_offer_body(body_bytes)
        token = _extract_login_sync_token(body)
        if token:
            # Shares resolve_user_context's cache with the real /api/offer
            # path, so both calls cost one Workers round-trip.
            user = await resolve_user_context(token)
            if user.is_logged_in:
                return JSONResponse(content={"ok": True, "anonymous": False})
            # Bad token reports the plain anonymous quota state — the
            # response shape never distinguishes it from "no token".

        ip = _resolve_client_ip_from_scope(request.scope)
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
