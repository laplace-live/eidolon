"""Render the same reply through Fish under one-at-a-time setting changes.

Speaks to the same WebSocket endpoint as ``FishAudioTTSService``, splitting text
with Pipecat's own sentence aggregator, so the baseline is what the bot does
today. Writes a WAV per variant plus results.json. Billed per character.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env", override=True)

import numpy as np
import ormsgpack
import websockets
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

HERE = Path(__file__).parent
URL = "wss://api.fish.audio/v1/tts/live"
SAMPLE_RATE = 44100

# One leading cue on a two-sentence reply, copied from a real call
# (docs/benchmarks/2026-09-19-retrieval-gate/call-before-1.json).
ONE_CUE = "[nostalgic] 他其实是一只黑色的布偶猫。虽然性格看着一点都不像布偶，反而像个高冷的理工猫，嗯。"

# The same reply with a cue opening every sentence, which is what the bot would
# need for each separately generated sentence to carry any emotion at all.
CUE_PER_SENTENCE = (
    "[nostalgic] 他其实是一只黑色的布偶猫。"
    "[chuckling] 嘿嘿，虽然性格看着一点都不像布偶，[relaxed] 反而像个高冷的理工猫，嗯。"
)

# Cues alone, with the wording of the reply left exactly as in ONE_CUE, so the
# comparison is not carrying an added interjection.
EMOTION_PER_SENTENCE = (
    "[nostalgic] 他其实是一只黑色的布偶猫。"
    "[amused] 虽然性格看着一点都不像布偶，[relaxed] 反而像个高冷的理工猫，嗯。"
)

# Free-form wording instead of the fixed tag list, which Fish documents for S2
# but persona.md rules out. Rendered to check whether it is spoken aloud.
FREE_FORM = (
    "[a little nostalgic, fondly] 他其实是一只黑色的布偶猫。"
    "[chuckling softly] 嘿嘿，虽然性格看着一点都不像布偶，[amused and warm] 反而像个高冷的理工猫，嗯。"
)

LOUD = {"prosody": {"speed": 1.0, "volume": 0, "normalize_loudness": False}}
HOT = {"temperature": 0.9, "top_p": 0.9}


@dataclass
class Variant:
    name: str
    note: str
    model: str  # pinned per variant, so nothing depends on FISH_MODEL
    text: str = ONE_CUE
    whole_reply: bool = False  # True → one generation instead of per sentence
    request: dict[str, Any] = field(default_factory=dict)


VARIANTS = [
    Variant("a-s2pro", "s2-pro, one leading cue — the .env this session started with", "s2-pro"),
    Variant("b-s21pro", "s2.1-pro, everything else equal", "s2.1-pro"),
    Variant("c-temperature", "b + temperature 0.9, top_p 0.9", "s2.1-pro", request=HOT),
    Variant("d-no-loudness-norm", "b + prosody.normalize_loudness false", "s2.1-pro",
            request=LOUD),
    Variant("e-whole-reply", "b + one generation for the whole reply", "s2.1-pro",
            whole_reply=True),
    Variant("f-cue-per-sentence", "b + a cue opening every sentence", "s2.1-pro",
            text=CUE_PER_SENTENCE),
    Variant("g-all", "f + temperature 0.9 + no loudness norm", "s2.1-pro",
            text=CUE_PER_SENTENCE, request={**HOT, **LOUD}),
    Variant("h-freeform", "b + free-form cues per sentence, which persona.md forbids",
            "s2.1-pro", text=FREE_FORM),
    Variant("i-emotion-per-sentence", "b + an emotion cue per sentence, no added words",
            "s2.1-pro", text=EMOTION_PER_SENTENCE),
]


async def sentences(text: str) -> list[str]:
    """Split exactly as the bot's TTS service does before each Fish request."""
    aggregator = SimpleTextAggregator()
    out = [item.text async for item in aggregator.aggregate(text)]
    remaining = await aggregator.flush()
    if remaining and remaining.text.strip():
        out.append(remaining.text)
    return [chunk for chunk in (c.strip() for c in out) if chunk]


