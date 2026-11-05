"""Prints golden.json: tools/ingest_facts.py over synthetic fact files. Line parsing, the prefix
strip, pathlib's glob over awkward file names, load_facts, and main() run end to end (argparse
included) with the embedding call stubbed, into a temporary directory. Synthetic text only.

    uv run --offline --no-sync python packages/ingest/test/fixtures/ingest_facts/golden.py \
        > packages/ingest/test/fixtures/ingest_facts/golden.json
    bunx biome check --write packages/ingest/test/fixtures/ingest_facts/golden.json
"""

from __future__ import annotations

import os

# Both are read when laplace_eidolon.embeddings is imported.
os.environ["EMBED_DIM"] = "4"
os.environ.pop("EMBED_MODEL", None)

import hashlib
import json
import platform
import shutil
import sqlite3
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any

import lancedb
import numpy as np
from loguru import logger

from laplace_eidolon.embeddings import EmbeddingUsage
from laplace_eidolon.tools import ingest_facts

messages: list[list[str]] = []
logger.remove()
logger.add(lambda m: messages.append([m.record["level"].name, m.record["message"]]), level="DEBUG")

# main() would read the repository's .env.
setattr(ingest_facts, "load_dotenv", lambda *args, **kwargs: False)

VERBS = ["声称", "强调", "说", "认为", "觉得", "表示", "回应", "喜欢", "分享", "多次"]

# Line breaks str.splitlines() honours beyond \n: \r\n, \r, \v, \f, \x1c, \x85 and \u2028.
FACT_FILES: dict[str, str] = {
    "乙设定集.txt": (
        "\ufeff2022年7月24日 / BOM开头的第一行不会被解析成日期\n"
        "2022年7月24日 / 明前奶绿声称坚果喜欢在花店门口晒太阳\r\n"
        "2025-12-29 00:15:16 / 发言：今天开播吗 / 回复：晚上见。\n"
        "第12楼：BV1em4y187Nc / 2022年10月3日，明前奶绿说过想养一只柴犬\r"
        "BV1em4y187Nc、2023-1-5T09:30 明前奶绿认为草莓蛋糕最好吃\n"
        "2023年圣诞节新衣回 / 明前奶黑的剑是一把伞\v"
        "2022年13月45日 / 日期不做日历校验的例子\f"
        "２０２２年７月２４日／明前奶绿说全角数字也算日期\n"
        "2025-12-290 后面紧跟数字的不算日期\x1c"
        "第5楼 没有冒号的不算楼层标记\n"
        "明前奶绿声称\n"
        "明前奶绿不喜欢下雨天出门\x85"
        "明前奶绿声称是猫派而不是狗派\n"
        "2022年7月24日 / 坚果\n"
        "2022年7月24日\n"
        "   \n"
        "\n"
        "明前奶绿说🎉🎉\u2028"
        "明前奶黑，强调自己不是明前奶绿\n"
        "2024-02-30 / BV1xx411c7mD / 日期后面的BV号不会被去掉\n"
        "  第 7 楼 ： 2024年2月3日、 明前奶绿：  回应了弹幕  \n"
        "明前奶绿走路很快\n"
        "2022年7月24日 / 明前奶绿声称坚果喜欢在花店门口晒太阳\n"
        "\t明前奶绿说过\t多次提到的事\t\n"
        "第0099楼:BV1aa411b7cD,2021-07-02 以文静的身份首次直播"
    ),
    "甲设定集.txt": (
        "明前奶绿喜欢喝奶茶\n"
        "2022年7月24日 / 明前奶绿声称坚果喜欢在花店门口晒太阳\n"
        "2023-03-01 / 明前奶绿声明花店周一休息\n"
        "明前奶绿喜欢喝奶茶\n"
    ),
    ".备份设定集.txt": "明前奶绿说这是备份文件里的事实\n",
    "丙事件集.txt": "".join(
        f"{'第' + str(n) + '楼: ' if n % 9 == 0 else ''}"
        f"2023-02-{n % 28 + 1:02d} 合成事件第{n}条：明前奶绿{VERBS[n % len(VERBS)]}"
        f"今天的花是第{n}种\n"
        for n in range(1, 111)
    ),
    "video-full.txt": "https://www.bilibili.com/video/BV1xx411c7mD\n",
    "X设定集.TXT": "明前奶绿说大写扩展名不会被匹配\n",
    "设定集.txt.bak": "明前奶绿说备份扩展名不会被匹配\n",
    "short.txt": "a\nbc\n\n2022年7月24日\n第3楼: 2023年1月1日 /\n",
}

