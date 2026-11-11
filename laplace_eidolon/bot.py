"""laplace-eidolon — Pipecat voice bot for a streamer RP persona.

A cascade pipeline: STT, then optional memory and RAG enrichment, then
LLM, TTS, and back out over WebRTC. Four storage tiers feed the LLM —
``persona.md`` for identity and hard rules (always in the system prompt),
persona facts and the stream archive as LanceDB indexes searched through
``retrieval.py``, and Mem0 for per-viewer episodic memory.

Soniox (STT), OpenRouter (LLM), and Fish Audio (TTS) are required.
Everything else degrades quietly when its key is absent: ``MEM0_API_KEY``
for memory, ``COHERE_API_KEY`` for reranking, and the ingest scripts for
either RAG tier.
"""

import asyncio
import ipaddress
import os
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from aioice.ice import Connection as IceConnection
from aioice.ice import TransportPolicy
from aiortc import rtcicetransport
from aiortc.codecs.opus import OpusEncoder as _AiortcOpusEncoder
from dotenv import load_dotenv

# Must precede every other import that reads os.getenv: the module-level
# constants below are evaluated at import time, so a deferred load would
# pin them to their fallback defaults even when .env sets a value.
load_dotenv(override=True)

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
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
from pipecat.turns.empty_user_turn import EmptyUserTurnConfig
from pipecat.workers.runner import WorkerRunner
from starlette.types import ASGIApp, Receive, Scope, Send

from . import image_generation, retrieval_gate
from .audio_quality import (
    DEFAULT_BITRATE_BPS,
    QUALITY_PRESETS_BPS,
    session_bitrate_bps,
)
from .embeddings import resolve_db_path
from .env import env_float, env_int
from .mcp_server import install_mcp
from .memory_admin import install_memory_admin
from .offer_middleware import install_offer_middleware
from .openrouter import openrouter_headers
from .retrieval import warm_tokenizer
from .user_context import UserContext, resolve_user_context
from .voice_switching import (
    install_voice_style_tool,
    load_voice_styles,
    persona_prefix_hint,
)

# Pipecat's runner accepts only a static ICE list, fixed at startup, but
# Cloudflare TURN credentials carry a TTL and must be minted per connection
# — hence the monkey-patch below.
#
# aiortc honors at most ONE STUN and ONE TURN server per connection and
# silently drops the rest, so ordering within each list matters. The
# frontend has no such limit and uses every URL Cloudflare returns.

CF_TURN_TTL_SEC = env_int("CLOUDFLARE_TURN_TTL_SEC", 3600)
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


def _prefer_turn_url(candidate: str, current: str) -> bool:
    """Whether ``candidate`` is a better TURN URL for us than ``current``.

    TCP wins over UDP, which is not the usual advice — UDP is the better
    media transport. It is about what Cloudflare will relay: measured
    between this host and a client on a UDP-blocked network, a TCP
    allocation delivers to a UDP one, but a UDP allocation never receives
    from a TCP one. Since the restricted clients are exactly the ones who
    need a relay, allocating over TCP is what lets their checks arrive.
    Both legs still run over Cloudflare's backbone.
    """
    return "transport=tcp" in candidate and "transport=tcp" not in current


def _resolve_ice_servers_for_aiortc() -> list[IceServer]:
    """Pick the single STUN + single TURN aiortc will actually use.

    aiortc keeps only the first STUN URL and first TURN URL it sees;
    this helper does that selection up-front so the log line is
    accurate and so we don't waste CPU constructing IceServer objects
    aiortc would discard.
    """
    out: list[IceServer] = []
    have_stun = False

    cf = _get_cloudflare_ice()
    if cf is not None:
        turn_entry: tuple[str, str | None, str | None] | None = None
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
                elif url.startswith(("turn:", "turns:")):
                    if turn_entry is None or _prefer_turn_url(url, turn_entry[0]):
                        turn_entry = (url, username, credential)
        if turn_entry is not None:
            url, username, credential = turn_entry
            out.append(IceServer(urls=url, username=username, credential=credential))
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


