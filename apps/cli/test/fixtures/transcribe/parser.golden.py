"""Prints parser.golden.json: Python's argparse (COLUMNS=80) running laplace-transcribe's and
laplace-extract-users' parsers as the TS port declares them, so the port's help text and usage
errors are argparse's own. Their flags differ from the Python tools' by design: transcribe drops
the whisper provider and adds --persona, --force and --json; extract-users adds --persona and labels
types 1 and 3 as gift and SC. `--types` parses with extract_users._parse_types itself.

    COLUMNS=80 uv run --offline --no-sync python apps/cli/test/fixtures/transcribe/parser.golden.py \
        > apps/cli/test/fixtures/transcribe/parser.golden.json
    bunx biome format --write apps/cli/test/fixtures/transcribe/parser.golden.json
"""

from __future__ import annotations

import argparse
import contextlib
import difflib
import io
import json
import os
import platform
import sys
from pathlib import Path

from laplace_eidolon.tools import extract_users, transcribe


def transcribe_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="laplace-transcribe", description=(transcribe.__doc__ or "").splitlines()[0]
    )
    p.add_argument("audio", type=Path, help="VOD file (mp3, m4a, mp4, wav, ...)")
    p.add_argument(
        "--provider",
        choices=("soniox",),
        default="soniox",
        help="Transcription backend (default: soniox, cloud).",
    )
    p.add_argument("--date", default=None, help="Stream date YYYY-MM-DD (default: today)")
    p.add_argument(
        "--language",
        default=None,
        help=(
            "ISO 639-1 code (e.g. 'en', 'zh'), sent to Soniox as a language hint (the model "
            "still auto-detects). Default: the transcription.language setting, else zh. Pass "
            "--language '' for no hint."
        ),
    )
    p.add_argument(
        "--window",
        type=int,
        default=300,
        help="Scene window in seconds (default: 300 = 5 minutes)",
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Output directory (default: the persona's streams/ in the data home's sources)",
    )
    p.add_argument(
        "--persona",
        default=None,
        help="Persona whose sources and glossary to use (default: the active persona)",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Transcribe again over an existing transcript (Soniox bills again)",
    )
    p.add_argument(
        "--json", action="store_true", help="Report progress as JSON lines on stdout"
    )
    g = p.add_argument_group("soniox provider")
    g.add_argument(
        "--soniox-model",
        default=None,
        help="Soniox async STT model (default: the transcription.model setting, else "
        "stt-async-v5)",
    )
    g.add_argument(
        "--keep-soniox-files",
        action="store_true",
        help=(
            "Don't delete the uploaded file + transcription record from "
            "Soniox after success. Default is to clean up so the 10GB / "
            "1000-file quota stays open."
        ),
    )
    g.add_argument(
        "--context-file",
        type=Path,
        default=None,
        help=(
            "TOML file with structured context (glossary + domain hints) "
            "passed to Soniox to improve accuracy. Mirrors Soniox's "
            "StructuredContext schema. Defaults to the persona's glossary.toml. "
            "Missing file is fine — the run just goes out without context."
        ),
    )
    g.add_argument(
        "--no-context",
        action="store_true",
        help=(
            "Skip the context file even if it exists. Useful for clean "
            "A/B comparisons or when you want to confirm a transcription "
            "issue is not caused by your glossary."
        ),
    )
    g.add_argument(
        "--auto-slice",
        action="store_true",
        help=(
            "When the source audio exceeds Soniox's 300-min "
            "per-file cap, split it with ffmpeg into multiple parts, "
            "transcribe each independently, and merge the segments + "
            "tokens with offset timestamps. Original file is never "
            "modified — slices live in a temp directory and are wiped "
            "on exit. Default off so the existing fail-fast behavior "
            "is preserved for one-off runs."
        ),
    )
    g.add_argument(
        "--slice-max-min",
        type=int,
        default=280,
        help=(
            "Max minutes per slice when --auto-slice is on (default: "
            "280). Must be ≤ 300. Lower values produce more "
            "parts and more Soniox jobs but tolerate more drift from "
            "ffmpeg's keyframe-bounded cuts."
        ),
    )
    return p


