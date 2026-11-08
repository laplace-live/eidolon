# Comment policy

**Audience:** anyone editing the TypeScript in this repo, human or agent.
**Scope:** what earns a comment, what earns a JSDoc block, what is banned, and
how to verify a prose-only sweep didn't change behavior.

`AGENTS.md` carries the short form. This is the long one, with the worked
examples that make the line concrete.

---

## Why the bar is this high

This codebase once carried ~34% prose by line, most of it explaining its own
structure back to itself. That prose is expensive twice: it rots silently, and
it buries the handful of comments that genuinely matter.

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
nothing.** Every keeper below cites LanceDB, an upstream SDK, mem0, pipedog,
or a benchmark. Every deleted essay explained our own module boundaries to
ourselves.

Assume the reader knows TypeScript and can read the code beneath the comment.
Explain *why*, never *what*.

## JSDoc

A one-line `/** … */` summary on an export whose purpose the name and
signature don't already say. No `@param` or `@returns` tags: the signature
carries the types. A parameter whose contract isn't obvious from its name and
type gets a clause in the summary; an interface field gets its own `/** … */`
line. Self-evident functions get none — a function returning
`stem + ".refined.json"` does not need prose.

```ts
export interface ChunkOutcome {
  readonly chunk: StreamChunk;
  /** Null when a pass failed; the chunk stays unrefined and the next run retries it. */
  readonly refinement: Refinement | null;
}
```

**Tool descriptions are not prose.** The MCP tools' descriptions and schemas
(`toolDefinitions()` in `apps/bot/src/mcp/tools.ts`) and each `LlmTool`'s
`schema` go to a model as written, so editing one changes runtime behavior.
They are string literals, not comments, so a comment sweep must not touch them
and the check below catches it if one does.

## Banned

- **Banner dividers.** No `// ─────` or `// -----` blocks. Especially not
  `// Main` above `function main()`.
- **`What lives here:` indexes.** The `export` statements are the index, and
  they don't go stale.
- **`Why X and not Y` sections.** Especially arguing against an alternative
  nobody proposed.
- **Changelog narration** — `we used to`, `earlier revisions`, `the old X`,
  `(verified 2026-05)`. Git owns this.
- **Usage transcripts** in module headers. That's `--help` and README
  territory.
- **Commented-out code.** Delete it.
- **Upstream line numbers, versions, and endpoint paths** —
  `@pipedog/core/dist/services/llm_service.js:125`, `mem0ai 1.0.11`,
  `POST /v2/memories/`. These rot on the next bump, and a stale one is worse
  than nothing: the mem0 comments here once pinned both a version and a path,
  and by the time anyone looked, the SDK was on 2.0.12 POSTing to `/v3/`.
  State the durable behavior — "takes the id only inside `filters`" — and name
  the symbol.
- **Repeating yourself across files.** Explain it once, at the place that owns
  the behavior.
- **Tutorial comments** on the standard library or well-known framework
  behavior.

Never touch directives (`// @ts-expect-error`, `// biome-ignore`), `TODO`/`FIXME`
notes, or license headers. When cleaning comments, change only comments —
never code.

## Worked examples

Keep — cites an external system, with a link (`packages/retrieval/src/tokenize.ts`):

```ts
// LanceDB ships no CJK tokenizer; pre-tokenizing at both ingest and query time is the official
// workaround. https://github.com/lancedb/lancedb/issues/2168
```

Keep — a trap, where removing the field breaks everything quietly
(`packages/retrieval/src/embeddings.ts`):

```ts
// encoding_format "float" is always sent: providers that mishandle base64 round-trip an empty
// response.
```

Keep — a measured number, unrecoverable from the code
(`packages/ingest/src/ingest_facts.ts`):

```ts
/**
 * The prefix `stripFactPrefix` removes: `subject`, an optional reporting verb, and punctuation.
 * About 95% of 奶绿's facts open "明前奶绿声称…", and that shared prefix pulled every vector into
 * one cluster; leaving it out of the embedding lifted vector-only MRR from 0.833 to 0.925.
 */
```

Delete — this repo narrating its own layout:

```ts
// Why this module exists separately from embeddings.ts: that one owns the embedding HTTP
// client (the write path). This one composes search-side operations (the read path). Keeping
// them split mirrors the write-vectors / read-and-rank divide.
```

Compress — root-cause narration down to the lines that act
(`packages/memory/src/provider.ts`):

```ts
/**
 * Pipecat records `{"role": "assistant", "tool_calls": [...]}` with no `content` on every tool
 * call, and mem0 rejects a whole batch over one such message. It stays in the cumulative context,
 * so the filter runs on every store; a batch that filters down to nothing skips the call.
 */
```

## Verifying a comment-only sweep

Editing prose across many files at once is easy to get subtly wrong. Prove you
didn't: tokenize each changed file before and after with TypeScript's own
scanner, as its parser drives it (so regular expressions, template strings and
JSX text come out as single tokens), drop the comments, and compare the two
token streams. Comments never become tokens, so identical streams mean only
prose moved. Do this instead of re-reading the diff and hoping.

One thing that check will not catch: a stale claim that was already wrong
before you touched it.
