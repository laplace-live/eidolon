"""Measure the configured LLM, sentence aggregation, and Fish streaming with real queries."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np
import ormsgpack
from dotenv import load_dotenv
from loguru import logger
from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env", override=True)
logger.remove()
logger.add(sys.stderr, level="WARNING")

from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.fish.tts import FishAudioTTSService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

from laplace_eidolon.bot import _build_persona_prefix, load_persona
from laplace_eidolon.openrouter import openrouter_headers
from laplace_eidolon.user_context import UserContext
from laplace_eidolon.voice_switching import install_voice_style_tool, load_voice_styles


async def fish_connect(latency: str) -> tuple[Any, float]:
    started = time.perf_counter()
    ws = await connect(
        "wss://api.fish.audio/v1/tts/live",
        additional_headers={
            "Authorization": f"Bearer {os.environ['FISH_API_KEY']}",
            "model": os.getenv("FISH_MODEL") or "s2.1-pro",
        },
        open_timeout=20,
    )
    await ws.send(
        ormsgpack.packb(
            {
                "event": "start",
                "request": {
                    "text": "",
                    "sample_rate": 44100,
                    "latency": latency,
                    "format": "pcm",
                    "normalize": False,
                    "prosody": {"speed": 1.0, "volume": 0},
                    "reference_id": os.environ["FISH_VOICE_ID"],
                },
            }
        )
    )
    return ws, time.perf_counter() - started


async def fish_speak(ws: Any, text: str, output: Path) -> dict[str, Any]:
    started = time.perf_counter()
    await ws.send(ormsgpack.packb({"event": "text", "text": text}))
    await ws.send(ormsgpack.packb({"event": "flush"}))
    pcm = bytearray()
    first_audio: float | None = None
    finish: dict[str, Any] = {}
    async with asyncio.timeout(35):
        while True:
            try:
                packet = await asyncio.wait_for(ws.recv(), timeout=2 if pcm else 20)
            except TimeoutError:
                if pcm:
                    finish = {"reason": "two_seconds_without_audio"}
                    break
                raise
            if not isinstance(packet, bytes):
                continue
            event = ormsgpack.unpackb(packet)
            if event.get("event") not in ("audio", "finish"):
                print(json.dumps({"fish_event": event}, default=str), flush=True)
            if event.get("event") == "audio":
                data = event.get("audio") or b""
                if len(data) > 1024:
                    if first_audio is None:
                        first_audio = time.perf_counter() - started
                    pcm.extend(data)
            if event.get("event") == "finish":
                finish = event
                break
    with wave.open(str(output), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(44100)
        wav.writeframes(pcm)
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float64)
    windows = len(samples) // 441
    rms = np.sqrt(np.mean(samples[: windows * 441].reshape(-1, 441) ** 2, axis=1))
    audible = np.flatnonzero(rms > 32768 * 10 ** (-40 / 20))
    leading = float(audible[0]) * 0.01 if len(audible) else None
    return {
        "text": text,
        "ttfb_s": first_audio,
        "finish_s": time.perf_counter() - started,
        "audio_duration_s": len(pcm) / 88200,
        "leading_silence_at_minus40db_s": leading,
        "finish_reason": finish.get("reason"),
        "wav": output.name,
    }


async def llm_turn(llm: OpenRouterLLMService, context: LLMContext, output: Path) -> dict[str, Any]:
    ws, connect_s = await fish_connect("normal")
    record: dict[str, Any] = {"fish_connect_s": connect_s}
    aggregator = SimpleTextAggregator()
    started = time.perf_counter()
    sentence_task: asyncio.Task[dict[str, Any]] | None = None
    text = ""
    try:
        stream = await llm.get_chat_completions(context)
        async with stream:
            async for chunk in stream:
                elapsed = time.perf_counter() - started
                record.setdefault("llm_first_chunk_s", elapsed)
                record["resolved_model"] = chunk.model
                if chunk.usage:
                    record["usage"] = chunk.usage.model_dump()
                if not chunk.choices:
                    continue
                content = chunk.choices[0].delta.content
                if not content:
                    continue
                record.setdefault("llm_first_content_s", elapsed)
                text += content
                async for sentence in aggregator.aggregate(content):
                    if sentence_task is None:
                        record["first_sentence_s"] = time.perf_counter() - started
                        sentence_task = asyncio.create_task(fish_speak(ws, sentence.text, output))
        record["llm_complete_s"] = time.perf_counter() - started
        if sentence_task is None:
            sentence = await aggregator.flush()
            if sentence:
                record["first_sentence_s"] = time.perf_counter() - started
                sentence_task = asyncio.create_task(fish_speak(ws, sentence.text, output))
        if sentence_task:
            record["fish"] = await sentence_task
            if record["fish"]["ttfb_s"] is not None:
                record["llm_request_to_first_audio_s"] = (
                    record["first_sentence_s"] + record["fish"]["ttfb_s"]
                )
        record["response"] = text
        return record
    finally:
        if sentence_task and not sentence_task.done():
            sentence_task.cancel()
            await asyncio.gather(sentence_task, return_exceptions=True)
        await ws.close()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contexts", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent)
    parser.add_argument("--tts-only", action="store_true")
    parser.add_argument("--skip-tts", action="store_true")
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--reasoning", choices=["minimal"])
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {
        "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "boundary": "Configured LLM service + Pipecat sentence aggregator + Fish WebSocket; "
        "first sentence only; excludes STT, retrieval time, WebRTC and playback.",
        "config": {k: os.getenv(k) for k in ["OPENROUTER_MODEL", "FISH_MODEL"]},
        "reasoning_override": args.reasoning,
        "tts": [],
        "llm": [],
    }
    result_path = args.output / ("tts.json" if args.tts_only else "voice.json")

    def save() -> None:
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

    speech = "嗯，今天过得怎么样呀？来花店坐一会儿吧。"
    for index, mode in enumerate([] if args.skip_tts else ["normal", "balanced"] * 3):
        row: dict[str, Any] = {"index": index, "latency": mode}
        try:
            ws, connect_s = await fish_connect(mode)
            try:
                row.update(await fish_speak(ws, speech, args.output / f"tts-{index}.wav"))
                row["connect_s"] = connect_s
            finally:
                await ws.close()
        except Exception as exc:
            row["error"] = f"{type(exc).__name__}: {exc}"
        result["tts"].append(row)
        save()
        print(json.dumps(row, ensure_ascii=False), flush=True)

    if args.tts_only:
        return
    styles = load_voice_styles()
    instruction = await asyncio.to_thread(
        lambda: _build_persona_prefix(UserContext(), voice_styles=styles) + load_persona()
    )
    llm = OpenRouterLLMService(
        api_key=os.environ["OPENROUTER_API_KEY"],
        settings=OpenRouterLLMService.Settings(
            model=os.getenv("OPENROUTER_MODEL") or "~google/gemini-flash-latest",
            system_instruction=instruction,
            extra={"extra_body": {"reasoning": {"effort": args.reasoning}}}
            if args.reasoning
            else {},
        ),
        default_headers=openrouter_headers(),
    )
    tts = FishAudioTTSService(api_key=os.environ["FISH_API_KEY"])
    schema = install_voice_style_tool(llm=llm, tts=tts, styles=styles)
    contexts = json.loads(args.contexts.read_text()) if args.contexts else []
    if not contexts:
        contexts = [
            {
                "query": "你梦想是什么",
                "messages": [{"role": "user", "content": "你梦想是什么"}],
                "label": "persona_only",
            }
        ]
    result["system_prompt_chars"] = len(instruction)
    for index, item in enumerate(contexts[: args.limit] * args.repeats):
        row = {
            "index": index,
            "query": item["query"],
            "label": item.get("label", "rag"),
            "context_chars": sum(len(m.get("content", "")) for m in item["messages"]),
        }
        context = (
            LLMContext(messages=item["messages"], tools=schema)
            if schema
            else LLMContext(messages=item["messages"])
        )
        try:
            async with asyncio.timeout(65):
                row.update(await llm_turn(llm, context, args.output / f"llm-{index}.wav"))
        except Exception as exc:
            row["error"] = f"{type(exc).__name__}: {exc}"
        result["llm"].append(row)
        save()
        print(json.dumps(row, ensure_ascii=False), flush=True)
    await llm._client.close()


if __name__ == "__main__":
    asyncio.run(main())
