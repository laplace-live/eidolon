"""Render Drama 3 markup through the bot's Fish path and measure every flush on its own.

Splits each reply with Pipecat's own sentence aggregator and sends every
sentence with its own flush on one socket, as ``FishAudioTTSService`` does.
Unlike the bot it waits for one sentence's audio before sending the next, so
each flush's audio can be measured separately; generation is per flush either
way. Every flush is then transcribed with ``transcribe-1-pro`` to catch markup
read aloud. Billed per character for TTS and per second for ASR.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import re
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env", override=True)

import httpx
import numpy as np
import ormsgpack
import websockets
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

HERE = Path(__file__).parent
URL = "wss://api.fish.audio/v1/tts/live"
ASR_URL = "https://api.fish.audio/v1/asr"
MODEL = "drama-3"
SAMPLE_RATE = 44100
FRAME = SAMPLE_RATE // 20  # 50 ms
# How long a flush may stay quiet before its audio counts as complete. Fish sent
# each short sentence as one message about 1.5 s after its flush.
FIRST_AUDIO_TIMEOUT_S = 8.0
IDLE_TIMEOUT_S = 2.5

SENTENCES = [
    "小时候上美术课老高兴了，老师会发美术本子，给出主题，画完交作业。",
    "我一般都能得A，就觉得挺好的。",
    "这种校园生活真的让人很开心。",
]
REPLY = "".join(SENTENCES)
WHISPER = "[压低声音，像在说悄悄话] "
SLOW = "[语速很慢，一字一顿] "


@dataclass
class Variant:
    name: str
    note: str
    text: str
    gap_s: float = 0.0  # extra wait before each later flush, as between two replies
    span: str | None = None  # spoken words to measure against the rest of their sentence
    whole: bool = False  # one flush for the whole text, as if the splitter kept a tag pair whole


VARIANTS = [
    Variant("a-plain", "the reply with no markup", REPLY),
    Variant("b-whisper-first", "a whisper direction on the first sentence only", WHISPER + REPLY),
    Variant("c-whisper-each", "the same direction on every sentence",
            "".join(WHISPER + s for s in SENTENCES)),
    Variant("d-slow-first", "a slow direction on the first sentence only", SLOW + REPLY),
    Variant("e-slow-each", "the same direction on every sentence",
            "".join(SLOW + s for s in SENTENCES)),
    Variant(
        "f-user-example", "a Chinese direction, <emphasis> and bare sound cues together",
        "[语气温暖，带着怀念，直播杂谈] 小时候上美术课<emphasis>老高兴了</emphasis>，"
        "老师会发美术本子，给出主题，画完交作业。[laughing]我一般都能得A，就觉得挺好的。"
        "[轻笑] 这种校园生活真的让人很开心。",
    ),
    Variant("g-paired-whisper", "<whisper> around most of the first sentence",
            "<whisper>小时候上美术课老高兴了，老师会发美术本子</whisper>，给出主题，画完交作业。"
            + "".join(SENTENCES[1:])),
    Variant("h-paired-slow", "<slow> around most of the first sentence",
            "<slow>小时候上美术课老高兴了，老师会发美术本子</slow>，给出主题，画完交作业。"
            + "".join(SENTENCES[1:])),
    Variant("i-split-whisper", "。 inside </whisper>, which the splitter cuts in two",
            "我没事。<whisper>你先走吧。</whisper>我一会儿就来。"),
    Variant("j-split-plain", "i without markup", "我没事。你先走吧。我一会儿就来。"),
    Variant("k-lone-closer", "a tag spanning two sentences, leaving </soft> its own flush",
            "<soft>别哭了。我在呢。</soft>"),
    Variant("l-laugh-bare", "[轻笑] with no laughing text", "[轻笑] " + SENTENCES[1]),
    Variant("m-laugh-text", "[轻笑] followed by 嘿嘿", "[轻笑] 嘿嘿，" + SENTENCES[1]),
    Variant("n-chuckling-bare", "[chuckling] with no laughing text", "[chuckling] " + SENTENCES[1]),
    Variant("o-whisper-gap", "b's carry-over, with a reply-sized pause before the next flush",
            WHISPER + SENTENCES[1] + SENTENCES[2], gap_s=10.0),
    Variant("p-whisper-override", "a whisper, then a sentence directed back to normal",
            WHISPER + SENTENCES[1] + "[正常音量，轻松自然] " + SENTENCES[2]),
    Variant("q-whisper-tail", "<whisper> around the end of a sentence",
            "我一般都能得A，<whisper>就觉得挺好的</whisper>。" + SENTENCES[2], span="就觉得挺好的"),
    Variant("r-emphasis", "<emphasis> around 老高兴了, no direction",
            "小时候上美术课<emphasis>老高兴了</emphasis>，老师会发美术本子，给出主题，画完交作业。",
            span="老高兴了"),
    Variant("s-emphasis-base", "r without the tag", SENTENCES[0], span="老高兴了"),
    Variant("t-chuckling-text", "[chuckling] followed by 嘿嘿", "[chuckling] 嘿嘿，" + SENTENCES[1]),
    Variant("u-laughing-text", "[laughing] followed by 哈哈哈", "[laughing] 哈哈哈，" + SENTENCES[1]),
    Variant("v-whisper-unsplit", "i sent as one flush, the tag pair kept whole",
            "我没事。<whisper>你先走吧。</whisper>我一会儿就来。", span="我一会儿就来", whole=True),
]

_MARKUP = re.compile(r"\[[^\]]*\]|</?[a-z]+>")
_ASR_MARKERS = re.compile(r"<\|[^|]*\|>")
_ASR_CUES = re.compile(r"\[([^\]]*)\]")
_SPOKEN = re.compile(r"[一-鿿A-Za-z0-9]")


async def sentences(text: str) -> list[str]:
    """Split exactly as the bot's TTS service does before each Fish request."""
    aggregator = SimpleTextAggregator()
    out = [item.text async for item in aggregator.aggregate(text)]
    remaining = await aggregator.flush()
    if remaining and remaining.text.strip():
        out.append(remaining.text)
    return [chunk for chunk in (c.strip() for c in out) if chunk]