# Media never traverses Cloudflare's HTTP proxy, so the origin is only
# hidden if every candidate we advertise is a TURN relay. aiortc exposes no
# `iceTransportPolicy`, but aioice takes `transport_policy`, and
# `connection_kwargs` is the one function building its kwargs.
#
# RELAY alone is not enough: aioice gates only the host candidate on the
# policy (ice.py, "add host candidate") and appends the server-reflexive one
# regardless — and srflx is precisely the candidate carrying our public IP.
# Dropping the STUN server is what stops it being gathered at all.
_ORIGINAL_CONNECTION_KWARGS = rtcicetransport.connection_kwargs


def _patched_connection_kwargs(servers: list[Any]) -> dict[str, Any]:
    kwargs = _ORIGINAL_CONNECTION_KWARGS(servers)
    # No TURN means relay-only would gather nothing at all, so leave those
    # connections alone: a local dev run with no TURN still works on host
    # candidates, and a TURN outage degrades to exposed rather than dead.
    if "turn_server" in kwargs:
        kwargs["transport_policy"] = TransportPolicy.RELAY
        kwargs.pop("stun_server", None)
    return kwargs


rtcicetransport.connection_kwargs = _patched_connection_kwargs


# Browsers advertise their LAN, CGNAT, Tailscale and mDNS addresses alongside
# the routable ones. A relay-only connection asks the TURN server for a
# permission per remote candidate, and Cloudflare refuses the unroutable ones
# with a bare 401 — no NONCE, no REALM. aioice only re-authenticates when
# those attributes are present (turn.py, "update long-term credentials"), so
# it raises instead, and every later request on that allocation fails too:
# one junk candidate takes down the pair that would have worked. Measured on
# a viewer who never connected: 68 checks in progress, 0 succeeded.
#
# A relay cannot reach these addresses under any policy, so dropping them
# costs nothing and keeps the allocation healthy.
_ORIGINAL_ADD_REMOTE_CANDIDATE = IceConnection.add_remote_candidate


def _relay_can_reach(host: str) -> bool:
    """Whether a TURN relay could plausibly send to ``host``.

    ``False`` for anything not globally routable, and for mDNS names, which
    resolve only on the peer's own LAN.
    """
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return False


async def _patched_add_remote_candidate(self: Any, remote_candidate: Any) -> None:
    # `None` is the end-of-candidates signal and must always pass through.
    if (
        remote_candidate is not None
        and self._transport_policy == TransportPolicy.RELAY
        and not _relay_can_reach(remote_candidate.host)
    ):
        logger.debug(f"[WebRTC] Dropping unroutable remote candidate: {remote_candidate.host}")
        return
    await _ORIGINAL_ADD_REMOTE_CANDIDATE(self, remote_candidate)


IceConnection.add_remote_candidate = _patched_add_remote_candidate


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


# Pipecat exposes no bitrate knob, so OpusEncoder.__init__ is the only seam.
# Re-setting bit_rate after the original constructor runs is safe because
# PyAV's CodecContext lazy-opens on first encode and reads the bitrate then.
# Application mode stays "voip": better speech timbre than "audio" at equal
# bitrate, and it engages in-band FEC for lossy viewer connections.
#
# See audio_quality.py for where the per-session value comes from.
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

    Offloaded to a thread because the cache lookup is a sync httpx call
    that blocks ~100-300 ms whenever a fresh mint is needed.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _resolve_ice_response)


install_offer_middleware(pipecat_app)
install_memory_admin(pipecat_app)
image_generation.install_selfie_route(pipecat_app)

# Mounted here so it shares resolve_user_context's cache.
install_mcp(pipecat_app)

