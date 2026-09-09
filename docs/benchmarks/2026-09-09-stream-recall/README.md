# Stream recall validation — 2026-09-09

The local catalog now selects the correct broadcasts for latest-stream, weekly,
explicit-date, and follow-up recaps without embedding or reranking requests.
This verifies selection, recording-part coverage, and local lookup performance.
It does not establish time to the first model answer or audible response.

Run the offline check from the repository root:

```sh
uv run python docs/benchmarks/2026-09-09-stream-recall/offline.py
uv run python docs/benchmarks/2026-09-09-stream-recall/startup.py
```

The script fixes the persona date at September 9, 2026 in Asia/Shanghai and uses
the real catalog and LanceDB. Its retriever raises if search is attempted, and
socket connections are blocked while the recall cases run. Each case runs
20 times after loading the catalog. Assertions check the exact broadcast IDs
and confirm every selected broadcast is represented in the rendered context.

| Question | Selected material | Median resolve + lookup + render |
| --- | --- | ---: |
| 你上次直播播了什么？ | September 8; 2 parts, 42 scenes | 0.31 ms |
| 你上周直播都播了什么？ | September 1–6; 6 broadcasts, 14 parts, 310 scenes | 0.51 ms |
| 2026年9月8日直播播了什么？ | September 8; 2 parts, 42 scenes | 0.32 ms |
| What did you stream on September 8, 2026? | September 8; 2 parts, 42 scenes | 0.30 ms |
| 那周播了什么？ after the weekly question | Same 6 broadcasts and 14 parts | 0.51 ms |

The first catalog load took 176.6 ms for 918 broadcasts. The weekly overview
contains 310 source scenes, including 74 anime-audio scenes omitted from the
236 indexed chunks for that week. This demonstrates that excluded transcription
content remains represented in overview coverage; detailed search still uses
the existing filtered chunk index. The final rendered weekly context contains
6,952 characters and includes all six broadcast IDs. Its scene excerpts are
compressed and do not reproduce every source detail.

All 100 measured cases completed with zero retriever calls and zero socket
connection attempts. Exact IDs, timing samples aggregated per case, and scene
counts are in [offline-results.json](offline-results.json). Warm timings cover
local date resolution, catalog selection, and formatting; model inference,
provider communication, STT, TTS, WebRTC, and Mem0 are excluded.

Live validation remains pending. A sandboxed baseline retrieval evaluation
failed to connect. Automatic approval review rejected its escalated retry
because it would send questions and archive snippets to configured external
embedding and reranking providers without explicit authorization for that data
and those destinations. After the user requested testing the existing local dev server with its `.env`,
automatic review again rejected the bounded provider run, interpreting that
instruction as local access only. Neither rejected command started. The existing
server at `127.0.0.1:7860` responded successfully to `GET /status`; no offer was
sent to it and no provider evaluation followed.

Prepared temporary harnesses in `/tmp/eidolon-recall-baseline/` support:

- `run_live.py`: shared 15-minute deadline and 12-answer cap across text and
  voice phases; subprocess timeouts terminate the test process group.
- `run_eval.py`: selected package against the checked-in retrieval baseline,
  restricted to `hybrid_rerank` by the coordinator.
- `benchmark_text.py`: before/after enrichment order, current native tool schemas
  and handlers, bounded streaming tool loop, and per-delta timestamps. The new
  package uses archive before facts and skips facts for recaps. It includes
  tool round trips but does not reproduce Pipecat scheduler or audio latency.
- `webrtc_call.py`: temporary local `/api/offer` server with an actual aiortc
  RTP/Opus peer and the selected package's bot pipeline. The comparison uses
  `--keep-ice` for the snapshot and `--server-url http://127.0.0.1:7860` for
  the existing dev server, preserving configured transport settings. A synthetic
  Chinese weekly-recap question goes through Soniox, retrieval, OpenRouter,
  and Fish. Anonymous identity skips Mem0, and no greeting is requested.
  Completion waits for the final model/tool cycle, spoken-text coverage, and
  quiet received audio; the instrumented snapshot also checks output drain.
  Recorded transcript and response audio must be inspected for success.
  External-server mode exposes RTVI events, but no internal retrieval spans.

The proposed live test is limited to 15 minutes total and at most 12 answered
turns. Its normal schedule produces 11 answers: these four fresh-context
questions once against the snapshot and once against the new package, one
additional fallback question against the new package, then one baseline local
WebRTC call and one call to the existing dev server:

1. 你上次直播播了什么？
2. 你上周直播都播了什么？
3. 2026年9月8日直播播了什么？
4. 2026年9月8日直播里你说喜欢什么样的ASMR？

The additional new-package question is “你上周四直播都播了什么？”. This
requires the native fallback because the deterministic parser deliberately
leaves weekday-qualified periods unresolved. The harness asserts an actual
`recall_streams` invocation; the selected date and final answer still require
review.

The WebRTC calls each replay the same 2.061-second synthetic question,
“你上周直播都播了什么？”. The coordinator performs no automatic answer retries. Each archive tool handler retains the runtime limit of two lookups
per user turn; the text harness also stops after four model passes. One
17-question retrieval evaluation in the `hybrid_rerank` mode per version checks
existing recall@k/MRR; those retrieval-only queries do not generate answers.

The authorized destinations requested are the existing configured embedding,
reranking, OpenRouter LLM, Soniox STT, and Fish TTS providers. Test data is
synthetic questions/audio, the configured persona prompt, and relevant archive
and persona-fact snippets. Every session is anonymous, so viewer private Mem0
memories are excluded. All requests target local test instances and the configured
providers; no production bot calls are needed.

First meaningful text must be marked by reviewing the saved answer and token
timestamps. First text and the first 12 characters are diagnostic timestamps;
fillers such as “let me check” do not count as an answer. The WebRTC transcript,
LLM text, and received audio must also agree before an audible result is accepted.

After explicit provider-test approval, these commands run both retrieval
evaluations, the text comparison, and real local calls within one shared budget.
The existing dev server is not restarted or reconfigured:

```sh
.venv/bin/python /tmp/eidolon-recall-baseline/run_live.py text
.venv/bin/python /tmp/eidolon-recall-baseline/run_live.py voice
```

The offline application startup check also entered and exited the current
ASGI, MCP, and WebRTC-handler lifespans with socket connections blocked.
`GET /status` returned `200` with `{"status":"ready","transports":["webrtc"]}`.
The runner has no `/health` route. This check used an in-process HTTP client,
sent no offer, and started no STT/LLM/TTS session; see
[startup-results.json](startup-results.json).

The harnesses compile, and ten synthetic voice-completion/privacy checks pass
with socket connections blocked and zero attempts. A local child-process check
verified timeout termination and enforcement of the answer cap. Full retrieval-quality
metrics and before/after time to first meaningful text or audio remain unmeasured.

The full local suite passes 209 tests. Ruff and changed-file Pyright pass.
Whole-repository Pyright reports the same three pre-existing possibly-unbound
`transcript` errors in `tools/transcribe.py` as the original package snapshot.
The lockfile check also passes. Pipeline command checks confirm the catalog is
rebuilt after a successful ingest, and skipped after a failed ingest or dry run.

A separate source audit rebuilt the catalog without network access and matched
all catalog content except its build timestamp. All 43,912 searchable scene IDs
matched the LanceDB table exactly; the remaining 7,469 scenes are represented
only in the catalog. See [catalog-audit-results.json](catalog-audit-results.json).
