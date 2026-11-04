---
name: stream-archive-embed
description: Update laplace-eidolon's local stream archive from the streamer's Bilibili replay series. Collect new BV IDs into timestamped data/auto-embed URL lists, resume unfinished batches, and run download, Soniox STT, refinement, and LanceDB ingestion. Use when asked to sync new stream replays or run the archive embedding workflow.
---

# Stream archive embed

Run from the laplace-eidolon repository root. The source is
<https://space.bilibili.com/2132180406/lists/2484684?type=series>
(明前奶绿 → 系列·直播回放).

An update request authorizes collecting the URLs and running the existing paid
STT, refinement, and embedding pipeline. A request to create/edit this skill or
preview new videos only stops before the pipeline. Do not schedule recurring
runs, commit, or deploy unless requested.

## 1. Inspect local state

- Read `AGENTS.md`, `.env.example`, and the relevant CLI help. Existing prepared
  URL lists are `data/video*.txt`, including `video-full.txt` and `video-sample.txt`.
  `data/.gitignore` hides them and `auto-embed/`; use filesystem reads or
  `rg --files --no-ignore data` when discovering them.
- Check `data/auto-embed/videos-*.txt`. A list without the matching
  `<stem>.done.json` is unfinished work, even if it has downloads or transcripts.
  Keep its original path and retry it before the newly collected batch.
- Use the repository's uv-managed `.venv`. If `.venv` is absent, create it
  with `uv venv .venv`; reuse it when present. Install the project and tools
  extras with `uv sync --extra tools` when needed.
- Run every Python helper and ad hoc verification through
  `uv run --extra tools python` from the repository root. This also keeps the
  tools extras available across commands; shell activation is unnecessary.
- Check `uv`, `yt-dlp`, `ffmpeg`, and `ffprobe`. Inspect credential presence
  without printing secrets. Soniox uses `SONIOX_API_KEY`; refinement and embeddings use
  the existing provider settings and their fallback keys in `.env.example`.
  Preserve models, dimensions, filtering, caches, and provider configuration.
- Ensure no other pipeline/ingest process is writing the same database.

## 2. Open and capture the complete series

Use the available browser tool to open the source URL and verify the streamer
and series title. Inspect the current page before choosing locators. This page
renders asynchronously: an empty list during navigation is not an empty archive.
Wait for video cards and the pagination controls.

Collect every page, including pages after the first already-known BV. Extract
only links from this series' video cards, preserving the case of `BV` IDs.
Deduplicate thumbnail/title links. Use the displayed total/page count and
`下一页`; verify each page has finished loading and changed before collecting it.
Do not stop just because one page contains only known IDs: older items can be
added to the series later.

With CUA's browser Playwright API, this read-only extraction is suitable after
the DOM confirms that the series cards are inside `main`:

```javascript
await tab.playwright.evaluate(() => Array.from(new Set(
  Array.from(document.querySelectorAll('main a[href]'))
    .map(a => a.getAttribute('href'))
    .map(href => href && href.match(/\/video\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/)?.[1])
    .filter(Boolean)
)));
```

Accumulate IDs outside the page across calls, then save one ID per line to a
temporary UTF-8 capture file. Keep browser access within the browser tool;
do not extract cookies to implement collection. If a login or challenge blocks
the archive, follow that tool's handoff rules and report the blocker.

Verify the distinct captured count equals the displayed archive total and that
the last page was reached. If the total changes mid-scan, revisit the affected
pages and reconcile the count. If coverage cannot be established, retain only
the temporary capture and report partial discovery; do not publish a batch or
claim there are no new videos.

## 3. Save the new batch

Use the helper with the complete capture and the actual displayed total:

```bash
uv run --extra tools python .agents/skills/stream-archive-embed/scripts/prepare_batch.py \
  /tmp/stream-archive-ids.txt --expected-count <displayed-total>
```

Add `--dry-run` for a preview. The helper compares BV IDs against the prepared
lists and all earlier batch lists. It writes only new IDs, as canonical URLs
accepted by the pipeline, into:

```text
data/auto-embed/videos-YYYY-MM-DD-hhmmss.txt
```

