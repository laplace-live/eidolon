"""Selfies — OpenRouter's image route behind a Pipecat ``ImageGenService``.

``POST /api/v1/images`` is not chat completions and has no OpenAI SDK
binding: reference images go in ``input_references`` and results come back
as raw base64 in ``data[].b64_json``, not as data URLs.

``ImageGenService`` generates from every ``TextFrame`` it sees, which here
would be every sentence on its way to TTS, so the service stays out of the
pipeline; ``install_selfie_tool`` drives ``run_image_gen`` from a
``take_selfie`` function call instead. The bytes are then served over HTTP
and only the URL rides the RTVI data channel — an inline base64 image runs
to megabytes, past what one SCTP message will carry.
"""

from __future__ import annotations

import base64
import io
import mimetypes
import os
import secrets
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from fastapi import FastAPI
from fastapi.responses import Response
from loguru import logger
from PIL import Image
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import ErrorFrame, Frame, URLImageRawFrame
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
from pipecat.services.image_service import ImageGenService
from pipecat.services.llm_service import FunctionCallParams, LLMService
from pipecat.services.settings import ImageGenSettings

from .env import env_int
from .openrouter import extract_cost_usd, openrouter_headers

API_URL = "https://openrouter.ai/api/v1/images"
DEFAULT_MODEL = "openai/gpt-image-2.5-flare"

ASPECT_RATIOS = ("auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9")
QUALITIES = ("auto", "low", "medium", "high", "xhigh", "max")
MAX_REFERENCES = 16
MAX_IMAGES = 10

# A max-quality render runs for minutes; httpx otherwise gives up after its
# 5s default read timeout. The bot bounds itself far lower, via timeout_secs.
TIMEOUT = httpx.Timeout(600.0, connect=10.0)

SUFFIXES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}

# Keep stable — the persona prompt names this tool, so a rename has to land
# in both places at once.
_TOOL_NAME = "take_selfie"

SELFIE_PATH = "/api/selfie"

# Resolved against the repo root rather than the working directory, like
# resolve_db_path, so any launcher finds it. The Dockerfile COPYs data/ whole,
# so what ships in here is what a deployment uses.
BUNDLED_REFERENCES = Path(__file__).resolve().parent.parent / "data" / "selfie-references"

# Two directories, two rules: one of ``outfits/`` is the persona, and every
# ``friends/`` image is a different person.
OUTFITS = BUNDLED_REFERENCES / "outfits"
FRIENDS = BUNDLED_REFERENCES / "friends"

SELFIE_PROMPT = """\
Turn the reference character into a casual selfie, drawn in classic 2D anime
style.

Keep unchanged: the character's face, hairstyle, hair color, eye color, and
outfit design. The result has to read as the same character, not a lookalike.
{company}
Framing: a phone selfie held at arm's length — camera slightly above eye
level, head and shoulders filling the frame, eyes on the lens, relaxed
natural smile.

Render: hand-drawn 2D anime, the look of a traditional cel animation frame.
Crisp inked outlines of varying weight, flat color fills, hard-edged two-tone
cel shading, glossy block highlights in the hair, classic anime eyes. No 3D,
no photorealism, no physically based materials, no rendered textures.

Time: it is {time}. The light, the shadows, and the sky have to read as that
hour.

Light: {light}, drawn as simple cel shadow shapes from one clear direction,
over {setting}.

No text, watermarks, logos, UI overlays, or anyone beyond the people
described above.
"""

_INDOORS = "a softly painted, uncluttered indoor background"
_OUTDOORS = (
    "a softly painted outdoor background in virtual Shanghai — a street, a park,"
    " a coffee shop, wherever the group would be"
)

