"""laplace-eidolon — Pipecat voice bot for a streamer RP persona.

Pipeline shape (cascade, with optional memory/archive enrichment)::

    transport.input → STT → user_aggregator
        → Mem0 (per-viewer memory, optional)
        → PersonaFacts (RAG over hand-compiled streamer facts, optional)
        → StreamArchive (RAG over past streams, optional)
        → LLM → TTS → transport.output → assistant_aggregator

Four persistent storage tiers feed the LLM:

1. ``persona.md``      — identity, voice, hard rules (always in system prompt)
2. Persona facts        — atomic fan-compiled "things she said" facts,
                          retrieved by relevance
                          (LanceDB index built by ``tools/ingest_facts.py``)
3. Stream archive       — verbatim past-stream chunks, retrieved by relevance
                          (LanceDB index built by ``tools/ingest_streams.py``)
4. Mem0                 — per-viewer episodic memory, auto-extracted from chat

Required services: Soniox (STT), OpenRouter (LLM), Fish Audio (TTS).
Optional: Mem0 (set MEM0_API_KEY), PersonaFacts + StreamArchive (set
OPENROUTER_API_KEY and run the ingest scripts).

Run the bot with::

    uv run bot.py
"""

import asyncio
import os
import threading
import time
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.run import app as pipecat_app
from pipecat.runner.types import RunnerArguments, SmallWebRTCRunnerArguments
from pipecat.services.fish.tts import FishAudioTTSService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

# ─────────────────────────────────────────────────────────────────────────────
# WebRTC ICE server configuration
# ─────────────────────────────────────────────────────────────────────────────
#
# Self-hosted SmallWebRTC behind any NAT (Docker bridge, VPS firewall,
# residential router, …) needs aiortc to:
#
#   1. Discover its own public IP via STUN, so the browser receives a
#      routable srflx candidate instead of just an unrouteable Docker
#      bridge IP (172.x.y.z).
#   2. (For symmetric-NAT clients) advertise a TURN relay candidate so
#      media has a fallback path when peer-to-peer ICE cannot converge.
#
# Pipecat's dev runner never wires server-side ICE servers in; it
# constructs SmallWebRTCRequestHandler() without `ice_servers`, which in
# turn constructs every SmallWebRTCConnection with `ice_servers=None`.
# That advertises ONLY host candidates — fine on localhost, broken
# behind any NAT. We monkey-patch __init__ to inject ICE servers (same
# pattern pipecat itself uses for USERDATA_MAX_LENGTH at
# pipecat/transports/smallwebrtc/connection.py:62).
#
# Resolution priority:
#
#   1. Cloudflare Realtime TURN (when CLOUDFLARE_TURN_KEY_ID +
#      CLOUDFLARE_TURN_KEY_API_TOKEN are set). Credentials are minted on
#      demand from rtc.live.cloudflare.com and cached in-process. Both
#      the server (aiortc) and the frontend (via GET /api/ice-servers)
#      read from the same cache so a single mint serves both ends.
#   2. Static WEBRTC_STUN_URL / WEBRTC_TURN_URL env vars. Useful for
#      coturn or other providers; bring-your-own-credentials.
#   3. Empty list → host candidates only. Fine for `uv run bot.py` on
#      localhost where browser and aiortc both bind to 127.0.0.1.
#
# aiortc has its own limitation independent of source: it honors at most
# ONE STUN and ONE TURN server per connection (see
# aiortc.rtcicetransport.connection_kwargs) — extras are silently
# dropped. The frontend, in contrast, can use every URL Cloudflare
# returns (UDP/TCP/TLS variants) for maximum reachability.

CF_TURN_TTL_SEC = int(os.getenv("CLOUDFLARE_TURN_TTL_SEC", "3600"))
# Refresh slightly before expiry so an in-flight credential never goes
# stale mid-call. Floor of 60s in case TTL is set very short for testing.
CF_REFRESH_MARGIN_SEC = 300

_cf_cache: dict[str, Any] | None = None
_cf_cache_expiry: float = 0.0
_cf_lock = threading.Lock()


def _fetch_cloudflare_ice() -> dict[str, Any] | None:
    """Mint a fresh Cloudflare TURN credential set.

    Returns the raw {"iceServers": [...]} payload on success, None on
    failure or when CF is not configured. Synchronous; blocks for the
    duration of the HTTP round-trip (~100–300 ms).
    """
    key_id = os.getenv("CLOUDFLARE_TURN_KEY_ID")
    api_token = os.getenv("CLOUDFLARE_TURN_KEY_API_TOKEN")
    if not key_id or not api_token:
        return None
    url = f"https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
    try:
        with httpx.Client(timeout=10.0) as client:
            r = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_token}",
                    "Content-Type": "application/json",
                },
                json={"ttl": CF_TURN_TTL_SEC},
            )
            r.raise_for_status()
            return r.json()
    except Exception as e:
        logger.warning(f"[WebRTC] Cloudflare TURN mint failed: {e}")
        return None


