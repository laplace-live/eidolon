"""Load a ``laplace-export-mem0`` dump into the self-hosted Mem0 store.

The counterpart to the export, for seeding a fresh Qdrant with memories
that predate the migration. Rows go in with ``infer=False``, so the text
is stored exactly as the cloud had it rather than being re-extracted by
an LLM, and the original ``created_at`` rides along in the metadata —
Mem0 only stamps its own when the key is absent.

Re-running is safe: every memory Mem0 stores carries an md5 of its text,
so a second pass skips what is already there rather than duplicating it.
That also makes an interrupted run resumable.

The target defaults to ``MEM0_QDRANT_HOST`` but ``--qdrant-host`` and
friends override it, which is the point: restoring to a deployment means
writing somewhere other than what ``.env`` describes, and ``.env`` loads
with ``override=True``, so exporting a shell variable would not win. The
resolved destination is printed before anything is written. The history
DB stays local to wherever this runs — only the memories land in Qdrant.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

DEFAULT_IN_PATH = "data/mem0-cloud-export.json"
DEFAULT_WORKERS = 8


def _existing_hashes(memory: Any, user_id: str) -> set[str]:
    """md5s of every memory already stored for ``user_id``.

    Mem0 hashes the memory text into the payload on write, which is what
    makes a re-run cheap: no embedding call is needed to tell whether a
    row is already present.
    """
    raw = memory.get_all(filters={"user_id": user_id}, top_k=100_000)
    rows = raw.get("results", []) if isinstance(raw, dict) else (raw or [])
    return {h for row in rows if (h := row.get("hash"))}


def _import_one(memory: Any, user_id: str, row: dict[str, Any]) -> str:
    """Insert one exported memory. Returns 'added', 'skipped', or 'failed:...'."""
    text = row.get("memory")
    if not isinstance(text, str) or not text.strip():
        return "skipped"

    metadata = dict(row.get("metadata") or {})
    if created_at := row.get("created_at"):
        metadata["created_at"] = created_at
    # Cloud-only enrichment the OSS engine never computes. Kept so the
    # dump stays lossless, but it lands in the payload's metadata blob
    # rather than the top-level field the admin API reads.
    if categories := row.get("categories"):
        metadata["categories"] = categories

    memory.add(
        messages=[{"role": "user", "content": text}],
        user_id=user_id,
        metadata=metadata,
        infer=False,
    )
    return "added"


def main() -> int:
    """Entry point for ``laplace-import-mem0``."""
    load_dotenv(override=True)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-i", "--in", dest="in_path", default=DEFAULT_IN_PATH, help="Dump to read"
    )
    parser.add_argument("--user", action="append", help="Only this user id; repeatable")
    parser.add_argument("--limit", type=int, help="Cap memories per user (for a trial run)")
    parser.add_argument(
        "--workers", type=int, default=DEFAULT_WORKERS, help="Concurrent inserts"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Report what would be written, write nothing"
    )
    parser.add_argument("--qdrant-host", help="Override MEM0_QDRANT_HOST for this run")
    parser.add_argument("--qdrant-port", help="Override MEM0_QDRANT_PORT for this run")
    parser.add_argument("--collection", help="Override MEM0_QDRANT_COLLECTION for this run")
    args = parser.parse_args()

    # After load_dotenv, which runs with override=True and would otherwise
    # win over anything exported in the shell.
    for flag, name in (
        (args.qdrant_host, "MEM0_QDRANT_HOST"),
        (args.qdrant_port, "MEM0_QDRANT_PORT"),
        (args.collection, "MEM0_QDRANT_COLLECTION"),
    ):
        if flag:
            os.environ[name] = str(flag)

    from .. import mem0_local

    if not mem0_local.is_configured():
        print("MEM0_QDRANT_HOST is unset — nothing to import into.", file=sys.stderr)
        return 1

    config = mem0_local.build_local_config()["vector_store"]["config"]
    print(
        f"target: qdrant {config['host']}:{config['port']} "
        f"collection={config['collection_name']}"
    )

    payload = json.loads(Path(args.in_path).read_text(encoding="utf-8"))
    entities = [
        e
        for e in payload.get("entities", [])
        if e.get("type") == "user" and e.get("memories")
    ]
    if args.user:
        wanted = set(args.user)
        entities = [e for e in entities if str(e.get("name")) in wanted]

    total = sum(len(e["memories"]) for e in entities)
    print(f"{len(entities)} users, {total} memories from {args.in_path}")
    if args.dry_run:
        print("(dry run — nothing written)")
        return 0

    from mem0 import Memory

    memory = Memory.from_config(mem0_local.build_local_config())

    added = skipped = failed = 0
    counts_lock = threading.Lock()

    for entity in entities:
        user_id = str(entity["name"])
        rows = entity["memories"][: args.limit] if args.limit else entity["memories"]
        try:
            seen = _existing_hashes(memory, user_id)
        except Exception as e:
            print(f"  {user_id}: could not read existing memories ({e}); skipping user")
            failed += len(rows)
            continue

        pending = [
            r
            for r in rows
            if isinstance(r.get("memory"), str)
            and hashlib.md5(r["memory"].encode()).hexdigest() not in seen
        ]
        already = len(rows) - len(pending)

        user_added = user_failed = 0
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(_import_one, memory, user_id, r): r for r in pending}
            for future in as_completed(futures):
                try:
                    if future.result() == "added":
                        user_added += 1
                except Exception as e:
                    user_failed += 1
                    print(f"  {user_id}: {type(e).__name__}: {e}", file=sys.stderr)

        with counts_lock:
            added += user_added
            skipped += already
            failed += user_failed
        print(
            f"  {user_id}: +{user_added} added, {already} already present"
            + (f", {user_failed} failed" if user_failed else "")
        )

    print(f"\nadded {added}, skipped {skipped} already present, failed {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
