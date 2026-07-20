"""Runtime voice-style switching for Fish Audio TTS.

When the viewer asks for a different style — "温柔一点", "换个活泼的声音",
"换回原来的" — the LLM calls ``change_voice_style``. The handler maps the
named style to a Fish Audio ``reference_id`` from env and pushes a
``TTSUpdateSettingsFrame``, so the next response is spoken in the new
voice without dropping the WebRTC session.

Nothing is registered with the LLM unless at least one alternative
``FISH_VOICE_ID_<STYLE>`` is configured.
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

# Reserved for ``FISH_VOICE_ID``, the persona's "real" voice. The LLM
# passes this value to swap back ("换回原来的声音").
DEFAULT_STYLE = "default"

# ``FISH_VOICE_ID_GENTLE`` becomes style ``gentle``; ``FISH_VOICE_ID_NAI_HEI``
# becomes ``nai_hei``.
_PREFIX = "FISH_VOICE_ID_"

# Keep stable — persona prompts hardcode this name, so a rename has to
# land in both places at once.
_TOOL_NAME = "change_voice_style"

# Chinese trigger phrases, injected into the schema's parameter
# description so the LLM can map an utterance to an enum value. A style
# with no entry here still works; the LLM infers from the bare name.
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

    A blank ``FISH_VOICE_ID_GENTLE=`` counts as "not configured" rather
    than as an empty voice id.
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

    ``enum`` is restricted to configured styles, so the model can't ask
    for a voice that isn't wired up.
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

        # Must be queued before result_callback: both go through the LLM
        # service's downstream queue, so FIFO gets the new voice to TTS
        # ahead of the first text token of its acknowledgment.
        # ``service=tts`` guards a future pipeline that fans out to more
        # than one TTS service.
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
    llm: LLMService[Any],
    tts: FishAudioTTSService,
    styles: dict[str, str] | None = None,
) -> ToolsSchema | None:
    """Register the voice-switching tool and return its ToolsSchema.

    The caller must pass the returned schema into ``LLMContext(tools=...)``
    or ``context.set_tools(...)``; registering the handler alone never
    tells the model the tool exists. ``None`` when only ``default`` is
    configured — a one-value enum wastes tokens and draws spurious no-op
    calls, so nothing is registered at all.
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

    Empty when no alternatives are configured, so the prefix builder can
    call this unconditionally without growing the prompt.
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


TOOL_NAME = _TOOL_NAME


__all__ = [
    "DEFAULT_STYLE",
    "TOOL_NAME",
    "alternative_style_names",
    "install_voice_style_tool",
    "load_voice_styles",
    "persona_prefix_hint",
]
