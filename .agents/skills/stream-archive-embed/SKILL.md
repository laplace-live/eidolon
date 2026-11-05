---
name: stream-archive-embed
description: Update laplace-eidolon's stream archive from the streamer's Bilibili replay series. Collect new BV IDs into a timestamped batch in the persona's URL lists, resume unfinished batches, and run download, Soniox STT, refinement, and LanceDB ingestion with the TypeScript tools. Use when asked to sync new stream replays or run the archive embedding workflow.
---

# Stream archive embed

Run from the laplace-eidolon repository root, for the persona `milky-green`. The source is
<https://space.bilibili.com/2132180406/lists/2484684?type=series>
(明前奶绿 → 系列·直播回放).

An update request authorizes collecting the URLs and running the existing paid
STT, refinement, and embedding pipeline. A request to create/edit this skill or
preview new videos only stops before the pipeline. Do not schedule recurring
runs, commit, or deploy unless requested.

Everything the workflow reads and writes is in the data home, `<home>`:
`EIDOLON_HOME` when the environment or `.env` sets it, else `~/.laplace/eidolon`
(`docs/personas.md`). The persona's sources are in `<home>/sources/milky-green/`:

```text
lists/            prepared URL lists: every *.txt here (video-full.txt, video-sample.txt)
lists/batches/    batches, videos-<YYYY-MM-DD-HHMMSS>.txt, each with its .log and,
                  once finished, its .done.json
vods/             downloaded audio + <id>.info.json
streams/          <date>-<id>.md transcripts, .soniox.json payloads, .refined.json sidecars
```

The index the bot reads is `<home>/personas/milky-green/index/`, unless
`LANCEDB_PATH` (environment or `.env`) or `knowledge.index` (`settings.yaml`,
`persona.yaml`) points elsewhere.

## 1. Inspect local state

- Read `AGENTS.md`, `docs/personas.md`, and the help of each command used below
  (`bun run laplace-pipeline --help`).
- A batch in `lists/batches/` without its `<stem>.done.json` is unfinished work,
  even if it has downloads or transcripts. Keep its original path and retry it
  before the newly collected batch. Only the pipeline writes `.done.json`.
- Run `bun install` when `node_modules/` is missing. The tools need no Python.
- Check `ffmpeg` and `ffprobe`. Audio longer than Soniox's 300-minute limit is
  sliced with ffmpeg and fails without it; without ffprobe, durations come from
  the `.info.json`. yt-dlp needs no setup: the tools install and update their own
  copy in `<home>/bin/` (`YT_DLP_PATH` runs another binary).
- Inspect credential presence without printing secrets, in the environment,
  `.env`, or `<home>/credentials.json`: `SONIOX_API_KEY` for STT, `REFINE_API_KEY`
  or `OPENROUTER_API_KEY` for refinement, `EMBED_API_KEY` or `OPENROUTER_API_KEY`
  for embeddings. Preserve models, dimensions, filtering, caches, and provider
  configuration.
- The tools lock what they write: a second pipeline for the persona, or a second
  writer of its index, exits 1 naming the one running. The Python tools in
  `laplace_eidolon/tools/` take no lock, so make sure none of them is running.

## 2. Capture the complete series

Use the available browser tool to open the source URL and verify the streamer
and series title. This page renders asynchronously: an empty list during
navigation is not an empty archive. Wait for video cards and the pagination
controls, then note the displayed total.

List the series with yt-dlp into a capture file outside `lists/`, where every
`.txt` counts as a prepared list:

```bash
capture="${TMPDIR:-/tmp}/stream-archive-ids.txt"
bun run laplace-download --persona milky-green \
  --expand 'https://space.bilibili.com/2132180406/lists/2484684?type=series' > "$capture"
```

It prints one video URL per line and reads cookies as a download does (step 4).
If it fails, or its count of distinct BV IDs differs from the displayed total,
collect the IDs from the page instead.

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

Accumulate IDs outside the page across calls, then save one ID per line to the
capture file as UTF-8. Keep browser access within the browser tool; do not
extract cookies to implement collection. If a login or challenge blocks the
archive, follow that tool's handoff rules and report the blocker.

Verify the distinct captured count equals the displayed archive total and that
the last page was reached. If the total changes mid-scan, revisit the affected
pages and reconcile the count. If coverage cannot be established, retain only
the temporary capture and report partial discovery; do not publish a batch or
claim there are no new videos.

## 3. Save the new batch

Run `laplace-prepare-batch` with the complete capture and the actual displayed
total:

```bash
bun run laplace-prepare-batch --persona milky-green "$capture" \
  --expected-count <displayed-total> \
  --source 'https://space.bilibili.com/2132180406/lists/2484684?type=series'
```

Add `--dry-run` for a preview. It writes nothing unless the capture holds exactly
the expected number of distinct videos. It compares BV IDs against every list and
batch under `lists/`, and writes only new IDs, as canonical URLs accepted by the
pipeline, into:

```text
<home>/sources/milky-green/lists/batches/videos-YYYY-MM-DD-hhmmss.txt
```

The timestamp uses local time (for example, `videos-2026-09-08-093000.txt`), and
`--source` heads the file. Existing files are never overwritten; if a filename
collides, rerun in the next second. Leave the prepared lists unchanged. No new
IDs means no empty batch file.

The JSON result separates `pending_batches` from `created_batch`, as absolute
paths. Process the pending paths oldest first, followed by the created path. If
both are empty, report that the archive has no new or unfinished batches. A zero
`new_count` alone does not mean the index is up to date.

## 4. Run the full pipeline

