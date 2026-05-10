"""laplace-avatar — Pipecat voice bot for a streamer RP persona.

Pipeline shape (cascade, with optional memory/archive enrichment)::

    transport.input → STT → user_aggregator
        → Mem0 (per-viewer memory, optional)
        → StreamArchive (RAG over past streams, optional)
        → LLM → TTS → transport.output → assistant_aggregator

Three persistent storage tiers feed the LLM:

1. ``persona.md``      — identity, voice, hard rules (always in system prompt)
2. Stream archive       — verbatim past-stream chunks, retrieved by relevance
                          (LanceDB index built by ``tools/ingest.py``)
3. Mem0                 — per-viewer episodic memory, auto-extracted from chat

Required services: Soniox (STT), OpenRouter (LLM), Fish Audio (TTS).
Optional: Mem0 (set MEM0_API_KEY), StreamArchive (set OPENAI_API_KEY and run
the ingest script).

Run the bot with::

    uv run bot.py
"""

import os
from pathlib import Path

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
from pipecat.runner.types import (
    DailyRunnerArguments,
    RunnerArguments,
    SmallWebRTCRunnerArguments,
)
from pipecat.services.fish.tts import FishAudioTTSService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.daily.transport import DailyParams, DailyTransport
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

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
    from archive import StreamArchiveService
except Exception as e:
    StreamArchiveService = None
    logger.debug(f"StreamArchive service unavailable: {e}")

load_dotenv(override=True)

# Resolve persona/data paths relative to this file so the bot works from any
# CWD (local dev, container, Pipecat Cloud).
SERVER_DIR = Path(__file__).resolve().parent
PERSONA_PATH = SERVER_DIR / os.getenv("PERSONA_FILE", "persona.md")
ARCHIVE_DB_PATH = SERVER_DIR / os.getenv("ARCHIVE_DB_PATH", "data/lancedb")

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

    tts = FishAudioTTSService(
        api_key=fish_api_key,
        settings=FishAudioTTSService.Settings(
            voice=os.getenv("FISH_VOICE_ID"),
            model=os.getenv("FISH_MODEL", "s2-pro"),
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

    # Optional stream archive (RAG over past stream transcripts). Lives at the
    # same pipeline position as Mem0 — both intercept LLMContextFrame and
    # inject one system message. Mem0 inserts at position 1, archive at
    # position 2, so the final message order is:
    #   [persona system prompt, viewer memory, stream archive, user message].
    archive = None
    if StreamArchiveService is not None and ARCHIVE_DB_PATH.exists():
        try:
            archive = StreamArchiveService(db_path=ARCHIVE_DB_PATH)
        except Exception as e:
            logger.warning(f"StreamArchiveService disabled: {e}")
    elif StreamArchiveService is not None:
        logger.info(
            f"Stream archive disabled: no LanceDB index at "
            f"{ARCHIVE_DB_PATH.relative_to(SERVER_DIR)}. "
            "Run `uv run python -m tools.ingest` to build it."
        )

    processors = [transport.input(), stt, user_aggregator]
    if memory is not None:
        processors.append(memory)
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
    """Main bot entry point."""

    transport = None

    match runner_args:
        case DailyRunnerArguments():
            transport = DailyTransport(
                runner_args.room_url,
                runner_args.token,
                "Pipecat Bot",
                params=DailyParams(
                    audio_in_enabled=True,
                    audio_out_enabled=True,
                ),
            )
        case SmallWebRTCRunnerArguments():
            webrtc_connection: SmallWebRTCConnection = runner_args.webrtc_connection

            transport = SmallWebRTCTransport(
                webrtc_connection=webrtc_connection,
                params=TransportParams(
                    audio_in_enabled=True,
                    audio_out_enabled=True,
                ),
            )
        case _:
            logger.error(f"Unsupported runner arguments type: {type(runner_args)}")
            return

    await run_bot(transport)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