def extract_users_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="laplace-extract-users", description=(extract_users.__doc__ or "").splitlines()[0]
    )
    p.add_argument("input", type=Path, help="Path to a danmakus.com JSON export.")
    p.add_argument(
        "-n",
        "--top",
        type=int,
        default=50,
        help="How many top usernames to emit on stdout (default: 50).",
    )
    p.add_argument(
        "--types",
        type=extract_users._parse_types,
        default=extract_users.DEFAULT_INCLUDE_TYPES,
        help=(
            "Comma-separated message-type integers to include in the "
            "ranking. Default '1,2,3' counts gifts, memberships and super "
            "chats — the events where the streamer reads names "
            "aloud. Pass 'all' to disable filtering, or e.g. '0,1,2,3' "
            "to also include free chat."
        ),
    )
    p.add_argument(
        "--persona", default=None, help="Persona to run for (default: the active persona)"
    )
    return p


def outcome(parser: argparse.ArgumentParser, argv: list[str]) -> dict[str, object]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            ns = parser.parse_args(argv)
        except SystemExit as e:
            return {"argv": argv, "code": e.code, "stdout": out.getvalue(), "stderr": err.getvalue()}
    values = {}
    for key, value in vars(ns).items():
        if isinstance(value, Path):
            value = str(value)
        elif isinstance(value, set):
            value = sorted(value)
        values[key] = value
    return {"argv": argv, "code": "parsed", "ns": values}


TRANSCRIBE_CASES = [
    ["-h"],
    [],
    ["a.m4a"],
    ["./vods//a.m4a", "--language", "", "--window", "60", "--date", "2026-01-02"],
    ["a.m4a", "--provider", "whisper"],
    ["a.m4a", "--window", "x"],
    ["a.m4a", "--slice-max-min", "１２"],
    ["a.m4a", "--no-context", "--context-file", "g.toml/", "--keep-soniox-files"],
    ["a.m4a", "--auto-slice", "--force", "--json", "--persona", "milky-green"],
    ["a.m4a", "--model", "small"],
    ["a.m4a", "b.m4a"],
]

EXTRACT_CASES = [
    ["-h"],
    [],
    ["x.json"],
    ["x.json", "-n", "5", "--types", "all"],
    ["x.json", "--types", " ALL "],
    ["x.json", "--types", "0, 2,,9"],
    ["x.json", "--types", "1,x"],
    ["x.json", "--types", ","],
    ["x.json", "-n", "-3"],
    ["x.json", "--top", "y"],
]


LONG = "录制-23197314-20230709-201234-123-【歌回】" + "唱歌啦～" * 60 + ".flv"
CLOSE_MATCHES = [
    ("BV1aaaaaaaaa.m4a", ["BV1aaaaaaaaa_p1.m4a", "BV1aaaaaaaab.m4a", "notes.txt", "BV1zzzzzzzzz.m4a"]),
    (
        "录制-23197314-20230709-201234-123-【歌回】唱歌啦.flv",
        [
            "录制-23197314-20230709-201234-123-【歌回】唱歌啦!!.flv",
            "录制-23197314-20230709-201234-123-【歌回】唱歌啦_1.flv",
            "录制-23197314-20230709.flv",
            "other.flv",
        ],
    ),
    (LONG, [LONG.replace(".flv", "!!.flv"), LONG[:150] + ".flv", "x" * 210, LONG[::-1]]),
    ("ab", ["ba", "ab", "abc", "b", "a"]),
    ("", ["", "a"]),
    ("a.m4a", ["c.m4a", "b.m4a", "d.m4a", "e.m4a", "f.m4a", "g.m4a"]),
]


def main() -> None:
    if os.environ.get("COLUMNS") != "80":
        sys.exit("Run with COLUMNS=80: argparse wraps help to the terminal's width.")
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()} argparse, COLUMNS=80: "
            "apps/cli/test/fixtures/transcribe/parser.golden.py"
        ),
        "transcribe": [outcome(transcribe_parser(), argv) for argv in TRANSCRIBE_CASES],
        "extract_users": [outcome(extract_users_parser(), argv) for argv in EXTRACT_CASES],
        "close_matches": [
            [word, names, difflib.get_close_matches(word, names, n=5, cutoff=0.5)]
            for word, names in CLOSE_MATCHES
        ],
    }
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
