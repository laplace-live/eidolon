"""Dump every memory in the Mem0 cloud account to a JSON file.

A one-way backup taken before the bot moved to a self-hosted Mem0 engine
(``mem0_local.py``). It is the only code left that talks to the cloud, so
it reads ``MEM0_API_KEY`` directly rather than through the runtime config.

The cloud groups memories by entity, so the export walks ``users()`` and
pages ``get_all`` per entity. Output is one JSON object per entity, with
the rows exactly as the API returned them — no projection, so the dump
stays re-importable if the decision to start fresh is ever revisited.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

DEFAULT_OUT_PATH = "data/mem0-cloud-export.json"
PAGE_SIZE = 100


def _entity_filters(entity: dict[str, Any]) -> dict[str, str] | None:
    """Build the ``get_all`` filter for one row of ``users()``.

    Returns ``None`` for a row whose type isn't one of the three the API
    filters on, which would otherwise export as an empty bucket.
    """
    entity_type = entity.get("type")
    name = entity.get("name")
    if not name or entity_type not in ("user", "agent", "run"):
        return None
    return {f"{entity_type}_id": str(name)}


def _fetch_all(client: Any, filters: dict[str, str]) -> list[dict[str, Any]]:
    """Page through ``get_all`` for one entity until the API stops advancing."""
    rows: list[dict[str, Any]] = []
    page = 1
    while True:
        raw = client.get_all(filters=filters, page=page, page_size=PAGE_SIZE)
        batch = raw.get("results", []) if isinstance(raw, dict) else (raw or [])
        rows.extend(batch)
        if not isinstance(raw, dict) or not raw.get("next") or not batch:
            return rows
        page += 1


def _fetch_entities(client: Any) -> list[dict[str, Any]]:
    """Every entity in the account, following ``users()``'s pagination.

    ``MemoryClient.users()`` returns only the first page and takes no page
    argument, so the rest come from following the absolute ``next`` URL on
    its own httpx client, which already carries the auth headers.
    """
    raw = client.users()
    if not isinstance(raw, dict):
        return list(raw or [])

    rows = list(raw.get("results", []))
    next_url = raw.get("next")
    while next_url:
        response = client.client.get(next_url)
        response.raise_for_status()
        page = response.json()
        rows.extend(page.get("results", []))
        next_url = page.get("next")
    return rows


def main() -> int:
    """Entry point for ``laplace-export-mem0``."""
    load_dotenv(override=True)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-o",
        "--out",
        default=DEFAULT_OUT_PATH,
        help=f"Where to write the dump (default: {DEFAULT_OUT_PATH})",
    )
    args = parser.parse_args()

    api_key = os.getenv("MEM0_API_KEY")
    if not api_key:
        print("MEM0_API_KEY is unset — nothing to export from.", file=sys.stderr)
        return 1

    try:
        from mem0 import MemoryClient
    except ImportError as e:
        print(f"mem0 is not installed: {e}", file=sys.stderr)
        return 1

    client = MemoryClient(api_key=api_key)
    rows = _fetch_entities(client)
    print(f"Exporting {len(rows)} entities\n")

    exported: list[dict[str, Any]] = []
    total = 0
    for entity in rows:
        filters = _entity_filters(entity)
        if filters is None:
            continue
        memories = _fetch_all(client, filters)
        total += len(memories)
        exported.append(
            {
                "type": entity.get("type"),
                "name": entity.get("name"),
                "count": len(memories),
                "memories": memories,
            }
        )
        print(f"{entity.get('type')}={entity.get('name')}: {len(memories)}")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "entity_count": len(exported),
                "memory_count": total,
                "entities": exported,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nWrote {total} memories across {len(exported)} entities to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