The ingest drops and rebuilds the whole `stream_chunks` table from `streams/`, so
a stream indexed without a local transcript would vanish from the index. Before
the first run, snapshot the index. `home` and `DB` follow the introduction:
export `EIDOLON_HOME` and `LANCEDB_PATH` first when only `.env` sets them, and
export `DB` as `knowledge.index` when that is set and `LANCEDB_PATH` is not.

```bash
home="${EIDOLON_HOME:-$HOME/.laplace/eidolon}"; home="${home/#\~/$HOME}"
DB="${DB:-${LANCEDB_PATH:-$home/personas/milky-green/index}}"; DB="${DB/#\~/$HOME}"
DB="$DB" STREAMS="$home/sources/milky-green/streams" bun -e '
import { iterStreams } from "./packages/ingest/src/index.ts";
import { openTable } from "./packages/retrieval/src/index.ts";
const { DB, STREAMS } = process.env;
const table = await openTable(DB, "stream_chunks");
if (!table) throw new Error(`No stream_chunks table in ${DB}`);
const rows = await table.query().select(["stream_id"]).toArray();
const streams = [...new Set(rows.map((r) => r.stream_id))].sort();
const local = new Set(iterStreams(STREAMS).map((s) => s.streamId));
const indices = await table.listIndices();
console.log(JSON.stringify({
  rows: rows.length,
  fts: indices.some((i) => i.indexType === "FTS" && i.columns.includes("tokens")),
  missingSources: streams.filter((id) => !local.has(id)),
  streams,
}));
' > "${TMPDIR:-/tmp}/stream-index-before.json"
```

It only reads. If `missingSources` is not empty, stop and report the missing
corpus.

Use the persona's full `vods/` and `streams/`, which the commands default to.
Transcription scans all downloaded audio, refinement scans all transcripts, and
ingestion rebuilds the table from all transcripts. Never point `--vods-dir` or
`--streams-dir` at a batch-only directory.

For each pending/new batch, replace the sample path below with that actual path
from step 3:

```bash
set -o pipefail
home="${EIDOLON_HOME:-$HOME/.laplace/eidolon}"; home="${home/#\~/$HOME}"
batch_path="$home/sources/milky-green/lists/batches/videos-2026-09-08-093000.txt"
bun run laplace-pipeline --persona milky-green "$batch_path" --abort-on-error 2>&1 \
  | tee -a "${batch_path%.txt}.log"
```

This runs download → STT → refinement → embeddings/FTS → the stream catalog.
Before ingesting it logs `Persona milky-green's index: <path>`; that must be the
index the bot reads. With `LANCEDB_PATH` in the environment or `.env`, the
command exits 2 and asks for `--db-path`: report the conflicting runtime path
before running an update against either index. Keep the process/session handle,
monitor progress, and wait for the exit status. Ctrl-C stops it cleanly
(exit 130), and the same command resumes. Log the invocation time and exit status
when appending a retry to an existing log.

Downloads default to Chrome cookies. If cookie access fails, inspect the error
and use an existing user-provided file with
`--cookies-from-browser '' --cookies '/path/to/cookies.txt'` if available; yt-dlp
writes the cookies it used back into that file. Do not quit the user's browser or
export credentials automatically. Explain any action needed to recover access.
Do not silently switch providers or bypass restricted videos. An HTTP 412 from
Bilibili means yt-dlp is outdated, not rate-limited: the managed copy checks for
a newer release once per run after one, and a `YT_DLP_PATH` binary needs
updating by hand.

On failure, leave the batch unfinished. Existing files and embedding caches make
the same command resumable. Retry once for a clearly transient failure; stop on
repeated failure, missing credentials, quota exhaustion, or unavailable videos
and report the failed stage and exact resume command. Do not delete working
outputs or force re-refinement (`--refine-force`) to retry.

## 5. Verify and record completion

Exit zero is insufficient: audio without an upload date is skipped without a
failed exit. A clean run of all four stages writes the batch's `<stem>.done.json`
(`{finishedAt, ids, parts, exitCode}`) and logs `Finished batch <stem>`, but only
once every listed video, part by part, is downloaded and transcribed or found to
hold no speech. Exit zero without it means something is missing.

Check each BV, part by part, with a dry run, which only reads:

```bash
bun run laplace-pipeline --persona milky-green "$batch_path" --dry-run --json \
  | jq -c --arg b "$(basename "$batch_path" .txt)" \
    'select(.type == "plan" and .video.batch == $b) | .video
     | {id, download, transcribe, refine, indexed}'
```

Each part (`BV…_pN` where applicable) must show `download` `done`, `refine.done`
equal to `refine.chunks`, `indexed` true, and `transcribe` `done`. A part with
`transcribe` `no-speech` has no transcript, so its `refine` is null and `indexed`
false; list such parts.

Then take the step 4 snapshot again and compare it with the first:

- every previously indexed stream is still there, and `fts` is true;
- `rows` equals the ingest's `Wrote N rows` line;
- a batch part missing from `streams` is valid only when every chunk in its
  sidecar (`streams/<stream id>.refined.json`, under `chunks`) has a
  `chunk_type` in the run's skip types (`skipTypes` in
  `<index>/stream_chunks.meta.json`); list such parts.

Investigate unexpected losses before declaring completion. If a check fails
after the pipeline wrote the batch's `.done.json`, delete that file so the next
invocation sees the batch pending, and report what failed. Never write a
`.done.json` yourself.

Report discovered/new BV counts, batch path(s), completed or pending status,
verified index row counts before and after, and any failures. The sources and the
index live outside the repository: production sees a rebuilt index only once it
is copied to the server's mounted data home (`docs/personas.md`, "Deploying a
persona"). Leave that copy and any deployment to a separate request.
