# laplace-eidolon

Pipecat voice bot for a streamer RP persona. Self-hosted SmallWebRTC, no
Daily, no telephony.

## Commands

```bash
uv sync                                  # runtime deps
uv sync --extra tools                    # + faster-whisper, soniox (offline only)
uv run python -m laplace_eidolon.bot     # run the bot (NOT a console script — see below)

uv run ruff check .                      # lint (line-length 100, import sorting only)
uv run pyright                           # types
uv run pytest                            # tests
```

The bot is deliberately not a `laplace-*` console script: Pipecat's runner
discovers `bot()` through `sys.modules["__main__"]`, which a generated
launcher doesn't satisfy. The offline tools are console scripts —
`laplace-refine`, `laplace-ingest-streams`, `laplace-ingest-facts`,
`laplace-search`, `laplace-pipeline`, `laplace-download`,
`laplace-transcribe`, `laplace-extract-users`, `laplace-eval-retrieval`.

## Architecture

Runtime path: `bot.py` builds the Pipecat pipeline and mounts the Starlette
app. `offer_middleware.py` rate-limits anonymous `/api/offer` calls;
`user_context.py` validates login tokens; `audio_quality.py` picks a
per-session Opus bitrate. Two Pipecat processors inject RAG context —
`persona_facts.py` (hand-compiled fan facts) and `stream_archive.py` (refined
stream transcripts). Both search through `retrieval.py`; both store through
`embeddings.py`. `mcp_server.py` exposes the same indexes publicly at `/mcp`.

Offline path: `tools/` is a batch chain — `download` → `transcribe` →
`refine` → `ingest_streams` / `ingest_facts`, with `pipeline` running it
end-to-end and `eval_retrieval` scoring the result. LanceDB holds both
tables.

## Style

- `from __future__ import annotations` at the top of every module. The
  exceptions are `bot.py` and the two `__init__.py` files.
- PEP 604/585 syntax: `str | None`, `dict[str, Any]`, `list[float]`.
- Type hints on everything. They carry the load that docstrings otherwise
  would.
- Line length 100. Ruff enforces import sorting (`select = ["I"]`) and
  nothing else, so the rest of this file is on you.

## Comments

This codebase previously carried ~34% prose by line, most of it explaining
its own structure back to itself. That prose is expensive twice: it rots
silently, and it buries the handful of comments that genuinely matter.

**Write the comment only if it survives this test.** One of:

1. **External behavior** — an upstream bug, version quirk, or SDK contract.
   Link the issue or name the version.
2. **A measured number** — something nobody can re-derive by reading the
   code.
3. **A trap** — a gotcha where deleting the line, or "tidying" it, causes a
   bug.
4. **Orientation** — one or two sentences at module top: what this is, who
   calls it.

The dividing line: **a comment about something outside this repo can be a
paragraph. A comment about this repo's own structure gets one sentence, or
nothing.** Every keeper in this codebase cites LanceDB, the OpenAI SDK, mem0,
python-dotenv, or a benchmark. Every deleted essay explained our own module
boundaries to ourselves.

Assume the reader knows Python and can read the code beneath the comment.
Explain *why*, never *what*.

### Docstrings

One-line summary. Add `Args:`/`Returns:` only for a parameter whose contract
isn't obvious from its name and type. Self-evident functions get no docstring
at all — `sidecar_path()` returning `self.md_path.with_suffix(".refined.json")`
does not need prose.

Plain prose, Google-style sections. Double-backtick literals are fine.

**One exception, and it matters:** the docstrings on `@mcp.tool()`-decorated
functions in `mcp_server.py` are not prose. FastMCP ships them to the model
as the tool's `description` field, so they are live API surface — editing one
changes runtime behavior. Same for the `Field(description=...)` strings.
Leave them alone unless you intend to change what the model sees.

Pydantic *attribute* docstrings (a bare string under a field) are the
opposite: `use_attribute_docstrings` is off, so they never reach the JSON
schema and are inert. Trim them like any other comment.

```python
def hybrid_search(table, query, ...) -> list[dict]:
    """Run a vector + FTS hybrid query, optionally reranked.

    Args:
        prefilter: forced ``True`` — post-filtering silently returns fewer
            than top-k at our scale.
    """
```

### Banned

- **Banner dividers.** No `# ─────` or `# -----` blocks. Especially not
  `# Main` above `def main()`.
- **RST section headers** (`Why this exists` + `-----` underline) and Sphinx
  roles (`:func:`, `:mod:`, `:class:`). Nothing here builds Sphinx docs.
- **`What lives here:` indexes.** The `def` statements are the index, and
  they don't go stale.
- **`Why X and not Y` sections.** Especially arguing against an alternative
  nobody proposed.
- **Changelog narration** — `we used to`, `earlier revisions`, `the old X`,
  `(verified 2026-05)`. Git owns this.
- **`Usage::` shell transcripts** in module docstrings. That's `--help` and
  README territory.
- **Commented-out code.** Delete it.
- **Upstream line numbers, versions, and endpoint paths** —
  `aiortc/codecs/opus.py:34`, `mem0ai 1.0.11`, `POST /v2/memories/`. These
  rot on the next bump, and a stale one is worse than nothing: the mem0
  comments here pinned both a version and a path, and by the time anyone
  looked, the SDK was on 2.0.12 POSTing to `/v3/`. State the durable
  behavior — "takes the id only inside `filters`" — and name the symbol.
- **Repeating yourself across files.** Explain it once, at the place that
  owns the behavior.
- **Tutorial comments** on stdlib or well-known framework behavior.

### Worked examples

Keep — cites an external system, with a link:

```python
# LanceDB 0.30.x ships no CJK tokenizer; pre-tokenizing at both ingest
# and query time is the official workaround.
# https://github.com/lancedb/lancedb/issues/2168
```

Keep — a trap, where removing the argument breaks everything quietly:

```python
# encoding_format="float" is required for non-OpenAI providers: the SDK
# defaults to base64, and providers that don't honour that contract
# round-trip an empty response ("No embedding data received").
```

Keep — a measured number, unrecoverable from the code:

```python
# Stripping the 贴吧 floor prefix lifts vector-only MRR 0.833 → 0.925,
# rescuing 你梦想是什么 from a total miss. With the Cohere reranker on,
# the gap closes to zero.
```

Delete — this repo narrating its own layout:

```python
# Why this exists separately from ``embeddings.py``: that module owns the
# embedding HTTP client (write path). This one composes search-side
# operations (read path). Keeping them split mirrors the
# write-vectors / read-and-rank divide.
```

Compress — 67 lines of root-cause narration become the 4 that act:

```python
"""Mem0 wrapper that drops messages without string content.

Pipecat's aggregator emits ``{"role": "assistant", "tool_calls": [...]}``
with no ``content``. Mem0's API 400s on it, then rejects every later turn
in the session — silently ending long-term memory.
"""
```

### Verifying a comment-only sweep

Editing prose across many files at once is easy to get subtly wrong. Prove
you didn't: parse each file before and after, strip every bare string-literal
statement, and compare `ast.dump()`. Comments never enter the AST, so an
identical tree means only prose moved. Do this instead of re-reading the diff
and hoping.

Two things that check will not catch, because they are real API surface:
the `@mcp.tool()` docstrings noted above, and a stale claim that was already
wrong before you touched it. Both showed up in the last sweep.
