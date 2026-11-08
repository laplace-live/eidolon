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

## When she last did something

"你上次播鬼武者是什么时候" asks for the newest of many dates, which ranking by
similarity never finds: the game's first session is the most "about" the game,
so it wins. When the retrieval gate's timeline questions say a turn asks when
she last or first did something, or how often
([retrieval-gate.md](retrieval-gate.md)), the archive answers from the catalog
instead.

`StreamCatalog.timeline` finds the scene topics the question contains, at least
two characters long and carried by at least two scenes, and drops any inside a
longer one it also contains; a topic in Latin letters must stand as a whole word,
so `ow` never matches inside "how". It then lists every broadcast with a scene naming
all of them in its heading, summary or topics, newest first, with the matching
scenes. When no scene names them all, the topic the fewest scenes name stands
alone. The index behind it is built once per parsed catalog, in slices like the
parse, and warmed at boot.

The block lists the three newest broadcasts, the newest with at least three
matching scenes, the first, and the first with three, each with its count and
headings: many scenes usually mean she spent the stream on it, one or two that
she mentioned it. It tells her to say the date as she would speak it, which
`prompt.md`'s rule against reading dates otherwise forbids.

It replaces the topical search's chunks, and the recall a bare 上次 scopes to
the newest broadcast, since 上次玩X means the last time she played X. 第一次玩X
is likewise no ordinal follow-up: only 第N场, a bare 第N次 and 第N次直播 pick a
listed broadcast. A recall scoped to dates (上周, 3月5号) keeps its scope. The decision is read only after
the search returns, so a slow or failed gate leaves the chunks as before. The
facts search still runs.

The topic comes from the viewer's latest line alone. A bare follow-up, a line
of nothing but pointers, time words, verbs and particles such as 那上次玩是什么时候,
takes it from the viewer's line before. A line that names something the
catalog lacks, 塞尔达 or "fall guys", keeps the search's chunks rather than
answer with the earlier topic. Follow-ups after a timeline resolve against
every broadcast its block names, the first included.

It can't tell playing a game from talking about it: a game she finished years
ago but still brings up reads as recent. Viewers aren't topics, so it can't
answer when a viewer last sent an SC. What else the archive can't answer yet is
in [recall-gaps.md](recall-gaps.md).

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
