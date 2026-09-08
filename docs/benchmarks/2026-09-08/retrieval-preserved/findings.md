# Retrieval with reranking preserved

The strongest initial change is to reuse the same question embedding for the two existing searches. Keeping their rerank requests sequential avoids increasing request concurrency against an already unstable endpoint. Parallel searches offer further upside, but the live sample includes one slower parallel run.

All tests used the configured `voyageai/rerank-2.5-lite` through OpenRouter, the existing embedding model/dimension, existing LanceDB tables, candidate counts (facts 30; archive 15), result counts (facts 8; archive 3), and date filters. No runtime source, configuration, or index was edited. Only benchmark harnesses and artifacts were added.

## Live timings

| Eval question | Existing serial | Shared embedding, serial searches | Shared embedding, parallel searches |
| --- | ---: | ---: | ---: |
| 你梦想是什么 | 7.727 s | 5.799 s | 4.363 s |
| 你拔过智齿吗 | 3.393 s | 2.006 s | 1.739 s |
| 26年3月24直播内容 | 3.654 s | 2.491 s | 4.110 s |

The dream baseline exhausted all three archive reranker attempts and fell back to RRF; the other schedules succeeded with reranking. Its output and latency are not an equivalent comparison. This question was also first in each process and includes cold connection effects.

For the other two questions, shared embedding with serial searches saved 1.39 s and 1.16 s in these runs; these are observed end-to-end differences, not a guaranteed optimization-only effect. The duplicate baseline embedding itself consumed 0.82 s and 0.95 s (0.64 s for the dream question). Provider/network variance accounts for the remaining difference.

Parallel retrieval saved 49% on the clean teeth comparison. It was 0.46 s slower for the date question: the archive's first HTTP 429 took 1.99 s in the parallel run versus 0.51 s in the serial run. This sample does not establish a consistent parallel speedup.

The first six runs alternated serial/parallel order by question. The three serial-shared runs followed in a separate process; they were not randomized paired trials. Samples are deliberately small and do not establish p95 latency or behavior under multi-user load.

## Result equivalence

For each question, all four independently requested live embedding vectors were identical. Across all three schedules, each table's actual reranker HTTP payload was identical, including model, the currently tokenized query, candidate document text and order. Every successful reranked result matched exactly in ordered IDs, scores, and formatted LLM context.

The one live output mismatch was the dream archive's existing serial-path fallback after three HTTP 429s. Both shared variants received the same successful ranking for its identical request payload. This is provider availability variation, not a ranking change introduced by the prototype.

The offline replay runs the actual `LanceRetriever.search` and real local LanceDB, replacing only embeddings and HTTP responses with captured fixtures. It compares serial, shared-serial, and shared-parallel schedules on all three questions, both with successful reranking and with archive reranking forced to return HTTP 429 for all three attempts. All 18 schedule runs produced exactly matching full rows and formatted contexts within each scenario. It performs zero network requests. This proves schedule equivalence for these inputs and response scenarios, not universal conversational answer quality.

Root-level `context-parity.json` separately checks how the existing services assemble messages and handle skipped queries and errors; it is not a live provider test.

## Provider reliability and bounds

The live work made 37 HTTP requests: 12 embeddings and 25 reranker attempts for 18 logical reranks. Eight reranker responses were HTTP 429, causing seven retry requests and one RRF fallback. The follow-up serial-shared batch used 10 of its hard 13-request cap; the cap was not reached. No viewer memories were used.

An implementation should preserve each table's independent failure behavior and retry opportunity if a shared embedding fails. The harness's success-path shared vector is not a drop-in production implementation of that policy. Retain current candidates, result counts, reranker, date filters, query construction and message insertion order. Provider concurrency and first-use initialization also need production handling before parallel retrieval is enabled.

## Artifacts and reproduction

- `results.json`: original paired live runs, vectors, candidate rows, exact HTTP payloads/responses, timings, final rows and formatted contexts.
- `results-serial-shared.json`: follow-up shared embedding with sequential searches.
- `summary.json`: exact payload/vector/result checks across all three schedules and aggregate request counts.
- `replay-results.json`: 18 deterministic local schedule runs, including failed archive reranking.
- `benchmark.py`: live harness; rerunning it sends project data to the configured embedding/rerank providers.
- `replay.py`: offline replay; no provider traffic.

```bash
.venv/bin/python docs/benchmarks/2026-09-08/retrieval-preserved/replay.py
.venv/bin/ruff check docs/benchmarks/2026-09-08/retrieval-preserved
.venv/bin/pyright --pythonpath .venv/bin/python docs/benchmarks/2026-09-08/retrieval-preserved/benchmark.py docs/benchmarks/2026-09-08/retrieval-preserved/replay.py
```
