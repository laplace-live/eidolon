"""Prints vectors.golden.json: what tools/refine.py's validators, lenient JSON parser, usage
accounting and prompt helpers make of each input below. refine.test.ts feeds the same
inputs to the TypeScript port; change both together.
"""

from __future__ import annotations

import json
import platform
import sys
from pathlib import Path
from typing import Any

from loguru import logger

from laplace_eidolon.tools import refine as r
from laplace_eidolon.tools._streams import ParsedStream

logger.remove()

EXTRACT = [
    # The spec's vectors (refine.md §5.3).
    '{"sc_events": [{"viewer": null, "content": null, "amount_yuan": "30", "response": null},'
    ' {"viewer": "  ", "content": "hi", "amount_yuan": 12.7}, {"viewer": "a", "amount_yuan": true},'
    ' {"viewer": "b", "amount_yuan": " 1_000 "}, {"viewer": "c", "amount_yuan": "30.5"},'
    ' {"viewer": "", "content": ""}, "not a dict"]}',
    '{"songs": [{"title": null, "note": "x"}, {"title": "", "note": "lyric"}, "  Song A  ",'
    ' {"title": "B"}, 5]}',
    '{"events": ["  e1 ", "", null, 3, {"k": "v"}, ["l"]]}',
    '{"topics": ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12"],'
    ' "is_anime_audio_dominant": "false"}',
    '[{"topics": ["a"], "is_karaoke_dominant": 1}, {"topics": ["b"], "events": "notalist"}]',
    "[]",
    "[1]",
    '"str"',
    # int() on amounts: NaN is a ValueError, infinity an OverflowError nothing catches.
    '{"sc_events": [{"viewer": "n", "amount_yuan": NaN}, {"viewer": "f", "amount_yuan": -2.9},'
    ' {"viewer": "e", "amount_yuan": 1e2}, {"viewer": "l", "amount_yuan": [1]},'
    ' {"viewer": "d", "amount_yuan": {"a": 1}}, {"viewer": "u", "amount_yuan": "\u0663"},'
    ' {"viewer": "z", "amount_yuan": false}, {"content": "only content"}]}',
    '{"sc_events": [{"viewer": "x", "amount_yuan": Infinity}]}',
    # str() of every JSON type, Unicode strip, and caps applied after filtering.
    '{"topics": [1.0, 2.5, -0.0, 1e20, 1e-7, true, null], "mentions": [{"k": "it\'s"}],'
    ' "events": ["\\u3000x\\u3000", "\\u00a0", "\\ufeffy", "\\u0085z\\u001c"],'
    ' "sc_events": [{"viewer": {"a": [1, null, true]}, "content": 5, "response": 1.5}]}',
    '{"events": ' + json.dumps([f"e{i}" for i in range(60)]) + ","
    ' "promises": ' + json.dumps(["", " "] * 30 + [f"p{i}" for i in range(55)]) + ","
    ' "key_quotes": ' + json.dumps([f"q{i}" for i in range(12)]) + ","
    ' "mentions": ' + json.dumps([f"m{i}" for i in range(52)]) + "}",
    '{"events": "x", "topics": {"a": 1}, "songs": {"title": "t"}, "sc_events": "s",'
    ' "is_anime_audio_dominant": 0.0, "is_karaoke_dominant": []}',
    '{"is_anime_audio_dominant": NaN, "is_karaoke_dominant": "0"}',
    '[{"sc_events": [{"viewer": "v1"}], "songs": ["s1"], "is_anime_audio_dominant": 0},'
    ' {"sc_events": null, "songs": [{"title": "s2", "note": " n "}], "key_quotes": ["k"],'
    ' "is_anime_audio_dominant": [0]}, {"mentions": "notalist", "promises": ["p"]}]',
    '[{"topics": ["only"]}]',
    "5",
    "5.5",
    "true",
    "null",
    "{}",
]

SYNTHESIS = [
    '{"heading": " H ", "summary": " S ", "details": null, "chunk_type": " KARAOKE "}',
    '{"heading": "H", "summary": ""}',
    '{"heading": "", "summary": "S"}',
    '{"heading": "H", "summary": "S", "chunk_type": "weird"}',
    '{"heading": "H", "summary": "S"}',
    '[{"heading": "A", "summary": "B", "chunk_type": "closing"}, {"heading": "C", "summary": "D"}]',
    "[]",
    '["x"]',
    '"s"',
    '{"heading": 1.0, "summary": 2, "chunk_type": null, "details": ["d"]}',
    '{"heading": "H", "summary": "S", "chunk_type": "\u212aaraoke"}',
    '{"heading": "H", "summary": "S", "chunk_type": "SC_SESSION", "details": " d "}',
    "3",
]

LENIENT = [
    # The spec's table (refine.md §6.4).
    '{"a": 1}',
    '{"a": "x\ny"}',
    '{"a": 1}}',
    '{"a": 1}\n{"a": 1}',
    '{"a": "x\ny"}}',
    '```json\n{"a": 1}\n```',
    'Here: {"a": 1}',
    "null",
    '{"a": NaN}',
    '{"a": "abc',
    '[{"a": 1}]',
    '\u3000{"a": 1}',
    # More of the scanner's edges.
    '\ufeff{"a": 1}',
    '{"a": "\t"}',
    '{"a": "x\\"}',
    '{"a": "\x01\x1f"}',
    '{"a": 1.0, "b": -0, "c": 1e400, "d": -Infinity}',
    "   ",
    "",
    '{"a": [1, 2,]}',
    '{"a": "x"',
    '{"a":"x"}\n\n garbage',
    '{\n  "a": "line\nbreak",\n  "b": [\n    1\n  ]\n}',
    '{"a": "\\u00e9\\ud83d\\ude00\\ud800"}',
    '{"a": "x\ny"}\n{"b": "p\tq"}',
    '{"a": 1}\x00',
    '\n\t {"a": "\r"}',
]

