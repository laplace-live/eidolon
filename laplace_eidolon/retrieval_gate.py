"""Jev decides whether a turn needs the LanceDB tiers at all.

``RetrievalGate`` starts one TypeSafe Jev decision per user turn without
holding the frame; both RAG services race their search against it through
``unless_skipped``.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from loguru import logger
from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .openrouter import openrouter_headers

GATE_FRAME_KEY = "retrieval_gate"
DEFAULT_MODEL = "~typesafe/jev-latest"
_URL = "https://openrouter.ai/api/alpha/decisions"

# Set on jev-1.13 against 185 labeled turns: the lowest of the 93 that needed
# recall scored 0.58, and repeat calls on one input moved by at most 0.05.
# docs/benchmarks/2026-09-19-retrieval-gate
_THRESHOLD = 0.3

# Dropping this line cost 2 of 93 recall turns; dropping it and "her flower
# shop" below cost 5, every one a question about her cat or her shop.
_STREAMER = (
    "明前奶绿, a Chinese VTuber who streams on Bilibili, runs a fictional flower shop "
    "(拉普拉斯花店) whose manager is her cat 坚果, and calls her fans 奶糖花"
)

# Jev reads each question literally, so each asks one thing and any one
# clearing the threshold means retrieve.
_QUESTIONS: dict[str, dict[str, str]] = {
    "about_her": {
        "type": "noul",
        "instructions": (
            "Is the viewer's latest message asking about the streamer herself — her "
            "preferences, opinions, habits, abilities, body, family, pets, friends, "
            "relationships, backstory, or her flower shop?"
        ),
    },
    "her_past": {
        "type": "noul",
        "instructions": (
            "Does the viewer's latest message ask about something the streamer said, did, "
            "or experienced in the past, including on her past live streams?"
        ),
    },
    "named_thing": {
        "type": "noul",
        "instructions": (
            "Does the viewer's latest message ask who or what a specific named person, "
            "character, place, group, game, song, or term is, or ask about one by name?"
        ),
    },
}

# The previous user line and the reply to it, so "它几岁了？" keeps its subject.
_EARLIER_TURNS = 2

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # httpx drops idle connections after 5 s, and turns 15-40 s apart then
        # paid a fresh TLS session each: ~1.4 s a call instead of ~0.5 s.
        _client = httpx.AsyncClient(
            timeout=10.0, limits=httpx.Limits(keepalive_expiry=120.0)
        )
    return _client


def gate_state(messages: list[Any]) -> dict[str, Any] | None:
    """What Jev sees: the latest user line and the turns just before it."""
    turns = [
        (m["role"], m["content"].strip())
        for m in messages
        if isinstance(m, dict)
        and m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str)
        and m["content"].strip()
    ]
    latest = next((i for i in range(len(turns) - 1, -1, -1) if turns[i][0] == "user"), None)
    if latest is None:
        return None
    return {
        "streamer": _STREAMER,
        "earlier_turns": [
            {"speaker": "viewer" if role == "user" else "streamer", "text": text}
            for role, text in turns[max(0, latest - _EARLIER_TURNS) : latest]
        ],
        "viewer_latest_message": turns[latest][1],
    }


class RetrievalGate(FrameProcessor):
    """Attaches one Jev decision per user turn to every context frame of that turn."""

    def __init__(self, *, api_key: str, model: str = DEFAULT_MODEL) -> None:
        super().__init__()
        self._headers = {**openrouter_headers(), "Authorization": f"Bearer {api_key}"}
        self._model = model
        self._turn: tuple[int, str] | None = None
        self._decision: asyncio.Task[bool] | None = None

    async def _decide(self, state: dict[str, Any] | None) -> bool:
        if state is None:
            return True
        started = time.perf_counter()
        try:
            response = await _get_client().post(
                _URL,
                headers=self._headers,
                json={"model": self._model, "state": state, "questions": _QUESTIONS},
            )
            response.raise_for_status()
            answers = response.json()["answers"]
            score = max(float(answers[name]["noul"]) for name in _QUESTIONS)
        except Exception as e:
            logger.warning(f"Retrieval gate failed open: {e!r}")
            return True
        needed = score >= _THRESHOLD
        logger.info(
            f"Retrieval gate: {'retrieve' if needed else 'skip'} "
            f"query={state['viewer_latest_message']!r} (score={score:.2f}, "
            f"{(time.perf_counter() - started) * 1000:.0f} ms)"
        )
        return needed

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Start a decision on each new user turn, and pass every frame straight on."""
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            messages = frame.context.get_messages()
            users = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
            turn = (len(users), str(users[-1].get("content", "")) if users else "")
            if turn != self._turn:
                self._turn = turn
                self._decision = self.create_task(
                    self._decide(gate_state(messages)), "retrieval_gate"
                )
            frame.metadata[GATE_FRAME_KEY] = self._decision
        await self.push_frame(frame, direction)


def from_env() -> RetrievalGate | None:
    """The gate as configured, or ``None`` when switched off or keyless."""
    if os.getenv("RETRIEVAL_GATE_ENABLED", "").strip().lower() in {"false", "0", "no", "off"}:
        logger.info("RETRIEVAL_GATE_ENABLED is off — every turn searches both LanceDB tiers")
        return None
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        return None
    model = os.getenv("RETRIEVAL_GATE_MODEL") or DEFAULT_MODEL
    logger.info(f"Retrieval gate enabled: model={model!r}")
    return RetrievalGate(api_key=api_key, model=model)


def _said_skip(decision: asyncio.Future[bool]) -> bool:
    # Pipecat's task wrapper logs an exception and returns None, so only an
    # explicit False skips.
    return decision.done() and not decision.cancelled() and decision.result() is False


async def unless_skipped(
    decision: asyncio.Future[bool] | None,
    search: Callable[[], Awaitable[list[dict[str, Any]]]],
) -> list[dict[str, Any]]:
    """Run ``search`` unless the gate rules the turn out before it finishes.

    A search that finishes first is kept, so a slow or failing gate never
    makes a turn slower than searching alone.
    """
    if decision is not None and _said_skip(decision):
        return []
    task = asyncio.ensure_future(search())
    try:
        if decision is not None and not decision.done():
            await asyncio.wait((task, decision), return_when=asyncio.FIRST_COMPLETED)
            if not task.done() and _said_skip(decision):
                return []
        return await task
    finally:
        task.cancel()
