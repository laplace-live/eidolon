# Retrieval

Hybrid RAG over hand-compiled persona facts (`persona_facts.lance`) and refined past-stream
transcripts (`stream_chunks.lance`), built by the offline chain into `<data home>/personas/<id>/index/`
and served by `packages/retrieval` and `packages/context`. Missing tables or missing keys fail open
quietly so a fresh checkout runs without indexes.

## Building the indexes

A persona's sources live in the data home (`EIDOLON_HOME`, default `~/.laplace/eidolon`), never in
git or container images ([personas.md](personas.md#a-personas-sources)):

```text
~/.laplace/eidolon/sources/<id>/facts/     fact files, one fact per line
~/.laplace/eidolon/sources/<id>/lists/     URL lists, one video per line
~/.laplace/eidolon/personas/<id>/index/    LanceDB tables and stream_catalog.json
```

```bash
pnpm laplace-ingest-facts
pnpm laplace-pipeline --dry-run ~/.laplace/eidolon/sources/<id>/lists/videos.txt
pnpm laplace-pipeline ~/.laplace/eidolon/sources/<id>/lists/videos.txt
```

Ingest and pipeline commands act on the active persona or `--persona <id>`
([typescript.md](typescript.md#the-offline-chain)); `laplace-search` and `laplace-eval-retrieval` use
`EIDOLON_PERSONA` or explicit `--db-path` / `--queries` flags instead of `--persona`.
The download stage installs its own `yt-dlp`, and audio over five hours uses `ffmpeg`. Both ingests
write a jieba-tokenized `tokens` column and build an FTS index after embedding so hybrid search
works at runtime without a separate build step.

## Turn pipeline

Each enabled turn runs this pipeline:

1. **Build a query** from the last few user turns so short utterances ("嗯, 那呢？") keep prior context.
2. **Embed the query** for each enabled index with `EMBED_MODEL` (default Gemini, `EMBED_DIM` 3072).
3. **Date pre-filter:** when the query mentions a date (`2026年5月9日`, `5月9号`, `2024年3月`),
   narrow each index with a SQL `WHERE` clause on its date column (`date` for `persona_facts`,
   `stream_date` for `stream_chunks`) before scoring.
4. **Hybrid search** (vector + jieba-tokenized BM25/FTS) pulls `PERSONA_FACTS_CANDIDATES` (default
   30) or `STREAM_ARCHIVE_CANDIDATES` (default 15), stripping Chinese stopwords on the query side
   only.
5. **Cross-encoder rerank:** `cohere/rerank-4-fast` via OpenRouter rescores to `top_k` (8 for facts,
   3 for chunks), falling back to LanceDB's RRF fusion when `RERANK_ENABLED=false` or when reranking
   fails.

Alongside retrieval, the retrieval gate asks Jev whether the turn needs recall at all and cancels
searches via `unlessSkipped` (`packages/context/src/gate.ts`) without delaying recall turns
([retrieval-gate.md](retrieval-gate.md)). Date-scoped recaps and occurrence/timeline questions
("when did you last play X") read `stream_catalog.json` via `StreamCatalog` instead of similarity
search ([stream-recall.md](stream-recall.md), [recall-gaps.md](recall-gaps.md)).

## Rules

- **Ingest-time and query-time vectors must match.** Changing `EMBED_MODEL` or `EMBED_DIM` requires
  re-running **both** `pnpm laplace-ingest-streams` and `pnpm laplace-ingest-facts` into the
  persona's `index/`, bumping `MEM0_QDRANT_COLLECTION` (Qdrant pins vector dimension at creation;
  existing memories do not migrate), and copying `index/` to servers with `rsync --checksum
  --delete-after --delay-updates` ([personas.md](personas.md#deploying-a-persona)).
- **FTS runs over jieba-tokenized `tokens`, never raw text.** Both ingests populate `tokens` via
  `tokenizeZh`, and queries run through `tokenizeZhQuery` (`packages/retrieval/src/tokenize.ts`).
  Strip stopwords from queries only — stripping them at ingest collapses BM25.
- **Indexes and sources stay out of git and images.** Never commit `index/` or `sources/`.
  `laplace-ingest-streams` rebuilds `stream_chunks` from **every** transcript in `streams/`, so a
  missing transcript drops that stream from the rebuilt table.
- **`hybridSearch` (`packages/retrieval/src/hybrid.ts`) is the one search path.** The bot, `/mcp`,
  `laplace-search`, and `laplace-eval-retrieval` all share it; runtime callers go through
  `LanceRetriever` (`retriever.ts`), which adds only table handles and stale-handle reopening.
- **Similarity search cannot answer occurrence questions.** "When did you last play X" and "how
  often" go through `StreamCatalog.timeline` (`packages/retrieval/src/stream_catalog.ts`), not
  larger `top_k` or rerankers ([stream-recall.md](stream-recall.md#when-she-last-did-something)).

## Evaluation

Whenever you change retrieval, tokenization, chunking, `top_k`, or candidate counts, measure recall@k
and MRR against the persona's baseline before claiming an improvement:

```bash
pnpm laplace-search "奶绿最喜欢喝什么"
pnpm laplace-eval-retrieval --verbose --save ~/.laplace/eidolon/sources/<id>/eval/baseline.json
# ... make changes, re-ingest, then compare ...
pnpm laplace-eval-retrieval --compare ~/.laplace/eidolon/sources/<id>/eval/baseline.json
```

Add new failure cases to `~/.laplace/eidolon/sources/<id>/eval/queries.toml` beside the baseline.
For real-corpus write-side parity tests, run `EIDOLON_REQUIRE_PARITY=1 pnpm test packages/retrieval/test/write_real.test.ts`
([typescript.md](typescript.md#real-data-tests)).
