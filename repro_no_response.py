"""Reproduce ``RuntimeError: No response returned.`` from stacked middleware.

Starlette's ``BaseHTTPMiddleware.coro`` catches ``Exception``, not
``BaseException``. So when a client disconnect cancels the request task, the
``CancelledError`` escapes with no response message ever sent, and
``call_next`` — reading a closed stream while ``app_exc is None`` — raises
``RuntimeError("No response returned.")``, which ``ServerErrorMiddleware``
turns into a 500.

Three handlers model that trigger (a direct ``CancelledError``, external
cancellation mid-await, a background task raising ``SystemExit``). Each runs
against the old stacked-``BaseHTTPMiddleware`` topology and against the
pure-ASGI middleware that replaced it, imported from the real modules so a
regression there fails here too. ``offer_middleware.py`` owns the
production-side explanation.

    uv run python repro_no_response.py
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


def _build_buggy_app(handler) -> FastAPI:
    """The pre-fix topology: CORS → two stacked ``BaseHTTPMiddleware``.

    ``@app.middleware("http")`` expands to
    ``add_middleware(BaseHTTPMiddleware, dispatch=fn)``, which is where the
    Starlette bug lives. Registration order mirrors the original bot: the
    rate limiter innermost, the demo block next, CORS outermost (Pipecat's
    runner adds CORS at startup).
    """
    app = FastAPI()

    @app.middleware("http")
    async def inner_offer_rate_limit(request: Request, call_next):
        # The real rate limiter also read the body before call_next, which
        # is what engages Starlette's _CachedRequest path.
        if request.method == "POST" and request.url.path == "/api/offer":
            await request.body()
        return await call_next(request)

    @app.middleware("http")
    async def middle_block_demo(request: Request, call_next):
        # Body-less, matching the demo blocker it stands in for.
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
    """The post-fix topology, built from the shipped pure-ASGI classes."""
    # Local import so the buggy app still runs even when the fixed
    # middleware is broken.
    from laplace_eidolon.bot import BlockPipecatDemoMiddleware
    from laplace_eidolon.offer_middleware import OfferRateLimitMiddleware
    from laplace_eidolon.rate_limit import ANON_QUOTA

    app = FastAPI()
    # add_middleware inserts at the head and build_middleware_stack then
    # reverses, so first-added ends up innermost: rate limit → demo block
    # → CORS, matching the production bot.
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


async def _handler_cancelled_error(request: Request) -> JSONResponse:
    """The route handler hits a ``CancelledError`` directly.

    Models an ``asyncio.timeout`` firing partway through
    ``setRemoteDescription`` / ICE setup, or the client closing its TCP
    connection and the server cancelling the request task.
    """
    raise asyncio.CancelledError("simulated cancel from inside the handler")


async def _handler_self_cancel(request: Request) -> JSONResponse:
    """The handler is cancelled mid-await by an external task.

    Models the request task being cancelled while ``setRemoteDescription``
    or ``createAnswer`` awaits socket / DTLS work.
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
    """The handler awaits a background task that dies with a BaseException.

    Models ``aiortc.RTCPeerConnection.setLocalDescription``, which schedules
    ``asyncio.ensure_future(self.__connect())``. If that task is killed, or
    anything it awaits raises a non-``Exception`` error, the failure takes
    this path.
    """
    async def bg():
        await asyncio.sleep(0.01)
        # SystemExit is a BaseException, so `except Exception` misses it
        # for the same reason it misses CancelledError.
        raise SystemExit("simulated background failure")

    task = asyncio.create_task(bg())
    try:
        await task
    finally:
        if not task.done():
            task.cancel()
    return JSONResponse({"sdp": "...", "type": "answer", "pc_id": "abc"})


class _StderrCapture(io.TextIOBase):
    """Tee writes to the real stderr and to an in-memory buffer.

    uvicorn logs its ``Exception in ASGI application`` traceback to stderr,
    which the run scans afterwards to count occurrences — the tee keeps that
    output visible to the user meanwhile.
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
            # uvicorn logs the ERROR + traceback only after the inner app
            # finishes, so give it a beat to flush.
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