# (first local hour, what to call it, how it's lit indoors, how it's lit
# outdoors). Ordered; hours before the first boundary wrap back to the last row.
_AMBIENCE = (
    (5, "early morning",
     "cool pale sunrise light slanting in through the window",
     "cool pale sunrise light and long thin shadows down the street"),
    (9, "mid-morning",
     "bright clear daylight filling the room",
     "bright clear morning sun under an open blue sky"),
    (12, "midday",
     "strong overhead sun, crisp shadows, curtains half-drawn",
     "strong overhead sun, short hard shadows, a washed-out bright sky"),
    (15, "late afternoon",
     "warm low golden sunlight and long soft shadows",
     "warm low golden sunlight raking across everything, long shadows"),
    (18, "dusk",
     "orange-pink sunset through the window, a lamp just switched on",
     "an orange-pink sunset sky, shopfront lights just coming on"),
    (21, "night",
     "warm indoor lamplight against a fully dark window",
     "a fully dark sky, everyone lit by warm street and storefront light"),
    (23, "late night",
     "a dim room lit mostly by the cool glow of a nearby screen",
     "a quiet dark street under sparse cool streetlight and neon"),
)


class ImageGenError(Exception):
    """The image API refused, failed, or returned nothing usable."""


@dataclass
class GeneratedImage:
    """One decoded image off the API, with the media type it reported."""

    data: bytes
    media_type: str

    @property
    def suffix(self) -> str:
        """The file extension matching ``media_type``."""
        return SUFFIXES.get(self.media_type) or mimetypes.guess_extension(
            self.media_type
        ) or ".png"


@dataclass
class Generation:
    """Everything one ``/images`` call produced."""

    images: list[GeneratedImage]
    cost_usd: float | None


def _local_now() -> datetime:
    """Now in the persona's timezone, falling back to UTC for an unknown zone."""
    try:
        timezone = ZoneInfo(os.getenv("PERSONA_TIMEZONE") or "Asia/Shanghai")
    except ZoneInfoNotFoundError:
        timezone = ZoneInfo("UTC")
    return datetime.now(timezone)


def _ambience(hour: int) -> tuple[str, str, str]:
    """``(label, indoor light, outdoor light)`` for ``hour``."""
    label, indoor, outdoor = _AMBIENCE[-1][1:]
    for start, name, inside, outside in _AMBIENCE:
        if hour >= start:
            label, indoor, outdoor = name, inside, outside
    return label, indoor, outdoor


def fill_time(template: str, *, outdoors: bool = False) -> str:
    """``template``'s {time} and {light} slots, resolved against the persona's clock.

    The bot answers viewers live, so its selfie should match the hour they
    are actually watching at — in the persona's timezone, not the machine's.
    """
    now = _local_now()
    label, indoor, outdoor = _ambience(now.hour)
    filled = template.replace("{time}", f"{label}, about {now:%H:%M} local time")
    return filled.replace("{light}", outdoor if outdoors else indoor)


# The hours _AMBIENCE draws without daylight, which is also when the persona
# wears her night outfit.
_AFTER_DARK = frozenset({"night", "late night"})


def select_outfit(sources: list[str]) -> list[str]:
    """``sources`` narrowed to the one outfit this hour calls for.

    ``outfits/`` holds one character in different outfits — ``day.png`` and
    ``night.png`` — not different views of one outfit. Hand the model two and
    it reads the second as a second person: a group selfie with one friend
    came back with three people in frame. So exactly one of them ever reaches
    ``input_references``, and the hour picks which, matching the light the
    prompt asks for. ``night`` in the file name is the whole convention.
    Friends are unaffected: they contribute one image each, from ``friends/``.
    """
    if len(sources) <= 1:
        return sources
    after_dark = _ambience(_local_now().hour)[0] in _AFTER_DARK
    for source in sources:
        if ("night" in Path(source).stem.lower()) is after_dark:
            return [source]
    return sources[:1]


def _images_in(directory: Path) -> list[str]:
    """Every image file sitting directly in ``directory``, sorted by name."""
    if not directory.is_dir():
        return []
    return [
        str(path)
        for path in sorted(directory.iterdir())
        if path.is_file() and (mimetypes.guess_type(path.name)[0] or "").startswith("image/")
    ]