def _markup_pieces(chunk: str) -> list[str]:
    """What would show up in a transcript if this chunk's markup were spoken."""
    pieces = []
    for tag in _MARKUP.findall(chunk):
        inner = tag.strip("[]</>")
        pieces += [p for p in re.split(r"[，,、\s]+", inner) if len(p) >= 2]
    return list(dict.fromkeys(pieces))


def metrics(pcm: bytes, chunk: str) -> dict[str, Any]:
    """Per-flush delivery: loudness, voicing, speaking rate, trailing silence.

    ``voiced_ratio`` is the share of loud frames whose autocorrelation peak in
    the 70-400 Hz lag range exceeds half the zero-lag value. Whispered speech
    has no pitch, so it scores near zero where normal speech scores well above.
    """
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768
    if samples.size < FRAME:
        return {"seconds": round(samples.size / SAMPLE_RATE, 2)}
    rms, pitch = _frames(samples)
    loud = rms > 10 ** (-50 / 20)
    if not loud.any():
        return {"seconds": round(samples.size / SAMPLE_RATE, 2), "loud_seconds": 0.0}
    first, last = int(np.argmax(loud)), int(len(loud) - 1 - np.argmax(loud[::-1]))
    speech_s = (last - first + 1) * FRAME / SAMPLE_RATE
    spoken = len(_SPOKEN.findall(_MARKUP.sub("", chunk)))
    return {
        "seconds": round(samples.size / SAMPLE_RATE, 2),
        "speech_seconds": round(speech_s, 2),
        "trailing_silence_s": round((len(loud) - 1 - last) * FRAME / SAMPLE_RATE, 2),
        "loudness_db": round(float(20 * np.log10(rms[loud]).mean()), 1),
        "voiced_ratio": round(float((pitch[loud] > 0).mean()), 2),
        "chars_per_second": round(spoken / speech_s, 2) if spoken else None,
    }