# Daemon thread: jieba's dict load is ~260ms of pure CPU, and on the event
# loop it stalls every in-progress call's audio. The greeting turn queries
# RAG, so warming lazily is too late.
threading.Thread(target=warm_tokenizer, name="jieba-warm", daemon=True).start()


# Pipecat's runner mounts PipecatPrebuiltUI at /client and redirects / to
# it, with no upstream toggle, so hiding it in production takes a
# middleware. Off by default: the demo page has no rate limit, no Workers
# integration, and no persona theming. Opt in with
# EIDOLON_PIPECAT_DEMO_ENABLED.
#
# Detecting dev via pipecat's own ENV=local does NOT work — its runner
# force-sets os.environ["ENV"] = "local" at import time, which fires the
# moment this module imports pipecat_app, production included.
#
# Pure ASGI rather than @pipecat_app.middleware("http") for the reason
# offer_middleware.py documents: the decorator form is BaseHTTPMiddleware.
_PIPECAT_DEMO_ENABLED = os.getenv("EIDOLON_PIPECAT_DEMO_ENABLED", "").strip().lower() in {
    "true",
    "1",
    "yes",
    "on",
}

_DEMO_PATHS = {"/", "/client"}


class BlockPipecatDemoMiddleware:
    """Pure-ASGI middleware: 404 the pipecat prebuilt demo in prod."""

    def __init__(self, app: ASGIApp, *, enabled: bool) -> None:
        self.app = app
        self.enabled = enabled

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or self.enabled:
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        if path in _DEMO_PATHS or path.startswith("/client/"):
            await send(
                {
                    "type": "http.response.start",
                    "status": 404,
                    "headers": [(b"content-length", b"0")],
                }
            )
            await send({"type": "http.response.body", "body": b"", "more_body": False})
            return
        await self.app(scope, receive, send)


pipecat_app.add_middleware(BlockPipecatDemoMiddleware, enabled=_PIPECAT_DEMO_ENABLED)


from . import mem0_local

# All three RAG/memory services are optional — the bot runs without the
# `mem0` extra, without OPENAI_API_KEY for embeddings, and on a fresh
# checkout where the LanceDB indexes haven't been built.
try:
    from .memory_service import LaplaceMem0MemoryService as Mem0MemoryService
except Exception as e:
    Mem0MemoryService = None
    logger.debug(f"Mem0 service unavailable: {e}")

try:
    from .stream_archive import StreamArchiveService
except Exception as e:
    StreamArchiveService = None
    logger.debug(f"StreamArchive service unavailable: {e}")

try:
    from .persona_facts import PersonaFactsService
except Exception as e:
    PersonaFactsService = None
    logger.debug(f"PersonaFacts service unavailable: {e}")

# TWO parents: this file is <repo>/laplace_eidolon/bot.py and the persona
# pack lives at the repo root. Walking up only one lands in the package dir,
# where the bot silently falls back to its stub persona with RAG disabled.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PERSONA_ID = os.getenv("EIDOLON_PERSONA") or "milky-green"
PERSONA_PATH = PROJECT_ROOT / (os.getenv("PERSONA_FILE") or f"personas/{PERSONA_ID}/prompt.md")
LANCEDB_PATH = resolve_db_path()


def _optional_rag(service_cls, label: str, ingest_cmd: str):
    """Build a RAG FrameProcessor, or None when its index isn't there."""
    if service_cls is None:
        return None
    if not LANCEDB_PATH.exists():
        logger.info(
            f"{label} disabled: no LanceDB index at {LANCEDB_PATH}. "
            f"Run `uv run {ingest_cmd}` to build it."
        )
        return None
    try:
        return service_cls(db_path=LANCEDB_PATH)
    except Exception as e:
        logger.warning(f"{label} disabled: {e}")
        return None