def friend_sources() -> dict[str, str]:
    """``{name: path}`` for every image in ``selfie-references/friends``.

    The file name is the name the LLM asks for, so adding a friend is
    dropping ``<their name>.png`` in that directory — nothing else.
    """
    return {Path(path).stem: path for path in _images_in(FRIENDS)}


def build_selfie_prompt(friends: list[str]) -> str:
    """The built-in prompt for one selfie — alone indoors, or out with ``friends``.

    Going out is what having company means here: a group selfie in the
    persona's room would read as odd, so naming anyone moves the scene
    outdoors and switches the hour's lighting to match.
    """
    if friends:
        company = (
            "\nAlso in frame: "
            + ", ".join(friends)
            + f". Exactly {len(friends) + 1} people are in the picture — one"
            " per reference image, and nobody else. The references map in"
            " order: the first is the main character, each one after it is the"
            " next friend named above. Draw one character per reference image;"
            " never turn a single reference into two characters. Match each"
            " friend's face, hair, and outfit as closely as the main"
            " character's. It's a group selfie taken while out together:"
            " everyone leaning into one phone camera, the main character"
            " nearest the lens holding it.\n"
        )
        setting = _OUTDOORS
    else:
        company = (
            "\nExactly one person is in the picture: the character in the"
            " single reference image. No second version of her, no one else.\n"
        )
        setting = _INDOORS

    filled = SELFIE_PROMPT.replace("{company}", company).replace("{setting}", setting)
    return fill_time(filled, outdoors=bool(friends))


def load_reference(source: str) -> dict[str, Any]:
    """One ``input_references`` entry from a local path or an http(s) URL.

    A local file has to become a ``data:`` URL carrying its real media
    type — the provider rejects a mislabelled one.
    """
    if source.startswith(("http://", "https://")):
        return {"type": "image_url", "image_url": {"url": source}}

    path = Path(source).expanduser()
    if not path.is_file():
        raise ImageGenError(f"{path}: no such file")
    media_type, _ = mimetypes.guess_type(path.name)
    if media_type is None or not media_type.startswith("image/"):
        raise ImageGenError(f"{path}: not a recognizable image type")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{encoded}"}}


def _error_message(response: httpx.Response) -> str:
    """OpenRouter's ``{"error": {"message": ...}}``, falling back to the raw body."""
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return str(error or body)


async def generate(
    *,
    api_key: str,
    prompt: str,
    references: list[dict[str, Any]] | None = None,
    model: str = DEFAULT_MODEL,
    n: int = 1,
    aspect_ratio: str = "auto",
    quality: str = "auto",
) -> Generation:
    """Call OpenRouter's image route once. The single path both callers share."""
    payload: dict[str, Any] = {"model": model, "prompt": prompt, "n": n}
    if references:
        payload["input_references"] = references
    # "auto" is the model's own default; omitting it keeps the body valid for
    # models whose enums differ.
    if aspect_ratio != "auto":
        payload["aspect_ratio"] = aspect_ratio
    if quality != "auto":
        payload["quality"] = quality

    headers = openrouter_headers()
    headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(API_URL, headers=headers, json=payload)
    except httpx.HTTPError as e:
        raise ImageGenError(f"request failed: {e}") from e

    if response.status_code != 200:
        raise ImageGenError(f"{response.status_code}: {_error_message(response)}")

    body = response.json()
    rows = (body.get("data") or []) if isinstance(body, dict) else []
    images = [
        GeneratedImage(
            data=base64.b64decode(row["b64_json"]),
            media_type=row.get("media_type") or "image/png",
        )
        for row in rows
        if isinstance(row, dict) and row.get("b64_json")
    ]
    if not images:
        raise ImageGenError("the response carried no image")
    return Generation(images=images, cost_usd=extract_cost_usd(body.get("usage")))


_STORE: dict[str, tuple[bytes, str, float]] = {}


def _publish(image: GeneratedImage, ttl_seconds: int) -> str:
    """Park ``image`` in the TTL store and return the path that serves it."""
    now = time.monotonic()
    for key, (_, _, expires_at) in list(_STORE.items()):
        if expires_at <= now:
            del _STORE[key]
    selfie_id = secrets.token_urlsafe(16)
    _STORE[selfie_id] = (image.data, image.media_type, now + ttl_seconds)
    return f"{SELFIE_PATH}/{selfie_id}{image.suffix}"


