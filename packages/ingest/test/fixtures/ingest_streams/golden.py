"""Prints ingest_streams.golden.json: what tools/ingest_streams.py and tools/build_stream_catalog.py
make of the synthetic transcripts in inputs.json. load_streams' rows and log lines for three skip
sets; ingest main()'s exit codes, log lines, stubbed embedding calls and written rows for a dry
run, an empty folder, a cold, warm and cleared cache, --no-cache and --skip-types ''; catalog
main()'s exit codes, log lines and file (built_at masked); and the TS commands' help as argparse
lays it out at 80 columns. Every file goes into a temporary folder; .env is never read.
"""

from __future__ import annotations

import os

# EMBED_DIM is read when laplace_eidolon.embeddings is imported, the rest when main() parses.
os.environ["EMBED_DIM"] = "4"
for _name in ("EMBED_MODEL", "INGEST_SKIP_TYPES", "LANCEDB_PATH"):
    os.environ.pop(_name, None)
os.environ["COLUMNS"] = "80"

import argparse
import json
import platform
import re
import shutil
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any

import lancedb
import numpy as np
from loguru import logger

from laplace_eidolon.embeddings import EmbeddingUsage
from laplace_eidolon.tools import build_stream_catalog, ingest_streams

HERE = Path(__file__).resolve().parent
INPUTS = json.loads((HERE / "inputs.json").read_text(encoding="utf-8"))

records: list[list[str]] = []
logger.remove()
logger.add(lambda m: records.append([m.record["level"].name, m.record["message"]]), level="DEBUG")


def _no_dotenv(*_args: object, **_kwargs: object) -> bool:
    return False


setattr(ingest_streams, "load_dotenv", _no_dotenv)
setattr(build_stream_catalog, "load_dotenv", _no_dotenv)


def fake_vector(text: str) -> list[float]:
    base = sum(ord(c) for c in text) % 97
    return [base / 7, -base / 3, 0.1 * base, 1 / (base + 3)]


calls: list[int] = []


async def fake_embed(
    texts: list[str], model: str | None = None, dimensions: int | None = None
) -> tuple[list[list[float]], EmbeddingUsage]:
    assert model == "google/gemini-embedding-2-preview" and dimensions == 4
    calls.append(len(texts))
    usage = EmbeddingUsage(
        prompt_tokens=7 * len(texts),
        total_tokens=7 * len(texts),
        cost_usd=0.000001 * len(texts),
        cost_source="openrouter",
    )
    return [fake_vector(t) for t in texts], usage


setattr(ingest_streams, "embed_texts_with_usage", fake_embed)


def materialize(files: dict[str, str], folder: Path) -> Path:
    folder.mkdir(parents=True)
    for name, text in files.items():
        (folder / name).write_text(text, encoding="utf-8")
    return folder


def placehold(text: str, paths: dict[str, str]) -> str:
    for placeholder, path in paths.items():
        text = text.replace(path, placeholder)
    return text


def run_main(module: Any, prog: str, argv: list[str], paths: dict[str, str]) -> dict[str, Any]:
    records.clear()
    calls.clear()
    sys.argv = [prog, *argv]
    try:
        code = module.main()
    except SystemExit as exc:
        code = exc.code
    return {
        "argv": [placehold(a, paths) for a in argv],
        "exit_code": code,
        "logs": [[level, placehold(message, paths)] for level, message in records],
        "embed_calls": list(calls),
    }


def table_rows(db_path: Path) -> dict[str, Any]:
    table = lancedb.connect(str(db_path)).open_table("stream_chunks")
    rows = table.to_arrow().to_pylist()
    return {
        "rows": [{k: v for k, v in row.items() if k != "vector"} for row in rows],
        "vectors_f32_hex": [
            np.asarray(row["vector"], dtype=np.float32).tobytes().hex() for row in rows
        ],
    }


def load_scenarios(streams: Path, paths: dict[str, str]) -> list[dict[str, Any]]:
    out = []
    for skip in (["anime_audio", "karaoke"], [], ["commentary", "sc_session", "None"]):
        records.clear()
        rows = ingest_streams.load_streams(streams, skip_types=set(skip))
        out.append(
            {
                "skip_types": skip,
                "rows": rows,
                "logs": [[level, placehold(message, paths)] for level, message in records],
            }
        )
    return out


def masked_catalog(path: Path) -> str | None:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    masked, count = re.subn(r'"built_at": "[^"]*"', '"built_at": "<BUILT_AT>"', text, count=1)
    assert count == 1
    return masked


STREAMS_HELP = (
    "Directory of *.md transcripts (default: the persona's streams/ in the data home's sources)"
)
INDEX_DEFAULT = (
    "the index the bot reads: knowledge.index or $LANCEDB_PATH, else the persona's index/ in "
    "the data home"
)
JSON_HELP = "Write progress events to stdout as JSON lines"


