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
                          retrieved via hybrid (vector + jieba-FTS) search
                          (LanceDB index built by ``tools/ingest_facts.py``)
3. Stream archive       — refined past-stream chunks, retrieved via hybrid
                          (vector + jieba-FTS) search
                          (LanceDB index built by ``tools/ingest_streams.py``)
4. Mem0                 — per-viewer episodic memory, auto-extracted from chat

Tiers 2 and 3 share one retrieval pipeline (see ``retrieval.py``):
conversation-aware query building, optional date pre-filter, vector +
BM25 hybrid, optional Cohere cross-encoder rerank. Score how well it
performs on a query set with ``laplace-eval-retrieval``.

Required services: Soniox (STT), OpenRouter (LLM), Fish Audio (TTS).
Optional: Mem0 (set MEM0_API_KEY), PersonaFacts + StreamArchive (set
OPENROUTER_API_KEY and run the ingest scripts), Cohere reranker (set
COHERE_API_KEY for best retrieval precision at scale).

Run the bot with::

    uv run bot.py
"""

import asyncio
import os
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from aiortc.codecs.opus import OpusEncoder as _AiortcOpusEncoder
from dotenv import load_dotenv

# Load .env BEFORE anything else touches os.getenv — module-level
# constants below (e.g. CF_TURN_TTL_SEC) are evaluated at import time,
# so a deferred load_dotenv() would leave them silently pinned to their
# fallback defaults even when .env sets a different value.
load_dotenv(override=True)

from fastapi import Request
from fastapi.responses import Response
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
from pipecat.processors.frameworks.rtvi.processor import RTVIProcessor
from pipecat.runner.run import app as pipecat_app
from pipecat.runner.types import RunnerArguments, SmallWebRTCRunnerArguments
from pipecat.services.fish.tts import FishAudioTTSService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from .audio_quality import (
    DEFAULT_BITRATE_BPS,
    QUALITY_PRESETS_BPS,
    session_bitrate_bps,
)
from .offer_middleware import install_offer_middleware
from .openrouter import openrouter_headers
from .user_context import UserContext, resolve_user_context

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

# `or "3600"` (not `os.getenv(..., "3600")`) so an empty `.env` entry
# — which is exactly what `cp .env.example .env` produces — falls through
# to the default instead of crashing with `int("")`. python-dotenv parses
# `KEY=` as the empty string, not as unset, so getenv's own default never
# fires for the most common misconfiguration.
CF_TURN_TTL_SEC = int(os.getenv("CLOUDFLARE_TURN_TTL_SEC") or "3600")
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


# ─────────────────────────────────────────────────────────────────────────────
# Opus encoder bitrate
# ─────────────────────────────────────────────────────────────────────────────
#
# aiortc hardcodes its Opus encoder at 96 kbps (aiortc/codecs/opus.py:34
# `self.codec.bit_rate = 96000`). That's already transparent for speech,
# and we keep it as the default — viewers who want vocal texture
# (breaths/laughs/sibilants) opt in to ``best`` (192 kbps) on the
# frontend, viewers on flaky connections opt down to ``low`` / ``lowest``.
# This way a fresh deployment has zero surprise quality drop relative
# to vanilla aiortc.
#
# Pipecat doesn't expose a knob for this; the only seam is OpusEncoder's
# __init__. We re-set bit_rate *after* the original constructor runs, which
# is safe because PyAV's CodecContext lazy-opens on first encode and the
# bitrate is read from the context at that point. Application mode stays
# "voip" — better speech timbre than "audio" mode at the same bitrate
# (speech-tuned pre-emphasis/post-filter) and engages in-band FEC for
# packet-loss recovery on lossy viewer connections.
#
# The bitrate is per-session: ``offer_middleware`` reads
# ``requestData.audioQuality`` (best/medium/low/lowest) from the WebRTC
# offer and pushes the matching preset onto a ContextVar. aiortc spawns
# the encoder inside a task tree that inherits that context, so each
# call gets the bitrate the viewer asked for. When no audioQuality is
# present (older clients, anonymous probes), the encoder falls back to
# ``DEFAULT_BITRATE_BPS`` — aligned to the ``medium`` preset (96 kbps)
# so missing-field and explicit-medium traffic encode identically. Both
# the fallback and each preset are env-overridable; see
# ``audio_quality.py`` and ``.env.example`` for the env vars.
_ORIGINAL_OPUS_INIT = _AiortcOpusEncoder.__init__


def _patched_opus_init(self: _AiortcOpusEncoder) -> None:
    _ORIGINAL_OPUS_INIT(self)
    bitrate = session_bitrate_bps.get()
    self.codec.bit_rate = bitrate
    logger.debug(f"[WebRTC] Opus encoder constructed at {bitrate // 1000} kbps")


_AiortcOpusEncoder.__init__ = _patched_opus_init
logger.info(
    f"[WebRTC] Opus encoder bitrate: default {DEFAULT_BITRATE_BPS // 1000} kbps, "
    f"presets "
    + ", ".join(f"{name}={bps // 1000}kbps" for name, bps in QUALITY_PRESETS_BPS.items())
)


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


# Wire the anonymous rate limit + camelCase body normalisation onto
# pipecat's FastAPI app before the runner registers /api/offer. Order
# doesn't matter for middleware registration (Starlette applies it on
# every request regardless of when it was added) but doing it here at
# module load keeps all server-side plumbing in one place. See
# offer_middleware.py for why the body rewrite is necessary — without
# it, runner_args.body would silently be None even when the JS SDK
# sent a loginSyncToken.
install_offer_middleware(pipecat_app)


# Hide pipecat's built-in SmallWebRTCPrebuiltUI demo (/, /client,
# /client/*) outside local dev. The runner mounts it unconditionally
# at pipecat/runner/run.py:_setup_webrtc_routes (`app.mount("/client",
# SmallWebRTCPrebuiltUI)` plus a `/ → /client/` redirect, no upstream
# toggle) — fine for `uv run bot.py` on localhost, embarrassing on a
# public deploy where the page has no rate limit, no Workers
# integration, and no persona theming. Starlette HTTP middleware runs
# before routing, so returning early here means the mounted
# StaticFiles app never sees the request.
#
# Toggle: EIDOLON_PIPECAT_DEMO_ENABLED. Disabled by default — prod is
# the safe default, so a fresh deploy never accidentally exposes the
# pipecat-branded demo page. Set to ``true`` / ``1`` / ``yes`` / ``on``
# in your local ``.env`` to opt in. We can't auto-detect dev via
# pipecat's own ENV=local because pipecat/runner/run.py force-sets
# ``os.environ["ENV"] = "local"`` at module import time, which fires
# the moment bot.py imports ``pipecat_app`` — even on a production
# server.
_PIPECAT_DEMO_ENABLED = (
    os.getenv("EIDOLON_PIPECAT_DEMO_ENABLED", "").strip().lower()
    in {"true", "1", "yes", "on"}
)


@pipecat_app.middleware("http")
async def _block_pipecat_demo_in_prod(request: Request, call_next):
    if not _PIPECAT_DEMO_ENABLED:
        path = request.url.path
        if path == "/" or path == "/client" or path.startswith("/client/"):
            return Response(status_code=404)
    return await call_next(request)


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
    from .stream_archive import StreamArchiveService
except Exception as e:
    StreamArchiveService = None
    logger.debug(f"StreamArchive service unavailable: {e}")

# PersonaFacts is also optional — same LanceDB instance as StreamArchive,
# but a separate ``persona_facts`` table built by tools/ingest_facts.py.
try:
    from .persona_facts import PersonaFactsService
except Exception as e:
    PersonaFactsService = None
    logger.debug(f"PersonaFacts service unavailable: {e}")

# Resolve persona/data paths relative to this file so the bot works from
# any CWD (local dev, Docker container). ``__file__`` is
# ``<repo>/laplace_eidolon/bot.py``, so we walk up TWO parents to reach
# the repo root where ``persona.md`` and ``data/lancedb`` live. The old
# ``SERVER_DIR`` only did one ``.parent`` — that pointed at
# ``laplace_eidolon/`` after the package move and silently demoted the
# bot to its fallback persona with all RAG retrieval disabled.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PERSONA_PATH = PROJECT_ROOT / os.getenv("PERSONA_FILE", "persona.md")
LANCEDB_PATH = PROJECT_ROOT / os.getenv("LANCEDB_PATH", "data/lancedb")

# Timezone used to inject "现在是 …" into the per-session system prompt
# prefix (see _build_persona_prefix). Defaults to Asia/Shanghai because
# the persona is Bilibili-based / 虚拟上海 — overridable via
# PERSONA_TIMEZONE for forks targeting a different streamer locale.
# `or "Asia/Shanghai"` (not getenv's default) so an empty .env entry —
# which is exactly what `cp .env.example .env` produces — falls through
# to the default instead of crashing ZoneInfo with the empty string.
# Defensive fallback to UTC so a typo'd or unsupported timezone (slim
# container without tzdata, Windows without the `tzdata` package) only
# costs a clearer-than-default clock instead of preventing module
# import — without this the whole bot fails to start.
try:
    PERSONA_TZ = ZoneInfo(os.getenv("PERSONA_TIMEZONE") or "Asia/Shanghai")
except ZoneInfoNotFoundError as e:
    logger.warning(
        f"PERSONA_TIMEZONE invalid or tzdata missing ({e}); falling back to UTC. "
        "On Windows or slim Docker images, install the `tzdata` package."
    )
    PERSONA_TZ = ZoneInfo("UTC")

_WEEKDAY_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# How many recent stream dates to inject into the per-session system
# prompt. Five covers most "你最近播了几场?" / "你这周播了吗?" /
# "你好久没播了吧" patterns without bloating the prompt. Bump to 7-10
# if you want a fuller weekly calendar.
RECENT_STREAM_DATES_N = 5

# Refresh interval for the cached stream-date list. Re-ingest is
# infrequent so a coarse cache is fine, but we still want the bot to
# pick up a fresh stream within ~10 minutes without a restart.
_STREAM_DATES_TTL_SEC = 600

_recent_stream_dates_cache: list[str] | None = None
_recent_stream_dates_cached_at: float = 0.0
_recent_stream_dates_lock = threading.Lock()

FALLBACK_PERSONA = (
    "You are a helpful assistant in a voice conversation. Your responses will "
    "be spoken aloud, so avoid emojis, bullet points, or other formatting that "
    "can't be spoken. Always reply in the same language the user just spoke; "
    "if they switch languages, switch with them. Respond briefly."
)


def _get_recent_stream_dates(n: int = RECENT_STREAM_DATES_N) -> list[str]:
    """Return up to ``n`` most-recent stream dates, newest first.

    Reads from the LanceDB ``stream_chunks`` table (one row per chunk;
    we deduplicate to one per stream day). Cached for
    ``_STREAM_DATES_TTL_SEC`` so the per-session system-prompt build
    doesn't re-scan the table on every call. Stale-on-failure: if the
    refresh fails, return the previous cache rather than the empty
    list, since a stale list is strictly better than the LLM being
    forced to guess a date.

    Why this exists: the embedding model can't answer "你最后一次直播
    什么时候?" — that's a meta question about table metadata, not a
    fact in any chunk. Injecting the answer into the system prompt
    sidesteps RAG entirely for the whole class of recency questions.
    """
    global _recent_stream_dates_cache, _recent_stream_dates_cached_at

    with _recent_stream_dates_lock:
        now = time.time()
        if (
            _recent_stream_dates_cache is not None
            and (now - _recent_stream_dates_cached_at) < _STREAM_DATES_TTL_SEC
        ):
            return _recent_stream_dates_cache[:n]

        try:
            # Local import: lancedb is heavy and only needed when the
            # archive is actually built. Bot still boots cleanly on a
            # fresh checkout where data/lancedb doesn't exist yet.
            import lancedb

            if not LANCEDB_PATH.exists():
                _recent_stream_dates_cache = []
                _recent_stream_dates_cached_at = now
                return []
            db = lancedb.connect(str(LANCEDB_PATH))
            if "stream_chunks" not in db.list_tables().tables:
                _recent_stream_dates_cache = []
                _recent_stream_dates_cached_at = now
                return []
            table = db.open_table("stream_chunks")
            # Pull just the date column, project then dedupe in Python.
            # LanceDB has no DISTINCT primitive; columnar scan of one
            # narrow column over ~30k rows is ~10-30ms and runs once
            # per TTL window so this is fine.
            rows = table.search().select(["stream_date"]).limit(200_000).to_list()
            unique = sorted(
                {r["stream_date"] for r in rows if r.get("stream_date")},
                reverse=True,
            )
            _recent_stream_dates_cache = unique
            _recent_stream_dates_cached_at = now
            return unique[:n]
        except Exception as e:  # noqa: BLE001
            logger.warning(
                f"Could not refresh recent stream dates: {e}; "
                f"returning cached={_recent_stream_dates_cache is not None}"
            )
            return _recent_stream_dates_cache[:n] if _recent_stream_dates_cache else []


def _humanize_days_ago(days: int) -> str:
    """Render a non-negative day-delta into a natural Chinese phrase.

    Used to annotate stream dates in the system prompt so the LLM can
    answer "上次什么时候播的?" in human terms ("昨天", "三天前", "一周前")
    without doing date arithmetic itself — LLMs are surprisingly bad
    at counting days.
    """
    if days <= 0:
        return "今天"
    if days == 1:
        return "昨天"
    if days == 2:
        return "前天"
    if days < 7:
        return f"{days}天前"
    if days < 30:
        weeks = days // 7
        return f"{weeks}周前"
    if days < 365:
        months = days // 30
        return f"{months}个月前"
    return f"{days // 365}年前"


def load_persona() -> str:
    """Load persona.md as the LLM system instruction.

    Falls back to a generic voice-assistant prompt if the file is missing —
    keeps the bot runnable on a fresh checkout before persona.md is authored.
    """
    if PERSONA_PATH.exists():
        text = PERSONA_PATH.read_text(encoding="utf-8").strip()
        if text:
            logger.info(f"Loaded persona from {PERSONA_PATH.relative_to(PROJECT_ROOT)}")
            return text
    logger.warning(f"Persona file {PERSONA_PATH} not found; using fallback prompt")
    return FALLBACK_PERSONA


def _build_persona_prefix(user: UserContext) -> str:
    """Per-session preamble prepended to ``persona.md``.

    Always emits the current local date/time so the LLM can reason
    about time-sensitive lore in ``persona.md`` (e.g. "坚果 跑路 in
    early 2026" — the model needs today's date to know how long ago
    that was). Adds:

    - The viewer's name/UID for logged-in viewers (so the bot greets
      them naturally without "what's your name").
    - The most recent stream dates from the LanceDB archive (so the
      bot can answer "你最后一次直播什么时候?" / "你上周播了几场?"
      without RAG — those are meta questions that semantic retrieval
      can't answer because the date lives in metadata, not in any
      chunk's text).

    The "不要主动念" lines are load-bearing — without them the model
    occasionally narrates the current time / reads the UID aloud,
    which sounds robotic and breaks the persona's "短简、不像 AI 助手"
    rule. Wording matches the 奶绿 / 奶糖花 vocabulary in
    ``persona.md``.
    """
    now = datetime.now(PERSONA_TZ)
    today = now.date()
    # Manual int formatting (not %-m / %#m) so the output is portable
    # across Linux, macOS, and Windows — strftime's non-padding flag
    # uses different syntax per-platform.
    date_str = (
        f"{now.year}年{now.month}月{now.day}日 "
        f"{_WEEKDAY_ZH[now.weekday()]} "
        f"{now.hour:02d}:{now.minute:02d}"
    )
    lines = [
        f"现在是 {date_str}。"
        "如果用户问到时间或日期，根据这里的事实回答；"
        "不要主动念时间，除非话题相关。",
    ]
    if user.is_logged_in and user.uname:
        lines.append(
            f"今天来花店的奶糖花叫「{user.uname}」（B站UID:{user.mid}）。"
            "聊天里可以自然地叫她/他的名字，但不要每句都重复，也不要主动念UID。"
        )

    # Recent-stream calendar — see ``_get_recent_stream_dates`` for
    # rationale. Omits the line entirely when no archive is built so
    # fresh checkouts don't see a stray empty section.
    recent = _get_recent_stream_dates()
    if recent:
        formatted: list[str] = []
        for iso in recent:
            try:
                d = date.fromisoformat(iso)
            except ValueError:
                continue
            ago = _humanize_days_ago((today - d).days)
            # Drop the year when it matches today's, mirroring the
            # natural-language phrasing a fan would actually use
            # ("5月9号" not "2026年5月9号" when both sides know it's 2026).
            if d.year == today.year:
                formatted.append(f"{d.month}月{d.day}日（{ago}）")
            else:
                formatted.append(f"{d.year}年{d.month}月{d.day}日（{ago}）")
        if formatted:
            lines.append(
                "你最近几次直播：" + "、".join(formatted) + "。"
                "如果用户问最近 / 上次 / 上一次 / 好久没播 / 这周播了吗 之类的，"
                "根据这里的日期自然回答；不要凭空编日期。"
            )

    return "\n".join(lines) + "\n\n"


class LaplaceRTVIProcessor(RTVIProcessor):
    """RTVIProcessor that brands the bot-ready ``about`` payload as ours."""

    # Keep in sync with pyproject.toml [project].version.
    _DEFAULT_ABOUT = {
        "library": "laplace-eidolon",
        "library_version": "0.1.0",
    }

    async def set_bot_ready(self, about=None):
        await super().set_bot_ready(about=about or self._DEFAULT_ABOUT)


async def run_bot(transport: BaseTransport, login_sync_token: str | None = None):
    """Main bot logic.

    Args:
        transport: The pipecat transport for this connection.
        login_sync_token: The viewer's loginSyncToken from
            ``requestData.loginSyncToken`` in the WebRTC offer. ``None``
            for anonymous viewers. Validated via Workers inside this
            function — the middleware only checked it was present, not
            that it was real.
    """
    logger.info("Starting bot")

    # Resolve the viewer's identity first — it gates two pipeline
    # decisions: whether to spin up Mem0 (only for logged-in viewers,
    # keyed on their Bilibili UID) and what prefix to prepend to the
    # persona system prompt (so the LLM can use their name naturally).
    # Fail-open: if Workers is down, user.is_logged_in == False and we
    # behave as if the viewer was anonymous.
    user = await resolve_user_context(login_sync_token)

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
        sample_rate=44100,
        settings=FishAudioTTSService.Settings(
            voice=os.getenv("FISH_VOICE_ID"),
            model=os.getenv("FISH_MODEL", "s2-pro"),
            # latency="normal",
            # Seems worse when reading years
            normalize=False,
            # temperature=0.7,
            # top_p=0.7,
            # prosody_speed=1.1,
        ),
    )

    # LLM service. Persona/identity/voice rules all live in persona.md
    # so they can be edited without touching code. _build_persona_prefix
    # injects per-session dynamic facts on top: the current date (for
    # all viewers, so the model can ground time-sensitive lore) and,
    # for logged-in viewers only, a line with their name/UID so the
    # bot greets them naturally.
    llm = OpenRouterLLMService(
        api_key=os.getenv("OPENROUTER_API_KEY"),
        settings=OpenRouterLLMService.Settings(
            model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-2024-11-20"),
            system_instruction=_build_persona_prefix(user) + load_persona(),
        ),
        default_headers=openrouter_headers(),
    )

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )

    # Long-term memory via Mem0. Only wired up for logged-in viewers —
    # ``user_id`` is the viewer's Bilibili UID so each fan gets their
    # own private memory namespace. Anonymous viewers skip Mem0 entirely
    # rather than pile into a shared ``default-user`` bucket where their
    # memories would cross-pollute every other anonymous conversation.
    memory = None
    mem0_api_key = os.getenv("MEM0_API_KEY")
    if not user.is_logged_in:
        logger.info("Mem0 skipped: anonymous viewer (no loginSyncToken / validation failed)")
    elif mem0_api_key and Mem0MemoryService is not None:
        memory = Mem0MemoryService(
            api_key=mem0_api_key,
            user_id=str(user.mid),
            agent_id=os.getenv("MEM0_AGENT_ID") or None,
            run_id=os.getenv("MEM0_RUN_ID") or None,
            params=Mem0MemoryService.InputParams(
                search_limit=int(os.getenv("MEM0_SEARCH_LIMIT", "10")),
                search_threshold=float(os.getenv("MEM0_SEARCH_THRESHOLD", "0.3")),
            ),
        )
        logger.info(f"Mem0 long-term memory enabled for user_id={user.mid} ({user.uname!r})")
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
            f"{LANCEDB_PATH.relative_to(PROJECT_ROOT)}. "
            "Run `uv run laplace-ingest-facts` to build it."
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
            f"{LANCEDB_PATH.relative_to(PROJECT_ROOT)}. "
            "Run `uv run laplace-ingest-streams` to build it."
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
        rtvi_processor=LaplaceRTVIProcessor(),
    )

    @task.rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        # Kick off the conversation. If Mem0 is enabled and we have prior
        # memories for this user, hint the LLM so the greeting feels personal.
        kickoff = "用一两句话简短自然地打个招呼。"
        if memory is not None:
            try:
                memories = await memory.get_memories()
                snippets = [m.get("memory", "") for m in (memories or []) if m.get("memory")]
                if snippets:
                    kickoff = (
                        "用一两句话简短自然地打个招呼。"
                        "你之前跟ta聊过这些事："
                        + "; ".join(snippets[:3])
                        + "。如果合适的话自然地提一两件，不要全念出来。"
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


def _extract_login_sync_token(body: Any) -> str | None:
    """Pull ``loginSyncToken`` out of the parsed ``requestData`` body.

    ``runner_args.body`` is whatever the SmallWebRTC route placed in
    ``request_data`` — typically the dict the frontend put under
    ``requestData`` in the offer JSON. The middleware's body rewrite
    guarantees this populates correctly for the JS SDK's camelCase
    payloads; here we just validate the inner shape and trim.
    """
    if not isinstance(body, dict):
        return None
    token = body.get("loginSyncToken")
    if isinstance(token, str) and token.strip():
        return token.strip()
    return None


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

    # The middleware in offer_middleware.py normalises camelCase
    # ``requestData`` to snake_case ``request_data`` before pipecat's
    # route parses it, so ``runner_args.body`` is the inner dict here
    # (not the full envelope). For anonymous viewers it's None.
    login_sync_token = _extract_login_sync_token(runner_args.body)
    # Spell out what the bot received so a missing-token surprise is
    # diagnosable from a single log line — without this the silent
    # "anonymous-everywhere" failure mode is invisible.
    if login_sync_token:
        logger.info(
            f"[bot] Session start with loginSyncToken (len={len(login_sync_token)})"
        )
    else:
        logger.info(
            f"[bot] Session start without loginSyncToken; "
            f"runner_args.body={runner_args.body!r}"
        )
    await run_bot(transport, login_sync_token=login_sync_token)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