def install_selfie_route(app: FastAPI) -> None:
    """Serve generated selfies. Call exactly once at startup.

    The id is the whole authorization: it is unguessable, single-purpose, and
    expires, so the route needs no session of its own.
    """
    logger.info(f"[selfie] Installed route: GET {SELFIE_PATH}/{{selfie_id}}")

    @app.get(SELFIE_PATH + "/{selfie_id}")
    async def get_selfie(selfie_id: str) -> Response:
        entry = _STORE.get(Path(selfie_id).stem)
        if entry is None or entry[2] <= time.monotonic():
            _STORE.pop(Path(selfie_id).stem, None)
            return Response(status_code=404)
        data, media_type, _ = entry
        return Response(content=data, media_type=media_type)


class OpenRouterImageGenService(ImageGenService):
    """OpenRouter image generation, yielding one ``URLImageRawFrame`` per image.

    Never put this in a pipeline: ``ImageGenService.process_frame`` generates
    from every ``TextFrame``, and this pipeline streams one per sentence.
    """

    Settings = ImageGenSettings

    def __init__(
        self,
        *,
        api_key: str,
        model: str = DEFAULT_MODEL,
        aspect_ratio: str = "auto",
        quality: str = "auto",
        ttl_seconds: int = 600,
    ):
        super().__init__(settings=ImageGenSettings(model=model))
        self._api_key = api_key
        self._aspect_ratio = aspect_ratio
        self._quality = quality
        self._ttl_seconds = ttl_seconds

    async def run_image_gen(
        self, prompt: str, *, extra_references: list[dict[str, Any]] | None = None
    ) -> AsyncGenerator[Frame, None]:
        """Generate, publish, and yield each image as a frame carrying its URL.

        The persona's reference is resolved per call, not held from startup:
        ``select_outfit`` reads the clock, and a bot that boots in daylight
        runs into the night.

        ``extra_references`` are appended after the persona's own, which is the
        order ``build_selfie_prompt`` tells the model to expect.
        """
        try:
            references = [
                *(load_reference(source) for source in reference_sources()),
                *(extra_references or []),
            ][:MAX_REFERENCES]
            result = await generate(
                api_key=self._api_key,
                prompt=prompt,
                references=references,
                model=str(self._settings.model or DEFAULT_MODEL),
                aspect_ratio=self._aspect_ratio,
                quality=self._quality,
            )
        except ImageGenError as e:
            yield ErrorFrame(f"Selfie generation failed: {e}")
            return

        logger.info(
            f"[selfie] Generated {len(result.images)} image(s)"
            + (f", cost ${result.cost_usd:.4f}" if result.cost_usd else "")
        )
        for image in result.images:
            decoded = Image.open(io.BytesIO(image.data))
            yield URLImageRawFrame(
                image=decoded.tobytes(),
                size=decoded.size,
                format=decoded.mode,
                url=_publish(image, self._ttl_seconds),
            )


def _build_schema(friends: list[str]) -> FunctionSchema:
    """The OpenAI-compatible schema the LLM sees.

    ``with_friends`` only appears when reference images exist to back it —
    an empty enum draws calls naming people the model then can't be shown.
    """
    properties: dict[str, Any] = {}
    if friends:
        properties["with_friends"] = {
            "type": "array",
            "items": {"type": "string", "enum": friends},
            "description": (
                "同框的朋友。**只有当你确实知道自己正和她们在外面时才填** —— "
                "比如记忆或刚才的对话里提到今天一起出门、正在逛街吃饭。"
                "不确定、只是聊到过这个人、或者你在家，就留空。"
                "填了就会画成在外面的合照。"
            ),
        }
    return FunctionSchema(
        name=_TOOL_NAME,
        description=(
            "给奶糖花拍一张自拍照，直接发到她屏幕上。"
            "奶糖花要看照片、要自拍、说想看看你的时候就调用 —— "
            "例如『发张自拍』『拍张照片』『让我看看你』。"
            "**这是唯一能把照片发出去的方式，被要求了就不要拒绝，"
            "也不要说自己拍不了、走不开、没相机。**"
            "可以一边调侃一边答应（『就知道你想看』），但必须真的调用。"
            "她没提照片的时候不要主动调用。"
            "拍一张要十几秒，调用后先自然地说一句『等我一下』之类的；"
            "不要照念工具名，也不要念出链接或文件名。"
        ),
        properties=properties,
        required=[],
    )


