"""Per-session Opus bitrate selection from a frontend ``audioQuality`` knob.

The frontend can include ``audioQuality`` in the WebRTC offer's
``requestData`` (alongside ``loginSyncToken``) to pick a preset:

    requestData: { audioQuality: "best" | "medium" | "low" | "lowest", … }

We map that string to an Opus bitrate (kept in ``QUALITY_PRESETS_BPS``)
and stash it on a :class:`contextvars.ContextVar` *before* pipecat's
``/api/offer`` route handler runs (see ``offer_middleware.py``). When
aiortc later constructs the per-RTCRtpSender ``OpusEncoder`` (lazily,
on the first outbound frame), the patched ``__init__`` in ``bot.py``
reads the contextvar and pins ``codec.bit_rate`` to the chosen preset.

Why a ContextVar (and not e.g. a ``{pc_id: bitrate}`` map)
---------------------------------------------------------
The encoder is constructed inside ``RTCRtpSender._next_encoded_frame``
in a task tree spawned from ``setLocalDescription`` →
``RTCPeerConnection.__connect`` → ``RTCRtpSender.send`` (each link is an
``asyncio.ensure_future`` that captures the current ``copy_context``).
That whole tree inherits the request-handler context, so a contextvar
set in our offer middleware is naturally visible at encoder
construction time without threading the value through pipecat.

Trade-off: an existing ``SmallWebRTCConnection`` that's renegotiated
re-uses its encoder, so an ``audioQuality`` change on a follow-up offer
doesn't take effect mid-session. For a quality switch the viewer must
hang up and reconnect — acceptable because the typical use case is
"my connection is bad, let me start a low-bitrate call", not "switch
mid-call". The first offer of a session always picks the right preset.

Backward compatibility
----------------------
When the frontend sends nothing (or an unrecognized value), the
encoder falls back to ``DEFAULT_BITRATE_BPS`` — which is still the
legacy ``EIDOLON_OPUS_BITRATE_BPS`` env var (default 128 kbps). Older
JS clients that don't know about ``audioQuality`` keep behaving
exactly as before.
"""

from __future__ import annotations

import contextvars
import os
from typing import Any, Final

# Built-in presets, in decreasing order of bandwidth. Numbers are based
# on the IETF Opus draft + aiortc's own historical default (96 kbps for
# voice). Each preset is independently overridable via env so an
# operator can re-tune without touching code:
#
#   best     192 kbps  Headroom above the speech-transparency knee for
#                       a voice-first persona where vocal texture
#                       (breaths, sibilants, laughs) really matters.
#   medium    96 kbps  aiortc's pre-patch default. Transparent for speech
#                       on a stable connection.
#   low       64 kbps  Toll-quality voice. Comfortable on mobile/3G.
#   lowest     8 kbps  Opus narrowband floor — heavy artifacts but still
#                       intelligible. Reserved for genuinely awful
#                       connections where the alternative is a dropped
#                       call. Below ~16 kbps Opus loses wideband, so
#                       the persona's voice timbre will sound noticeably
#                       compressed.
#
# `or "<default>"` (not getenv's default) so an empty `.env` entry —
# exactly what `cp .env.example .env` produces — falls through to the
# default instead of crashing `int("")`.
QUALITY_PRESETS_BPS: Final[dict[str, int]] = {
    "best": int(os.getenv("EIDOLON_OPUS_BITRATE_BEST_BPS") or "192000"),
    "medium": int(os.getenv("EIDOLON_OPUS_BITRATE_MEDIUM_BPS") or "96000"),
    "low": int(os.getenv("EIDOLON_OPUS_BITRATE_LOW_BPS") or "64000"),
    "lowest": int(os.getenv("EIDOLON_OPUS_BITRATE_LOWEST_BPS") or "8000"),
}

# Fallback when the offer body has no ``audioQuality`` (or the value is
# invalid). Aligned with the ``medium`` preset (96 kbps) so a viewer
# whose client doesn't pass the field gets the same audio as one who
# explicitly chose ``medium`` — no surprise tier between the four
# presets. Coincidentally this matches aiortc's own historical default
# (``OpusEncoder.codec.bit_rate = 96000``) so we're back to a value
# the upstream library considers transparent for speech.
#
# Operators who want a different fallback (e.g. always pick ``best``,
# or pin to a non-preset bitrate for a low-bandwidth deployment) can
# still override via ``EIDOLON_OPUS_BITRATE_BPS``. Practical range
# 32000–256000.
DEFAULT_BITRATE_BPS: Final[int] = int(os.getenv("EIDOLON_OPUS_BITRATE_BPS") or "96000")

# Per-session bitrate. Set by the offer middleware after parsing
# ``requestData.audioQuality``; read by the patched ``OpusEncoder.__init__``
# in ``bot.py``. Default is the operator-level fallback above so that
# encoders constructed *outside* a request context (shouldn't happen,
# but cheap insurance) still get a sensible bitrate instead of zero.
session_bitrate_bps: contextvars.ContextVar[int] = contextvars.ContextVar(
    "eidolon_session_bitrate_bps",
    default=DEFAULT_BITRATE_BPS,
)


def resolve_quality_bitrate(quality: Any) -> int | None:
    """Map an ``audioQuality`` value from the offer body to a bitrate.

    Args:
        quality: Whatever the frontend put under ``requestData.audioQuality``.
            Typically a string but defensively typed since the body is
            user-controlled.

    Returns:
        The bitrate in bps for a known preset, or ``None`` for any
        invalid input (non-string, empty string, unknown preset name).
        ``None`` signals to the caller "fall back to
        :data:`DEFAULT_BITRATE_BPS` and warn"; we deliberately don't
        silently accept arbitrary integers here because letting the
        frontend pick raw bitrates lets a misbehaving client pin 1 Mbps
        per session and saturate uplink.
    """
    if not isinstance(quality, str):
        return None
    return QUALITY_PRESETS_BPS.get(quality.strip().lower())


def quality_choices() -> list[str]:
    """Return the preset names accepted by :func:`resolve_quality_bitrate`.

    Useful for log messages and error responses so the frontend (and
    log readers) can see the canonical set in one place. Order matches
    :data:`QUALITY_PRESETS_BPS`, i.e. best → lowest.
    """
    return list(QUALITY_PRESETS_BPS.keys())
