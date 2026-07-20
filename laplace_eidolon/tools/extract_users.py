"""Extract the top-N most-spoken usernames from a danmakus.com chat export.

danmakus.com archives a streamer's super chats, membership renewals, and
chat danmaku as JSON: a flat list under ``.data.data.danmakus`` whose
entries carry ``uId``, ``uName``, ``type``, ``price``, and ``sendDate``.

Dedupes by ``uId`` (viewers rename themselves between archives), keeps the
most recent ``uName`` as canonical, and ranks by frequency of paid events —
those are the ones where the streamer reads a name aloud, so they're the
names worth hand-pasting into the ``terms`` array in
``soniox_context.toml``. Types ``{1, 2, 3}`` (super chat, membership
renewal, low-tier super chat) count by default; system events like room
entry and bans are excluded so lurkers don't crowd out actual chatters.

Stdout is one username per line and nothing else, so it pipes straight into
a file. The summary goes to stderr, out of the way.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Type values published by danmakus.com.
TYPE_LABELS: dict[int, str] = {
    0: "free chat",
    1: "SC",
    2: "membership",
    3: "SC (low-tier)",
    4: "room entry",
    5: "title update",
    8: "stream start",
    9: "ban",
}
DEFAULT_INCLUDE_TYPES: set[int] = {1, 2, 3}


def _parse_types(arg: str) -> set[int] | None:
    """Parse the ``--types`` CLI value into a filter set.

    ``"all"`` returns ``None``, meaning no filtering.
    """
    if arg.strip().lower() == "all":
        return None
    out: set[int] = set()
    for piece in arg.split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            out.add(int(piece))
        except ValueError as e:
            raise argparse.ArgumentTypeError(
                f"--types: '{piece}' is not an integer or 'all'"
            ) from e
    if not out:
        raise argparse.ArgumentTypeError("--types must include at least one type")
    return out


def _fmt_date(ms: int | None) -> str:
    if not ms:
        return "?"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "input",
        type=Path,
        help="Path to a danmakus.com JSON export.",
    )
    parser.add_argument(
        "-n",
        "--top",
        type=int,
        default=50,
        help="How many top usernames to emit on stdout (default: 50).",
    )
    parser.add_argument(
        "--types",
        type=_parse_types,
        default=DEFAULT_INCLUDE_TYPES,
        help=(
            "Comma-separated message-type integers to include in the "
            "ranking. Default '1,2,3' counts paid SC + membership + "
            "low-tier SC — the events where the streamer reads names "
            "aloud. Pass 'all' to disable filtering, or e.g. '0,1,2,3' "
            "to also include free chat."
        ),
    )
    args = parser.parse_args()

    if not args.input.exists():
        print(f"error: file not found: {args.input}", file=sys.stderr)
        return 1

    print(
        f"Reading {args.input} ({args.input.stat().st_size / 1024 / 1024:.1f} MB)…", file=sys.stderr
    )
    with args.input.open("r", encoding="utf-8") as f:
        payload: Any = json.load(f)

    try:
        items: list[dict[str, Any]] = payload["data"]["data"]["danmakus"]
    except (KeyError, TypeError) as e:
        print(
            f"error: unexpected JSON shape (expected .data.data.danmakus): {e}",
            file=sys.stderr,
        )
        return 1
    if not isinstance(items, list):
        print("error: .data.data.danmakus is not a list", file=sys.stderr)
        return 1

    counts: Counter[int] = Counter()  # uid -> messages-included count
    # Some SC prices are fractional (¥5.2 for 情书), so spend can't ride on
    # a Counter — typeshed types its values as int.
    spend: defaultdict[int, float] = defaultdict(float)  # uid -> total price
    last_name: dict[int, tuple[int, str]] = {}  # uid -> (latest sendDate, uName)
    type_counts_all: Counter[int] = Counter()
    type_counts_kept: Counter[int] = Counter()
    earliest_ms: int | None = None
    latest_ms: int | None = None
    skipped_no_id = 0

    for item in items:
        if not isinstance(item, dict):
            continue
        uid_raw = item.get("uId")
        uname = item.get("uName")
        msg_type = item.get("type")
        send_date = item.get("sendDate") or 0
        price = item.get("price") or 0

        if isinstance(msg_type, int):
            type_counts_all[msg_type] += 1

        if not uid_raw or not uname:
            skipped_no_id += 1
            continue
        uid = int(uid_raw)

        # Tracked regardless of the type filter, so the top-spenders
        # summary covers lifetime spend rather than just counted events.
        spend[uid] += float(price)
        prev = last_name.get(uid)
        if prev is None or send_date >= prev[0]:
            last_name[uid] = (int(send_date), str(uname))
        if send_date:
            if earliest_ms is None or send_date < earliest_ms:
                earliest_ms = int(send_date)
            if latest_ms is None or send_date > latest_ms:
                latest_ms = int(send_date)

        if args.types is not None and msg_type not in args.types:
            continue
        counts[uid] += 1
        if isinstance(msg_type, int):
            type_counts_kept[msg_type] += 1

    if not counts:
        print(
            "error: no entries matched the type filter. Try --types all.",
            file=sys.stderr,
        )
        return 1

    print("", file=sys.stderr)
    print(f"  total entries  : {len(items):,}", file=sys.stderr)
    print(f"  unique users   : {len(last_name):,}", file=sys.stderr)
    print(f"  date range     : {_fmt_date(earliest_ms)} → {_fmt_date(latest_ms)}", file=sys.stderr)
    if skipped_no_id:
        print(f"  skipped (no uId/uName): {skipped_no_id:,}", file=sys.stderr)

    def _fmt_types(c: Counter[int]) -> str:
        return ", ".join(f"{TYPE_LABELS.get(t, f'type={t}')}={n:,}" for t, n in sorted(c.items()))

    print(f"  all types      : {_fmt_types(type_counts_all)}", file=sys.stderr)
    print(f"  counted types  : {_fmt_types(type_counts_kept)}", file=sys.stderr)
    total_spend = sum(spend.values())
    if total_spend:
        print(f"  total spend    : ¥{total_spend:,.0f} across all types", file=sys.stderr)

    # Ranked by spend, not frequency. Eyeball test: if the top names look
    # familiar, this file really is the right streamer's archive.
    top_spenders = sorted(spend.items(), key=lambda kv: kv[1], reverse=True)[:10]
    if top_spenders:
        print("", file=sys.stderr)
        print("  top 10 spenders (informational, not in stdout):", file=sys.stderr)
        for uid, total in top_spenders:
            name = last_name.get(uid, (0, "?"))[1]
            print(f"    ¥{total:>9,.0f}  {name}", file=sys.stderr)

    print("", file=sys.stderr)
    print(f"top {args.top} usernames by message frequency → stdout:", file=sys.stderr)
    print("", file=sys.stderr)

    for uid, _count in counts.most_common(args.top):
        name = last_name[uid][1]
        print(name)

    return 0


if __name__ == "__main__":
    sys.exit(main())
