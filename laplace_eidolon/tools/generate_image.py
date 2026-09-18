"""Generate an image from a text prompt plus optional reference images.

OpenRouter's unified image route (``POST /api/v1/images``) is not chat
completions and has no OpenAI SDK binding: reference images go in
``input_references``, and results come back as raw base64 in
``data[].b64_json`` — not as data URLs. So this talks to it over httpx.

Usage:
    uv run laplace-generate-image "put her in a red scarf, keep the pose" -i ref.png -o out.png
    uv run laplace-generate-image -i ref.png          # falls back to DEFAULT_PROMPT
"""

from __future__ import annotations

import argparse
import base64
import mimetypes
import os
import sys
import textwrap
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from dotenv import load_dotenv

from ..openrouter import extract_cost_usd, openrouter_headers

API_URL = "https://openrouter.ai/api/v1/images"
# DEFAULT_MODEL = "openai/gpt-image-2.5-sunburst"
DEFAULT_MODEL = "openai/gpt-image-2.5-flare"
DEFAULT_OUT_PATH = "data/generated/image.png"

DEFAULT_PROMPT = """\
Turn the reference character into a casual selfie, drawn in classic 2D anime
style.

Keep unchanged: the character's face, hairstyle, hair color, eye color, and
outfit design. The result has to read as the same character, not a lookalike.

Framing: a phone selfie held at arm's length — camera slightly above eye
level, head and shoulders filling the frame, eyes on the lens, relaxed
natural smile.

Render: hand-drawn 2D anime, the look of a traditional cel animation frame.
Crisp inked outlines of varying weight, flat color fills, hard-edged two-tone
cel shading, glossy block highlights in the hair, classic anime eyes. No 3D,
no photorealism, no physically based materials, no rendered textures.

Time: it is {time}. The window, the sky beyond it, and the room lighting all
have to read as that hour.

Light: {light}, drawn as simple cel shadow shapes from one clear direction,
over a softly painted, uncluttered indoor background.

No text, watermarks, logos, UI overlays, or extra characters.
"""

ASPECT_RATIOS = ("auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9")
QUALITIES = ("auto", "low", "medium", "high", "xhigh", "max")
MAX_REFERENCES = 16
MAX_IMAGES = 10

# A max-quality render runs for minutes; httpx otherwise gives up after
# its 5s default read timeout.
TIMEOUT = httpx.Timeout(600.0, connect=10.0)

_SUFFIXES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}

# (first local hour, what to call it, how the scene is lit). Ordered; hours
# before the first boundary wrap back to the last row.
_AMBIENCE = (
    (5, "early morning", "cool pale sunrise light slanting in through the window"),
    (9, "mid-morning", "bright clear daylight filling the room"),
    (12, "midday", "strong overhead sun, crisp shadows, curtains half-drawn"),
    (15, "late afternoon", "warm low golden sunlight and long soft shadows"),
    (18, "dusk", "orange-pink sunset through the window, a lamp just switched on"),
    (21, "night", "warm indoor lamplight against a fully dark window"),
    (23, "late night", "a dim room lit mostly by the cool glow of a nearby screen"),
)


def _fill_time(template: str) -> str:
    """``template``'s {time} and {light} slots, resolved against the persona's clock.

    The bot answers viewers live, so its selfie should match the hour they
    are actually watching at — in the persona's timezone, not the machine's.
    """
    try:
        timezone = ZoneInfo(os.getenv("PERSONA_TIMEZONE") or "Asia/Shanghai")
    except ZoneInfoNotFoundError:
        timezone = ZoneInfo("UTC")
    now = datetime.now(timezone)

    label, light = _AMBIENCE[-1][1:]
    for start, name, description in _AMBIENCE:
        if now.hour >= start:
            label, light = name, description

    filled = template.replace("{time}", f"{label}, about {now:%H:%M} local time")
    return filled.replace("{light}", light)


