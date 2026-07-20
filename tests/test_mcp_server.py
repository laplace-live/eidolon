"""Tests for the public MCP retrieval server.

Starlette's TestClient drives the mounted app synchronously — it runs the
ASGI app and lifespan in a background portal, so no pytest-asyncio. Fake
services and tiny quotas go in through install_mcp's keyword args, keeping
LanceDB and the network out of the tests.
"""

from __future__ import annotations

import json
from typing import Any, cast

from fastapi import FastAPI
from starlette.testclient import TestClient

import laplace_eidolon.mcp_server as mcp_server
from laplace_eidolon.mcp_server import _project_chunk, _project_fact, install_mcp
from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.rate_limit import AnonymousIpQuota
from laplace_eidolon.stream_archive import StreamArchiveService
from laplace_eidolon.user_context import UserContext

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


ACCEPT = "application/json, text/event-stream"


class FakeService:
    """Stand-in for PersonaFactsService / StreamArchiveService. A ``_table``
    of None mimics a missing index; otherwise ``_search`` returns canned hits."""

    def __init__(self, hits: list[dict[str, Any]], *, has_table: bool = True):
        self._table = object() if has_table else None
        self._hits = hits

    async def _search(self, query: str) -> list[dict[str, Any]]:
        return self._hits


def _build_client(*, anon_max=5, auth_max=50, facts=None, streams=None) -> TestClient:
    app = FastAPI()
    install_mcp(
        app,
        persona_facts=cast(
            PersonaFactsService, facts if facts is not None else FakeService([FACT_HIT])
        ),
        stream_archive=cast(
            StreamArchiveService, streams if streams is not None else FakeService([CHUNK_HIT])
        ),
        anon_quota=AnonymousIpQuota(anon_max, 3600),
        auth_quota=AnonymousIpQuota(auth_max, 3600),
    )
    return TestClient(app)


def _rpc(client, method, params=None, _id=1, token=None):
    headers = {"Content-Type": "application/json", "Accept": ACCEPT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        body["params"] = params
    if _id is not None:
        body["id"] = _id
    # Mount is at /mcp with streamable_http_path="/", so the clean 200 path
    # is "/mcp/" ("/mcp" 307-redirects to it).
    return client.post("/mcp/", json=body, headers=headers)


def _call_tool(client, name, arguments=None, *, token=None, _id=1):
    return _rpc(
        client, "tools/call", {"name": name, "arguments": arguments or {}}, _id=_id, token=token
    )


def test_tools_list_exposes_both_search_tools():
    with _build_client() as client:
        r = _rpc(client, "tools/list", {})
        names = {t["name"] for t in r.json()["result"]["tools"]}
        assert names == {"search_persona_facts", "search_streams"}


def test_search_persona_facts_returns_projected_results():
    with _build_client() as client:
        result = _call_tool(client, "search_persona_facts", {"query": "奶茶"}).json()["result"]
        assert result["isError"] is False
        sc = result["structuredContent"]
        assert sc["count"] == 1
        assert sc["results"][0] == {"text": "她喜欢喝奶茶", "date": "2025-05-09", "score": 0.92}


def test_search_streams_returns_projected_chunks():
    with _build_client() as client:
        result = _call_tool(client, "search_streams", {"query": "游戏"}).json()["result"]
        sc = result["structuredContent"]
        assert sc["count"] == 1
        assert sc["results"][0]["content"] == "聊了新游戏"
        assert sc["results"][0]["topics"] == ["游戏", "杂谈"]


def test_missing_index_returns_note_not_error():
    with _build_client(facts=FakeService([], has_table=False)) as client:
        result = _call_tool(client, "search_persona_facts", {"query": "x"}).json()["result"]
        assert result["isError"] is False
        assert result["structuredContent"]["count"] == 0
        assert "not built" in result["structuredContent"]["note"]


def test_anonymous_rate_limit_blocks_after_quota():
    with _build_client(anon_max=2) as client:
        assert _call_tool(client, "search_streams", {"query": "a"}, _id=1).json()["result"]["isError"] is False
        assert _call_tool(client, "search_streams", {"query": "b"}, _id=2).json()["result"]["isError"] is False
        blocked = _call_tool(client, "search_streams", {"query": "c"}, _id=3).json()["result"]
        assert blocked["isError"] is True
        assert "Rate limit exceeded for anonymous" in blocked["content"][0]["text"]


def test_valid_token_uses_higher_authenticated_tier(monkeypatch):
    async def fake_resolve(token):
        return UserContext(mid=12345678, uname="奶绿粉丝", is_logged_in=True)

    monkeypatch.setattr(mcp_server, "resolve_user_context", fake_resolve)
    with _build_client(anon_max=2, auth_max=50) as client:
        for i in range(5):
            result = _call_tool(
                client, "search_streams", {"query": f"q{i}"}, token="good-token", _id=i + 1
            ).json()["result"]
            assert result["isError"] is False
