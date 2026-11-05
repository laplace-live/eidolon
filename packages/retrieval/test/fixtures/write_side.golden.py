"""Prints write_side.golden.json: EmbedCache keys, blobs and file, embed_in_batches and main_async
log lines with the embedding call stubbed, both Arrow schemas at EMBED_DIM=4, and what
write_table makes of a few rows of each table. Synthetic inputs only; every table and cache goes
into a temporary directory.
"""

from __future__ import annotations

import os

# Both are read when laplace_eidolon.embeddings is imported.
os.environ["EMBED_DIM"] = "4"
os.environ.pop("EMBED_MODEL", None)

import argparse
import asyncio
import json
import platform
import sqlite3
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from types import ModuleType
from typing import Any

import lancedb
import numpy as np
import pyarrow as pa
from loguru import logger

from laplace_eidolon import embeddings
from laplace_eidolon.embeddings import EmbedCache, EmbeddingUsage
from laplace_eidolon.tools import ingest_facts, ingest_streams

MODEL = embeddings.DEFAULT_EMBED_MODEL
DIM = embeddings.DEFAULT_EMBED_DIM

messages: list[str] = []
logger.remove()
logger.add(lambda m: messages.append(m.record["message"]), level="DEBUG")


def fake_vector(text: str) -> list[float]:
    base = sum(ord(c) for c in text) % 97
    return [base / 7, -base / 3, 0.1 * base, 1 / (base + 3)]


def stub(module: ModuleType, usages: list[EmbeddingUsage], calls: list[dict[str, Any]]) -> None:
    async def fake(
        texts: list[str], model: str | None = None, dimensions: int | None = None
    ) -> tuple[list[list[float]], EmbeddingUsage]:
        calls.append({"texts": list(texts), "model": model, "dimensions": dimensions})
        return [fake_vector(t) for t in texts], usages.pop(0)

    setattr(module, "embed_texts_with_usage", fake)


def f32_hex(vector: Any) -> str:
    return np.asarray(vector, dtype=np.float32).tobytes().hex()


def usage_list(u: EmbeddingUsage) -> list[Any]:
    return [u.prompt_tokens, u.total_tokens, u.cost_usd, u.cost_source]


def scenario(
    tmp: Path,
    name: str,
    module: ModuleType,
    texts: list[str],
    batch_size: int,
    seeded: list[int],
    usages: list[EmbeddingUsage],
    use_cache: bool = True,
) -> dict[str, Any]:
    messages.clear()
    calls: list[dict[str, Any]] = []
    stub(module, list(usages), calls)
    cache = None
    if use_cache:
        cache = EmbedCache(tmp / f"{name}.db")
        cache.put_many(MODEL, DIM, [(texts[i], fake_vector(texts[i])) for i in seeded])
    rows: list[dict[str, Any]] = [{"embed_input": t} for t in texts]
    total = asyncio.run(module.embed_in_batches(rows, batch_size=batch_size, cache=cache))
    blobs: dict[str, str | None] = {}
    count = None
    if cache is not None:
        for t in texts:
            got = cache.get_many(MODEL, DIM, [t])
            blobs[t] = f32_hex(got[0]) if got else None
        count = cache.count()
        cache.close()
    return {
        "name": name,
        "noun": "chunks" if module is ingest_streams else "facts",
        "texts": texts,
        "batch_size": batch_size,
        "seeded": seeded,
        "use_cache": use_cache,
        "usages": [usage_list(u) for u in usages],
        "messages": list(messages),
        "calls": calls,
        "vectors_f32_hex": [f32_hex(r["vector"]) if "vector" in r else None for r in rows],
        "total": usage_list(total),
        "cache_count": count,
        "cache_blobs": blobs,
    }