PARSE_LINES = [
    "2022年7月24日 / 明前奶绿声称坚果喜欢在花店门口晒太阳",
    "2025-12-29 00:15:16 / 发言：奶姐 / 回复：都去都去。",
    "第12楼：BV1em4y187Nc / 2022年10月3日，明前奶绿说过想养狗",
    "BV1em4y187Nc、2023-1-5T09:30 明前奶绿认为草莓最好吃",
    "2023年圣诞节新衣回 / 明前奶黑的剑是伞骨",
    "2022年13月45日 / 日期不校验的例子",
    "２０２２年７月２４日／明前奶绿说全角数字",
    "2025-12-290 后面跟着数字不算日期",
    "第5楼 没有冒号不算楼层",
    "明前奶绿声称",
    "明前奶绿不喜欢下雨天",
    "明前奶绿声称是猫派",
    "\ufeff2022年7月24日 / BOM开头的第一行",
    "2022年7月24日 / 坚果",
    "2022年7月24日",
    "",
    "   ",
    "第٣٤楼：٢٠٢٣年٥月٦日 阿拉伯数字也是Nd数字",
    "2023-1-5 12:3 不完整的时间",
    "2023-1-5 12:34:56:78 多出来的冒号",
    "2023-1-5T9:30后面紧跟文字",
    "BV1abc／全角斜杠不是分隔符",
    "BV 1abc / BV和数字之间有空格",
    "第12楼：第13楼：两个楼层标记",
    "2022年7月24日，2023年1月1日 两个日期",
    "明前奶绿明前奶绿声称重复的名字",
    "明前奶黑说：「引号开头」",
    "明前奶绿。。。省略号",
    "明前奶绿声称是",
    "Ａ明前奶绿说前面有全角字母",
    "　明前奶绿说全角空格开头　",
]

GLOB_NAMES = [
    "a.txt", "b.TXT", ".hidden.txt", "x设定集.txt", ".y设定集.txt", "z事件集.txt", "[ab].txt",
    "a-b.txt", "c]d.txt", "e!f.txt", "g^h.txt", "i\\j.txt", "k&l.txt", "m~n.txt", "o|p.txt",
    "q.r.s", "t u.txt", "v*w.txt", "x?y.txt", "-.txt", "]x.txt", "😀.txt", "ab", "abc", "a",
    "b", "c", "-", "!", "^", "\\", "]", "[", "&", "a\nb", "设定集.txt",
]

GLOB_PATTERNS = [
    "*.txt", "*设定集.txt", "*事件集.txt", "?.txt", "??", "*", "a*", "[ab].txt", "[!a].txt",
    "[a-c]*", "[!a-c]*", "[]x].txt", "[!]x].txt", "[^a]*", "[a-]*", "[-a]*", "[\\]*",
    "[z-a]*", "[a-c-e]*", "[!]*", "[*", "a[", "*.TXT", "x?y.txt", "v[*]w.txt", "[[]ab].txt",
    "[&~|]*", "*.t?t", "*[0-9]*", "e[!]f.txt", "[!!]", "[]-a]", "[!--]", "[--]", "[a-a]",
    "[]]", "[!]]", "[]", "[!]", "a?b", "*\\*", "[\\-^]", "[b-a-c]", "[%--]", "[---]",
    "*设定集*", "***.txt", "[]a-c]", "[^]", "[a&&b]", "x设定集.txt", ".*", "[.]*", "[!z-a]",
    "[\\--a]", "[a-c][!x]*", "*[]", "[😀]*", "[一-龥]*", "*[!t]",
]


def write_files(root: Path, files: dict[str, str]) -> None:
    root.mkdir(parents=True)
    for name, text in files.items():
        (root / name).write_bytes(text.encode("utf-8"))


def parse_case(raw: str) -> dict[str, Any]:
    iso, floor, cleaned = ingest_facts._parse_line(raw)
    stripped = ingest_facts._strip_persona_prefix(cleaned)
    return {
        "raw": raw,
        "date": iso,
        "floor": floor,
        "text": cleaned,
        "stripped": stripped,
        "id": hashlib.sha1(cleaned.encode("utf-8")).hexdigest()[:16],
        "tokens": ingest_facts.tokenize_zh(cleaned),
    }


def glob_matrix(root: Path) -> dict[str, Any]:
    root.mkdir()
    for name in GLOB_NAMES:
        (root / name).write_bytes(b"")
    matches: dict[str, Any] = {}
    for pattern in GLOB_PATTERNS:
        try:
            matches[pattern] = [p.name for p in sorted(root.glob(pattern))]
        except Exception as error:  # the TS port must refuse the same patterns
            matches[pattern] = {"error": type(error).__name__}
    return {"names": GLOB_NAMES, "matches": matches}


