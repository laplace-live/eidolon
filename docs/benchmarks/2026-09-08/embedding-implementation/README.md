# Shared query embedding implementation

Persona facts and stream archive now reuse a successful embedding when their exact
query text, effective model, and vector dimension match within one context frame.
The cache belongs to that frame, so it does not carry across turns or viewers.
Failed or empty embeddings remain retryable by the next service. Missing tables
still skip embedding entirely.

Both searches and their rerank requests remain sequential. Candidate pools,
result counts, date filtering, stale-table recovery, rerank fallback, and context
formatting are preserved. The model, dimensions, and stored vectors are unchanged;
**existing databases do not need reindexing**.

## Validation

| Check | Result |
| --- | --- |
| Full test suite | 26 passed, including 17 new cache and processor cases |
| Ruff | Passed across the repository |
| Pyright, changed source and tests | Passed |
| Pyright, whole repository | Three existing possibly-unbound `transcript` errors in `tools/transcribe.py`, lines 601, 633, and 634 |
| Recorded-response replay | All six comparisons / 12 runs preserved exact rows, formatted contexts, reranker payloads/statuses, and facts-then-archive execution |
| Embedding requests in replay | Two reduced to one in every comparison |
| Live retrieval evaluation | All 17 questions matched the pre-change current-configuration metrics |
| Real local WebRTC call | One successful embedding request shared by both searches; two successful rerank requests; complete spoken answer received |

The replay uses the actual implementation with and without its optional cache,
real LanceDB tables, and recorded provider responses. It covers three questions
with normal reranking and forced archive HTTP 429 exhaustion/fallback. It made
zero network requests. See [results](replay-results.json) and [harness](replay.py).

The live evaluation retained facts recall@3 of 100% and MRR of 0.778 across 12
questions, and archive recall@1 of 100% and MRR of 1.0 across five questions.
The checked-in historical baseline has a higher facts MRR of 0.958; the difference
already existed in the initial live benchmark with the current reranker before
this implementation. See [evaluation](retrieval-eval.json) and
[comparison with the initial live run](eval-comparison.json).

The [WebRTC call evidence](webrtc-call.md) records actual `/api/offer`, RTP audio,
STT, retrieval, LLM, and TTS execution. It used local host candidates and an
anonymous viewer. TURN, WAN, browser interaction, and Mem0 were outside this check.
Soniox split the opening name into an early fragment, causing an interrupted LLM
request before the full question completed. This single call verifies integration
and request counts; it does not establish a comparative latency improvement.

The [earlier live prototype comparisons](../retrieval-preserved/README.md) measured
the potential time saved. This implementation removes one duplicate embedding
round trip when both searches use the same query, without changing ranking.
