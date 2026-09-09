from __future__ import annotations

import argparse
import json
import logging
import socket
import sys
from pathlib import Path
from typing import Any, Never

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
attempts: list[str] = []


def reject(*args: Any, **kwargs: Any) -> Never:
    attempts.append("connect")
    raise AssertionError("Offline startup attempted external connection")


socket.socket.connect = reject
socket.socket.connect_ex = reject
from loguru import logger

logger.remove()
logging.basicConfig(level=logging.CRITICAL)
from pipecat.runner import run as runner
from starlette.testclient import TestClient

from laplace_eidolon import bot as bot_module

args = argparse.Namespace(
    ice_servers=[], esp32=False, host="127.0.0.1", folder=None, transport="webrtc"
)
runner._setup_webrtc_routes(bot_module.pipecat_app, args, {})
runner._setup_unified_start_route(bot_module.pipecat_app, args, {})
with TestClient(bot_module.pipecat_app) as client:
    response = client.get("/status")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "transports": ["webrtc"]}
    assert client.get("/health").status_code == 404
    routes = [getattr(route, "path", "") for route in bot_module.pipecat_app.routes]
    assert "/api/offer" in routes and "/mcp" in routes
    assert bot_module.StreamArchiveService is not None
    assert bot_module.PersonaFactsService is not None
assert attempts == []
result = {
    "boundary": "Current bot import, actual ASGI/MCP/WebRTC request-handler lifespan startup and shutdown, in-process HTTP /status only; no listening socket, no offer or provider pipeline call.",
    "status_code": response.status_code,
    "response": response.json(),
    "health_route": "/health is not implemented; current runner readiness endpoint is /status",
    "external_connection_attempts": len(attempts),
    "optional_archive_imported": True,
    "optional_persona_facts_imported": True,
    "shutdown_completed": True,
}
Path(__file__).with_name("startup-results.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
