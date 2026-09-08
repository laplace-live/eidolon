# Retrieval performance with the existing ranking preserved

The shared embedding change is now implemented locally. See the
[implementation and validation report](../embedding-implementation/README.md).
The measurements below describe the preceding prototype investigation.

**Reuse one successful query embedding for persona facts and archive retrieval,
while keeping their searches and rerank requests sequential.** This is the most
conservative improvement supported by the follow-up measurements. It removes a
duplicate API request without changing the query, embedding model, reranker,
candidate pools, result counts, date filtering, or context formatting.

The prototype improved the two live comparisons in which both baseline and
optimized retrieval completed reranking successfully:

| Query | Current sequential path | Shared embedding, sequential searches | Observed reduction |
| --- | ---: | ---: | ---: |
| 你拔过智齿吗 | 3.393 s | 2.006 s | 40.9% |
| 26年3月24直播内容 | 3.654 s | 2.491 s | 31.8% |

Both comparisons returned **identical ordered IDs, relevance scores, and formatted
context** for both tables. These are two individual samples, not a guaranteed
percentage improvement. The redundant second embedding alone took 0.638, 0.822,
and 0.953 seconds across the three original queries. That removed work is the
clearest expected saving; the larger observed differences also include provider
latency variation.

The third query, 你梦想是什么, took 7.727 seconds in the baseline and 5.799 seconds
with a shared embedding. It is excluded from the result-equivalent speed comparison:
the baseline archive rerank exhausted three HTTP 429 retries and fell back to RRF;
the shared-embedding run successfully used the configured reranker. Its outputs
matched the other successful reranked run for that query.

This prototype investigation changed no runtime code, `.env`, persona, or index
files. The timing boundary is the two
retrieval stages only, excluding STT, Mem0, LLM, TTS, and WebRTC.

## What “preserved” means here

The live prototype calls the existing `LanceRetriever.search()` and
`hybrid_search()` methods. A benchmark-only embedding substitution supplies the
same successful vector to both calls. Facts retain candidates/top-k **30/8** and
archive **15/3**, the existing date filters, and the configured
**`voyageai/rerank-2.5-lite`** reranker. Tables contain 3,398 facts and 41,367 chunks.

There are three complementary checks:

- Live HTTP payload comparisons include the exact reranker query and candidate
  document order. Payloads matched between schedules. All independently requested
  vectors for each repeated question were byte-identical in these tests.
- [Recorded-response replay](replay-results.json) runs real LanceDB retrieval and
  the existing ranking adapter against the same saved provider responses. All
  **18 schedule executions** produced identical rows and formatted context across
  serial, shared-embedding serial, and shared-embedding parallel variants. This
  includes forced archive 429 exhaustion and the existing RRF fallback. It makes
  **zero network requests** and isolates scheduling from provider variability.
- [Context assembly checks](context-parity.json) compare the real enrichment
  methods across **99 turns in nine scenarios**, using recorded result rows in
  place of `_search`. They preserve exact serialized messages, query assembly,
  repeated-query suppression, empty results, failure isolation, and missing
  service behavior. This is an offline orchestration check, not 99 live queries.

These checks establish equivalence for the tested inputs and responses. External
service failures can change a live result even when the same unmodified search is
repeated; the baseline fallback above demonstrated that distinction.

## Why parallel searches are a second step

Sharing a vector and running both searches concurrently also preserved output
whenever reranking succeeded, but the measured speed was inconsistent:

| Query | Current sequential path | Shared embedding + parallel searches |
| --- | ---: | ---: |
| 你拔过智齿吗 | 3.393 s | 1.739 s, 48.8% faster |
| 26年3月24直播内容 | 3.654 s | 4.110 s, 12.5% slower |

The dated query incurred one archive 429 in both schedules. That failed attempt
took 0.507 seconds in the baseline and 1.991 seconds in the parallel run. This
small sample does not establish that concurrency caused the throttling; it does
show that overlapping requests does not ensure lower wall-clock latency with
this provider. The dream-query parallel run also needed two archive retries.

Across this follow-up, there were **12 embedding HTTP requests and 25 rerank HTTP
attempts for 18 logical reranks**: eight HTTP 429 responses and one RRF fallback.
Keep the current reranker enabled, and validate provider retry/fallback behavior
under realistic concurrency before making parallel retrieval the default.

## Implementation boundaries

Share embeddings only within the current retrieval turn, keyed by the **exact
query text, effective embedding model, and vector dimension**. The two services
normally assemble the same query, but their per-service settings can differ.
Store successful embeddings only: if the first lookup fails, the second service
must retain its independent opportunity to request an embedding. Preserve the
existing skip behavior for absent tables, short queries, and repeated queries.

For a later parallel implementation, retrieve independently and apply context
updates sequentially in the existing facts-then-archive execution order. Both
services insert at position 2, so concurrently calling their current `_enhance()`
methods can change final message order. Preserve each branch's stale-table retry,
rerank fallback, and cancellation behavior. The current reranker receives the
tokenized FTS query from LanceDB; replacing it with raw user text would be a
separate ranking change.

This optimization does not need smaller embeddings, fewer candidates, fewer
returned chunks, result caching, context removal, or a different reranker. Leave
those choices outside this change when preserving the current result is the goal.

## Reproduction

Live fixtures and per-request timings are in [results.json](results.json) and
[results-serial-shared.json](results-serial-shared.json). The first live run
alternated baseline/parallel order across three questions. The serial-shared
follow-up ran afterward in a fresh process, so its first request also includes
cold HTTP connection effects. No other live provider benchmarks ran concurrently.

The live benchmark makes paid requests with the existing configuration. Use a new
output path to preserve these measurements:

```sh
.venv/bin/python docs/benchmarks/2026-09-08/retrieval-preserved/benchmark.py --help
.venv/bin/python docs/benchmarks/2026-09-08/retrieval-preserved/replay.py
.venv/bin/python docs/benchmarks/2026-09-08/context_parity.py
```

Ruff and scoped Pyright validation passed for the benchmark programs. No production
performance improvement is claimed until the selected change is implemented and
the bot is measured again through a real call.
