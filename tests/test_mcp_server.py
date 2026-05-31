"""Tests for the public MCP retrieval server.

Integration tests drive the mounted Streamable HTTP app through Starlette's
TestClient (synchronous — it runs the ASGI app + lifespan in a background
portal, so no pytest-asyncio is needed). Fake services + tiny quotas are
injected via install_mcp's keyword args, so tests need neither LanceDB nor
the network.
"""

from __future__ import annotations

import json
from typing import Any

from laplace_eidolon.mcp_server import _project_chunk, _project_fact

FACT_HIT = {
    "text": "她喜欢喝奶茶",
    "date": "2025-05-09",
    "source": "设定集",
    "_relevance_score": 0.92,
    "vector": [0.1, 0.2],
}
CHUNK_HIT = {
    "stream_date": "2025-05-09",
    "details": "聊了新游戏",
    "summary": "游戏",
    "text": "raw transcript",
    "topics": json.dumps(["游戏", "杂谈"]),
    "_relevance_score": 0.81,
    "vector": [0.3],
}


def test_project_fact_keeps_text_date_score_and_drops_vector():
    out = _project_fact(FACT_HIT)
    assert out == {"text": "她喜欢喝奶茶", "date": "2025-05-09", "score": 0.92}
    assert "vector" not in out


def test_project_chunk_prefers_details_and_decodes_topics():
    out = _project_chunk(CHUNK_HIT)
    assert out["stream_date"] == "2025-05-09"
    assert out["content"] == "聊了新游戏"  # details beats summary/text
    assert out["topics"] == ["游戏", "杂谈"]
    assert out["score"] == 0.81
    assert "vector" not in out


def test_project_chunk_falls_back_to_summary_then_text():
    assert _project_chunk({"summary": "s", "text": "t"})["content"] == "s"
    assert _project_chunk({"text": "t"})["content"] == "t"
    assert _project_chunk({"text": "t"})["topics"] == []