def _frames(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame RMS and pitch in Hz, 0 where no pitch was found."""
    frames = samples[: samples.size // FRAME * FRAME].reshape(-1, FRAME)
    rms = np.sqrt((frames**2).mean(axis=1))
    lo, hi = SAMPLE_RATE // 400, SAMPLE_RATE // 70
    pitch = np.zeros(len(frames))
    for index, frame in enumerate(frames):
        frame = frame - frame.mean()
        spectrum = np.fft.rfft(frame, n=2 * frame.size)
        corr = np.fft.irfft(spectrum * np.conj(spectrum))[: frame.size]
        if corr[0] > 0 and corr[lo:hi].max() > 0.5 * corr[0]:
            pitch[index] = SAMPLE_RATE / (lo + int(corr[lo:hi].argmax()))
    return rms, pitch


def span_metrics(pcm: bytes, span: str, segments: list[dict[str, Any]]) -> dict[str, Any]:
    """How ``span`` is delivered against the rest of its sentence.

    Locates the span with transcribe-1-pro's per-character timings. Positive
    ``span_db`` and ``span_semitones`` mean louder and higher than the rest;
    ``span_stretch`` above 1 means more seconds per character.
    """
    heard = "".join(s["text"] for s in segments)
    at = heard.find(span)
    if at < 0:
        return {"span_found": False}
    start, end = segments[at]["start"], segments[at + len(span) - 1]["end"]
    rest_chars = len(segments) - len(span)
    rest_s = segments[-1]["end"] - segments[0]["start"] - (end - start)
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768
    rms, pitch = _frames(samples)
    times = (np.arange(len(rms)) + 0.5) * FRAME / SAMPLE_RATE
    loud = rms > 10 ** (-50 / 20)
    inside = loud & (times >= start) & (times <= end)
    outside = loud & ~inside & (times >= segments[0]["start"]) & (times <= segments[-1]["end"])
    if not inside.any() or not outside.any():
        return {"span_found": False}

    def semitones(mask: np.ndarray) -> float:
        voiced = pitch[mask & (pitch > 0)]
        return float(np.median(12 * np.log2(voiced))) if voiced.size else float("nan")

    return {
        "span_found": True,
        "span_db": round(float(20 * (np.log10(rms[inside]).mean()
                                     - np.log10(rms[outside]).mean())), 1),
        "span_semitones": round(semitones(inside) - semitones(outside), 1),
        "span_stretch": round(((end - start) / len(span)) / (rest_s / rest_chars), 2)
        if rest_chars and rest_s > 0 else None,
        "span_voiced": round(float((pitch[inside] > 0).mean()), 2),
        "rest_voiced": round(float((pitch[outside] > 0).mean()), 2),
    }


def to_wav(pcm: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm)
    return buffer.getvalue()


async def transcribe(client: httpx.AsyncClient, pcm: bytes, timestamps: bool) -> dict[str, Any]:
    response = await client.post(
        ASR_URL,
        headers={"Authorization": f"Bearer {os.environ['FISH_API_KEY']}",
                 "model": "transcribe-1-pro"},
        files={"audio": ("flush.wav", to_wav(pcm), "audio/wav")},
        data={"ignore_timestamps": "false" if timestamps else "true"},
        timeout=120,
    )
    response.raise_for_status()
    return response.json()


async def synthesize(chunks: list[str], voice: str, gap_s: float,
                     model: str) -> list[tuple[bytes, float | None]]:
    """One socket, one flush per chunk; returns each flush's audio and first-audio delay."""
    request = {
        "text": "",
        "sample_rate": SAMPLE_RATE,
        "latency": "normal",
        "format": "pcm",
        "normalize": False,
        "prosody": {"speed": 1.0, "volume": 0},
        "reference_id": voice,
    }
    out: list[tuple[bytes, float | None]] = []
    async with websockets.connect(
        URL,
        max_size=16 * 1024 * 1024,
        additional_headers={"Authorization": f"Bearer {os.environ['FISH_API_KEY']}",
                            "model": model},
    ) as socket:
        await socket.send(ormsgpack.packb({"event": "start", "request": request}))
        for index, chunk in enumerate(chunks):
            if index and gap_s:
                await asyncio.sleep(gap_s)
            await socket.send(ormsgpack.packb({"event": "text", "text": chunk}))
            await socket.send(ormsgpack.packb({"event": "flush"}))
            sent = time.perf_counter()
            audio = bytearray()
            first: float | None = None
            while True:
                timeout = IDLE_TIMEOUT_S if audio else FIRST_AUDIO_TIMEOUT_S
                try:
                    message = await asyncio.wait_for(socket.recv(), timeout)
                except TimeoutError:
                    break
                event = ormsgpack.unpackb(message) if isinstance(message, bytes) else None
                if isinstance(event, dict) and event.get("event") == "audio" and event.get("audio"):
                    first = first if first is not None else time.perf_counter() - sent
                    audio.extend(event["audio"])
            out.append((bytes(audio), first))
        await socket.send(ormsgpack.packb({"event": "stop"}))
    return out


async def render(variant: Variant, voice: str, take: int, client: httpx.AsyncClient,
                 asr: bool, model: str) -> dict[str, Any]:
    chunks = [variant.text] if variant.whole else await sentences(variant.text)
    flushes = await synthesize(chunks, voice, variant.gap_s, model)
    rows = []
    for index, (chunk, (pcm, first)) in enumerate(zip(chunks, flushes), 1):
        row: dict[str, Any] = {
            "flush": index, "text": chunk,
            "first_audio_ms": round(first * 1000) if first is not None else None,
            **metrics(pcm, chunk),
        }
        span = variant.span if variant.span and variant.span in chunk else None
        if asr and len(pcm) >= FRAME * 2:
            result = await transcribe(client, pcm, timestamps=span is not None)
            heard = result.get("text", "")
            spoken = _ASR_CUES.sub("", _ASR_MARKERS.sub("", heard))
            row["asr"] = _ASR_MARKERS.sub("", heard)
            row["asr_cues"] = _ASR_CUES.findall(heard)
            row["leaked"] = [p for p in _markup_pieces(chunk) if p.lower() in spoken.lower()]
            if span:
                row |= span_metrics(pcm, span, result.get("segments") or [])
        rows.append(row)
    name = variant.name if model == MODEL else f"{model}-{variant.name}"
    name = f"{name}.wav" if not take else f"{name}-{take}.wav"
    (HERE / name).write_bytes(to_wav(b"".join(pcm for pcm, _ in flushes)))
    return {"variant": variant.name, "take": take, "note": variant.note, "wav": name,
            "flushes": rows}


async def main(wanted: list[str], repeat: int, asr: bool, parallel: int, model: str) -> None:
    voice = os.environ["FISH_VOICE_ID"]
    jobs = [(v, take) for v in VARIANTS if not wanted or v.name in wanted
            for take in range(repeat)]
    gate = asyncio.Semaphore(parallel)
    async with httpx.AsyncClient() as client:

        async def run(variant: Variant, take: int) -> dict[str, Any]:
            async with gate:
                result = await render(variant, voice, take, client, asr, model)
                for row in result["flushes"]:
                    print(json.dumps({"variant": variant.name, "take": take, **row},
                                     ensure_ascii=False))
                return result

        results = await asyncio.gather(*(run(v, take) for v, take in jobs))

    path = HERE / ("results.json" if model == MODEL else f"results-{model}.json")
    kept = json.loads(path.read_text())["variants"] if path.exists() else []
    fresh = {(r["variant"], r["take"]) for r in results}
    merged = [r for r in kept if (r["variant"], r["take"]) not in fresh] + list(results)
    merged.sort(key=lambda r: (r["variant"], r["take"]))
    path.write_text(
        json.dumps({"model": model, "voice": voice[:8] + "…", "variants": merged},
                   ensure_ascii=False, indent=1)
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variants", nargs="*", help="variant names; default all")
    parser.add_argument("--repeat", type=int, default=1, help="takes per variant")
    parser.add_argument("--no-asr", action="store_true", help="skip transcribe-1-pro")
    parser.add_argument("--parallel", type=int, default=3, help="concurrent sockets")
    parser.add_argument("--model", default=MODEL,
                        help="Fish model header; results go to results-<model>.json")
    args = parser.parse_args()
    asyncio.run(main(args.variants, args.repeat, not args.no_asr, args.parallel, args.model))
