"""Generate an image from a text prompt plus optional reference images.

The bot's selfie tool and this script share one path — ``image_generation``
owns the OpenRouter call and the built-in prompt, so what you probe here is
what a viewer gets.

Usage:
    uv run laplace-generate-image "put her in a red scarf, keep the pose" -i ref.png -o out.png
    uv run laplace-generate-image -i ref.png          # falls back to the built-in prompt
    uv run laplace-generate-image --friend 七海Nana7mi  # the group-selfie variant
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import textwrap
from pathlib import Path

from dotenv import load_dotenv

from ..image_generation import (
    ASPECT_RATIOS,
    DEFAULT_MODEL,
    MAX_IMAGES,
    MAX_REFERENCES,
    QUALITIES,
    GeneratedImage,
    ImageGenError,
    build_selfie_prompt,
    friend_sources,
    generate,
    load_reference,
    reference_sources,
)

DEFAULT_OUT_PATH = "data/generated/image.png"


def _out_path(base: Path, index: int, count: int, image: GeneratedImage) -> Path:
    """``base`` renamed to the suffix the API actually returned, numbered when count > 1."""
    stem = base.stem if base.suffix else base.name
    if count > 1:
        stem = f"{stem}-{index + 1}"
    return base.with_name(stem + image.suffix)


def main() -> int:
    """Entry point for ``laplace-generate-image``."""
    load_dotenv(override=True)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "prompt",
        nargs="?",
        help="What to generate, or how to edit the references (default: the built-in prompt)",
    )
    parser.add_argument(
        "-i",
        "--image",
        action="append",
        metavar="PATH_OR_URL",
        help=(
            f"Reference image, local path or URL; repeat for up to {MAX_REFERENCES}. "
            "Defaults to the bundled ones the bot uses."
        ),
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
    known_friends = friend_sources()
    parser.add_argument(
        "--friend",
        action="append",
        metavar="NAME",
        choices=sorted(known_friends) or None,
        help="Put a friend from selfie-references/friends in the shot; repeat for more",
    )
    args = parser.parse_args()

    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        print("OPENROUTER_API_KEY is unset.", file=sys.stderr)
        return 1

    friends: list[str] = args.friend or []
    missing = [name for name in friends if name not in known_friends]
    if missing:
        print(f"unknown friend(s) {missing}; known: {sorted(known_friends)}", file=sys.stderr)
        return 1

    sources: list[str] = [
        *(args.image or reference_sources()),
        *(known_friends[name] for name in friends),
    ]
    if len(sources) > MAX_REFERENCES:
        print(f"{len(sources)} references given; the cap is {MAX_REFERENCES}.", file=sys.stderr)
        return 1
    if not 1 <= args.n <= MAX_IMAGES:
        print(f"-n must be between 1 and {MAX_IMAGES}.", file=sys.stderr)
        return 1

    prompt: str = args.prompt or build_selfie_prompt(friends)
    print(f"{args.model}: {args.n} image(s) from {len(sources)} reference(s)")
    if not args.prompt:
        print(f"No prompt given; using the built-in one:\n{textwrap.indent(prompt.strip(), '  ')}")

    try:
        references = [load_reference(source) for source in sources]
        result = asyncio.run(
            generate(
                api_key=api_key,
                prompt=prompt,
                references=references,
                model=args.model,
                n=args.n,
                aspect_ratio=args.aspect_ratio,
                quality=args.quality,
            )
        )
    except ImageGenError as e:
        print(str(e), file=sys.stderr)
        return 1

    base = Path(args.out).expanduser()
    base.parent.mkdir(parents=True, exist_ok=True)
    for index, image in enumerate(result.images):
        out_path = _out_path(base, index, len(result.images), image)
        out_path.write_bytes(image.data)
        print(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")

    if result.cost_usd:
        print(f"Cost: ${result.cost_usd:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
