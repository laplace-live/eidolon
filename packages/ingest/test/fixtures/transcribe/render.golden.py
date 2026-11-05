"""Prints render.golden.json: tools/transcribe.py's rendering and glossary functions, and the
soniox SDK's token dumps, timestamps and create body, on synthetic inputs. transcribe_render.test.ts
and transcribe_context.test.ts read it.

    uv run --offline --no-sync python packages/ingest/test/fixtures/transcribe/render.golden.py \
        > packages/ingest/test/fixtures/transcribe/render.golden.json
    bunx biome format --write packages/ingest/test/fixtures/transcribe/render.golden.json
"""

from __future__ import annotations

import hashlib
import json
import platform
import sys
from importlib.metadata import version
from pathlib import Path
from typing import Any

from loguru import logger
from soniox.api._utils import build_create_payload
from soniox.types import CreateTranscriptionConfig, StructuredContext, Token, Transcription

from laplace_eidolon.tools import transcribe as t

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]


def tokens(rows: list[tuple[str, int | None, int | None]]) -> list[Token]:
    return [Token(text=text, start_ms=start, end_ms=end) for text, start, end in rows]


def segments(rows: list[tuple[float, float, str]]) -> list[t.Segment]:
    return [t.Segment(start=a, end=b, text=c) for a, b, c in rows]


def seg_rows(segs: list[t.Segment]) -> list[list[object]]:
    return [[s.start, s.end, s.text] for s in segs]


TOKEN_CASES = {
    "spec": [
        ("你", 0, 100),
        ("好", 200, 300),
        ("。", 3100, 3150),
        (" ", 3150, 3150),
        ("我", 3200, 3300),
        ("们", 3400, 3500),
        ("?", 3600, 3650),
        (" ", 3650, 3650),
        ("A", 6800, 6900),
        ("B", None, 7000),
        ("C", 37000, 37100),
    ],
    "english": [
        ("Hello", 0, 400),
        (" world", 400, 900),
        (".", 900, 950),
        (" How", 4000, 4200),
        (" are", 4200, 4400),
        (" you", 4400, 4600),
        ("?", 4600, 4700),
        ("  ", 4700, 4700),
        (" Fine", 8000, 8300),
        ("!", 8300, 8350),
    ],
    "whitespace_only": [(" ", 0, 0), ("　", 10, 10), ("\n", 4000, 4000)],
    "no_timestamps": [("a", None, None), ("b", 5, None), ("c", None, 9)],
    "sentence_then_space_runs": [
        ("一", 0, 100),
        ("。", 3000, 3050),
        ("\x1c", 3050, 3050),
        ("二", 3100, 3200),
        ("！", 6200, 6300),
        ("\x85", 6300, 6300),
        ("三", 6400, 6500),
    ],
    "long_gap": [("x", 0, 100), ("y", 45000, 45100), ("z", 45200, 45300)],
    "exact_min": [("a", 1000, 1100), (".", 3900, 4000), ("b", 4000, 4100)],
    "empty": [],
}

HINTS = [
    "喂？啊，好了好了好了。 什么游戏？",
    "Hello.World",
    "Wait!!! What",
    "好。。。",
    "x　y。 z",
    "a" * 58 + " bc" + "d" * 10,
    "😀" * 61,
    "a" * 60,
    "a" * 61,
    "。 abc",
    "!!!",
    "",
    "   \t\n ",
    "abc\x1c\x1ddef。\x85ghi",
    "a​b。 c",
    "﻿x。 y",
    "a" * 59 + " " + "b",
    "a" * 58 + " " + "b" * 3,
    "第一句话！第二句话？ 第三句",
    "end with space. ",
    "tab\tsep.\tnext",
]

SHORT_TS = [0, 0.4, 59.9, 60, 299.99, 300, 734.5, 3599.999, 3600, 3660, 35999, 360000, 1e7]
FORMAT_TS = [0, 59.9, 734.5, 3599.5, 3600, 86399, 360000.75]
FORMAT_DUR = [-5, 0, 42, 59.99, 60, 312, 3599, 3600, 5025, 86400, 360000]