# Asia/Shanghai because the persona is 虚拟上海; forks override with
# PERSONA_TIMEZONE. The UTC fallback keeps a missing tzdata (slim
# containers, Windows without the `tzdata` package) from failing import
# outright — a wrong clock beats a bot that won't start.
try:
    PERSONA_TZ = ZoneInfo(os.getenv("PERSONA_TIMEZONE") or "Asia/Shanghai")
except ZoneInfoNotFoundError as e:
    logger.warning(
        f"PERSONA_TIMEZONE invalid or tzdata missing ({e}); falling back to UTC. "
        "On Windows or slim Docker images, install the `tzdata` package."
    )
    PERSONA_TZ = ZoneInfo("UTC")

_WEEKDAY_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# Five dates covers the usual "你最近播了几场?" / "你这周播了吗?" questions
# without bloating the prompt; raise to 7-10 for a full weekly calendar.
RECENT_STREAM_DATES_N = 5

# Coarse, since re-ingest is infrequent — but short enough that a new
# stream shows up without a restart.
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

    Injected into the system prompt because recency questions like
    "你最后一次直播什么时候?" ask about table metadata, not about any
    fact inside a chunk — retrieval cannot answer them at all.

    Falls back to the previous cache on refresh failure: a stale date
    list beats the LLM guessing.
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
            # Local import: lancedb is heavy, and a fresh checkout with no
            # data/lancedb should still boot.
            from .embeddings import open_table
            from .stream_archive import DEFAULT_TABLE as STREAM_TABLE

            table = open_table(LANCEDB_PATH, STREAM_TABLE)
            if table is None:
                _recent_stream_dates_cache = []
                _recent_stream_dates_cached_at = now
                return []
            # LanceDB has no DISTINCT, so dedupe in Python. A columnar scan
            # of one narrow column over ~30k rows is 10-30 ms, once per TTL.
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


def _build_persona_prefix(
    user: UserContext,
    *,
    voice_styles: dict[str, str] | None = None,
    selfie: bool = False,
) -> str:
    """Per-session preamble prepended to ``persona.md``: current date/time,
    viewer name, recent stream dates, available voice styles.

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

    # Omitted entirely when no archive is built, so a fresh checkout
    # doesn't get a stray empty section.
    recent = _get_recent_stream_dates()
    if recent:
        formatted: list[str] = []
        for iso in recent:
            try:
                d = date.fromisoformat(iso)
            except ValueError:
                continue
            ago = _humanize_days_ago((today - d).days)
            # "5月9号", not "2026年5月9号" — how a fan would actually say it
            # when both sides know the year.
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

    if voice_styles:
        voice_line = persona_prefix_hint(voice_styles)
        if voice_line:
            lines.append(voice_line)

    if selfie:
        lines.append(image_generation.persona_prefix_hint())

    return "\n".join(lines) + "\n\n"


class LaplaceRTVIProcessor(RTVIProcessor):
    """RTVIProcessor that brands the bot-ready ``about`` payload as ours."""

    # Written by apps/bot/scripts/sync-version.ts on each release.
    _DEFAULT_ABOUT = {
        "library": "laplace-eidolon",
        "library_version": "0.7.0",
    }

    async def set_bot_ready(self, about=None):
        await super().set_bot_ready(about=about or self._DEFAULT_ABOUT)


class LaplaceFishTTSService(FishAudioTTSService):
    """FishAudioTTSService whose socket accepts a long sentence's audio."""

    # With latency="normal" Fish returns a long sentence's audio as a few large
    # messages, and Pipecat opens the socket with websockets' default 1 MiB
    # max_size — about 12 s of 44.1 kHz audio. A bigger message closes the
    # socket with 1009 (message too big) and its sentence is never heard.
    # Drop this once https://github.com/pipecat-ai/pipecat/pull/6217 ships.
    async def _websocket_connect(self, uri: str, **kwargs: Any):
        kwargs.setdefault("max_size", 16 * 1024 * 1024)
        return await super()._websocket_connect(uri, **kwargs)