def _reference(source: str) -> dict[str, Any]:
    """One ``input_references`` entry from a local path or an http(s) URL.

    A local file has to become a ``data:`` URL carrying its real media
    type — the provider rejects a mislabelled one.
    """
    if source.startswith(("http://", "https://")):
        return {"type": "image_url", "image_url": {"url": source}}

    path = Path(source).expanduser()
    if not path.is_file():
        raise ValueError(f"{path}: no such file")
    media_type, _ = mimetypes.guess_type(path.name)
    if media_type is None or not media_type.startswith("image/"):
        raise ValueError(f"{path}: not a recognizable image type")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{encoded}"}}


def _out_path(base: Path, index: int, count: int, media_type: str) -> Path:
    """``base`` renamed to the suffix the API actually returned, numbered when count > 1."""
    suffix = _SUFFIXES.get(media_type) or mimetypes.guess_extension(media_type) or ".png"
    stem = base.stem if base.suffix else base.name
    if count > 1:
        stem = f"{stem}-{index + 1}"
    return base.with_name(stem + suffix)


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


def main() -> int:
    """Entry point for ``laplace-generate-image``."""
    load_dotenv(override=True)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "prompt",
        nargs="?",
        help="What to generate, or how to edit the references (default: DEFAULT_PROMPT)",
    )
    parser.add_argument(
        "-i",
        "--image",
        action="append",
        metavar="PATH_OR_URL",
        help=f"Reference image, local path or URL; repeat for up to {MAX_REFERENCES}",
    )
    parser.add_argument(
        "-o",
        "--out",
        default=DEFAULT_OUT_PATH,
        help=f"Where to write it; the suffix follows the response (default: {DEFAULT_OUT_PATH})",
    )
    parser.add_argument(
        "-n",
        type=int,
        default=1,
        help=f"How many to generate, 1-{MAX_IMAGES} (default: 1)",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"OpenRouter model slug (default: {DEFAULT_MODEL})",
    )
    parser.add_argument("--aspect-ratio", default="auto", choices=ASPECT_RATIOS)
    parser.add_argument("--quality", default="auto", choices=QUALITIES)
    args = parser.parse_args()

    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        print("OPENROUTER_API_KEY is unset.", file=sys.stderr)
        return 1

    sources: list[str] = args.image or []
    if len(sources) > MAX_REFERENCES:
        print(f"{len(sources)} references given; the cap is {MAX_REFERENCES}.", file=sys.stderr)
        return 1
    if not 1 <= args.n <= MAX_IMAGES:
        print(f"-n must be between 1 and {MAX_IMAGES}.", file=sys.stderr)
        return 1

    try:
        references = [_reference(source) for source in sources]
    except (ValueError, OSError) as e:
        print(str(e), file=sys.stderr)
        return 1

    prompt: str = args.prompt or _fill_time(DEFAULT_PROMPT)
    payload: dict[str, Any] = {"model": args.model, "prompt": prompt, "n": args.n}
    if references:
        payload["input_references"] = references
    # "auto" is this model's own default; omitting it keeps the body valid
    # for models whose enums differ.
    if args.aspect_ratio != "auto":
        payload["aspect_ratio"] = args.aspect_ratio
    if args.quality != "auto":
        payload["quality"] = args.quality

    headers = openrouter_headers()
    headers["Authorization"] = f"Bearer {api_key}"

    print(f"{args.model}: {args.n} image(s) from {len(references)} reference(s)")
    if not args.prompt:
        print(f"No prompt given; using the built-in one:\n{textwrap.indent(prompt.strip(), '  ')}")
    try:
        response = httpx.post(API_URL, headers=headers, json=payload, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        print(f"Request failed: {e}", file=sys.stderr)
        return 1

    if response.status_code != 200:
        print(f"{response.status_code}: {_error_message(response)}", file=sys.stderr)
        return 1

    body = response.json()
    images = (body.get("data") or []) if isinstance(body, dict) else []
    base = Path(args.out).expanduser()
    base.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    for index, image in enumerate(images):
        encoded = image.get("b64_json") if isinstance(image, dict) else None
        if not encoded:
            continue
        media_type = image.get("media_type") or "image/png"
        out_path = _out_path(base, index, len(images), media_type)
        out_path.write_bytes(base64.b64decode(encoded))
        written += 1
        print(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")

    if not written:
        print("The response carried no image.", file=sys.stderr)
        return 1

    cost = extract_cost_usd(body.get("usage"))
    if cost:
        print(f"Cost: ${cost:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
