# Stream recall

The archive has two levels. `stream_catalog.json` contains broadcast overviews,
while `stream_chunks` keeps the existing searchable transcript scenes. The
catalog groups Bilibili recording parts by date and BV ID, so two broadcasts
on the same day remain separate. Source files have dates but no reliable
start times; when several broadcasts share the latest date, their order is
unknown.

`laplace-build-stream-catalog` builds the catalog locally from `streams/*.md`
and their refined sidecars. It uses the existing summaries, headings, topics,
and scene classifications; it makes no model or embedding requests. Activity
counts and representative excerpts form a compact overview. Every scene's
summary and source ID remains in the catalog. These are extractive, compressed
overviews, not a claim that every moment is included in the answer.

The builder reads source scenes without excluding karaoke or anime audio. Those scenes
remain represented in the broadcast overview even though the detailed LanceDB
index excludes them by default. Missing refinement is recorded. Missing
archive coverage never establishes that the streamer did not broadcast.

Run `bun run laplace-build-stream-catalog` after adding or refining transcripts.
Use `--streams-dir` and `--db-path` for another archive. The normal
`laplace-pipeline` command rebuilds the catalog after a successful ingest.
Standalone `laplace-ingest-streams` users must run the catalog builder separately.
The generated file lives beside the tables in the persona's index,
`<data home>/personas/<id>/index/`, and deploys with it
([personas.md](personas.md#deploying-a-persona)). Rebuilding it does not change
chunk vectors or require either embedding ingest to run again.

## Answering a turn

The stream archive processor runs before persona facts. It supplies compact
overviews of three recent broadcasts, and resolves common Chinese and English
dates and periods using `PERSONA_TIMEZONE`. Last week means the previous
Monday through Sunday; the past seven days includes today. Date ranges use
an exclusive end internally. Unqualified month/day references select their
most recent occurrence. Ambiguous dates are left for the conversational model
to interpret or clarify.

Recap questions read the matching catalog records directly and skip archive
embedding, reranking, and persona-fact retrieval. Questions about a particular
topic within a period use the existing `LanceRetriever` and `retrieval.py`
hybrid search with a metadata prefilter. Mem0 remains unchanged for logged-in
viewers. Catalog files are cached across sessions and refresh when the file
changes; loading runs off the audio event loop.

The `recall_streams` tool handles requests whose time reference or scope needs
the conversational model. It accepts a symbolic period, a validated date
range, or catalog IDs already supplied in context. The backend computes
relative dates and constructs filters. Each user turn permits at most two
lookups, after which the archive tool is removed until the next user turn;
voice-switching tools remain available. Queries preserve the selected dates
and broadcasts for follow-ups. The archive owns and replaces its context
blocks, so repeated turns do not accumulate copies of recent overviews.

Absent or unreadable catalogs fail open. Existing topical chunk retrieval
still works, and explicit date filters can query the chunk table without a
catalog. A latest-stream question cannot fall back to unrelated old chunks
when the latest broadcast cannot be identified.

## Validation

`uv run laplace-search --recall --today 2026-09-09 '你上周直播都播了什么？'`
exercises the same overview lookup with a reproducible clock. Existing search
output remains the default without `--recall`.

Tests cover calendar boundaries, recording-part grouping, retained activity
types, contextual references, filtered detail search, and tool-call limits.
The existing retrieval evaluation still measures chunk ranking. Recap coverage
must also be checked against all catalog broadcasts in the requested period.
Provider-free lookup timings measure local retrieval only. First useful text
and first audible answer require the actual provider pipeline and a WebRTC
call; a spoken acknowledgement does not count as an answer.