def _pitch_semitone_std(frames: np.ndarray, loud: np.ndarray) -> float:
    """Spread of frame pitch in semitones, over autocorrelation estimates.

    A crude f0 tracker: per loud frame, the autocorrelation peak within
    70-400 Hz. Octave errors and unvoiced frames add noise, so read it as a
    relative ranking between variants of the same line, not as absolute pitch.
    """
    lo, hi = SAMPLE_RATE // 400, SAMPLE_RATE // 70
    pitches = []
    for frame in frames[loud]:
        frame = frame - frame.mean()
        correlation = np.correlate(frame, frame, mode="full")[frame.size - 1 :]
        window = correlation[lo:hi]
        if window.size and window.max() > 0.3 * correlation[0]:
            pitches.append(SAMPLE_RATE / (lo + int(window.argmax())))
    if len(pitches) < 2:
        return 0.0
    return round(float((12 * np.log2(np.array(pitches))).std()), 2)


def dynamics(pcm: bytes) -> dict[str, float]:
    """Loudness and pitch spread — rough proxies for expressiveness."""
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768
    if samples.size == 0:
        return {}
    frame = int(SAMPLE_RATE * 0.05)
    frames = samples[: samples.size // frame * frame].reshape(-1, frame)
    rms = np.sqrt((frames**2).mean(axis=1))
    loud = rms > 10 ** (-50 / 20)  # ignore silence between phrases
    db = 20 * np.log10(rms[loud]) if loud.any() else np.array([0.0])
    return {
        "seconds": round(samples.size / SAMPLE_RATE, 2),
        "loudness_std_db": round(float(db.std()), 2),
        "loudness_range_db": round(float(db.max() - db.min()), 2) if db.size else 0.0,
        "pitch_std_semitones": _pitch_semitone_std(frames, loud),
        "peak_dbfs": round(float(20 * np.log10(max(np.abs(samples).max(), 1e-9))), 2),
    }


async def render(variant: Variant, voice: str, take: int = 0) -> dict[str, Any]:
    model = variant.model
    chunks = [variant.text] if variant.whole_reply else await sentences(variant.text)
    request = {
        "text": "",
        "sample_rate": SAMPLE_RATE,
        "latency": "normal",
        "format": "pcm",
        "normalize": False,
        "prosody": {"speed": 1.0, "volume": 0},
        "reference_id": voice,
        **variant.request,
    }
    audio = bytearray()
    started = time.perf_counter()
    first: float | None = None
    async with websockets.connect(
        URL, additional_headers={"Authorization": f"Bearer {os.environ['FISH_API_KEY']}",
                                 "model": model}
    ) as socket:
        await socket.send(ormsgpack.packb({"event": "start", "request": request}))
        for chunk in chunks:
            await socket.send(ormsgpack.packb({"event": "text", "text": chunk}))
            await socket.send(ormsgpack.packb({"event": "flush"}))
        await socket.send(ormsgpack.packb({"event": "stop"}))
        async for message in socket:
            if not isinstance(message, bytes):
                continue
            event = ormsgpack.unpackb(message)
            if not isinstance(event, dict):
                continue
            if event.get("event") == "audio" and event.get("audio"):
                first = first if first is not None else time.perf_counter() - started
                audio.extend(event["audio"])
            elif event.get("event") == "finish":
                break

    path = HERE / (f"{variant.name}.wav" if not take else f"{variant.name}-{take}.wav")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(bytes(audio))
    return {
        "variant": variant.name, "take": take, "note": variant.note, "model": model,
        "chunks": chunks, "first_audio_ms": round((first or 0) * 1000),
        "wav": path.name, **dynamics(bytes(audio)),
    }


async def main(wanted: list[str], repeat: int) -> None:
    voice = os.environ["FISH_VOICE_ID"]
    rows = []
    for variant in VARIANTS:
        if wanted and variant.name not in wanted:
            continue
        for take in range(repeat):
            row = await render(variant, voice, take if repeat > 1 else 0)
            rows.append(row)
            print(json.dumps({k: v for k, v in row.items() if k != "chunks"}, ensure_ascii=False))
    # Merge into whatever is already recorded, so rendering a subset keeps the
    # rest of the file instead of replacing it.
    path = HERE / "results.json"
    kept = json.loads(path.read_text())["variants"] if path.exists() else []
    fresh = {(row["variant"], row["take"]) for row in rows}
    merged = [row for row in kept if (row["variant"], row["take"]) not in fresh] + rows
    merged.sort(key=lambda row: (row["variant"], row["take"]))
    path.write_text(
        json.dumps({"voice": voice[:8] + "…", "variants": merged}, ensure_ascii=False, indent=1)
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variants", nargs="*", help="variant names; default all")
    parser.add_argument("--repeat", type=int, default=1, help="takes per variant")
    args = parser.parse_args()
    asyncio.run(main(args.variants, args.repeat))