SANITIZE = [
    'a\nb"c\nd"e\nf',
    '"\\"\n"',
    '"\\\n"',
    '"\x00\x07\x1b\x7f\u2028"',
    "no strings\n\t\r",
    '"unterminated\n',
]

CONTEXT = [
    {"stream_date": "2022-04-24", "language": "zh", "duration_min": 143, "source_file": "x.m4a"},
    {"stream_date": "2022-04-24", "language": "zh", "duration_min": 0},
    {},
    {"mood": "happy", "notes": ["a", "b"], "duration_min": 180.0, "language": False},
    {"notes": {"k": 1}, "stream_date": None, "language": "", "duration_min": True},
]

HEADINGS = ["05:00 — 喂？啊，好了", "无破折号", "  01:23  —  x — y", "—x", "a–b", ""]

USAGE_RESPONSES = [
    {"usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.001}},
    {
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "cost": 0,
            "cost_details": {"upstream_inference_cost": 0.0005},
        }
    },
    {"usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0}},
    {"usage": {"prompt_tokens": 1234, "completion_tokens": 567}},
    {"usage": None},
    {},
    {"usage": {"prompt_tokens": "12", "completion_tokens": 12.7, "cost": "0.25"}},
    {
        "usage": {
            "prompt_tokens": True,
            "completion_tokens": None,
            "cost": None,
            "cost_details": {"upstream_inference_cost": None},
        }
    },
    {"usage": {"prompt_tokens": 3, "completion_tokens": 4, "cost": -1}},
]
USAGE_MODELS = ["~google/gemini-flash-latest", "~google/gemini-pro-latest"]

# Usage.add's asymmetric cost-source rule, over every pair and a few chains.
SOURCES = ["openrouter", "estimate", "mixed", "unknown"]
CHAINS = [
    [("openrouter", 0.1), ("estimate", 0.2), ("openrouter", 0.3)],
    [("estimate", 0.1), ("openrouter", 0.2)],
    [("unknown", 0.0), ("unknown", 0.0), ("estimate", 0.00001)],
    [("openrouter", 0.1), ("openrouter", 0.2), ("unknown", 0.0)],
    [("mixed", 0.1), ("estimate", 0.2)],
]


def _parsed(metadata: dict[str, Any]) -> ParsedStream:
    return ParsedStream(md_path=Path("x.md"), stream_id="x", metadata=metadata, chunks=[])


def _error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _validate(fn: Any, text: str) -> dict[str, str]:
    try:
        return {"input": text, "result": _dumps(fn(json.loads(text)))}
    except Exception as exc:  # noqa: BLE001 — the error is the vector's output
        return {"input": text, "error": _error(exc)}


def _usage(prompt: int, completion: int, cost: float, source: str) -> r.Usage:
    return r.Usage(
        prompt_tokens=prompt, completion_tokens=completion, cost_usd=cost, cost_source=source
    )


def _usage_out(u: r.Usage) -> dict[str, Any]:
    return {
        "prompt_tokens": u.prompt_tokens,
        "completion_tokens": u.completion_tokens,
        "cost_usd": repr(u.cost_usd),
        "cost_source": u.cost_source,
        "fmt": r._fmt_cost(u),
    }


def main() -> None:
    lenient = []
    for text in LENIENT:
        value, note = r._parse_json_lenient(text)
        # ASCII-escaped: a parsed value can hold a lone surrogate.
        lenient.append({"input": text, "value": json.dumps(value), "note": note})

    pairs = []
    for a in SOURCES:
        for b in SOURCES:
            u = _usage(1, 2, 0.5, a)
            u.add(_usage(3, 4, 0.25, b))
            pairs.append({"self": a, "other": b, **_usage_out(u)})
    chains = []
    for chain in CHAINS:
        u = r.Usage()
        for source, cost in chain:
            u.add(_usage(1, 1, cost, source))
        chains.append({"chain": chain, **_usage_out(u)})

    extracted = []
    for model in USAGE_MODELS:
        for response in USAGE_RESPONSES:
            extracted.append(
                {
                    "model": model,
                    "response": response,
                    **_usage_out(r._extract_usage(response, model)),
                }
            )

    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}: laplace_eidolon.tools.refine through "
            "packages/ingest/test/fixtures/refine/vectors.golden.py"
        ),
        "extract": [_validate(r._validate_extract, t) for t in EXTRACT],
        "synthesis": [_validate(r._validate_synthesis, t) for t in SYNTHESIS],
        "lenient": lenient,
        "sanitize": [{"input": t, "output": r._sanitize_json_text(t)} for t in SANITIZE],
        "context": [{"metadata": m, "context": r._stream_context(_parsed(m))} for m in CONTEXT],
        "timestamps": [{"heading": h, "timestamp": r._heading_timestamp(h)} for h in HEADINGS],
        "usage_pairs": pairs,
        "usage_chains": chains,
        "extract_usage": extracted,
        "v2": [
            {"record": rec, "v2": r._is_v2_refinement(rec)}
            for rec in [
                {"details": "", "key_quotes": []},
                {"details": "d"},
                {"key_quotes": []},
                [],
                None,
                "x",
                {"summary": "s", "heading": "h"},
            ]
        ],
    }
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
