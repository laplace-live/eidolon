"""Per-session Opus bitrate selection from a frontend ``audioQuality`` knob.

The frontend puts ``audioQuality`` (``best`` / ``medium`` / ``low`` /
``lowest``) in the WebRTC offer's ``requestData``; ``offer_middleware``
resolves it to a bitrate and sets ``session_bitrate_bps`` before pipecat's
``/api/offer`` handler runs. aiortc constructs the ``OpusEncoder`` lazily,
inside a task tree that inherits that context, so the patched ``__init__``
in ``bot.py`` reads the value with nothing threaded through pipecat.

A renegotiated ``SmallWebRTCConnection`` reuses its encoder, so changing
``audioQuality`` mid-session has no effect — the viewer must reconnect.
"""

from __future__ import annotations

import contextvars
from typing import Any, Final

from .env import env_int

# Presets in decreasing order of bandwidth. ``lowest`` sits under Opus's
# ~16 kbps wideband floor: still intelligible, but the persona's timbre
# audibly degrades. It's for connections where the alternative is a
# dropped call.
QUALITY_PRESETS_BPS: Final[dict[str, int]] = {
    "best": env_int("EIDOLON_OPUS_BITRATE_BEST_BPS", 192000),
    "medium": env_int("EIDOLON_OPUS_BITRATE_MEDIUM_BPS", 96000),
    "low": env_int("EIDOLON_OPUS_BITRATE_LOW_BPS", 64000),
    "lowest": env_int("EIDOLON_OPUS_BITRATE_LOWEST_BPS", 8000),
}

# Fallback when the offer body has no usable ``audioQuality``. Defaults to
# the ``medium`` preset — including any override of it — so a client that
# omits the field encodes identically to one that asks for ``medium``.
DEFAULT_BITRATE_BPS: Final[int] = env_int(
    "EIDOLON_OPUS_BITRATE_BPS", QUALITY_PRESETS_BPS["medium"]
)

# Defaulted so an encoder built outside any request context still gets a
# sane bitrate rather than zero.
session_bitrate_bps: contextvars.ContextVar[int] = contextvars.ContextVar(
    "eidolon_session_bitrate_bps",
    default=DEFAULT_BITRATE_BPS,
)


def resolve_quality_bitrate(quality: Any) -> int | None:
    """Map an ``audioQuality`` value from the offer body to a bitrate.

    ``None`` for anything that isn't a known preset name — the body is
    user-controlled, so non-strings arrive here too.
    """
    if not isinstance(quality, str):
        return None
    return QUALITY_PRESETS_BPS.get(quality.strip().lower())


def quality_choices() -> list[str]:
    """Preset names accepted by ``resolve_quality_bitrate``, best → lowest."""
    return list(QUALITY_PRESETS_BPS.keys())
