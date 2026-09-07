# Comment and docstring policy

**Audience:** anyone editing Python in this repo, human or agent.
**Scope:** what earns a comment, what earns a docstring, what is banned, and
how to verify a prose-only sweep didn't change behavior.

`AGENTS.md` carries the short form. This is the long one, with the worked
examples that make the line concrete.

---

## Why the bar is this high

This codebase previously carried ~34% prose by line, most of it explaining its
own structure back to itself. That prose is expensive twice: it rots silently,
and it buries the handful of comments that genuinely matter.

## The test

**Write the comment only if it survives this test.** One of:

1. **External behavior** — an upstream bug, version quirk, or SDK contract.
   Link the issue or name the version.
2. **A measured number** — something nobody can re-derive by reading the code.
3. **A trap** — a gotcha where deleting the line, or "tidying" it, causes a bug.
4. **Orientation** — one or two sentences at module top: what this is, who
   calls it.

The dividing line: **a comment about something outside this repo can be a
paragraph. A comment about this repo's own structure gets one sentence, or
nothing.** Every keeper here cites LanceDB, the OpenAI SDK, mem0,
python-dotenv, or a benchmark. Every deleted essay explained our own module
boundaries to ourselves.

Assume the reader knows Python and can read the code beneath the comment.
Explain *why*, never *what*.

## Docstrings

One-line summary. Add `Args:`/`Returns:` only for a parameter whose contract
isn't obvious from its name and type. Self-evident functions get no docstring
at all — `sidecar_path()` returning `self.md_path.with_suffix(".refined.json")`
does not need prose.

Plain prose, Google-style sections. Double-backtick literals are fine.

```python
def hybrid_search(table, query, ...) -> list[dict]:
    """Run a vector + FTS hybrid query, optionally reranked.

    Args:
        prefilter: forced ``True`` — post-filtering silently returns fewer
            than top-k at our scale.
    """
```

**One exception, and it matters:** the docstrings on `@mcp.tool()`-decorated
functions in `mcp_server.py` are not prose. FastMCP ships them to the model as
the tool's `description` field, so they are live API surface — editing one
changes runtime behavior. Same for the `Field(description=...)` strings. Leave
them alone unless you intend to change what the model sees.

Pydantic *attribute* docstrings (a bare string under a field) are the
opposite: `use_attribute_docstrings` is off, so they never reach the JSON
schema and are inert. Trim them like any other comment.

## Banned

- **Banner dividers.** No `# ─────` or `# -----` blocks. Especially not
  `# Main` above `def main()`.
- **RST section headers** (`Why this exists` + `-----` underline) and Sphinx
  roles (`:func:`, `:mod:`, `:class:`). Nothing here builds Sphinx docs.
- **`What lives here:` indexes.** The `def` statements are the index, and they
  don't go stale.
- **`Why X and not Y` sections.** Especially arguing against an alternative
  nobody proposed.
- **Changelog narration** — `we used to`, `earlier revisions`, `the old X`,
  `(verified 2026-05)`. Git owns this.
- **`Usage::` shell transcripts** in module docstrings. That's `--help` and
  README territory.
- **Commented-out code.** Delete it.
- **Upstream line numbers, versions, and endpoint paths** —
  `aiortc/codecs/opus.py:34`, `mem0ai 1.0.11`, `POST /v2/memories/`. These rot
  on the next bump, and a stale one is worse than nothing: the mem0 comments
  here pinned both a version and a path, and by the time anyone looked, the SDK
  was on 2.0.12 POSTing to `/v3/`. State the durable behavior — "takes the id
  only inside `filters`" — and name the symbol.
- **Repeating yourself across files.** Explain it once, at the place that owns
  the behavior.
- **Tutorial comments** on stdlib or well-known framework behavior.

Never touch functional directives (`# type: ignore`, `# noqa`, `# pragma: no
cover`), `TODO`/`FIXME`/`HACK` notes, or license headers. When cleaning
comments, change only comments — never code.

## Worked examples

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

## Verifying a comment-only sweep

Editing prose across many files at once is easy to get subtly wrong. Prove you
didn't: parse each file before and after, strip every bare string-literal
statement, and compare `ast.dump()`. Comments never enter the AST, so an
identical tree means only prose moved. Do this instead of re-reading the diff
and hoping.

Two things that check will not catch, because they are real API surface: the
`@mcp.tool()` docstrings noted above, and a stale claim that was already wrong
before you touched it. Both showed up in the last sweep.