async def run_bot(transport: BaseTransport, login_sync_token: str | None = None):
    """Main bot logic.

    Args:
        login_sync_token: ``None`` for anonymous viewers. Revalidated here
            rather than trusted from the middleware, which only checked
            that a token was present.
    """
    logger.info("Starting bot")

    # Identity gates two pipeline decisions: whether Mem0 runs at all, and
    # what prefix goes on the persona prompt. Fail-open — a Workers outage
    # yields is_logged_in == False and the viewer proceeds anonymously.
    user = await resolve_user_context(login_sync_token)

    soniox_api_key = os.getenv("SONIOX_API_KEY")
    if not soniox_api_key:
        raise RuntimeError("SONIOX_API_KEY environment variable is required")

    stt = SonioxSTTService(
        api_key=soniox_api_key,
        settings=SonioxSTTService.Settings(
            model=os.getenv("SONIOX_MODEL") or "stt-rt-v5",
        ),
    )

    fish_api_key = os.getenv("FISH_API_KEY")
    if not fish_api_key:
        raise RuntimeError("FISH_API_KEY environment variable is required")

    # Read once so the prompt hint and the registered handler are built
    # from the same dict.
    voice_styles = load_voice_styles()

    # latency="normal" is Fish's best-quality mode. Pipecat defaults to
    # "balanced", which shaves ~50-100 ms TTFB at an audible cost — the wrong
    # trade when the voice is the product.
    #
    # Pipecat can't reach prosody.normalize_loudness, chunk_length,
    # repetition_penalty, condition_on_previous_chunks, or min_chunk_length
    # without a subclass that injects them into the start message. Revisit if
    # the voice clips, drifts across turns, or repeats artifacts.
    tts = LaplaceFishTTSService(
        api_key=fish_api_key,
        sample_rate=44100,
        # Allow slow first audio; Pipecat also uses this timeout for trailing audio idle.
        # https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/services/tts_service.py
        stop_frame_timeout_s=15.0,
        settings=FishAudioTTSService.Settings(
            voice=os.getenv("FISH_VOICE_ID"),
            model=os.getenv("FISH_MODEL") or "drama-3",
            latency="normal",
            # Fish's EN/ZH number normalization is on server-side by default,
            # but it reads years badly (2026 as a cardinal, not "二零二六").
            normalize=False,
        ),
    )

    # Off-loop: on a TTL miss this scans stream_date across every chunk row
    # (~65ms cold) and reads persona.md, both of which would otherwise stall
    # audio for every other in-progress call.
    selfie_enabled = image_generation.is_configured()
    system_instruction = await asyncio.to_thread(
        lambda: _build_persona_prefix(user, voice_styles=voice_styles, selfie=selfie_enabled)
        + load_persona()
    )
    llm = OpenRouterLLMService(
        api_key=os.getenv("OPENROUTER_API_KEY"),
        settings=OpenRouterLLMService.Settings(
            model=os.getenv("OPENROUTER_MODEL") or "~google/gemini-flash-latest",
            system_instruction=system_instruction,
        ),
        default_headers=openrouter_headers(),
    )

    tools = install_voice_style_tool(llm=llm, tts=tts, styles=voice_styles)
    # Before the archive: its install_tool snapshots the schema list, and on a
    # second recall in one turn it resets the context to that snapshot. A tool
    # registered after it would be dropped for the rest of the session.
    tools = image_generation.install_selfie_tool(llm=llm, tools=tools)
    archive = _optional_rag(
        StreamArchiveService, "Stream archive", "laplace-ingest-streams"
    )
    if archive is not None:
        tools = archive.install_tool(llm, tools)

    context = LLMContext(tools=tools) if tools else LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
            # Sent when a turn that cut the bot off ends with no transcript (a cough,
            # noise, speech Soniox couldn't make out). Pipecat's own wording is English.
            empty_user_turn=EmptyUserTurnConfig(
                interrupted_prompt=(
                    "你刚才说话的时候，好像说了句什么，但没听清。"
                    "你的话在那儿被打断了，对话里只留下ta听到的部分，也可能一句都没听到。"
                    "用一句话自然地请ta再说一遍；"
                    "如果你刚才问了问题，ta可能没听到，就顺带再问一次。"
                ),
            ),
        ),
    )

    # Keyed on Bilibili UID. Anonymous viewers skip Mem0 rather than share a
    # `default-user` bucket, where their memories would cross-pollute every
    # other anonymous conversation.
    memory = None
    mem0_enabled = mem0_local.is_configured()
    if not user.is_logged_in:
        logger.info("Mem0 skipped: anonymous viewer (no loginSyncToken / validation failed)")
    elif mem0_enabled and Mem0MemoryService is not None:
        try:
            memory = Mem0MemoryService(
                local_config=mem0_local.build_local_config(),
                user_id=str(user.mid),
                agent_id=os.getenv("MEM0_AGENT_ID") or None,
                run_id=os.getenv("MEM0_RUN_ID") or None,
                params=Mem0MemoryService.InputParams(
                    search_limit=env_int("MEM0_SEARCH_LIMIT", 10),
                    search_threshold=env_float("MEM0_SEARCH_THRESHOLD", 0.3),
                ),
            )
            logger.info(f"Mem0 long-term memory enabled for user_id={user.mid} ({user.uname!r})")
        except Exception as e:
            # Constructing the engine reaches Qdrant to create the collection,
            # so an unreachable vector store surfaces here rather than at boot.
            logger.warning(f"Mem0 unavailable, continuing without memory: {e}")
    elif mem0_enabled and Mem0MemoryService is None:
        logger.warning(
            "MEM0_QDRANT_HOST is set but pipecat-ai[mem0] is not installed; skipping memory"
        )
    else:
        logger.info("Mem0 skipped: MEM0_QDRANT_HOST is unset, so there is no vector store")

    facts = _optional_rag(PersonaFactsService, "Persona facts", "laplace-ingest-facts")
    gate = retrieval_gate.from_env() if archive is not None or facts is not None else None

    # The gate's decision and archive recaps reach the RAG services through
    # frame metadata; the gate goes first so its call overlaps Mem0's search.
    processors = [
        transport.input(),
        stt,
        user_aggregator,
        *(p for p in (gate, memory, archive, facts) if p is not None),
        llm,
        tts,
        transport.output(),
        assistant_aggregator,
    ]

    pipeline = Pipeline(processors)

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        observers=[],
        rtvi_processor=LaplaceRTVIProcessor(),
    )

    @worker.rtvi.event_handler("on_client_ready")
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
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


def _extract_login_sync_token(body: Any) -> str | None:
    """Pull ``loginSyncToken`` out of the parsed ``requestData`` body."""
    if not isinstance(body, dict):
        return None
    token = body.get("loginSyncToken")
    if isinstance(token, str) and token.strip():
        return token.strip()
    return None


async def bot(runner_args: RunnerArguments):
    """Main bot entry point.

    SmallWebRTC only, since this self-hosts. A non-WebRTC connection
    reaching here means the runner is misconfigured.
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

    # runner_args.body is the inner requestData dict, not the full envelope,
    # because offer_middleware rewrote the key before pipecat's route parsed
    # it. None for anonymous viewers.
    login_sync_token = _extract_login_sync_token(runner_args.body)
    # Logged either way: the "anonymous everywhere" failure mode is
    # otherwise silent, and this makes it one grep.
    if login_sync_token:
        logger.info(f"[bot] Session start with loginSyncToken (len={len(login_sync_token)})")
    else:
        logger.info(
            f"[bot] Session start without loginSyncToken; runner_args.body={runner_args.body!r}"
        )
    await run_bot(transport, login_sync_token=login_sync_token)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
