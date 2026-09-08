# Voice response performance investigation — 2026-09-08

Sharing the query embedding between both searches is now implemented locally;
see the [implementation and validation report](embedding-implementation/README.md).
The [ranking-preserving investigation](retrieval-preserved/README.md) documents
the measurements supporting that change. The original investigation follows.

The measured delay comes mainly from serial external retrieval requests, LLM time
to speakable text, and Fish synthesis. Local LanceDB execution is comparatively
small. One completed replay through the actual bot took **14.57 seconds from the
end of the input recording to the first transport audio**. This is a diagnostic
sample, not a production average or a browser round-trip measurement.

The original investigation changed no runtime source, environment settings,
persona, or retrieval indexes.
The files here contain the benchmark programs, results, and saved audio comparisons.

## What was tested

Tests ran on this local Apple Silicon Mac with the existing `.env`, repository
commit `1f29436`, Pipecat 1.8.1, LanceDB 0.38.0, and the real local indexes:
**3,398 persona facts and 41,367 archive chunks**. Provider calls used the existing
configured accounts after explicit approval; no viewer memories were uploaded.

The effective configuration matters: the LLM alias `~google/gemini-flash-latest`
resolved to **`google/gemini-3.8-flash`** in the measured replies; Fish was
**`s2-pro`, latency `normal`**, and the reranker was
**`voyageai/rerank-2.5-lite` through OpenRouter**. These differ from some documented
defaults. Embeddings were `google/gemini-embedding-2-preview`, 3072 dimensions.

| Experiment | Sample and boundary |
| --- | --- |
| Actual bot audio replay | Two inputs: one synthetic Chinese question and one six-second real VOD excerpt. Unchanged `run_bot`, Soniox, VAD/SmartTurn, both RAG services, LLM, Fish; local PCM transport replaces WebRTC. One response completed; the clipped VOD input stalled. |
| Retrieval stages | Three exact two-table sequences; 20 live embeddings and 20 logical reranks, with 21 rerank HTTP attempts because one 429 recovered on retry. |
| Retrieval quality | All 17 checked-in evaluation questions: 12 facts and five archive queries; current reranker versus local RRF on the same query vectors. |
| LLM and first-sentence audio | Two real questions with their actual retrieved context, twice each: four baseline replies. One additional exploratory `reasoning.effort=minimal` reply. |
| Fish mode comparison | Identical synthetic Chinese text and configured voice, alternating `normal`/`balanced`, three requests per mode. |
| Context growth | Local execution of the real enrichment methods, replaying two successful retrieval result sets over 20 turns. No extra LLM calls. |
| Mem0 | Read-only connection probe and installed-source audit. Configured local Qdrant refused the connection; live memory retrieval remains unmeasured. |

These are small, sequential per-harness samples. Harnesses overlapped during part
of the run, so shared provider load is possible. They are not a concurrency/load
test, deployed-host benchmark, or reliable p95 estimate. Sandbox DNS failures and
the initial Fish harness's incorrect wait-for-session-finish behavior were excluded
from the successful latency samples.

## Observed response breakdown

The completed question was “奶绿，你平时最喜欢吃什么呀？”. Soniox returned
“耐力，你平时最喜欢吃什么呀？”, and the model spent part of its answer correcting
the name. Times below are measured on that single contiguous pipeline trace.

| Stage | Time |
| --- | ---: |
| Input recording ends → final transcript and turn release | 0.51 s |
| Persona facts, including embedding and reranking | 4.13 s |
| Archive, including another embedding and reranking | 2.01 s |
| LLM request → first complete speakable sentence | 5.51 s |
| Sentence → first Fish PCM and transport output | 2.41 s |
| **Total to first output audio** | **14.57 s** |

Fish also reported **0.96 s of leading silence**, placing estimated audible onset
around **15.53 s** after recording end. The transport bytes were directly observed;
speaker playback and audible onset in a browser were not. Recording EOF can differ
from the acoustic end of speech. See [the trace](call-results.json) and
[call findings](call-summary.json).

The second input, a six-second cut from a real VOD, produced “呃，好。” and was judged
incomplete by SmartTurn. It waited for three seconds of silence, then a subsequent
turn restart/interruption left it without an LLM response before the 75-second
cutoff. This is a captured failure sequence worth investigating. A clipped recording
and artificial replay boundary can contribute; this does not establish its frequency
in real conversations. It is excluded from completed-response latency summaries.

## Which changes have supporting evidence

**1. Disable the current reranker first, then monitor real conversation quality.**
The existing `RERANK_ENABLED=false` switch selects RRF. On this complete but small
evaluation set, disabling reranking preserved every expected match at top three
and improved persona-fact first-result accuracy. The comparison used the same
embedding for each question, isolating ranking from embedding variation.

| Table / metric | Current reranker | RRF without reranker |
| --- | ---: | ---: |
| Facts: recall@1, 12 questions | 58.3% | 75.0% |
| Facts: MRR | 0.778 | 0.875 |
| Facts: recall@3 | 100% | 100% |
| Archive: recall@1 and MRR, five questions | 100% / 1.000 | 100% / 1.000 |
| Facts search/rank median, excluding embedding | 477 ms | 7.85 ms |
| Archive search/rank median, excluding embedding | 780 ms | 48.39 ms |

This suggests roughly a second of retrieval savings for many turns, but the sum of
per-table median differences is an estimate, not a measured optimized end-to-end
result. Broader answer quality was not scored. See [retrieval results](retrieval.json).