def ingest_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="laplace-ingest-streams", description=(ingest_streams.__doc__ or "").splitlines()[0]
    )
    p.add_argument("--streams-dir", help=STREAMS_HELP)
    p.add_argument("--db-path", help=f"LanceDB directory (default: {INDEX_DEFAULT})")
    p.add_argument("--table", help="Table name (default: stream_chunks)")
    p.add_argument(
        "--skip-types",
        help=(
            "Comma-separated chunk_type values to drop from the index (default: "
            "knowledge.archive.skipTypes or $INGEST_SKIP_TYPES, else 'anime_audio,karaoke'; "
            "none drops nothing). Pass an empty string to disable filtering."
        ),
    )
    p.add_argument(
        "--dry-run", action="store_true", help="Parse and chunk but skip embedding and writing."
    )
    p.add_argument(
        "--cache-path",
        help=(
            "SQLite file used to cache embedding vectors so a crashed/re-run ingest skips work "
            "that already succeeded (default: cache/embed_cache.db in the data home). Cache key "
            "is (model, dim, text); changing EMBED_MODEL or EMBED_DIM auto-invalidates entries."
        ),
    )
    p.add_argument(
        "--no-cache",
        action="store_true",
        help="Skip the embedding cache entirely (always re-embed).",
    )
    p.add_argument(
        "--clear-cache",
        action="store_true",
        help=(
            "Empty the embedding cache before this run. Every persona and model shares it, so "
            "this deletes all of their vectors."
        ),
    )
    p.add_argument(
        "--persona", help="Persona whose transcripts to ingest (default: the active persona)"
    )
    p.add_argument("--json", action="store_true", help=JSON_HELP)
    return p


def catalog_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="laplace-build-stream-catalog",
        description=(build_stream_catalog.__doc__ or "").splitlines()[0],
    )
    p.add_argument("--streams-dir", help=STREAMS_HELP)
    p.add_argument("--db-path", help=f"Where stream_catalog.json goes (default: {INDEX_DEFAULT})")
    p.add_argument(
        "--persona", help="Persona whose transcripts to read (default: the active persona)"
    )
    p.add_argument("--json", action="store_true", help=JSON_HELP)
    return p


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="ingest-streams-golden-")).resolve()
    try:
        streams = materialize(INPUTS["streams"], tmp / "streams")
        bad = materialize(INPUTS["bad_date"], tmp / "bad")
        empty = tmp / "empty"
        empty.mkdir()
        paths = {"<STREAMS>": str(streams), "<TMP>": str(tmp)}
        cache = str(tmp / "cache" / "embed_cache.db")

        def ingest(*argv: str) -> dict[str, Any]:
            return run_main(ingest_streams, "laplace-ingest-streams", list(argv), paths)

        runs: list[dict[str, Any]] = []
        source = ["--streams-dir", str(streams)]
        cached = ["--db-path", str(tmp / "db"), "--cache-path", cache]
        for name, argv, db in [
            ("dry_run", [*source, "--db-path", str(tmp / "dry"), "--dry-run"], None),
            ("empty", ["--streams-dir", str(empty), "--db-path", str(tmp / "db0")], None),
            ("cold", [*source, *cached], tmp / "db"),
            ("warm", [*source, *cached], tmp / "db"),
            ("cleared", [*source, *cached, "--clear-cache"], tmp / "db"),
            ("no_cache", [*source, "--db-path", str(tmp / "db2"), "--no-cache"], tmp / "db2"),
            (
                "skip_nothing",
                [*source, "--db-path", str(tmp / "db3"), "--no-cache", "--skip-types", ""],
                tmp / "db3",
            ),
        ]:
            result = {"name": name, **ingest(*argv)}
            result["table"] = None
            if db is not None and result["exit_code"] == 0:
                result["table"] = table_rows(db)
            runs.append(result)

        catalogs: list[dict[str, Any]] = []

        def catalog(name: str, streams_dir: str, db: Path) -> None:
            result = run_main(
                build_stream_catalog,
                "laplace-build-stream-catalog",
                ["--streams-dir", streams_dir, "--db-path", str(db)],
                paths,
            )
            result["text"] = masked_catalog(db / "stream_catalog.json")
            catalogs.append({"name": name, **result})

        catalog("absolute", str(streams), tmp / "cat")
        catalog("empty", str(empty), tmp / "cat-empty")
        catalog("bad_date", str(bad), tmp / "cat-bad")
        cwd = os.getcwd()
        os.chdir(streams)
        try:
            catalog("relative_dot", ".", tmp / "cat-dot")
        finally:
            os.chdir(cwd)

        golden = {
            "printed_by": (
                f"{platform.python_implementation()} {platform.python_version()}, "
                f"lancedb {version('lancedb')}, jieba {version('jieba')}, "
                f"python-frontmatter {version('python-frontmatter')}, PyYAML {version('PyYAML')}: "
                "packages/ingest/test/fixtures/ingest_streams/golden.py with EMBED_DIM=4 and "
                "embed_texts_with_usage stubbed"
            ),
            "load_streams": load_scenarios(streams, paths),
            "ingest": runs,
            "catalog": catalogs,
            "help": {
                "ingest_streams": [ingest_parser().format_usage(), ingest_parser().format_help()],
                "build_stream_catalog": [
                    catalog_parser().format_usage(),
                    catalog_parser().format_help(),
                ],
            },
        }
        json.dump(golden, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
