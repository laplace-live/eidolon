"""Replay two short audio files through run_bot with a measured local PCM transport."""

from __future__ import annotations

import asyncio
import json
import sys
import time
import wave
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from loguru import logger
from pipecat.frames.frames import (
    InputAudioRawFrame,
    LLMContextFrame,
    MetricsFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import BaseTransport, TransportParams

from laplace_eidolon import bot

OUT = Path(__file__).resolve().parent
OUT.mkdir(parents=True, exist_ok=True)
logger.remove()
logger.add("/tmp/eidolon-call-runtime.log", level="DEBUG", mode="w")
state: dict[str, Any] = {
    "events": [],
    "trials": [],
    "boundary": "Real-time PCM replay into unchanged run_bot; BaseInputTransport/BaseOutputTransport capture replaces WebRTC. Anonymous, no greeting or Mem0. Excludes browser, network WebRTC/TURN, and physical speaker playback.",
}
origin = time.monotonic()
started = asyncio.Event()
turn_done = asyncio.Event()
taskbox: list[PipelineTask] = []
turn = 0
seen: set[Any] = set()


def record(kind: str, **fields: Any) -> None:
    state["events"].append(
        {"t": round(time.monotonic() - origin, 6), "turn": turn, "kind": kind, **fields}
    )


class Observer(BaseObserver):
    async def on_pipeline_started(self) -> None:
        record("pipeline_started")
        started.set()

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        name = type(frame).__name__
        if isinstance(frame, LLMContextFrame):
            key = (frame.id, data.source.name, data.destination.name)
            if key in seen:
                return
            seen.add(key)
            record(
                name,
                source=data.source.name,
                destination=data.destination.name,
                messages=len(frame.context.get_messages()),
                chars=sum(
                    len(str(m.get("content", "")))
                    for m in cast(list[dict[str, Any]], frame.context.get_messages())
                ),
            )
        elif name in {
            "VADUserStartedSpeakingFrame",
            "VADUserStoppedSpeakingFrame",
            "UserStartedSpeakingFrame",
            "UserStoppedSpeakingFrame",
            "TranscriptionFrame",
            "InterimTranscriptionFrame",
            "InterruptionFrame",
            "LLMFullResponseStartFrame",
            "LLMFullResponseEndFrame",
            "TTSStartedFrame",
            "TTSStoppedFrame",
            "BotStartedSpeakingFrame",
            "BotStoppedSpeakingFrame",
            "ErrorFrame",
            "MetricsFrame",
            "TTSAudioRawFrame",
            "LLMTextFrame",
            "AggregatedTextFrame",
        }:
            if frame.id in seen:
                return
            seen.add(frame.id)
            fields: dict[str, Any] = {}
            if hasattr(frame, "text"):
                fields["text"] = getattr(frame, "text")
            if hasattr(frame, "stop_secs"):
                fields["stop_secs"] = getattr(frame, "stop_secs")
            if isinstance(frame, MetricsFrame):
                fields["metrics"] = [d.model_dump() for d in frame.data]
            if hasattr(frame, "error"):
                fields["error"] = getattr(frame, "error")
            if name == "TTSAudioRawFrame":
                if any(e["kind"] == name and e["turn"] == turn for e in state["events"]):
                    return
                fields["bytes"] = len(getattr(frame, "audio"))
                fields["sample_rate"] = getattr(frame, "sample_rate")
            record(name, source=data.source.name, **fields)
            if name == "BotStoppedSpeakingFrame":
                turn_done.set()


class Input(BaseInputTransport):
    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)


class Output(BaseOutputTransport):
    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        if not any(
            e["kind"] == "transport_first_audio" and e["turn"] == turn for e in state["events"]
        ):
            record("transport_first_audio", sample_rate=frame.sample_rate, bytes=len(frame.audio))
        await asyncio.sleep(len(frame.audio) / (frame.sample_rate * frame.num_channels * 2))
        return True


class Transport(BaseTransport):
    def __init__(self) -> None:
        super().__init__()
        params = TransportParams(audio_in_enabled=True, audio_out_enabled=True)
        self.i = Input(params)
        self.o = Output(params)
        self._register_event_handler("on_client_connected")
        self._register_event_handler("on_client_disconnected")

    def input(self) -> FrameProcessor:
        return self.i

    def output(self) -> FrameProcessor:
        return self.o


class InstrumentedTask(PipelineTask):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs["observers"] = [Observer()]
        super().__init__(*args, **kwargs)
        taskbox.append(self)


bot.PipelineTask = InstrumentedTask


async def replay(transport: Transport, path: Path, label: str) -> None:
    global turn
    turn += 1
    turn_done.clear()
    with wave.open(str(path), "rb") as w:
        audio = w.readframes(w.getnframes())
        rate = w.getframerate()
    record("replay_start", source=str(path), label=label, duration=len(audio) / (rate * 2))
    deadline = time.monotonic()
    for pos in range(0, len(audio), 640):
        await transport.i.push_audio_frame(
            InputAudioRawFrame(audio[pos : pos + 640].ljust(640, b"\x00"), rate, 1)
        )
        deadline += 0.02
        await asyncio.sleep(max(0, deadline - time.monotonic()))
    record("replay_end")
    silence_start = time.monotonic()
    while not turn_done.is_set() and time.monotonic() - silence_start < 75:
        await transport.i.push_audio_frame(InputAudioRawFrame(b"\x00" * 640, rate, 1))
        deadline += 0.02
        await asyncio.sleep(max(0, deadline - time.monotonic()))
    record("replay_done", completed=turn_done.is_set())
    state["trials"].append({"turn": turn, "label": label, "completed": turn_done.is_set()})
    OUT.joinpath("call-results.json").write_text(json.dumps(state, ensure_ascii=False, indent=2))
    print(json.dumps(state["trials"][-1]), flush=True)


async def main() -> None:
    transport = Transport()
    run = asyncio.create_task(bot.run_bot(transport))
    try:
        await asyncio.wait_for(started.wait(), 60)
        await replay(
            transport,
            OUT / "call-question.wav",
            "macOS Tingting synthesized Chinese question: 奶绿，你平时最喜欢吃什么呀？",
        )
        await asyncio.sleep(1)
        await replay(
            transport,
            OUT / "call-vod.wav",
            "existing VOD BV1De4y1K7K5.m4a 10:00-10:06, unmodified speech excerpt",
        )
    finally:
        if taskbox:
            await taskbox[0].cancel()
        await asyncio.wait_for(run, 15)
        OUT.joinpath("call-results.json").write_text(
            json.dumps(state, ensure_ascii=False, indent=2)
        )


if __name__ == "__main__":
    asyncio.run(main())