def _make_handler(
    service: OpenRouterImageGenService,
) -> Callable[[FunctionCallParams], Awaitable[None]]:
    """Closure that handles a ``take_selfie`` tool call."""

    async def handler(params: FunctionCallParams) -> None:
        known = friend_sources()
        requested = params.arguments.get("with_friends")
        names = [str(n) for n in requested] if isinstance(requested, list) else []
        # An enum the model ignores is a normal failure mode; drop what we
        # can't illustrate rather than sending a prompt naming a stranger.
        friends = [n for n in names if n in known]
        unknown = [n for n in names if n not in known]
        if unknown:
            logger.warning(f"[selfie] LLM named unknown friends {unknown}; known: {sorted(known)}")

        try:
            extra = [load_reference(known[name]) for name in friends]
        except ImageGenError as e:
            logger.warning(f"[selfie] {e}")
            friends, extra = [], []

        if friends:
            logger.info(f"[selfie] Group selfie with {friends}")

        urls: list[str] = []
        async for frame in service.run_image_gen(
            build_selfie_prompt(friends), extra_references=extra
        ):
            if isinstance(frame, ErrorFrame):
                logger.warning(f"[selfie] {frame.error}")
                await params.result_callback({"ok": False, "error": frame.error})
                return
            if isinstance(frame, URLImageRawFrame) and frame.url:
                urls.append(frame.url)

        if not urls:
            await params.result_callback({"ok": False, "error": "no image"})
            return

        # Through the LLM's own downstream queue, so the RTVIObserver turns it
        # into a `server-message` for the client.
        await params.llm.push_frame(
            RTVIServerMessageFrame(data={"type": "selfie", "urls": urls})
        )
        await params.result_callback({"ok": True, "count": len(urls)})

    return handler


def reference_sources() -> list[str]:
    """The persona's reference image for right now — one outfit, never two.

    ``SELFIE_REFERENCE_IMAGES`` if set, else what's bundled. The bundled
    directory is the whole configuration for a normal deployment — drop an
    outfit in, it becomes selectable; take them all out and the tool stops
    being offered. Everything here goes through ``select_outfit``, so no
    caller can put the same character in frame twice.
    """
    raw = os.getenv("SELFIE_REFERENCE_IMAGES") or ""
    configured = [part.strip() for part in raw.split(",") if part.strip()]
    if configured:
        return select_outfit(configured)
    # Loose files directly under selfie-references/ are the layout from before
    # outfits/ existed, so a deployment mounting its own data/ still works.
    return select_outfit(_images_in(OUTFITS) or _images_in(BUNDLED_REFERENCES))


def load_references() -> list[dict[str, Any]]:
    """The persona's current outfit, encoded for ``input_references``.

    Raises ``ImageGenError`` for a configured path that doesn't resolve —
    silently generating a selfie of nobody is worse than not offering one.
    ``MAX_REFERENCES`` is enforced where friends are added and can push the
    total past it; this side is always one image.
    """
    return [load_reference(source) for source in reference_sources()]


def is_configured() -> bool:
    """Whether a selfie tool will be registered, without paying to encode one.

    ``_build_persona_prefix`` runs before the tool is installed and has to
    decide whether to mention it, so this repeats the cheap half of
    ``install_selfie_tool``'s check.
    """
    if not os.getenv("OPENROUTER_API_KEY"):
        return False
    sources = reference_sources()
    return bool(sources) and all(
        source.startswith(("http://", "https://")) or Path(source).expanduser().is_file()
        for source in sources
    )


