"""Score the retrieval gate on labeled turns, exactly as the bot asks Jev.

Each turn in turns.toml goes through the gate's own state builder, questions,
model, and threshold; results land in decisions.json. Exits non-zero if any
turn that needs recall would be skipped. About $0.002 of Jev calls.
"""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import sys
import time
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env", override=True)

import httpx

from laplace_eidolon import retrieval_gate as gate
from laplace_eidolon.openrouter import openrouter_headers

HERE = Path(__file__).parent


async def ask(client: httpx.AsyncClient, model: str, turn: dict[str, Any]) -> dict[str, Any]:
    history = turn.get("before", [])
    messages = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": text}
        for i, text in enumerate(history)
    ] + [{"role": "user", "content": turn["text"]}]
    started = time.perf_counter()
    response = await client.post(gate._URL, json={
        "model": model, "state": gate.gate_state(messages), "questions": gate._QUESTIONS,
    })
    ms = (time.perf_counter() - started) * 1000
    response.raise_for_status()
    body = response.json()
    nouls = {name: answer["noul"] for name, answer in body["answers"].items()}
    return {
        "set": turn.get("set"), "text": ("…" if history else "") + turn["text"],
        "recall": turn.get("recall"), "score": max(nouls.values()), "nouls": nouls,
        "ms": round(ms), "model": body["model"],
    }


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    recall = [r for r in rows if r["recall"] is True]
    chat = [r for r in rows if r["recall"] is False]
    return {
        "recall_kept": f"{sum(r['score'] >= gate._THRESHOLD for r in recall)}/{len(recall)}",
        "chit_chat_skipped": f"{sum(r['score'] < gate._THRESHOLD for r in chat)}/{len(chat)}",
        "lowest_recall_score": min((r["score"] for r in recall), default=None),
        "highest_chit_chat_score": max((r["score"] for r in chat), default=None),
    }


async def main() -> None:
    turns = tomllib.loads((HERE / "turns.toml").read_text())["turn"]
    model = os.getenv("RETRIEVAL_GATE_MODEL") or gate.DEFAULT_MODEL
    headers = {**openrouter_headers(), "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"}
    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        await ask(client, model, {"text": "你好"})  # opens the connection, as a live session has
        rows = [await ask(client, model, turn) for turn in turns]

    latency = [r["ms"] for r in rows]
    result = {
        "model": sorted({r["model"] for r in rows}),
        "threshold": gate._THRESHOLD,
        "latency_ms": {
            "p50": statistics.median(latency),
            "p90": statistics.quantiles(latency, n=10)[-1],
            "max": max(latency),
        },
        "sets": {
            name: summarize([r for r in rows if r["set"] == name])
            for name in ("dev", "heldout", "fresh")
        } | {"all": summarize(rows)},
        "turns": [{k: v for k, v in r.items() if k not in ("ms", "model")} for r in rows],
    }
    (HERE / "decisions.json").write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n")

    print(f"model {result['model']}, threshold {gate._THRESHOLD}, latency {result['latency_ms']}")
    for name, summary in result["sets"].items():
        print(f"{name:8} {summary}")
    for r in rows:
        if r["recall"] is None:
            print(f"borderline {r['score']:.2f} {r['text']}")
    missed = [r for r in rows if r["recall"] is True and r["score"] < gate._THRESHOLD]
    for r in missed:
        print(f"MISSED {r['score']:.2f} {r['text']} {r['nouls']}")
    sys.exit(1 if missed else 0)


if __name__ == "__main__":
    asyncio.run(main())