OFFSET = 9337.6974165
BOUNDARY_VALUES = sorted(
    {
        *(k * 300.0 + d for k in range(0, 80) for d in (-1e-9, -1e-12, -1e-13, 0.0, 1e-13)),
        *(OFFSET + ms / 1000.0 for ms in range(262_290, 262_320)),
        *(OFFSET * 2 + ms / 1000.0 for ms in range(0, 40, 3)),
        599.9999999999999,
        600.0000000000001,
        0.30000000000000004,
        1e-300,
    }
)

SCENE_CASES = [
    ("spec", [(1, 2, " a "), (299.9, 330, "b"), (300, 301, "c"), (905.5, 906, "d")], 300),
    ("one", [(12.5, 14.0, "only")], 300),
    ("gaps", [(0.0, 3.0, "a"), (3.5, 4.0, "b"), (1234.5, 1240.0, "c"), (1235.0, 1236.0, "d")], 300),
    ("window_7", [(0.0, 1.0, "a"), (6.999, 8.0, "b"), (7.0, 9.0, "c"), (21.0, 22.0, "d")], 7),
    ("window_1", [(0.25, 0.5, "a"), (0.75, 1.0, "b"), (1.0, 2.0, "c")], 1),
    ("shifted", [(OFFSET + 262.3, OFFSET + 263.0, "x"), (OFFSET + 262.302, OFFSET + 270.0, "y")], 300),
    ("empty", [], 300),
]

RENDER_CASES = [
    {
        "stream_date": "2026-01-02",
        "stream_id": "2026-01-02-BV1aaaaaaaaa",
        "duration_min": 143,
        "source_file": "BV1aaaaaaaaa.m4a",
        "language": "zh",
        "scenes": [
            {"start": 300.0, "end": 330.0, "text": "喂？啊，好了好了好了。 什么游戏？"},
            {"start": 3600.0, "end": 3601.0, "text": "。 abc"},
            {"start": 7200.0, "end": 7201.0, "text": "tail  "},
        ],
    },
    {
        "stream_date": "2026-1-2",
        "stream_id": "x",
        "duration_min": 0,
        "source_file": "a b: c.m4a",
        "language": None,
        "scenes": [],
    },
]

CREATED_AT = [
    "2026-09-18T11:48:53.399Z",
    "2026-09-18T11:48:53.399000Z",
    "2026-09-18T11:48:53Z",
    "2026-09-18T11:48:53.000Z",
    "2026-09-18T11:48:53.1Z",
    "2026-09-18T11:48:53.123456Z",
    "2026-09-18T11:48:53.399+00:00",
    "2026-09-18T11:48:53.399+02:00",
    "2026-09-18T11:48:53.399-05:30",
    "2026-09-18 11:48:53.399Z",
]

TOKEN_DUMPS = [
    {"text": "是", "start_ms": 390, "end_ms": 570, "confidence": 0.8469772338867188},
    {"text": "好", "start_ms": 1, "end_ms": 2, "confidence": 1},
    {"text": "好", "start_ms": 1, "end_ms": 2, "confidence": 1.0, "is_audio_event": None},
    {"text": " ", "start_ms": 5, "end_ms": 5, "confidence": 0.5, "is_audio_event": True},
    {"text": "x", "is_audio_event": False, "speaker": "1", "zeta": 1.0, "alpha": [1, "a"]},
    {"is_audio_event": None, "language": "zh", "text": "y", "confidence": 1e-05},
]


