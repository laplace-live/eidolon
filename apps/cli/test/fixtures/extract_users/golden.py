"""Prints golden.json: tools/extract_users.py's main() over the synthetic exports beside this file,
with TYPE_LABELS set to the port's (types 1 and 3 are gifts and super chats, as the data shows).
extract_users.test.ts runs the same argv through the port.

    uv run --offline --no-sync python apps/cli/test/fixtures/extract_users/golden.py \
        > apps/cli/test/fixtures/extract_users/golden.json
    bunx biome format --write apps/cli/test/fixtures/extract_users/golden.json
"""

from __future__ import annotations

import contextlib
import io
import json
import platform
import sys
from pathlib import Path

from laplace_eidolon.tools import extract_users

HERE = Path(__file__).resolve().parent

CASES = [
    ["danmakus.json"],
    ["danmakus.json", "-n", "3", "--types", "all"],
    ["danmakus.json", "--types", "0"],
    ["danmakus.json", "--types", "2, 7"],
    ["danmakus.json", "-n", "0"],
    ["danmakus.json", "-n", "-2"],
    ["danmakus.json", "--types", "6"],
    ["edge.json", "--types", "all"],
    ["list.json"],
    ["nokey.json"],
    ["strdata.json"],
    ["nulldata.json"],
    ["notlist.json"],
    ["missing.json"],
    ["bad.txt"],
]


def run(argv: list[str]) -> dict[str, object]:
    sys.argv = ["laplace-extract-users", str(HERE / argv[0]), *argv[1:]]
    out, err = io.StringIO(), io.StringIO()
    raised = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code: object = extract_users.main()
        except Exception as e:  # noqa: BLE001 — a traceback is an outcome too
            code, raised = 1, type(e).__name__
    return {
        "argv": argv,
        "code": code,
        "raised": raised,
        "stdout": out.getvalue(),
        "stderr": err.getvalue().replace(str(HERE), "<FIX>"),
    }


def main() -> None:
    extract_users.TYPE_LABELS.update({1: "gift", 3: "SC"})
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}: apps/cli/test/fixtures/extract_users/golden.py"
        ),
        "cases": [run(argv) for argv in CASES],
    }
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