def totals(tmp: Path) -> dict[str, str]:
    streams = tmp / "streams"
    streams.mkdir()
    (streams / "2026-01-02-BV1x.md").write_text(
        "---\nstream_date: 2026-01-02\nstream_id: 2026-01-02-BV1x\n---\n"
        "## 00:00 — A\n第一段。\n\n## 01:00 — B\n第二段。\n",
        encoding="utf-8",
    )
    facts = tmp / "facts"
    facts.mkdir()
    (facts / "x设定集.txt").write_text("店长喜欢吃坚果。\n店长有一只猫。\n", encoding="utf-8")
    sources = {
        "openrouter": EmbeddingUsage(11, 11, 0.0000123, "openrouter"),
        "estimate": EmbeddingUsage(11, 12, 12 * 0.15 / 1e6, "estimate"),
        "mixed": EmbeddingUsage(11, 13, 0.000002, "mixed"),
        "unknown": EmbeddingUsage(11, 14, 0.0, "unknown"),
    }
    out: dict[str, str] = {}
    for source, usage in sources.items():
        runs = [
            ("chunks", ingest_streams, argparse.Namespace(
                streams_dir=str(streams), db_path=str(tmp / f"streams-{source}"),
                table="stream_chunks", skip_types="", dry_run=False, cache_path="",
                no_cache=True, clear_cache=False,
            )),
            ("facts", ingest_facts, argparse.Namespace(
                data_dir=str(facts), files=None, min_chars=4, no_strip_prefix=False,
                db_path=str(tmp / f"facts-{source}"), table="persona_facts", dry_run=False,
                cache_path="", no_cache=True, clear_cache=False,
            )),
        ]
        for noun, module, args in runs:
            messages.clear()
            stub(module, [usage], [])
            assert asyncio.run(module.main_async(args)) == 0
            out[f"{noun}/{source}"] = next(m for m in messages if m.startswith("Embedding totals"))
    return out


FACT_ROWS: list[dict[str, Any]] = [
    {"id": "f0", "source": "a设定集.txt", "date": "2026-05-09", "floor": 12, "text": "坚果体重5.5kg",
     "tokens": "坚果 体重 5.5 kg", "embed_input": "2026-05-09 体重5.5kg", "vector": [1.0, 0.0, 0.0, 0.0]},
    {"id": "f1", "source": "b事件集.txt", "date": "", "floor": 0, "text": "坚果出生",
     "tokens": "坚果 出生", "embed_input": "出生", "vector": [0.9, 0.1, -0.0, 1e-45]},
    {"id": "f2", "source": "a设定集.txt", "date": "2025-01-02", "floor": -7, "text": "Café BV1x",
     "tokens": "Café BV1x", "embed_input": "Café", "vector": [1 / 3, 2.5e-38, 16777217.0, -1.5]},
]
CHUNK_ROWS: list[dict[str, Any]] = [
    {"id": "s_p1::000", "stream_id": "s_p1", "stream_date": "2026-09-08", "heading": "开场问候",
     "text": "大家好。", "summary": "", "details": "我和大家打了招呼。", "chunk_type": "karaoke",
     "topics": '"ab"', "mentions": '["Alex"]', "extras_json": '{"key_quotes": []}',
     "refined": True, "tokens": "开场 问候", "source_path": "streams/s_p1.md",
     "embed_input": "On 2026-09-08, 开场问候.\n大家好。", "vector": [0.5, 0.25, 0.125, 1.0]},
    {"id": "s_p1::001", "stream_id": "s_p1", "stream_date": "None", "heading": "10:00 — 第三段",
     "text": "继续聊天。", "summary": "", "details": "", "chunk_type": "", "topics": "[]",
     "mentions": "[]", "extras_json": "{}", "refined": False, "tokens": "10 : 00 — 第三 三段",
     "source_path": "streams/s_p1.md", "embed_input": "x", "vector": [0.0, 1.0, 0.0, 0.0]},
]


def written(tmp: Path, name: str, module: ModuleType, rows: list[dict[str, Any]]) -> dict[str, Any]:
    db_path = tmp / name
    db_path.mkdir()
    module.write_table([dict(r) for r in rows], db_path, name)
    table = lancedb.connect(str(db_path)).open_table(name)
    [index] = table.list_indices()
    data = table.to_arrow().to_pylist()
    return {
        "rows": rows,
        "indices": [[index.name, index.index_type, index.columns, index.index_details]],
        "versions": [v["version"] for v in table.list_versions()],
        "manifests": sorted(p.name for p in (db_path / f"{name}.lance" / "_versions").iterdir()),
        "read_back": [{k: v for k, v in r.items() if k != "vector"} for r in data],
        "vectors_f32_hex": [f32_hex(r["vector"]) for r in data],
    }


