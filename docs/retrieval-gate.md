# Retrieval gate

Every user turn used to search both LanceDB tables before the LLM could
start: an embedding and a rerank per table, 4.5–5.5 s in a live call. Most
of that time bought nothing on turns like 我今天加班好累啊 or 哈哈哈好吧,
which ask nothing about the streamer. `retrieval_gate.py` asks TypeSafe's
Jev, a decision model served through OpenRouter's Decisions route, whether
a turn needs her memories at all, and lets the two RAG services drop their
search when it does not.

## Deciding a turn

`RetrievalGate` is the first processor after the user aggregator, ahead of
Mem0, so its call overlaps Mem0's search for logged-in viewers. On each new
user turn it starts one decision and attaches it to the frame's metadata
under `GATE_FRAME_KEY`. A turn is its user-message count plus the latest
user text, so tool continuations within a turn reuse the same decision.

Jev sees the latest user line, the exchange just before it, and a one-line
description of the persona. It answers three yes/no questions: is the
viewer asking about the streamer herself (preferences, habits, body, pets,
friends, backstory, her flower shop), about something she said or did in
the past, or who or what a specific named thing is. Any answer at or above
0.3 means retrieve. Jev reads questions literally, so each one asks a single
thing and the code combines them.

The same request asks three more questions, kept out of that score: does the
viewer ask when she last did something, when she first did it, or how many
times. Any of them at or above 0.7 marks the turn as a timeline question, and
the archive answers it from the catalog instead of the three most similar
chunks ([stream-recall.md](stream-recall.md#when-she-last-did-something)).

## Racing, never waiting

The archive starts its search without waiting for the gate, and
`unless_skipped` cancels that search only if the gate answers "skip" before
the search finishes. A search that finishes first is kept, and an error, a
timeout, or anything but an explicit `False` counts as retrieve. A recall
turn therefore costs what it did before, and a Jev outage costs a warning
line per turn rather than latency. Awaiting the gate before searching would
add its ~0.5 s to every recall turn instead. Persona facts run after the
archive, by which point the decision has almost always settled.

The gate covers only the archive's topical search and the persona-fact
search. The regex-routed branches (date-scoped recall, recaps, the
`recall_streams` tool, and its prompt hint) already know the turn is about
streams and run as before. So do the recent-broadcast overview block and
Mem0.

The gate keeps its own HTTP connection open for 120 s. At httpx's default of
5 s, a call made 15–40 s after the previous one paid a fresh TLS session:
about 1.4 s instead of 0.5 s. The first call of a session still pays it,
which is why the greeting turn's gate takes ~1.3 s.

## Accuracy

Measured on jev-1.13 over 185 labeled turns
([turns.toml](benchmarks/2026-09-19-retrieval-gate/turns.toml)): all 93
turns that needed recall were kept, the lowest scoring 0.58, and 72 of 92
chit-chat turns were skipped. Repeat calls on the same input move by up to
0.05. The skipped share was 83% on a held-out set written before the
questions and threshold were fixed.

The chit-chat that still retrieves falls into a few groups: questions about
her current state (你吃饭了吗, 你今天心情怎么样), voice and selfie requests,
and "what did you just say". Those cost a search, exactly as every turn did
before, and never a missing memory.

Jev reads persona lore only through the description in the state and
"her flower shop" in the first question. Without both, 5 of the 93 recall
turns fell below the threshold, every one about her cat or her shop, such
as 坚果会咬电线吗 and 花店现在还营业吗. TypeSafe documents lower accuracy on
CJK text than on English, so measure before trusting a change.

Re-measured on 2026-11-07, when `~typesafe/jev-latest` answered as jev-1.14,
the gate still kept all 93 recall turns, the lowest at 0.65. It skipped 66 of
the 92 chit-chat turns, against 72 on jev-1.13.

## Changing it

Re-run `uv run python docs/benchmarks/2026-09-19-retrieval-gate/decisions.py`
after touching the questions, the state, the threshold, or
`RETRIEVAL_GATE_MODEL`. It exits non-zero if any labeled recall turn would
be skipped. `~typesafe/jev-latest` follows new Jev releases, which can move
the calibration the threshold relies on; pin `typesafe/jev-1.13` to hold it.
`RETRIEVAL_GATE_ENABLED=false` restores searching on every turn, and turns
timeline answers off with it.

After touching the timeline questions or `TIMELINE_THRESHOLD`, re-run
`bun docs/benchmarks/2026-11-07-timeline-question/score.ts`. It exits
non-zero if any labeled turn lands on the wrong side of the threshold.

Live before/after calls and their method are in the
[benchmark](benchmarks/2026-09-19-retrieval-gate/README.md); the timeline
questions' are in [their own](benchmarks/2026-11-07-timeline-question/README.md).
