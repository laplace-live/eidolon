# Python spec copy of the skill's .agents/skills/stream-archive-embed/scripts/prepare_batch.py,
# which laplace-prepare-batch ports. download.golden.py and download-real.golden.py load it, and
# the goldens' printed_by names it by that path. Keep it unchanged.
"""Turn a complete archive capture into a deduplicated pipeline URL list."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

ARCHIVE_URL = "https://space.bilibili.com/2132180406/lists/2484684?type=series"
BV_ID = re.compile(r"BV[0-9A-Za-z]{10}")


def read_ids(path: Path) -> list[str]:
    ids: dict[str, None] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        if not BV_ID.fullmatch(value):
            url = urlsplit("https:" + value if value.startswith("//") else value)
            match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10})/?", url.path)
            if url.hostname not in {"www.bilibili.com", "bilibili.com"} or not match:
                raise ValueError(f"{path}:{number}: expected a BV ID or Bilibili video URL")
            value = match[1]
        ids[value] = None
    return list(ids)


def prepare_batch(
    root: Path, capture: Path, expected_count: int, dry_run: bool
) -> dict[str, object]:
    captured = read_ids(capture)
    if expected_count < 1 or len(captured) != expected_count:
        raise ValueError(
            f"Archive coverage mismatch: captured {len(captured)} unique IDs, "
            f"expected {expected_count}; no batch written"
        )

    data_dir = root / "data"
    baselines = sorted(data_dir.glob("video*.txt"))
    if not baselines:
        raise ValueError("No prepared data/video*.txt lists found; check --root")
    archive_dir = data_dir / "auto-embed"
    batches = sorted(archive_dir.glob("videos-*.txt"))
    known = {bv for path in [*baselines, *batches] for bv in read_ids(path)}
    pending = [str(path) for path in batches if not path.with_suffix(".done.json").exists()]
    new_ids = [bv for bv in captured if bv not in known]
    output: Path | None = None

    if new_ids and not dry_run:
        archive_dir.mkdir(parents=True, exist_ok=True)
        now = datetime.now().astimezone()
        output = archive_dir / f"videos-{now:%Y-%m-%d-%H%M%S}.txt"
        with output.open("x", encoding="utf-8") as stream:
            stream.write(f"# Source: {ARCHIVE_URL}\n")
            stream.write(f"# Captured: {now.isoformat(timespec='seconds')}\n")
            stream.write(f"# Archive total: {expected_count}; new BV IDs: {len(new_ids)}\n")
            stream.writelines(f"https://www.bilibili.com/video/{bv}\n" for bv in new_ids)

    return {
        "captured_count": len(captured),
        "known_count": len(known),
        "new_count": len(new_ids),
        "new_ids": new_ids,
        "pending_batches": pending,
        "created_batch": str(output) if output else None,
        "dry_run": dry_run,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path, help="Complete capture: one BV ID or URL per line")
    parser.add_argument("--expected-count", type=int, required=True, help="Archive's displayed total")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="Repository root")
    parser.add_argument("--dry-run", action="store_true", help="Print the plan without writing files")
    args = parser.parse_args()
    try:
        result = prepare_batch(args.root.resolve(), args.capture, args.expected_count, args.dry_run)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