def cache_file(tmp: Path) -> dict[str, Any]:
    path = tmp / "fresh" / "embed_cache.db"
    EmbedCache(path).close()
    with sqlite3.connect(path) as db:
        sql = db.execute("SELECT sql FROM sqlite_master WHERE name = 'embed_cache'").fetchone()[0]
        mode = db.execute("PRAGMA journal_mode").fetchone()[0]
    return {"sql": sql, "journal_mode": mode}


def describe(schema: pa.Schema) -> dict[str, Any]:
    fields: list[list[Any]] = []
    for f in schema:
        entry: list[Any] = [f.name, str(f.type), f.nullable]
        if isinstance(f.type, pa.FixedSizeListType):
            item = f.type.value_field
            entry += [item.name, str(item.type), item.nullable]
        fields.append(entry)
    return {"metadata": dict(schema.metadata or {}), "fields": fields}


def main() -> None:
    key_cases: list[tuple[str, int, str]] = [
        ("google/gemini-embedding-2-preview", 3072, "On 2026-09-08, 开场问候.\n大家好。"),
        ("", 3072, ""),
        ("m", 4, "a\0b"),
        ("~google/x", 1, "😀 emoji"),
        ("openai/text-embedding-3-large", 3072, "line1\r\nline2"),
    ]
    # Rounding to float32: ties to even, the smallest subnormal, overflow to inf, -0.0.
    blob_cases = [
        [0.1, -0.0, 1e-45, 3.4028235e38],
        [1 / 3, 0.30000000000000004, 16777217.0, 1e39],
        [2.5e-38, -1.5, 0.0, 7.006492321624085e-46],
    ]
    seven = ["零", "一 one", "二\n二", "三3", "四 four", "五", "六 six"]
    with tempfile.TemporaryDirectory() as name:
        tmp = Path(name)
        scenarios = [
            scenario(tmp, "mixed", ingest_streams, seven, 2, [1], [
                EmbeddingUsage(7, 7, 7 * 0.15 / 1e6, "estimate"),
                EmbeddingUsage(9, 9, 0.0000123, "openrouter"),
                EmbeddingUsage(5, 6, 0.0, "unknown"),
            ]),
            scenario(tmp, "facts-nocache", ingest_facts, ["甲", "乙", "丙"], 96, [], [
                EmbeddingUsage(3, 3, 3 * 0.15 / 1e6, "estimate"),
            ], use_cache=False),
            scenario(tmp, "all-cached", ingest_facts, ["甲", "乙"], 96, [0, 1], []),
            scenario(tmp, "no-hits", ingest_streams, ["a", "b", "c"], 64, [], [
                EmbeddingUsage(0, 0, 0.0, "unknown"),
            ]),
            scenario(tmp, "empty-nocache", ingest_streams, [], 64, [], [], use_cache=False),
            scenario(tmp, "dup-texts", ingest_streams, ["x", "y", "x"], 2, [], [
                EmbeddingUsage(2, 2, 0.5, "openrouter"),
                EmbeddingUsage(1, 1, 0.25, "openrouter"),
            ]),
        ]
        totals_lines = totals(tmp)
        tables = {
            "persona_facts": written(tmp, "persona_facts", ingest_facts, FACT_ROWS),
            "stream_chunks": written(tmp, "stream_chunks", ingest_streams, CHUNK_ROWS),
        }
        file = cache_file(tmp)
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}, numpy {version('numpy')}, "
            f"pyarrow {version('pyarrow')}, lancedb {version('lancedb')}: "
            "packages/retrieval/test/fixtures/write_side.golden.py through "
            "laplace_eidolon.embeddings and tools.ingest_streams / tools.ingest_facts"
        ),
        "keys": [[m, d, t, EmbedCache._key(m, d, t)] for m, d, t in key_cases],
        "blobs": [[v, f32_hex(v)] for v in blob_cases],
        "cache_file": file,
        "tables": tables,
        "scenarios": scenarios,
        "totals": totals_lines,
        "schemas": {
            "persona_facts": describe(ingest_facts.build_arrow_schema()),
            "stream_chunks": describe(ingest_streams.build_arrow_schema()),
        },
    }
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
