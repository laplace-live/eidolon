"""Prints download-real.golden.json: what tools/download.py's read_url_list and prepare_batch.py's
read_ids make of the real URL lists, as counts and hashes that carry no URLs.
download_real.test.ts hashes the same lines; change both.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import platform
import sys
from pathlib import Path

from laplace_eidolon.tools.download import read_url_list

REPO = Path(__file__).resolve().parents[5]
spec = importlib.util.spec_from_file_location(
    "prepare_batch", REPO / ".agents/skills/stream-archive-embed/scripts/prepare_batch.py"
)
assert spec and spec.loader
prepare_batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_batch)


def digest(values: list[str]) -> str:
    return hashlib.sha256("".join(f"{v}\n" for v in values).encode()).hexdigest()


def main() -> None:
    home = os.environ.get("EIDOLON_REAL_HOME") or os.environ.get("EIDOLON_HOME")
    root = Path(home).expanduser() if home else Path.home() / ".laplace" / "eidolon"
    lists_dir = root / "sources" / "milky-green" / "lists"
    # prepare_batch.py's baselines (data/video*.txt) and batches (data/auto-embed/videos-*.txt),
    # where the migration moved them.
    baselines = sorted(lists_dir.glob("video*.txt"))
    batches = sorted((lists_dir / "batches").glob("videos-*.txt"))
    lists = {}
    known: set[str] = set()
    for path in [*baselines, *batches]:
        urls = read_url_list(path)
        ids = prepare_batch.read_ids(path)
        known.update(ids)
        lists[path.relative_to(lists_dir).as_posix()] = {
            "file_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "urls": len(urls),
            "urls_sha256": digest(urls),
            "ids": len(ids),
            "ids_sha256": digest(ids),
        }
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}: "
            "packages/ingest/test/fixtures/download/download-real.golden.py over "
            "<EIDOLON_REAL_HOME>/sources/milky-green/lists"
        ),
        "lists": lists,
        "known": len(known),
        "known_sha256": digest(sorted(known)),
        "pending": [
            p.relative_to(lists_dir).as_posix()
            for p in batches
            if not p.with_suffix(".done.json").exists()
        ],
    }
    json.dump(golden, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