def context_case(path: Path) -> dict[str, object]:
    """The loader's result or the error it raises, and whether the SDK accepts the result."""
    case: dict[str, object] = {"name": path.stem}
    try:
        ctx = t._load_soniox_context_dict(path, skip=False)
    except Exception as e:  # noqa: BLE001 — the golden records every outcome
        case["error_type"] = type(e).__name__
        case["error"] = str(e).replace(str(path), "<PATH>") if isinstance(e, RuntimeError) else None
        return case
    case["context"] = ctx
    case["serialized"] = None if ctx is None else json.dumps(ctx, ensure_ascii=False)
    case["summary"] = None if ctx is None else t._summarize_soniox_context(ctx)
    try:
        if ctx is not None:
            StructuredContext(**ctx)
        case["sdk_accepts"] = True
    except Exception:  # noqa: BLE001
        case["sdk_accepts"] = False
    return case


def create_body(ctx: dict[str, Any] | None, language: str | None) -> str:
    config = CreateTranscriptionConfig(
        language_hints=[language] if language else None,
        context=StructuredContext(**ctx) if ctx is not None else None,
    )
    payload = build_create_payload(
        model="stt-async-v5",
        file_id="file-1",
        audio_url=None,
        client_reference_id="laplace-eidolon:BV1aaaaaaaaa.m4a",
        config=config,
    )
    return json.dumps(payload.model_dump(exclude_none=True), ensure_ascii=False)


def main() -> None:
    logger.remove()
    glossary = REPO / "personas" / "milky-green" / "glossary.toml"
    real = t._load_soniox_context_dict(glossary, skip=False)
    assert real is not None
    real_serialized = json.dumps(real, ensure_ascii=False)
    contexts = [context_case(path) for path in sorted((HERE / "glossary").glob("*.toml"))]
    full = next(c for c in contexts if c["name"] == "full")["context"]
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}, soniox {version('soniox')}, "
            f"pydantic {version('pydantic')}: "
            "packages/ingest/test/fixtures/transcribe/render.golden.py"
        ),
        "short_ts": [[v, t._short_ts(v)] for v in SHORT_TS],
        "format_ts": [[v, t._format_ts(v)] for v in FORMAT_TS],
        "format_dur": [[v, t._format_dur(v)] for v in FORMAT_DUR],
        "hints": [[h, t._heading_hint(h)] for h in HINTS],
        "tokens_to_segments": {
            name: {
                "tokens": [list(row) for row in rows],
                "segments": seg_rows(t._tokens_to_segments(tokens(rows))),
            }
            for name, rows in TOKEN_CASES.items()
        },
        "floor_div_300": [[v, v // 300] for v in BOUNDARY_VALUES],
        "scenes": [
            {
                "name": name,
                "window": window,
                "segments": [list(row) for row in rows],
                "scenes": t.group_segments_into_scenes(segments(rows), window),
            }
            for name, rows, window in SCENE_CASES
        ],
        "render": [
            {"args": case, "markdown": t.render_markdown(**case)}  # type: ignore[arg-type]
            for case in RENDER_CASES
        ],
        "created_at": [
            [
                s,
                Transcription.model_validate(
                    {
                        "id": "x",
                        "status": "completed",
                        "created_at": s,
                        "model": "m",
                        "filename": "f",
                        "enable_speaker_diarization": False,
                        "enable_language_identification": False,
                    }
                ).created_at.isoformat(),
            ]
            for s in CREATED_AT
        ],
        "token_dumps": [
            [
                json.dumps(tok, ensure_ascii=False),
                json.dumps(
                    Token.model_validate(tok).model_dump(mode="json"), ensure_ascii=False, indent=2
                ),
            ]
            for tok in TOKEN_DUMPS
        ],
        "contexts": contexts,
        "create_bodies": {
            "context_zh": create_body(full, "zh"),  # type: ignore[arg-type]
            "no_context_no_language": create_body(None, None),
        },
        "real_glossary": {
            "chars": len(real_serialized),
            "sha256": hashlib.sha256(real_serialized.encode()).hexdigest(),
            "summary": t._summarize_soniox_context(real),
            "create_body_sha256": hashlib.sha256(create_body(real, "zh").encode()).hexdigest(),
        },
    }
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
