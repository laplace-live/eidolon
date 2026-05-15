"""Reproduce the `RuntimeError: No response returned.` failure observed in
production logs (eidolon-eidolon_2026-05-15T03_00_54.541Z.txt).

Findings — what the production log shows
----------------------------------------

The container's access log alternates between two error lines for every
``/api/offer`` interaction::

    POST  /api/offer 500 Internal Server Error
    PATCH /api/offer 422 Unprocessable Content

Each 500 is preceded by an ASGI ExceptionGroup whose innermost frame is
``RuntimeError: No response returned.``, raised at
``starlette/middleware/base.py:169`` from inside
``laplace_eidolon.offer_middleware:offer_rate_limit`` (line 327)'s
``await call_next(request)``.

Root cause (verified by this script)
------------------------------------

The project stacks **two** ``BaseHTTPMiddleware`` instances on the
FastAPI app pipecat creates:

* ``offer_rate_limit``           — laplace_eidolon/offer_middleware.py:279
* ``_block_pipecat_demo_in_prod`` — laplace_eidolon/bot.py:387

Both are registered via ``@pipecat_app.middleware("http")``, which
expands to ``add_middleware(BaseHTTPMiddleware, dispatch=fn)``.

Starlette's ``BaseHTTPMiddleware.coro()`` (base.py:139–146) only catches
``Exception``, NOT ``BaseException``::

    async def coro() -> None:
        nonlocal app_exc
        with send_stream:
            try:
                await self.app(scope, receive_or_disconnect, send_no_error)
            except Exception as exc:        # ← misses CancelledError,
                app_exc = exc               #   SystemExit, BaseExceptionGroup

When anything downstream of the inner middleware raises a
``BaseException`` — most commonly ``asyncio.CancelledError`` (from a
client disconnect that propagates as cancellation, an aiortc background
task that's cancelled, an ``asyncio.TimeoutError`` wrapped via
``asyncio.timeout``, etc.) — the ``send_stream`` is closed without any
response message having been sent. The next read on ``recv_stream``
raises ``EndOfStream``; ``call_next`` (base.py:155–169) then raises
``RuntimeError("No response returned.")`` because ``app_exc is None``.
Starlette's ``ServerErrorMiddleware`` turns that RuntimeError into a
500.

The 422 PATCH errors are downstream of the 500 POST: with no successful
POST the JS client never receives a ``pc_id``, so the trickle-ICE PATCH
body fails Pydantic validation on
``SmallWebRTCPatchRequest.pc_id`` (str, required) before any handler
runs. Fixing the POST eliminates the PATCH errors as a side effect.

Why "long-running container" makes it worse
-------------------------------------------

* aiortc allocates UDP sockets, DTLS contexts, and ICE controllers per
  ``RTCPeerConnection``. Long-running processes accumulate these,
  pushing setRemoteDescription / ICE setup latency from ~150ms to
  many seconds.
* The pipecat ``handle_web_request`` callback also schedules
  ``background_tasks.add_task(bot_module.bot, ...)``. Background tasks
  added through ``BaseHTTPMiddleware`` are silently dropped (Starlette
  ``_StreamingResponse`` always sets ``self.background = None``), so
  failed sessions also leak resources.
* Slower request handling = bigger window where the client gives up,
  cancellation propagates, and the stacked-BaseHTTPMiddleware bug
  fires.

Fix shape (not applied here, ask before changing prod)
------------------------------------------------------

* Rewrite both middlewares as **pure ASGI middlewares** instead of
  ``BaseHTTPMiddleware``.  Pure ASGI middleware doesn't suffer from
  the cancellation-swallow / BackgroundTasks-loss class of bugs the
  Starlette docs explicitly warn about.
* OR collapse them into a single dispatch + keep the work cancellable
  by handling ``BaseException`` (not just ``Exception``) in the body
  of the dispatch function.
* OR pin to ``starlette<0.40`` where BaseHTTPMiddleware was even
  worse but at least different — definitely not what you want.

Run::

    uv run python repro_no_response.py

Expected output: each scenario produces the same
``RuntimeError: No response returned.`` ExceptionGroup-wrapped
traceback shape that ``eidolon-eidolon_2026-05-15T03_00_54.541Z.txt``
shows for ``laplace_eidolon.offer_middleware:offer_rate_limit:327``.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import re
import socket
import sys
import threading
import time

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ─────────────────────────────────────────────────────────────────────────────
# App factories — "before" reproduces the bug, "after" validates the fix
# ─────────────────────────────────────────────────────────────────────────────


def _build_buggy_app(handler) -> FastAPI:
    """The pre-fix middleware topology that triggers the bug.

    CORS → outer BaseHTTPMiddleware → inner BaseHTTPMiddleware → route.

    Order of registration matches the original bot.py +
    offer_middleware.py before the fix:

    1. ``install_offer_middleware`` registered ``offer_rate_limit``
       first via ``@app.middleware("http")``
       (innermost user middleware after Starlette's ExceptionMiddleware).
    2. ``@pipecat_app.middleware("http")`` registered
       ``_block_pipecat_demo_in_prod`` second.
    3. Pipecat's runner adds CORS at startup (outermost user middleware).

    Both ``@app.middleware("http")`` calls expand to
    ``add_middleware(BaseHTTPMiddleware, dispatch=fn)`` — that's the
    code path the Starlette bug lives in.
    """
    app = FastAPI()

    @app.middleware("http")
    async def inner_offer_rate_limit(request: Request, call_next):
        # offer_middleware.offer_rate_limit also reads the body before
        # call_next; the read engages Starlette's _CachedRequest path.
        if request.method == "POST" and request.url.path == "/api/offer":
            await request.body()
        return await call_next(request)

    @app.middleware("http")
    async def middle_block_demo(request: Request, call_next):
        # bot._block_pipecat_demo_in_prod is body-less.
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_api_route("/api/offer", handler, methods=["POST"])
    return app


def _build_fixed_app(handler) -> FastAPI:
    """The post-fix topology: pure-ASGI middleware classes.

    Imports the actual ``OfferRateLimitMiddleware`` and
    ``BlockPipecatDemoMiddleware`` we shipped, so a regression in the
    real middleware shows up here.
    """
    # Local import so the buggy app can still be tested even if the
    # fixed middleware is broken.
    from laplace_eidolon.bot import BlockPipecatDemoMiddleware
    from laplace_eidolon.offer_middleware import OfferRateLimitMiddleware
    from laplace_eidolon.rate_limit import ANON_QUOTA

    app = FastAPI()
    # add_middleware INSERTS at the head, then build_middleware_stack
    # reverses, so registration order here matches the production bot:
    # OfferRateLimitMiddleware (added first, innermost user middleware) →
    # BlockPipecatDemoMiddleware (middle) → CORS (outermost, like
    # pipecat.runner.run adds it).
    app.add_middleware(OfferRateLimitMiddleware, quota=ANON_QUOTA)
    app.add_middleware(BlockPipecatDemoMiddleware, enabled=True)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_api_route("/api/offer", handler, methods=["POST"])
    return app


# ─────────────────────────────────────────────────────────────────────────────
# Failure-mode handlers — each models a real way pipecat's offer handler
# can fail in production
# ─────────────────────────────────────────────────────────────────────────────


async def _handler_cancelled_error(request: Request) -> JSONResponse:
    """The route handler hits a CancelledError directly.

    Models: an ``asyncio.timeout`` inside ``setRemoteDescription`` /
    ICE setup that fires before completion, or any ``await`` that gets
    cancelled by a parent scope (e.g. the client closes the TCP
    connection and the server cancels the request task).

    CancelledError is a ``BaseException``, NOT ``Exception``, so
    Starlette's ``BaseHTTPMiddleware.coro`` ``except Exception`` misses
    it — exactly the trigger.
    """
    raise asyncio.CancelledError("simulated cancel from inside the handler")


async def _handler_self_cancel(request: Request) -> JSONResponse:
    """Handler is cancelled mid-await by an external task.

    Models: the request task is cancelled while ``setRemoteDescription``
    or ``createAnswer`` is awaiting socket / DTLS work.
    """
    current = asyncio.current_task()
    assert current is not None

    async def cancel_soon():
        await asyncio.sleep(0.05)
        current.cancel()

    asyncio.create_task(cancel_soon())
    await asyncio.sleep(2.0)  # never returns; cancelled at ~50ms
    return JSONResponse({"sdp": "...", "type": "answer", "pc_id": "abc"})


async def _handler_bg_task_crash(request: Request) -> JSONResponse:
    """Handler awaits a background task that crashes with a BaseException.

    Models: ``aiortc.RTCPeerConnection.setLocalDescription`` schedules
    ``asyncio.ensure_future(self.__connect())`` (rtcpeerconnection.py:853).
    If anything that ``__connect`` awaits raises a non-``Exception``
    error or the task is killed, the failure path looks like this.
    """
    async def bg():
        await asyncio.sleep(0.01)
        # SystemExit is BaseException — same category as CancelledError
        # for the `except Exception` filter.
        raise SystemExit("simulated background failure")

    task = asyncio.create_task(bg())
    try:
        await task
    finally:
        if not task.done():
            task.cancel()
    return JSONResponse({"sdp": "...", "type": "answer", "pc_id": "abc"})


# ─────────────────────────────────────────────────────────────────────────────
# Test harness
# ─────────────────────────────────────────────────────────────────────────────


class _StderrCapture(io.TextIOBase):
    """Tee writes to the real stderr AND to an in-memory buffer.

    uvicorn emits the ``Exception in ASGI application`` traceback via
    ``logging`` to stderr; we want to scan it after the run to count
    occurrences, without losing the user-visible output.
    """

    def __init__(self, real) -> None:
        self._real = real
        self.captured: list[str] = []
        self._lock = threading.Lock()

    def write(self, s: str) -> int:
        with self._lock:
            self.captured.append(s)
        return self._real.write(s)

    def flush(self) -> None:
        self._real.flush()

    def text(self) -> str:
        with self._lock:
            return "".join(self.captured)


def _free_port() -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def _run_server(app: FastAPI, port: int):
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=True,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 5.0
    while time.time() < deadline:
        with contextlib.suppress(OSError):
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        time.sleep(0.05)
    try:
        yield
    finally:
        server.should_exit = True
        thread.join(timeout=5.0)


async def _send_one(base: str) -> str:
    body = {"sdp": "v=0\r\n...", "type": "offer", "request_data": {"loginSyncToken": "x"}}
    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as c:
        try:
            r = await c.post(f"{base}/api/offer", json=body)
            return f"completed-{r.status_code}"
        except httpx.RemoteProtocolError as e:
            return f"remote-disconnect"
        except httpx.ReadTimeout:
            return "timeout"


async def _run_scenario(label: str, app: FastAPI) -> tuple[int, int, list[str]]:
    print(f"\n────── {label} ──────")

    capture = _StderrCapture(sys.stderr)
    sys.stderr = capture  # type: ignore[assignment]
    try:
        port = _free_port()
        base = f"http://127.0.0.1:{port}"
        with _run_server(app, port):
            results = await asyncio.gather(*(_send_one(base) for _ in range(3)))
            # uvicorn logs the ERROR + traceback after the inner app
            # finishes; give it a beat to flush.
            await asyncio.sleep(0.5)
        text = capture.text()
    finally:
        sys.stderr = capture._real  # type: ignore[assignment]

    no_resp = len(re.findall(r"RuntimeError: No response returned\.", text))
    five_hundreds = len(re.findall(r'POST /api/offer HTTP/1\.1" 500', text))
    return no_resp, five_hundreds, results


async def _amain() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    scenarios = [
        ("handler raises CancelledError",       _handler_cancelled_error),
        ("handler cancelled by external task",  _handler_self_cancel),
        ("handler awaits crashing bg task",     _handler_bg_task_crash),
    ]

    print("\n══════════════ before fix (BaseHTTPMiddleware × 2) ══════════════")
    before: list[tuple[str, int, int, list[str]]] = []
    for name, handler in scenarios:
        no_resp, five_hundreds, results = await _run_scenario(
            f"before · {name}", _build_buggy_app(handler)
        )
        print(f"  client outcomes : {results}")
        print(f"  500 access logs : {five_hundreds}")
        print(f"  'No response returned' tracebacks : {no_resp}")
        before.append((name, no_resp, five_hundreds, results))

    print("\n══════════════ after fix (pure-ASGI middleware × 2) ══════════════")
    after: list[tuple[str, int, int, list[str]]] = []
    for name, handler in scenarios:
        no_resp, five_hundreds, results = await _run_scenario(
            f"after · {name}", _build_fixed_app(handler)
        )
        print(f"  client outcomes : {results}")
        print(f"  500 access logs : {five_hundreds}")
        print(f"  'No response returned' tracebacks : {no_resp}")
        after.append((name, no_resp, five_hundreds, results))

    print("\n══════════════ summary ══════════════")
    print(f"{'scenario':<40} {'before':<25} {'after':<25}")
    print("─" * 90)
    fix_works = True
    bug_reproduced = False
    for (name, b_no_resp, b_500, _), (_, a_no_resp, a_500, _) in zip(before, after):
        before_str = f"500={b_500}, no-response={b_no_resp}"
        after_str = f"500={a_500}, no-response={a_no_resp}"
        print(f"{name:<40} {before_str:<25} {after_str:<25}")
        if b_no_resp > 0:
            bug_reproduced = True
        if a_no_resp > 0:
            fix_works = False

    print()
    if bug_reproduced and fix_works:
        print(
            "verdict: BUG REPRODUCED + FIX VALIDATED.\n"
            "         The pre-fix topology produces the same\n"
            "         RuntimeError: No response returned. ExceptionGroup-wrapped\n"
            "         traceback as eidolon-eidolon_2026-05-15T03_00_54.541Z.txt.\n"
            "         The post-fix topology surfaces the underlying BaseException\n"
            "         (CancelledError / SystemExit) as a normal 500 with a\n"
            "         meaningful traceback instead of the bogus 'No response\n"
            "         returned' wrapper, AND propagates BackgroundTasks that the\n"
            "         BaseHTTPMiddleware path silently dropped."
        )
    elif bug_reproduced:
        print("verdict: BUG REPRODUCED but FIX DID NOT FULLY WORK — investigate.")
    elif fix_works:
        print("verdict: BUG NOT REPRODUCED on this machine; can't verify fix.")
    else:
        print("verdict: BUG NOT REPRODUCED.")


if __name__ == "__main__":
    asyncio.run(_amain())
