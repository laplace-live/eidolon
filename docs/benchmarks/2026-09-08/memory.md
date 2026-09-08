# Mem0 latency investigation

The configured local Qdrant service was unavailable. A read-only collection metadata
request to the loopback listener on port 6333 returned connection refused in
26.92 ms after approval for local network access. The earlier sandbox-denied
attempt is recorded separately and is not a service measurement. No collection
metadata, viewer contents, or memory search latency was obtained. This result
does not establish the availability or latency of the deployed service.

No Docker service was started, no `Memory` engine was constructed, and no provider
requests or vector-store writes were made. Raw measurements are in [memory.json](memory.json).

## Findings from the installed code

- Logged-in sessions await Mem0 search before persona facts, stream archive,
  and answer generation. Anonymous sessions skip Mem0. The Pipecat service
  awaits `_enhance_context_with_memories`, then starts a background store task,
  then forwards the context frame. Writes are already outside the direct
  response dependency, although their resource contention has not been measured.
- The local wrapper adds no retrieval deadline. Installed Mem0 creates its
  embedding `OpenAI` client without timeout or retry overrides. Installed OpenAI
  defaults are a 600-second timeout, 5-second connection timeout, and two retries.
  These are SDK limits, not observed request durations or a single overall
  wall-clock deadline. Treat this as an unmeasured tail-latency concern.
- The installed Mem0 search embeds the query, performs semantic search with
  `max(top_k * 4, 60)` candidates, attempts optional keyword/entity work, then
  scores results. Here spaCy and fastembed are absent, so NLP and keyword
  acceleration should not be credited with measured cost or benefit.
- Each logged-in session constructs an engine synchronously during setup.
  Its constructor checks/creates collection indexes and opens SQLite history;
  telemetry initialization may also construct another vector store. This is a
  connection-startup candidate to measure on a running deployment, not a
  measured per-turn cost. Constructor side effects are why this probe did not
  use `Memory.from_config` merely to test reads.

## Reproduced context growth

The exact installed `_enhance_context_with_memories` method was extracted from
its AST and executed in isolation with a fake context, three distinct synthetic
queries, and the same synthetic one-memory response for every query. The number
of injected memory system messages grew **1 → 2 → 3**. It inserts each turn's
retrieval result without replacing its previous result. The same immediately
repeated query is skipped by `last_query`; distinct queries trigger growth.

This demonstrates an accumulating context behavior, not an observed latency
increase. The real latency and token effects need a multi-turn logged-in call.
Replacing the previous injected memory message with the current result is a
concrete candidate to test, especially for long sessions.

## Follow-up measurements

1. On a running deployment, compare anonymous and consented test-user sessions
   with the same question, separating engine setup, greeting `get_all`, search,
   background store activity, and LLM first-token time. Record counts and timings
   without persisting viewer contents.
2. Measure Mem0 search latency before assigning it a response-time budget.
   Exercise provider timeout/failure behavior with controlled faults before
   changing timeout policy; cancelling `asyncio.to_thread` alone does not stop
   the synchronous request already running in its worker.
3. Run a multi-turn comparison with current versus replaced memory injection,
   measuring prompt tokens and first-token latency while checking answer quality.

## Source evidence

All source evidence is from this checkout and its installed environment:

- `laplace_eidolon/bot.py:759-807`: identity gate, per-session construction,
  and processor order; `:820-835`: greeting memory retrieval.
- `laplace_eidolon/mem0_local.py:64-123`: configuration and history directory.
- `.venv/lib/python3.13/site-packages/pipecat/services/mem0/memory.py:198-257`:
  awaited threaded search; `:260-296`: context insertion; `:329-334`: search,
  background write, and downstream forwarding order.
- `.venv/lib/python3.13/site-packages/mem0/memory/main.py:490-552`: constructor;
  `:1632-1668`: embedding and retrieval sequence.
- `.venv/lib/python3.13/site-packages/mem0/embeddings/openai.py:35`: client
  construction; `.venv/lib/python3.13/site-packages/openai/_constants.py:9-10`:
  timeout and retries.
- `.venv/lib/python3.13/site-packages/mem0/vector_stores/qdrant.py:130-165`:
  collection/index initialization.

Versions: Pipecat 1.8.1, Mem0 2.0.20, OpenAI 2.54.0, Qdrant client 1.19.0,
Python 3.13.4. No source files were changed for this investigation.