def _get_cloudflare_ice() -> dict[str, Any] | None:
    """Return cached or freshly-minted Cloudflare ICE config.

    Stale-on-failure: if a refresh fails but we have an old (possibly
    expired) cache, return it anyway — Cloudflare TURN keeps accepting
    a credential for ~30s past its expiry, and a stale credential is
    strictly better than dropping the call.
    """
    global _cf_cache, _cf_cache_expiry
    now = time.time()
    with _cf_lock:
        if _cf_cache and now < _cf_cache_expiry:
            return _cf_cache
        fresh = _fetch_cloudflare_ice()
        if fresh is not None:
            _cf_cache = fresh
            _cf_cache_expiry = now + max(CF_TURN_TTL_SEC - CF_REFRESH_MARGIN_SEC, 60)
            logger.info(
                f"[WebRTC] Minted fresh Cloudflare TURN credentials "
                f"(TTL {CF_TURN_TTL_SEC}s, refresh in "
                f"{int(_cf_cache_expiry - now)}s)"
            )
            return fresh
        return _cf_cache


def _resolve_ice_response() -> dict[str, Any]:
    """Build the {iceServers: [...]} JSON payload for the frontend.

    Always returns a valid object — empty `iceServers` list when nothing
    is configured, which lets local-dev (browser ↔ localhost) work via
    host candidates.
    """
    cf = _get_cloudflare_ice()
    if cf is not None:
        return cf

    servers: list[dict[str, Any]] = []
    stun_url = os.getenv("WEBRTC_STUN_URL")
    if stun_url:
        servers.append({"urls": [stun_url]})
    turn_url = os.getenv("WEBRTC_TURN_URL")
    if turn_url:
        servers.append(
            {
                "urls": [turn_url],
                "username": os.getenv("WEBRTC_TURN_USERNAME", ""),
                "credential": os.getenv("WEBRTC_TURN_CREDENTIAL", ""),
            }
        )
    return {"iceServers": servers}


def _resolve_ice_servers_for_aiortc() -> list[IceServer]:
    """Pick the single STUN + single TURN aiortc will actually use.

    aiortc keeps only the first STUN URL and first TURN URL it sees;
    this helper does that selection up-front so the log line is
    accurate and so we don't waste CPU constructing IceServer objects
    aiortc would discard.
    """
    out: list[IceServer] = []
    have_stun = False
    have_turn = False

    cf = _get_cloudflare_ice()
    if cf is not None:
        for entry in cf.get("iceServers", []):
            urls = entry.get("urls", [])
            if isinstance(urls, str):
                urls = [urls]
            username = entry.get("username")
            credential = entry.get("credential")
            for url in urls:
                if not have_stun and url.startswith("stun:"):
                    out.append(IceServer(urls=url))
                    have_stun = True
                elif not have_turn and url.startswith(("turn:", "turns:")):
                    # Cloudflare returns udp first, which is what aiortc
                    # wants for best perf — picking the first match
                    # naturally favors udp:3478.
                    out.append(IceServer(urls=url, username=username, credential=credential))
                    have_turn = True
        return out

    stun_url = os.getenv("WEBRTC_STUN_URL")
    if stun_url:
        out.append(IceServer(urls=stun_url))
    turn_url = os.getenv("WEBRTC_TURN_URL")
    if turn_url:
        out.append(
            IceServer(
                urls=turn_url,
                username=os.getenv("WEBRTC_TURN_USERNAME"),
                credential=os.getenv("WEBRTC_TURN_CREDENTIAL"),
            )
        )
    return out


_ORIGINAL_SWRTC_INIT = SmallWebRTCConnection.__init__


def _patched_swrtc_init(self, ice_servers=None, connection_timeout_secs=60):
    if not ice_servers:
        resolved = _resolve_ice_servers_for_aiortc()
        if resolved:
            ice_servers = resolved
    _ORIGINAL_SWRTC_INIT(
        self,
        ice_servers=ice_servers,
        connection_timeout_secs=connection_timeout_secs,
    )


SmallWebRTCConnection.__init__ = _patched_swrtc_init


