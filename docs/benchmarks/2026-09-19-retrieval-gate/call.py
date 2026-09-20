"""Hold one real WebRTC call through bot() and time every turn's retrieval stage.

macOS only: the viewer's lines are spoken by `say -v Tingting`. Makes real
Soniox, OpenRouter, and Fish Audio requests.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import socket
import subprocess
import sys
import tempfile
import time
import wave
from fractions import Fraction
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from loguru import logger

logger.remove()
logging.basicConfig(level=logging.CRITICAL)

import httpx
import numpy as np
import uvicorn
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    LLMContextFrame,
    LLMTextFrame,
    TranscriptionFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator
from pipecat.runner import run as pipecat_run
from pipecat.services.llm_service import LLMService

from laplace_eidolon import bot as bot_module

bot = bot_module.bot  # the runner looks for bot() on __main__

LINES = [
    "我今天加班好累啊。",
    "你喜欢吃纳豆吗？",
    "哈哈哈，好吧。",
    "坚果是什么品种的猫？",
    "你是不是说过你不敢去网吧？",
    "好的，我先去吃饭了，一会儿回来。",
]
PAUSE_SEC = 2.0
TURN_TIMEOUT_SEC = 45.0

origin = time.monotonic()
events: list[dict[str, Any]] = []
seen: set[int] = set()
speaking = False
last_stop = 0.0


def now() -> float:
    return round(time.monotonic() - origin, 4)


def record(kind: str, **fields: Any) -> None:
    events.append({"t": now(), "kind": kind, **fields})


def log_sink(message: Any) -> None:
    item = message.record
    if item["name"].startswith("laplace_eidolon") and item["level"].no >= 20:
        record("log", text=item["message"][:300])


logger.add(log_sink, level="INFO")

_async_send = httpx.AsyncClient.send
_sync_send = httpx.Client.send
_TRACKED = {"embeddings", "rerank", "decisions", "completions"}


async def timed_async_send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
    target = request.url.path.rsplit("/", 1)[-1]
    start = now()
    response = await _async_send(self, request, *args, **kwargs)
    if target in _TRACKED:
        record("http", target=target, ms=round((now() - start) * 1000),
               status=response.status_code)
    return response


def timed_sync_send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
    target = request.url.path.rsplit("/", 1)[-1]
    start = now()
    response = _sync_send(self, request, *args, **kwargs)
    if target in _TRACKED:
        record("http", target=target, ms=round((now() - start) * 1000),
               status=response.status_code)
    return response


httpx.AsyncClient.send = timed_async_send
httpx.Client.send = timed_sync_send


class Observer(BaseObserver):
    async def on_push_frame(self, data: FramePushed) -> None:
        global speaking, last_stop
        frame = data.frame
        if isinstance(frame, LLMContextFrame):
            if isinstance(data.source, LLMUserAggregator):
                record("context_out_of_aggregator", frame=frame.id)
            elif isinstance(data.destination, LLMService):
                record("context_into_llm", frame=frame.id)
            return
        if frame.id in seen:
            return
        if isinstance(frame, TranscriptionFrame):
            seen.add(frame.id)
            record("transcription", text=frame.text)
        elif isinstance(frame, LLMTextFrame):
            seen.add(frame.id)
            record("llm_text", text=frame.text)
        elif isinstance(frame, BotStartedSpeakingFrame):
            seen.add(frame.id)
            speaking = True
            record("bot_started_speaking")
        elif isinstance(frame, BotStoppedSpeakingFrame):
            seen.add(frame.id)
            speaking, last_stop = False, time.monotonic()
            record("bot_stopped_speaking")


class ObservedTask(PipelineTask):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs["observers"] = [Observer()]
        super().__init__(*args, **kwargs)


bot_module.PipelineTask = ObservedTask
bot_module._resolve_ice_servers_for_aiortc = lambda: []


def speak(text: str, directory: Path, index: int) -> bytes:
    aiff, wav_path = directory / f"{index}.aiff", directory / f"{index}.wav"
    subprocess.run(["say", "-v", "Tingting", "-o", str(aiff), text], check=True)
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff),
         "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", str(wav_path)],
        check=True,
    )
    with wave.open(str(wav_path), "rb") as source:
        return source.readframes(source.getnframes())


class ViewerMic(AudioStreamTrack):
    """Silence, except while a queued line is playing, paced at real time."""

    def __init__(self) -> None:
        super().__init__()
        self.pending = b""
        self.done = asyncio.Event()
        self.timestamp = 0
        self.begin: float | None = None

    def play(self, pcm: bytes) -> None:
        record("speech_start")
        self.pending = pcm
        self.done.clear()

    async def recv(self) -> AudioFrame:
        if self.begin is None:
            self.begin = time.monotonic()
        await asyncio.sleep(max(0.0, self.begin + self.timestamp / 16000 - time.monotonic()))
        chunk = bytes(640)
        if self.pending:
            chunk, self.pending = self.pending[:640].ljust(640, b"\x00"), self.pending[640:]
            if not self.pending:
                record("speech_end")
                self.done.set()
        frame = AudioFrame(format="s16", layout="mono", samples=320)
        frame.planes[0].update(chunk)
        frame.sample_rate = 16000
        frame.pts = self.timestamp
        frame.time_base = Fraction(1, 16000)
        self.timestamp += 320
        return frame


async def listen(track: Any) -> None:
    while True:
        frame = await track.recv()
        pcm = frame.to_ndarray().astype("float64")
        if float(np.sqrt(np.mean(pcm**2))) > 100:
            record("audible")


async def wait_for_reply(since: float) -> None:
    """Return once the bot has answered and stayed quiet for PAUSE_SEC.

    Fish can pause between sentences long enough for a stop/start pair, so
    one stop does not end the reply.
    """
    deadline = since + TURN_TIMEOUT_SEC
    while time.monotonic() < deadline:
        await asyncio.sleep(0.1)
        if not speaking and last_stop > since and time.monotonic() - last_stop >= PAUSE_SEC:
            return
    raise TimeoutError("the bot did not finish replying")


def turns() -> list[dict[str, Any]]:
    """Split the event log into turns and time each stage of every reply.

    A turn runs from one line's first sample to the next's, because Soniox
    finalizes words before the line ends. Its clock starts at the line's last
    sample, or at client-ready for the greeting.
    """
    marks = [e for e in events if e["kind"] in ("client_ready_sent", "speech_start")]
    out = []
    for i, mark in enumerate(marks):
        end = marks[i + 1]["t"] if i + 1 < len(marks) else float("inf")
        window = [e for e in events if mark["t"] <= e["t"] < end]

        def first(kind: str) -> float | None:
            return next((e["t"] for e in window if e["kind"] == kind), None)

        trigger = mark["t"] if mark["kind"] == "client_ready_sent" else first("speech_end")
        ctx_in, ctx_llm = first("context_out_of_aggregator"), first("context_into_llm")
        text, audible = first("llm_text"), first("audible")
        out.append({
            "line": "(greeting)" if mark["kind"] == "client_ready_sent" else LINES[i - 1],
            "heard": "".join(e["text"] for e in window if e["kind"] == "transcription"),
            "turn_detection_ms": _ms(trigger, ctx_in),
            "retrieval_stage_ms": _ms(ctx_in, ctx_llm),
            "llm_first_text_ms": _ms(ctx_llm, text),
            "tts_first_audio_ms": _ms(text, audible),
            "first_audible_ms": _ms(trigger, audible),
            "requests_ms": {
                target: [e["ms"] for e in window if e["kind"] == "http" and e["target"] == target]
                for target in ("decisions", "embeddings", "rerank")
            },
            "logs": [e["text"] for e in window if e["kind"] == "log" and (
                "gate" in e["text"] or " hit:" in e["text"] or " miss:" in e["text"]
            )],
            "reply": "".join(e["text"] for e in window if e["kind"] == "llm_text")[:120],
        })
    return out


def _ms(start: float | None, end: float | None) -> int | None:
    return round((end - start) * 1000) if start is not None and end is not None else None


async def main(label: str) -> None:
    clips = Path(tempfile.mkdtemp(prefix="eidolon-call-"))
    logger.add(clips / "bot.log", level="DEBUG")
    print(f"clips and full log: {clips}")
    pcm = [speak(line, clips, i) for i, line in enumerate(LINES)]
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    args = argparse.Namespace(ice_servers=[], esp32=False, host="127.0.0.1", folder=None)
    pipecat_run._setup_webrtc_routes(bot_module.pipecat_app, args, {})
    server = uvicorn.Server(uvicorn.Config(
        bot_module.pipecat_app, log_level="critical", access_log=False,
        timeout_graceful_shutdown=8,
    ))
    server_task = asyncio.create_task(server.serve(sockets=[sock]))
    mic = ViewerMic()
    client = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    client.addTrack(mic)
    channel = client.createDataChannel("pipecat")
    connected = asyncio.Event()
    workers: list[asyncio.Task[Any]] = []

    @client.on("connectionstatechange")
    async def on_state() -> None:
        if client.connectionState == "connected":
            connected.set()

    @client.on("track")
    def on_track(track: Any) -> None:
        if track.kind == "audio":
            workers.append(asyncio.create_task(listen(track)))

    async def keepalive() -> None:
        while True:
            if channel.readyState == "open":
                channel.send("ping")
            await asyncio.sleep(2)

    try:
        while not server.started:
            await asyncio.sleep(0.05)
        await client.setLocalDescription(await client.createOffer())
        assert client.localDescription is not None
        async with httpx.AsyncClient(timeout=15) as http:
            response = await http.post(f"http://127.0.0.1:{port}/api/offer", json={
                "sdp": client.localDescription.sdp, "type": client.localDescription.type,
                "requestData": {},
            })
            response.raise_for_status()
            answer = response.json()
        await client.setRemoteDescription(
            RTCSessionDescription(sdp=answer["sdp"], type=answer["type"])
        )
        workers.append(asyncio.create_task(keepalive()))
        await asyncio.wait_for(connected.wait(), 20)
        while channel.readyState != "open":
            await asyncio.sleep(0.05)
        await asyncio.sleep(1.0)
        record("client_ready_sent")
        channel.send(json.dumps({
            "label": "rtvi-ai", "type": "client-ready", "id": "bench",
            "data": {"version": "1.0.0", "about": {"library": "retrieval-gate-bench"}},
        }))
        await wait_for_reply(time.monotonic())
        for clip in pcm:
            mic.play(clip)
            await mic.done.wait()
            await wait_for_reply(time.monotonic())
    finally:
        await client.close()
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        server.should_exit = True
        with contextlib.suppress(Exception):
            await asyncio.wait_for(server_task, 12)
        result = {"label": label, "turns": turns()}
        out = Path(__file__).with_name(f"call-{label}.json")
        out.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n")
        for turn in result["turns"]:
            print(json.dumps({k: turn[k] for k in (
                "line", "heard", "retrieval_stage_ms", "first_audible_ms", "requests_ms",
            )}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("label", help="names the output file, e.g. before-1")
    asyncio.run(main(parser.parse_args().label))