**2. Embed each query once and share the vector between both retrieval services.**
The two services currently run in sequence, and each calls `embed_texts` with the
same query. Runtime retrieval does not use the ingest embedding cache. The redundant
second request took **601–631 ms** in the three paired sequences; the median of all
20 embedding requests was **614 ms**. This saving can preserve the exact model,
dimension, query text, and search behavior. No re-ingest is needed to reuse a vector.

If reranking is retained, both independent table searches/reranks can then run
concurrently, with context injection performed afterward in the existing order.
That concurrency is a proposed change, not benchmarked here. Once reranking is off,
local search is only tens of milliseconds, so sharing the embedding has greater value
than parallelizing local scans. See [the current caller](../../../laplace_eidolon/retriever.py).

**3. Listen to the Fish `balanced` samples before changing its setting.**

| Mode | Median time to first PCM | Range | n |
| --- | ---: | ---: | ---: |
| `normal` | 1.573 s | 1.382–1.619 s | 3 |
| `balanced` | 0.549 s | 0.541–0.563 s | 3 |

That is a **1.02 s median difference**, excluding the WebSocket connection, which
was established before sending text. For these samples, leading silence was 0–10 ms.
Listen to [normal](tts-0.wav) and [balanced](tts-1.wav); both use the same text and
voice. Quality was not graded. Fish documents the modes as a speed/quality tradeoff
([official guidance](https://docs.fish.audio/resources/best-practices/real-time-streaming)).
The measured difference here is larger than the 50–100 ms comment in `bot.py`.

**4. Replace previous RAG injections instead of accumulating them forever.**
Both `_enhance` methods insert another system message on every different query.
Alternating the two real result sets produced **2,787 RAG characters after one turn,
26,595 after ten, and 53,190 after twenty**. Keep current retrieval context in a
replaceable slot for each source, while preserving actual conversation history.
The local reproduction proves growth; it does not measure how many seconds this
adds to a long call. Mem0 has the same injection pattern in the installed dependency.
See [context-growth evidence](call-context-growth.json) and [memory findings](memory.md).

**5. Investigate the LLM's first-answer latency; lowering reasoning alone is not yet a win.**
Across four actual RAG prompts of 5,022–5,150 input tokens, first response chunks
arrived in **3.40–3.73 s**, first speakable text in **4.19–5.72 s** (median **4.48 s**),
and the first complete sentence in **4.46–6.05 s**. Replies used **192–345 reasoning
tokens**. Prompt cache reads were zero in all four responses.

One controlled-input `minimal` reasoning probe returned first speakable text in
**4.46 s**, within the baseline range; it still used 187 reasoning tokens. This
does **not** establish a speedup. A larger interleaved comparison of model/provider
routing, a fixed model ID, and supported reasoning settings is the next useful LLM
experiment, with grounding/persona/tool-use checks alongside timing. Hiding reasoning
with `exclude` is not equivalent to reducing its compute
([OpenRouter documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)).

The baseline's first-sentence aggregation added only **0.08–0.33 s after the first
speakable token**. It can wait for the whole response when punctuation is absent,
but token-level flushing is not the largest measured issue here. A shorter natural
first sentence may also reduce Fish time: the tested first sentences varied from
roughly two to ten seconds of generated audio. That relationship is observational,
not a controlled sentence-length experiment.

## What to measure in production next

Record speech-end → turn release → each retrieval stage → first speakable LLM token
→ first sentence → first audible audio, plus input-token count, reasoning-token
count, provider errors, and completed versus stalled/interrupted turns. Pipecat
already emits service metrics, but `observers=[]` leaves this project without a
dedicated user-to-bot latency observer. Add stage timing for the custom enrichers;
their serial wait is otherwise easy to miss. Pipecat's
[latency observer](https://docs.pipecat.ai/api-reference/server/utilities/observers/user-bot-latency-observer)
and [TTFAT/TTFA metrics](https://reference-server.pipecat.ai/en/latest/api/pipecat.metrics.metrics.html)
describe the relevant boundaries.

Repeat on the deployed host through a real browser/WebRTC/TURN connection, then
cover logged-in Mem0 and longer conversations. Mem0 writes already run in the
background; moving them there is not an outstanding optimization. The installed
search/embedding retry budgets can produce long waits during outages, but that
tail behavior was not reproduced in these successful requests.

Start with reranker removal, embedding reuse, and Fish listening QA. Keep their
validation separate, then measure the combined change end to end; their savings
should not be added to promise an untested response-time target.

## Reproducing and checking the artifacts

The benchmark scripts make real provider requests when run. The retrieval and call
scripts overwrite their adjacent JSON results; archive this directory before
rerunning them. The voice script accepts a separate output directory. The call
script's adjacent WAV files are saved local inputs and are ignored by Git under
the existing audio rules.

```sh
.venv/bin/python docs/benchmarks/2026-09-08/retrieval_benchmark.py
.venv/bin/python docs/benchmarks/2026-09-08/call_benchmark.py
.venv/bin/python docs/benchmarks/2026-09-08/voice_benchmark.py \
  --contexts docs/benchmarks/2026-09-08/voice-contexts.json --skip-tts \
  --output /tmp/eidolon-voice-comparison
.venv/bin/python docs/benchmarks/2026-09-08/voice_benchmark.py \
  --tts-only --output /tmp/eidolon-fish-comparison
```

Ruff and explicit type checks for the benchmark scripts passed. The whole-project
Pyright check reports three existing `transcript` possibly-unbound errors in
`laplace_eidolon/tools/transcribe.py` at lines 601, 633, and 634. Runtime files were
not edited to address those unrelated errors.
