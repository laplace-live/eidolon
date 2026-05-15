"""Runtime voice-style switching for Fish Audio TTS.

When the viewer asks the bot to talk in a different style — "温柔一点",
"换个活泼的声音", "换回原来的" — an LLM tool call routes that intent
through here. Each named style maps to a Fish Audio ``reference_id``
configured via env; the handler pushes a :class:`TTSUpdateSettingsFrame`
so the next response is spoken in the new voice without dropping the
WebRTC session.

Why function-calling and not STT keyword matching
-------------------------------------------------
Open-ended intents ("声音温柔一点", "换个温柔点的声音", "可以柔一点吗",
"换回原来那个声音") share the same goal but no shared substring. A regex
list would need constant tending and still miss the long tail. The LLM
already does this classification for free: it reads the user message,
emits ``change_voice_style(style="gentle")`` when appropriate, and
generates a natural follow-up acknowledgment in the new voice.

Configuration
-------------
Voices come from env vars::

    FISH_VOICE_ID=...               # default voice (the one in persona.md)
    FISH_VOICE_ID_GENTLE=...        # picked when user asks for 温柔/轻柔
    FISH_VOICE_ID_LIVELY=...        # picked when user asks for 活泼/精神/营业声线

The suffix is lowercased into the style name. ``default`` is reserved
for ``FISH_VOICE_ID`` itself — the LLM uses it to switch back. The tool
no-ops (and isn't registered with the LLM at all) when no alternative
``FISH_VOICE_ID_*`` is configured, so a fresh ``.env`` with only the
required ``FISH_VOICE_ID`` behaves bit-for-bit like before this feature.

Frame ordering
--------------
The handler runs inside the LLM service's tool-dispatch task. It calls
``params.llm.push_frame(TTSUpdateSettingsFrame(...))`` and *then*
``params.result_callback(...)``. Both pushes go through the LLM
service's downstream queue: the settings frame is queued first, the
follow-up ``LLMTextFrame`` (generated after the result is fed back to
the model) is queued second. So the FIFO guarantee means TTS reconnects
with the new voice *before* it sees the first text token of the
acknowledgment. Targeting via ``service=tts`` is defensive against a
future pipeline that fans out to multiple TTS services.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import TTSUpdateSettingsFrame
from pipecat.services.fish.tts import FishAudioTTSService
from pipecat.services.llm_service import FunctionCallParams, LLMService

# Style name reserved for ``FISH_VOICE_ID`` (the persona's "real" voice).
# The LLM uses this value to swap back when asked ("换回原来的声音").
DEFAULT_STYLE = "default"

# Env prefix for alternative voices. ``FISH_VOICE_ID_GENTLE`` becomes
# style ``gentle``; ``FISH_VOICE_ID_NAI_HEI`` becomes ``nai_hei``.
_PREFIX = "FISH_VOICE_ID_"

# Tool name that the LLM will see and call. Keep it stable — changing it
# would require simultaneous edits to persona prompts that hardcode the
# name.
_TOOL_NAME = "change_voice_style"

# Human-readable trigger phrases for each style. Used to enrich the JSON
# schema parameter description so the LLM picks the right enum value
# from a Chinese voice utterance. Add an entry when you add a new
# ``FISH_VOICE_ID_<STYLE>`` env var; styles without an entry still work
# (the LLM falls back to inferring from the bare style name).
_STYLE_HINTS: dict[str, str] = {
    "default": "默认/原来的/正常的声音",
    "gentle": "温柔/温和/轻柔/温暖/柔一点",
    "lively": "活泼/精神/有活力/欢快/明亮/营业声线",
    "calm": "平静/冷静/沉稳",
    "sweet": "甜美/可爱/软糯",
    "playful": "俏皮/调皮/调侃",
}


def load_voice_styles() -> dict[str, str]:
    """Return ``{style_name: reference_id}`` for every configured voice.

    Always includes ``default`` when ``FISH_VOICE_ID`` is set (which the
    bot already requires to boot, so this is effectively always
    populated). Each ``FISH_VOICE_ID_<STYLE>`` adds another entry keyed
    on the lowercased suffix. Empty env values are skipped — a blank
    ``FISH_VOICE_ID_GENTLE=`` in ``.env`` is treated as "not configured"
    rather than as a literal empty voice id.
    """
    styles: dict[str, str] = {}
    default = (os.getenv("FISH_VOICE_ID") or "").strip()
    if default:
        styles[DEFAULT_STYLE] = default
    for key, value in os.environ.items():
        if not key.startswith(_PREFIX):
            continue
        cleaned = (value or "").strip()
        if not cleaned:
            continue
        suffix = key[len(_PREFIX) :].lower()
        if not suffix:
            continue
        styles[suffix] = cleaned
    return styles


def alternative_style_names(styles: dict[str, str]) -> list[str]:
    """Sorted list of non-default style names."""
    return sorted(s for s in styles if s != DEFAULT_STYLE)


def _build_schema(styles: dict[str, str]) -> FunctionSchema:
    """Build the OpenAI-compatible FunctionSchema visible to the LLM.

    The ``style`` parameter is constrained to the actually-configured
    styles via the ``enum`` field, so the model can't request a voice
    that isn't wired up. The description embeds Chinese trigger
    phrases for each style so the LLM has a clean mapping from natural
    utterance ("温柔一点") to schema value ("gentle").
    """
    enum_values = sorted(styles.keys())
    hint_parts = [f"`{s}` ({_STYLE_HINTS.get(s, s)})" for s in enum_values]
    param_description = "声线名称。" + "; ".join(hint_parts) + "。"
    description = (
        "切换主播声线风格。**只在奶糖花明确要求换声音时调用** —— "
        "例如『声音温柔一点』『换个活泼的』『换回原来的声音』。"
        "不要主动切换，不要在打招呼时切换；只在用户表达想换声音时调用。"
        "切换后用一两句话自然回应（『嗯，这样可以嘛』），不要照念工具名。"
    )
    return FunctionSchema(
        name=_TOOL_NAME,
        description=description,
        properties={
            "style": {
                "type": "string",
                "description": param_description,
                "enum": enum_values,
            }
        },
        required=["style"],
    )


def _make_handler(
    *,
    tts: FishAudioTTSService,
    styles: dict[str, str],
) -> Callable[[FunctionCallParams], Awaitable[None]]:
    """Closure that handles a ``change_voice_style`` tool call."""

    async def handler(params: FunctionCallParams) -> None:
        raw = params.arguments.get("style")
        style = (str(raw).strip().lower() if raw is not None else "")
        voice_id = styles.get(style)
        if not voice_id:
            logger.warning(
                f"[voice] LLM requested unknown style {raw!r}; "
                f"configured: {sorted(styles)}"
            )
            await params.result_callback(
                {
                    "ok": False,
                    "error": f"unknown style {raw!r}",
                    "available": sorted(styles),
                }
            )
            return

        # Push downstream from the LLM service so the frame reaches TTS
        # before the LLM's follow-up text. ``service=tts`` is defensive:
        # if a future pipeline ever fans out to multiple TTS services
        # (e.g. a recorder branch), the targeting prevents the recorder
        # from reconnecting alongside the live voice.
        logger.info(
            f"[voice] Switching style → {style!r} "
            f"(reference_id={voice_id[:8]}…)"
        )
        await params.llm.push_frame(
            TTSUpdateSettingsFrame(
                delta=FishAudioTTSService.Settings(voice=voice_id),
                service=tts,
            )
        )
        await params.result_callback({"ok": True, "style": style})

    return handler


def install_voice_style_tool(
    *,
    llm: LLMService,
    tts: FishAudioTTSService,
    styles: dict[str, str] | None = None,
) -> ToolsSchema | None:
    """Register the voice-switching tool and return its ToolsSchema.

    The caller must pass the returned schema into ``LLMContext(tools=...)``
    (or ``context.set_tools(...)``) so the LLM is actually told the tool
    exists. Returns ``None`` when only ``default`` (or nothing) is
    configured — in that case nothing is registered and the bot behaves
    as if this feature didn't exist. That's deliberate: telling the
    model about a tool with only one valid value would waste tokens and
    occasionally trigger spurious no-op calls.
    """
    styles = styles if styles is not None else load_voice_styles()
    alts = alternative_style_names(styles)
    if not alts:
        logger.info(
            "[voice] Voice switching disabled "
            "(no FISH_VOICE_ID_<STYLE> env vars set)."
        )
        return None

    schema = _build_schema(styles)
    handler = _make_handler(tts=tts, styles=styles)
    llm.register_function(_TOOL_NAME, handler)
    logger.info(
        f"[voice] Voice switching enabled. "
        f"Default={DEFAULT_STYLE!r}, alternatives={alts}."
    )
    return ToolsSchema(standard_tools=[schema])


def persona_prefix_hint(styles: dict[str, str]) -> str:
    """One-line system-prompt hint about the voice-switching tool.

    Returned empty when no alternatives are configured, so the prefix
    builder can unconditionally call this without growing the prompt on
    a bare ``.env``. Mentions ``default`` as a valid value so the LLM
    knows how to switch back when asked.
    """
    alts = alternative_style_names(styles)
    if not alts:
        return ""
    enum_values = [DEFAULT_STYLE, *alts]
    return (
        "如果奶糖花明确要求换声音（『温柔一点』『换个声音』『换回原来的』之类），"
        f"调用 {_TOOL_NAME} 工具，参数 style 可选："
        + "、".join(enum_values)
        + "。不要主动切换；平时保持默认声线。"
    )


# Public re-export for callers that want to inspect the tool name (e.g.
# tests or future telemetry). Keep this stable.
TOOL_NAME = _TOOL_NAME


__all__ = [
    "DEFAULT_STYLE",
    "TOOL_NAME",
    "alternative_style_names",
    "install_voice_style_tool",
    "load_voice_styles",
    "persona_prefix_hint",
]