def fake_vector(text: str) -> list[float]:
    base = sum(ord(c) for c in text) % 97
    return [base / 7, -base / 3, 0.1 * base, 1 / (base + 3)]


calls: list[dict[str, Any]] = []


async def fake_embed(
    texts: list[str], model: str | None = None, dimensions: int | None = None
) -> tuple[list[list[float]], EmbeddingUsage]:
    calls.append({"texts": list(texts), "model": model, "dimensions": dimensions})
    tokens = sum(len(t) for t in texts)
    return [fake_vector(t) for t in texts], EmbeddingUsage(
        tokens, tokens, tokens * 0.15 / 1e6, "estimate"
    )


setattr(ingest_facts, "embed_texts_with_usage", fake_embed)


def table_state(db_path: Path, name: str) -> dict[str, Any] | None:
    """The table's row count, and digests of its rows (as JSON, in order) and float32 vectors."""
    if not (db_path / f"{name}.lance").exists():
        return None
    data = lancedb.connect(str(db_path)).open_table(name).to_arrow().to_pylist()
    rows = [{k: v for k, v in r.items() if k != "vector"} for r in data]
    vectors = np.asarray([r["vector"] for r in data], dtype=np.float32).tobytes()
    return {
        "rows": len(rows),
        "rows_sha256": hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest(),
        "vectors_sha256": hashlib.sha256(vectors).hexdigest(),
    }


def cache_count(path: Path) -> int | None:
    if not path.exists():
        return None
    with sqlite3.connect(path) as db:
        return db.execute("SELECT COUNT(*) FROM embed_cache").fetchone()[0]


SCENARIOS: list[tuple[str, list[str]]] = [
    ("dry-run", ["--dry-run"]),
    ("cold", []),
    ("warm", []),
    ("partial", ["--min-chars", "2"]),
    ("unstripped", ["--no-strip-prefix", "--no-cache", "--table", "persona_facts_unstripped"]),
    ("clear-cache", ["--clear-cache"]),
    ("files", ["--files", "<TMP>/facts/甲设定集.txt", "<TMP>/facts/missing.txt",
               "<TMP>/facts/甲设定集.txt", "--dry-run"]),
    ("files-empty", ["--files", "--dry-run"]),
    ("no-files", ["--data-dir", "<TMP>/nowhere"]),
    ("no-rows", ["--files", "<TMP>/facts/short.txt"]),
]
BASE_ARGS = [
    "--data-dir", "<TMP>/facts",
    "--db-path", "<TMP>/index",
    "--cache-path", "<TMP>/cache/embed_cache.db",
]


def run_scenarios(tmp: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for name, extra in SCENARIOS:
        argv = BASE_ARGS + extra
        messages.clear()
        calls.clear()
        sys.argv = ["laplace-ingest-facts", *(a.replace("<TMP>", str(tmp)) for a in argv)]
        code = ingest_facts.main()
        table = "persona_facts_unstripped" if name == "unstripped" else "persona_facts"
        out.append({
            "name": name,
            "argv": argv,
            "exit_code": code,
            "logs": [[lvl, msg.replace(str(tmp), "<TMP>")] for lvl, msg in messages],
            "calls": list(calls),
            "table": table,
            "state": table_state(tmp / "index", table),
            "cache_count": cache_count(tmp / "cache" / "embed_cache.db"),
        })
    return out


def main() -> None:
    tmp = Path(tempfile.mkdtemp()).resolve()
    try:
        write_files(tmp / "facts", FACT_FILES)
        files = ingest_facts._resolve_files(None, tmp / "facts")
        messages.clear()
        rows = ingest_facts.load_facts(files)
        load = {
            "files": [p.name for p in files],
            "rows": rows,
            "logs": [[lvl, msg.replace(str(tmp), "<TMP>")] for lvl, msg in messages],
        }
        glob = glob_matrix(tmp / "glob")
        scenarios = run_scenarios(tmp)
    finally:
        shutil.rmtree(tmp)
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}, lancedb {version('lancedb')}, "
            f"jieba {version('jieba')}: packages/ingest/test/fixtures/ingest_facts/golden.py "
            "through laplace_eidolon.tools.ingest_facts"
        ),
        "fact_files": FACT_FILES,
        "parse": [parse_case(raw) for raw in PARSE_LINES],
        "load": load,
        "glob": glob,
        "scenarios": scenarios,
    }
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