def install_selfie_tool(
    *, llm: LLMService[Any], tools: ToolsSchema | None
) -> ToolsSchema | None:
    """Register ``take_selfie`` and return ``tools`` with its schema merged in.

    Returns ``tools`` untouched when no reference image or API key is
    configured, so a fresh checkout runs without one.
    """
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        logger.info("[selfie] Disabled: OPENROUTER_API_KEY is unset.")
        return tools
    sources = reference_sources()
    if not sources:
        logger.info(f"[selfie] Disabled: no reference images in {BUNDLED_REFERENCES}.")
        return tools
    # Encode once here and throw it away: a path that can't be read should
    # leave the tool unregistered rather than fail inside a viewer's call.
    try:
        load_references()
    except ImageGenError as e:
        logger.warning(f"[selfie] Disabled: {e}")
        return tools

    service = OpenRouterImageGenService(
        api_key=api_key,
        model=os.getenv("SELFIE_MODEL") or DEFAULT_MODEL,
        aspect_ratio=os.getenv("SELFIE_ASPECT_RATIO") or "3:4",
        quality=os.getenv("SELFIE_QUALITY") or "auto",
        ttl_seconds=env_int("SELFIE_TTL_SECONDS", 600),
    )
    # Asynchronous: the LLM keeps talking instead of holding the turn for the
    # ten-odd seconds a render takes, and the result arrives as a developer
    # message when it lands.
    llm.register_function(
        _TOOL_NAME,
        _make_handler(service),
        cancel_on_interruption=False,
        timeout_secs=float(env_int("SELFIE_TIMEOUT_SECONDS", 120)),
    )
    logger.info(
        f"[selfie] Enabled. Outfit for this hour: {Path(sources[0]).name}"
        " (re-picked per render)."
    )
    friends = sorted(friend_sources())
    if friends:
        logger.info(f"[selfie] Friend references available: {friends}")
    return ToolsSchema(
        standard_tools=[*(tools.standard_tools if tools else []), _build_schema(friends)]
    )


def persona_prefix_hint() -> str:
    """System-prompt hint about the selfie tool, and who can be in the shot."""
    lines = [
        "奶糖花要看照片 / 要自拍 / 说想看看你（『发张自拍』『让我看看你』『来张照片』之类），"
        f"一定要调用 {_TOOL_NAME} 工具，这是唯一能把照片发出去的方式。"
        "你可以一边调侃一边拍（『就知道你想看』『只此一张啊』），"
        "但不能用『想得美』『不给看』之类的话搪塞过去，也不能说自己拍不了或者走不开。"
        "拍照要十几秒，调用后先说一句让对方等一下，照片会自动出现在对方屏幕上。"
        "她没提照片时不要主动拍，也不要念出图片链接或文件名。"
    ]
    friends = sorted(friend_sources())
    if friends:
        lines.append(
            "如果你记得或者刚才聊到今天正和朋友在外面（一起逛街、吃饭、出门玩），"
            f"拍照时把她们填进 with_friends 参数，可选：{'、'.join(friends)}，"
            "拍出来就是在外面的合照。不确定、或者你人在家，就不要填。"
        )
    return "\n".join(lines)


TOOL_NAME = _TOOL_NAME


__all__ = [
    "ASPECT_RATIOS",
    "DEFAULT_MODEL",
    "MAX_IMAGES",
    "MAX_REFERENCES",
    "QUALITIES",
    "BUNDLED_REFERENCES",
    "FRIENDS",
    "OUTFITS",
    "SELFIE_PROMPT",
    "TOOL_NAME",
    "GeneratedImage",
    "Generation",
    "ImageGenError",
    "OpenRouterImageGenService",
    "build_selfie_prompt",
    "fill_time",
    "friend_sources",
    "generate",
    "install_selfie_route",
    "install_selfie_tool",
    "is_configured",
    "load_reference",
    "persona_prefix_hint",
    "reference_sources",
    "select_outfit",
]