@pipecat_app.get("/api/ice-servers")
async def get_ice_servers():
    """Serve fresh ICE config to the frontend.

    Frontend should call this immediately before opening the WebRTC
    connection and pass the returned `iceServers` array into its
    RTCPeerConnection / SmallWebRTCTransport. Cache lookup is sync
    (httpx.Client) so we offload to a thread to keep the event loop
    responsive when a fresh mint is needed (~100–300 ms blocking call).
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _resolve_ice_response)


# Mem0 is an optional dependency; only import if available so the bot still
# runs when the user hasn't installed the `mem0` extra or set MEM0_API_KEY.
try:
    from pipecat.services.mem0.memory import Mem0MemoryService
except Exception as e:
    Mem0MemoryService = None
    logger.debug(f"Mem0 service unavailable: {e}")

# StreamArchive is also optional — disabled if OPENAI_API_KEY (used for
# embeddings) is missing or the LanceDB index hasn't been built yet.
try:
    from stream_archive import StreamArchiveService
except Exception as e:
    StreamArchiveService = None
    logger.debug(f"StreamArchive service unavailable: {e}")

# PersonaFacts is also optional — same LanceDB instance as StreamArchive,
# but a separate ``persona_facts`` table built by tools/ingest_facts.py.
try:
    from persona_facts import PersonaFactsService
except Exception as e:
    PersonaFactsService = None
    logger.debug(f"PersonaFacts service unavailable: {e}")

load_dotenv(override=True)

# Resolve persona/data paths relative to this file so the bot works from any
# CWD (local dev, Docker container).
SERVER_DIR = Path(__file__).resolve().parent
PERSONA_PATH = SERVER_DIR / os.getenv("PERSONA_FILE", "persona.md")
LANCEDB_PATH = SERVER_DIR / os.getenv("LANCEDB_PATH", "data/lancedb")

FALLBACK_PERSONA = (
    "You are a helpful assistant in a voice conversation. Your responses will "
    "be spoken aloud, so avoid emojis, bullet points, or other formatting that "
    "can't be spoken. Always reply in the same language the user just spoke; "
    "if they switch languages, switch with them. Respond briefly."
)


def load_persona() -> str:
    """Load persona.md as the LLM system instruction.

    Falls back to a generic voice-assistant prompt if the file is missing —
    keeps the bot runnable on a fresh checkout before persona.md is authored.
    """
    if PERSONA_PATH.exists():
        text = PERSONA_PATH.read_text(encoding="utf-8").strip()
        if text:
            logger.info(f"Loaded persona from {PERSONA_PATH.relative_to(SERVER_DIR)}")
            return text
    logger.warning(f"Persona file {PERSONA_PATH} not found; using fallback prompt")
    return FALLBACK_PERSONA


async def run_bot(transport: BaseTransport):
    """Main bot logic."""
    logger.info("Starting bot")

    soniox_api_key = os.getenv("SONIOX_API_KEY")
    if not soniox_api_key:
        raise RuntimeError("SONIOX_API_KEY environment variable is required")

    stt = SonioxSTTService(
        api_key=soniox_api_key,
        settings=SonioxSTTService.Settings(
            model=os.getenv("SONIOX_MODEL", "stt-rt-v4"),
        ),
    )

    fish_api_key = os.getenv("FISH_API_KEY")
    if not fish_api_key:
        raise RuntimeError("FISH_API_KEY environment variable is required")

    # Fish Audio WebSocket TTS (wss://api.fish.audio/v1/tts/live, PCM output).
    # Pipecat exposes a subset of the Fish API; we pin the knobs that affect
    # perceived quality:
    #
    #   latency="normal"   Fish's best-quality mode. Pipecat's default is
    #                      "balanced" which shaves ~50-100 ms TTFB at an
    #                      audible cost. For a streamer persona where the
    #                      voice IS the product, normal wins.
    #   normalize=True     Text normalization for EN/ZH numbers, dates, units.
    #                      On by default; pinned here for documentation.
    #   temperature=0.7    Server default. Lower (0.5-0.6) = more consistent,
    #                      higher (0.8-0.9) = more expressive. Tune if delivery
    #                      feels flat or unstable.
    #   top_p=0.7          Server default. Pair with temperature for diversity.
    #
    # Not exposed by Pipecat (would need a subclass to inject into the start
    # message): prosody.normalize_loudness (S2-Pro perceived-loudness
    # normalization, defaults true server-side), chunk_length, repetition_
    # penalty, condition_on_previous_chunks, min_chunk_length. Revisit if the
    # voice clips, drifts across turns, or repeats artifacts.
    tts = FishAudioTTSService(
        api_key=fish_api_key,
        settings=FishAudioTTSService.Settings(
            voice=os.getenv("FISH_VOICE_ID"),
            model=os.getenv("FISH_MODEL", "s2-pro"),
            # latency="normal",
            normalize=True,
            # temperature=0.7,
            # top_p=0.7,
            # prosody_speed=1.1,
        ),
    )

    # LLM service. Persona/identity/voice rules all live in persona.md so
    # they can be edited without touching code.
    llm = OpenRouterLLMService(
        api_key=os.getenv("OPENROUTER_API_KEY"),
        settings=OpenRouterLLMService.Settings(
            model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-2024-11-20"),
            system_instruction=load_persona(),
        ),
    )

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )

    # Optional long-term memory via Mem0. Sits between the user aggregator and
    # the LLM so it can intercept LLMContextFrame, search relevant memories,
    # and inject them into the context before the LLM runs.
    memory = None
    mem0_api_key = os.getenv("MEM0_API_KEY")
    if mem0_api_key and Mem0MemoryService is not None:
        memory = Mem0MemoryService(
            api_key=mem0_api_key,
            user_id=os.getenv("MEM0_USER_ID", "default-user"),
            agent_id=os.getenv("MEM0_AGENT_ID") or None,
            run_id=os.getenv("MEM0_RUN_ID") or None,
            params=Mem0MemoryService.InputParams(
                search_limit=int(os.getenv("MEM0_SEARCH_LIMIT", "10")),
                search_threshold=float(os.getenv("MEM0_SEARCH_THRESHOLD", "0.3")),
            ),
        )
        logger.info("Mem0 long-term memory enabled")
    elif mem0_api_key and Mem0MemoryService is None:
        logger.warning("MEM0_API_KEY is set but pipecat-ai[mem0] is not installed; skipping memory")

    # Optional persona-facts retrieval (RAG over hand-compiled streamer facts
    # in data/*设定集.txt + data/*事件集.txt). Same LanceDB instance as the
    # stream archive, different table.
    facts = None
    if PersonaFactsService is not None and LANCEDB_PATH.exists():
        try:
            facts = PersonaFactsService(db_path=LANCEDB_PATH)
        except Exception as e:
            logger.warning(f"PersonaFactsService disabled: {e}")
    elif PersonaFactsService is not None:
        logger.info(
            f"Persona facts disabled: no LanceDB index at "
            f"{LANCEDB_PATH.relative_to(SERVER_DIR)}. "
            "Run `uv run python -m tools.ingest_facts` to build it."
        )

    # Optional stream archive (RAG over past stream transcripts). Mem0,
    # PersonaFacts, and StreamArchive each intercept LLMContextFrame and
    # inject one system message per turn. Default positions stack them
    # roughly as: [user, mem0, persona_facts, stream_archive] (the
    # system_instruction from persona.md is prepended automatically by
    # the LLM service).
    archive = None
    if StreamArchiveService is not None and LANCEDB_PATH.exists():
        try:
            archive = StreamArchiveService(db_path=LANCEDB_PATH)
        except Exception as e:
            logger.warning(f"StreamArchiveService disabled: {e}")
    elif StreamArchiveService is not None:
        logger.info(
            f"Stream archive disabled: no LanceDB index at "
            f"{LANCEDB_PATH.relative_to(SERVER_DIR)}. "
            "Run `uv run python -m tools.ingest_streams` to build it."
        )

    processors = [transport.input(), stt, user_aggregator]
    if memory is not None:
        processors.append(memory)
    if facts is not None:
        processors.append(facts)
    if archive is not None:
        processors.append(archive)
    processors.extend([llm, tts, transport.output(), assistant_aggregator])

    pipeline = Pipeline(processors)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        observers=[],
    )

    @task.rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        # Kick off the conversation. If Mem0 is enabled and we have prior
        # memories for this user, hint the LLM so the greeting feels personal.
        kickoff = "Please introduce yourself."
        if memory is not None:
            try:
                memories = await memory.get_memories()
                snippets = [m.get("memory", "") for m in (memories or []) if m.get("memory")]
                if snippets:
                    kickoff = (
                        "Greet the user warmly and briefly. Things you remember "
                        "about them from past conversations: "
                        + "; ".join(snippets[:3])
                        + ". Reference one or two naturally if it fits."
                    )
            except Exception as e:
                logger.warning(f"Could not load Mem0 memories for greeting: {e}")

        context.add_message({"role": "user", "content": kickoff})
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)

    await runner.run(task)


async def bot(runner_args: RunnerArguments):
    """Main bot entry point.

    SmallWebRTC only — Daily/telephony transports were removed because
    laplace-eidolon self-hosts on its own server. If a non-WebRTC
    connection ever shows up here it's a misconfiguration of the runner.
    """
    if not isinstance(runner_args, SmallWebRTCRunnerArguments):
        logger.error(f"Unsupported runner arguments type: {type(runner_args)}")
        return

    webrtc_connection: SmallWebRTCConnection = runner_args.webrtc_connection
    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )

    await run_bot(transport)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
