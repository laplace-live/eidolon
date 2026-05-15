"""Rate-limit anonymous WebRTC offers + expose a preflight endpoint +
normalize the offer body so downstream pipecat sees ``request_data`` +
push the per-session Opus bitrate from ``requestData.audioQuality``.

Four pieces of plumbing live here, all attached to the FastAPI app
Pipecat creates in ``pipecat.runner.run``:

1. A pure-ASGI HTTP middleware (:class:`OfferRateLimitMiddleware`) on
   ``POST /api/offer``. Reads the body once, looks for
   ``requestData.loginSyncToken``, and either lets the request through
   (token *validated* as a logged-in Bilibili viewer) or consumes one
   slot from :data:`rate_limit.ANON_QUOTA` (anonymous viewer OR token
   present but didn't validate). If the slot would be the (N+1)th in
   the window, returns ``429`` with ``Retry-After`` without ever
   spawning the WebRTC pipeline.

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
   outbound audio track. Because ``asyncio.ensure_future`` inside
   aiortc's connect/send chain captures ``copy_context`` at
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

Why pure ASGI and not ``BaseHTTPMiddleware``
--------------------------------------------
Earlier revisions used ``@app.middleware("http")`` (which expands to
``add_middleware(BaseHTTPMiddleware, dispatch=fn)``). Starlette's
``BaseHTTPMiddleware.coro`` only catches ``Exception`` — not
``BaseException`` — so any ``asyncio.CancelledError`` from a client
disconnect (or any other ``BaseException``) escapes the inner
``except``, leaves ``app_exc`` ``None``, and ``call_next`` (base.py:169)
raises a generic ``RuntimeError("No response returned.")`` that
``ServerErrorMiddleware`` renders as ``500`` to the caller. The bug
amplifies when two ``BaseHTTPMiddleware`` instances are stacked (the
project had two before this rewrite — see ``bot._block_pipecat_demo``)
and was the root cause of the "POST /api/offer 500 / PATCH /api/offer
422" cascade in the production logs (see
``repro_no_response.py``). Starlette upstream warns against
``BaseHTTPMiddleware`` for exactly this reason.

A pure-ASGI middleware also restores ``BackgroundTasks``: Starlette's
``_StreamingResponse`` (returned by ``BaseHTTPMiddleware.call_next``)
hard-codes ``self.background = None``, which silently drops the
``background_tasks.add_task(bot_module.bot, …)`` pipecat queues from
its ``/api/offer`` handler. Without this rewrite the bot itself never
runs even when the offer "succeeds".

How body buffering works here
-----------------------------
Reading the request body in middleware would normally exhaust the ASGI
``receive`` callable so the downstream Pipecat handler hangs on
``await request.json()``. We solve this by buffering all
``http.request`` chunks ourselves and handing the downstream app a
``wrapped_receive`` that replays the (possibly rewritten) body once
and then defers to the original ``receive`` for any post-body messages
(notably ``http.disconnect``).

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

    Replaces an earlier ``@app.middleware("http")`` /
    ``BaseHTTPMiddleware`` implementation that would surface client
    cancellations / aiortc background-task failures as a generic
    ``RuntimeError("No response returned.")`` ⇒ ``500`` (see the
    module docstring + ``repro_no_response.py``).

    Stateless apart from a per-instance reference to the shared
    ``AnonymousIpQuota``. Safe to instantiate exactly once at app
    startup via ``app.add_middleware(OfferRateLimitMiddleware,
    quota=...)``.
    """

    def __init__(self, app: ASGIApp, quota: AnonymousIpQuota | None = None) -> None:
        self.app = app
        self.quota = quota or ANON_QUOTA

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Only gate the actual offer POST. PATCH /api/offer (trickled
        # ICE candidates) reuses the same path but has no business
        # being throttled: it only follows a successful POST. The
        # preflight route below has its own peek-only logic. Everything
        # else (e.g. /api/ice-servers, /start) — and every non-HTTP
        # scope (websocket, lifespan) — passes through untouched.
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope["method"] != "POST" or scope["path"] != OFFER_PATH:
            await self.app(scope, receive, send)
            return

        # Buffer the request body so we can parse + optionally rewrite,
        # and so the downstream app can still read it via a wrapped
        # receive(). Pure ASGI gives us no _CachedRequest to lean on,
        # so the buffering is explicit here.
        body_bytes = await _read_body(receive)
        body = _parse_offer_body(body_bytes)
        # Normalize requestData → request_data before pipecat's route
        # parses the body — see module docstring for the parsing-bug
        # explanation. No-op when there's no requestData payload.
        rewrote = False
        if body is not None:
            rewrote, body_bytes = _normalize_request_data_alias(body, body_bytes)
        # Pin the per-session Opus bitrate from requestData.audioQuality
        # *before* dispatching downstream so the offer handler (and the
        # aiortc tasks it spawns to encode outbound audio) all inherit
        # the contextvar. Done unconditionally — works the same for
        # logged-in viewers (who bypass the rate limit below) and
        # rate-limited anonymous ones, and the contextvar is
        # request-scoped so it can't leak.
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
                await self.app(scope, _replay_body(receive, body_bytes), send)
                return
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

    Returns the concatenated body bytes. Stops on the first
    ``http.disconnect`` or after a chunk with ``more_body=False``.
    Treats early disconnect as an empty / partial body — the downstream
    parser will fail validation on its own and surface a 422 / 400.
    """
    body = b""
    while True:
        msg = await receive()
        if msg["type"] != "http.request":
            # Most commonly http.disconnect; stop reading and let the
            # downstream app see what we have so far via the replay.
            break
        body += msg.get("body", b"") or b""
        if not msg.get("more_body", False):
            break
    return body


def _replay_body(original_receive: Receive, body: bytes) -> Receive:
    """Wrap ``receive`` so the downstream app sees ``body`` once.

    Returns a new receive callable that emits the buffered body as a
    single ``http.request`` message (``more_body=False``) on its first
    call, then defers to ``original_receive`` for any subsequent
    messages. Subsequent messages are mostly ``http.disconnect`` —
    pipecat's offer handler doesn't poll receive again, but FastAPI's
    body parser does (one extra call to confirm there are no more
    chunks), and a clean ``http.disconnect`` passthrough lets a
    well-behaved handler observe client cancellation.
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
    """Send a small JSON response via the raw ASGI ``send`` callable.

    Mirrors what ``fastapi.responses.JSONResponse`` produces but skips
    the Starlette ``Response`` plumbing — we only ever use this for
    early-return rejection responses, so the simpler path is clearer.
    """
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
    """Pure-ASGI variant of :func:`_resolve_client_ip` that reads from
    the ASGI ``scope`` directly instead of a Starlette ``Request``.

    Same precedence as the Request variant: env-configured header first
    (e.g. ``cf-connecting-ip``, ``x-forwarded-for``), then ASGI
    ``scope['client']``, then the literal ``"unknown"`` bucket.
    """
    header_name = (os.getenv("EIDOLON_REAL_IP_HEADER") or "").strip().lower()
    if header_name:
        target = header_name.encode("latin-1")
        for k, v in scope.get("headers", []):
            if k.lower() == target:
                # X-Forwarded-For convention: "client, proxy1, proxy2".
                # Take the left-most entry (the original client).
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

    app.add_middleware(OfferRateLimitMiddleware, quota=quota)

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