The timestamp uses local time and the
current year (for example, `videos-2026-09-08-093000.txt`). Existing files are
never overwritten; if a filename collides, rerun in the next second. Leave the
prepared lists unchanged. No new IDs means no empty batch file.

The JSON result separates `pending_batches` from `created_batch`. Process the
pending paths oldest first, followed by the created path. If both are empty,
report that the archive has no new or unfinished batches. A zero `new_count`
alone does not mean the database is up to date.

## 4. Run the full pipeline

Before ingestion, compare the existing `stream_chunks` table's `stream_id` and
`source_path` values with the complete local `streams/*.md` corpus (use
`laplace_eidolon.tools._streams.iter_streams`). Save the existing row/stream counts
and IDs for verification. If indexed streams lack local sources, stop and
report the missing corpus: ingest drops and recreates the entire table.

Use the repository's full `vods/` and `streams/` directories. Transcription scans
all downloaded audio, refinement scans all transcripts, and ingestion rebuilds
the table from all transcripts. Never point production ingest at a batch-only
transcript directory. The pipeline's ingest stage targets the persona's index in
the data home (`~/.laplace/eidolon/personas/milky-green/index`, or under
`EIDOLON_HOME`), even if `LANCEDB_PATH` configures another runtime path; report a
conflicting runtime path before running an update to the wrong DB.

For each pending/new list, replace the sample path below with that actual path:

```bash
set -o pipefail
batch_path='data/auto-embed/videos-2026-09-08-093000.txt'
uv run --extra tools laplace-pipeline "$batch_path" \
  --provider soniox --abort-on-error 2>&1 | tee -a "${batch_path%.txt}.log"
```

This runs download → STT → refinement → embeddings/FTS. Keep the process/session
handle, monitor progress, and wait for the exit status. Log the invocation time
and exit status when appending a retry to an existing log.

Downloads default to Chrome cookies. If cookie access fails, inspect the error
and use an existing user-provided file with
`--cookies-from-browser '' --cookies '/path/to/cookies.txt'` if available.
Do not quit the user's browser or export credentials automatically. Explain any
action needed to recover access. Do not silently switch providers or bypass
restricted videos.

On failure, leave the batch unfinished. Existing files and embedding caches make
the same command resumable. Retry once for a clearly transient failure; stop on
repeated failure, missing credentials, quota exhaustion, or unavailable videos
and report the failed stage and exact resume command. Do not delete working
outputs or force re-refinement to retry.

## 5. Verify and record completion

Exit zero is insufficient: missing upload dates and empty ingest input can be
skipped without a failed exit. Check the final stage summaries and each BV:

- Match every expected downloaded part (`BV…_pN` where applicable) from yt-dlp's
  output and metadata to a nonempty audio file and `.info.json` with upload date.
  Account for all parts, not just one transcript per BV.
- Confirm its expected `streams/YYYY-MM-DD-<audio-stem>.md` exists and parses
  into chunks. Use `_streams.parse_stream` and `_streams.load_sidecar`; every
  chunk must have the current complete refinement (see `refine._is_v2_refinement`).
- Derive the expected retained rows using `ingest_streams.load_streams` with the
  same effective skip types used by this run. Compare chunk `id` values and
  `stream_id` against the rebuilt database. A fully filtered part is valid only
  when its completed refinements account for all its chunks; list such parts.
- Confirm previously indexed streams remain, the new expected chunks are present,
  row counts match the full expected corpus, and the FTS index on `tokens` exists.
  Investigate unexpected losses before declaring completion. Load dotenv with
  `override=True` before importing modules that read environment variables.

Only after a successful full pipeline and these checks, write the batch's
`<stem>.done.json` with completion timestamp, pipeline exit status, BV IDs,
verified parts, filtered parts, database path/table, and before/after row counts.
Keep the batch immutable. Never write this completion record for a dry run,
interrupted process, or partial result; the next invocation must see it pending.

Report discovered/new BV counts, batch path(s), completed or pending status,
verified database row counts, and any failures. Local batch files are ignored
by Git, and the index lives outside the repository: production sees a rebuilt
one only once it is copied to the server's mounted data home (docs/personas.md).
Leave that copy and any deployment to a separate request.
