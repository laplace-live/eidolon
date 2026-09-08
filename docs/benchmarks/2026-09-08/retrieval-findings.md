Retrieval spends most of its time on remote embeddings and reranking. The two existing LanceDB tables are fast on this machine. The currently configured reranker did not improve quality on the repository's 17-query evaluation set.

Measured on 2026-09-08 with the existing local indexes: **3,398 persona facts** (table version 3), **41,367 stream chunks** (version 2), `google/gemini-embedding-2-preview` embeddings at 3072 dimensions, and `voyageai/rerank-2.5-lite` through OpenRouter. Candidate limits were the existing facts=30/archive=15 and runtime output limits facts=8/archive=3. The active reranker differs from the repository's default `cohere/rerank-4-fast`.

The approved live run made **20 embedding calls and 20 logical reranks**. The latter produced **21 HTTP attempts: 20 succeeded and one 429 succeeded on its immediate retry**. Every final search succeeded. Tokenizer initialization was warmed outside the search timings. All requests were serial within this benchmark; other test agents may have used independent speech/LLM APIs concurrently. These are local development-machine measurements, not production server measurements.

| Measured stage | Samples | Median | p95 | Range |
|---|---:|---:|---:|---:|
| Query embedding, including client setup on the first call | 20 | 614 ms | 1,170 ms | 578–1,835 ms |
| Rerank HTTP attempt | 21 | 476 ms | 1,512 ms | 418–1,946 ms |
| Facts hybrid search with configured reranker | 12 | 477 ms | 1,532 ms | 433–1,532 ms |
| Facts hybrid search with RRF only | 12 | 7.9 ms | 13.7 ms | 6.7–13.7 ms |
| Archive hybrid search with configured reranker | 5 | 780 ms | 1,976 ms | 700–1,976 ms |
| Archive hybrid search with RRF only | 5 | 48.4 ms | 100.9 ms | 30.1–100.9 ms |

The hybrid comparisons reuse the same real query embedding across both modes. Their timings exclude embedding and include local search, result conversion, and reranking where enabled. Nearest-rank p95 is simply the maximum at these small sample counts. Three quality measurements reuse the full reranker result from the preceding exact runtime search, captured before its final 8/3-row slice; they incur no extra paid request.

Three queries also traversed the **exact two sequential `LanceRetriever.search` calls**, with the normal 8 facts and 3 archive chunks:

| Query | Total before LLM | Embedding 1 / 2 | Both reranks combined | Local search and other overhead |
|---|---:|---:|---:|---:|
| 你梦想是什么 | 5,472 ms | 1,835 / 601 ms | 2,924 ms | 112 ms |
| 你拔过智齿吗 | 2,479 ms | 600 / 630 ms | 1,183 ms | 66 ms |
| 26年3月24直播内容 | 2,995 ms | 657 / 631 ms | 1,602 ms | 105 ms |

The first pair includes cold client/network behavior. The third includes the recovered 429, whose rejected attempt took 482 ms. The remainder column is subtraction from directly observed stage timings, not an independently timed stage.

`LanceRetriever.search` embeds independently for each table. `embed_texts` always calls the remote embedding service; it does not use `EmbedCache`. The existing ingest cache has 52,865 vectors, with **zero exact matches for the 17 evaluation questions**. Therefore, describing repeated runtime requests as cached would be incorrect. The second identical embedding request alone took 601–631 ms in these three actual turns.

| Existing evaluation set | Mode | Recall@1 | Recall@3 | Recall@10 | MRR |
|---|---|---:|---:|---:|---:|
| Facts, 12 queries | RRF only | 75.0% | 100% | 100% | 0.875 |
| Facts, 12 queries | Configured reranker | 58.3% | 100% | 100% | 0.778 |
| Archive, 5 queries | RRF only | 100% | 100% | 100% | 1.000 |
| Archive, 5 queries | Configured reranker | 100% | 100% | 100% | 1.000 |

Examples: reranking moved the expected answer from rank 1 to 2 for `你梦想是什么`, `坚果体重多少斤`, and `你智商多少`; it improved `你体重多少kg` from 2 to 1. Both modes retrieve the expected answer inside the runtime output sizes for all 17 queries. These are the repository's existing substring-match judgments, including some broad acceptable-substring lists; they do not establish production answer quality or general reranker superiority. The historical baseline reports facts MRR 0.958 for both hybrid modes and archive MRR 1.000, but does not record corpus/model metadata. Today's paired comparison is the controlled comparison; a baseline regression cannot be assigned to one cause from that file alone.

The first changes to evaluate are:

1. **Disable the currently configured reranker using the existing `RERANK_ENABLED=false` switch**, then expand conversational evaluation before making it permanent. It added approximately 469 ms per facts search and 732 ms per archive search when comparing the respective medians, without a measured retrieval-quality benefit here. Those differences are descriptive comparisons, not a measured end-to-end speedup.
2. **Compute the query embedding once per turn and share it between facts and archive**, preserving their independent optional-failure behavior. The three exact turns each contain a directly removable second network call of about 0.63 seconds. A turn-scoped shared vector avoids needing a broad persistent cache.
3. **If reranking remains necessary, run the two independent searches concurrently after the shared embedding**, then insert their context blocks in the existing deterministic order. No concurrent implementation was tested here; measure it with a real call after implementation.
4. **Prioritize these remote waits over a database migration or vector-index changes.** A separate local replay over all 17 query texts, three passes each, measured 51 facts searches at median 6.3 ms and 51 archive searches at 29.5 ms; the sequential pair median was 35.8 ms, p95 41.5 ms. That replay substituted existing corpus-row vectors selected by FTS, so it measures local search cost only and makes no retrieval-quality claim. Both current indexes have complete FTS coverage.

For scale, subtracting the measured reranker durations from each exact pair estimates 2,548 / 1,296 / 1,393 ms of retrieval with reranking removed. Also subtracting the duplicate second embedding estimates **1,947 / 667 / 762 ms**. These are arithmetic budgets from the recorded serial stages, **not timings of implemented changes**; local RRF work and provider variation mean the actual result needs another end-to-end call.

The saved live context blocks contain 318–433 fact characters and 2,214–4,209 archive characters per turn. These exact formatted results are available for the separate LLM and context-growth tests in `retrieval-contexts.json`.

Reproduce the live run from the repository root with `.venv/bin/python docs/benchmarks/2026-09-08/retrieval_benchmark.py`; it reads `.env`, makes approximately 40 provider calls plus retries, and overwrites `retrieval.json` and `retrieval-contexts.json`. The network-free counterpart is `.venv/bin/python docs/benchmarks/2026-09-08/retrieval_local_benchmark.py`, writing `retrieval-local.json`. The scripts instrument existing functions in their own process; they do not edit runtime code or ingest data. Both benchmark scripts passed Ruff and explicit Pyright checks. `git status` and `git diff` confirmed no changes to the tracked `data/lancedb/` indexes or runtime source files. The embedding cache was opened with SQLite `mode=ro`; `.env` was only read.
