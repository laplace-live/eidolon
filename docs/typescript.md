# The TypeScript bot

The bot, and the offline chain that builds its indexes, in Bun/TypeScript, built on
[pipedog](https://github.com/polvallverdu/pipedog) (a TypeScript port of Pipecat). The bot has
run production since 2026-11-04. The code and its own tests are the only source of truth for how
it behaves.

## Layout

Bun workspaces, one package per subsystem. Dependencies point down this list; nothing below
`runtime` imports pipedog, and `core` imports nothing.

| Package | Owns |
| --- | --- |
| `packages/core` | the extension contracts: `ContextProvider`, `LlmTool`, `ConversationContext`, `TurnGate` |
| `packages/config` | `.env` loading (python-dotenv rules), env readers, settings and the data home, the logger, Python-compatible helpers, the OpenAI-compatible HTTP client, the persona clock |
| `packages/providers` | the provider catalog and the roles a persona fills with it, resolving a role's provider, model and key, the fetch clients that stand in for vendor SDKs, prices and usage reports ([providers.md](providers.md)) |
| `packages/usage` | the usage ledger: SQLite records of what each request cost, and their sums |
| `packages/access` | `loginSyncToken` validation, quotas, client IP, CORS, the `/api/offer` guard, audio quality |
| `packages/turn` | Cloudflare TURN credentials, ICE plans, relay-only candidate rules |
| `packages/retrieval` | the LanceDB read path: jieba (pure TS, same dictionary), hybrid search, RRF and the reranker, stream dates and the catalog; and its write side: the Arrow schemas, `writeTable`, `EmbedCache`, `embedInBatches` |
| `packages/memory` | Mem0's engine over Qdrant: mem0's payloads, its `history.db` |
| `packages/context` | the retrieval gate, both RAG providers, the recall tool, the system instruction, the greeting, and group chats' director ([chat.md](chat.md#the-director)) |
| `packages/tools`, `packages/imagegen` | `change_voice_style`, `take_selfie`, the selfie store |
| `packages/chat` | the chat log's format, browser-safe: its events, `viewOf`, `parseMentions`, the `ChatStore` interface and its contract suite; `@eidolon/chat/jsonl` is the local store ([chat.md](chat.md)) |
| `packages/engine` | the turn engine: one persona's text turn, her mind per provider without pipedog, the tool loop and her context providers ([chat.md](chat.md#a-turn-runturn)); `runChat`, a chat's turns in the order the director chooses ([chat.md](chat.md#the-chain)) |
| `packages/ingest` | the offline chain: download, transcribe, refine, both ingests, the stream catalog and the pipeline ([below](#the-offline-chain)) |
| `packages/voice` | the native voice engine's pieces, not yet loaded in production: the Ear (Silero VAD, Smart Turn, the turn detector), the sentence segmenter, the Speaker and spoken-text tracker, the vendored resampler, the RTVI codec and emitter. Its live recognizers and speech clients are `@eidolon/providers/stt` and `/speech-stream`; only `packages/runtime` imports it (Biome) |
| `packages/runtime` | the only pipedog importer: the pipeline, adapters from `core` contracts to pipedog, WebRTC signalling, and the `CallBinding` that runs a call inside a chat ([chat.md](chat.md#the-binding)) |
| `apps/bot` | `Bun.serve`, the routes, MCP, the entry point, and the production chat endpoint, `src/chat` ([chat.md](chat.md#production-the-browser-keeps-the-chat)) |
| `apps/cli` | every `laplace-*` command and the gate benchmark: argparse specs, the persona, locks, printing, exit codes |

A new context tier implements `ContextProvider`; a new LLM tool implements `LlmTool`. Neither
touches pipedog: `packages/runtime` adapts both. Clients (the `/ai` page today; Electron or Expo
later) talk to `apps/bot` over HTTP and RTVI.

The bot reads each persona's index from the data home ([personas.md](personas.md)) and viewers'
memories from Qdrant. The compose `bot-ts` service keeps Mem0's `history.db` on a volume of its
own, beside the read-only data home.

## Commands

```bash
bun install
bun run dev                           # watch mode on :7860; --port 7861 to run beside another bot
bun run start                         # no watch
bun run typecheck && bun run lint && bun run test
bun run laplace-search "奶绿最喜欢喝什么"
bun run laplace-eval-retrieval        # recall@k and MRR against the persona's eval queries
bun run laplace-generate-image        # billed per image
bun run gate-decisions                # billed; rewrites the gate benchmark's decisions.json
docker compose --profile ts up --build bot-ts   # the image on :7861, with Qdrant
```

CI publishes the image as `ghcr.io/laplace-live/eidolon`, tagged `edge`, `sha-…`, and per release
`X.Y.Z`, `X.Y` and `X`.

`bun apps/bot/scripts/e2e-call.ts --text` (or `--audio`) holds a real call through headless
Chrome and reports latency per stage; `--base-url` points it at another bot. On a Mac where
headless Chrome is killed after about 30 s, add `--headful`.

## The offline chain

`packages/ingest` is a library: every entry point takes `{onProgress, signal}`, returns a report
and never prints. `apps/cli` wraps each stage in a command with argparse-style flags, `--persona`
and `--json` among them:

```bash
bun run laplace-pipeline <url list>      # download → transcribe → refine → ingest → catalog, resumable
bun run laplace-pipeline --dry-run       # plans every video the persona's sources know; writes nothing
bun run laplace-download <url list>      # yt-dlp → sources/<id>/vods/; --expand <url> lists a playlist
bun run laplace-transcribe <audio>       # Soniox async → sources/<id>/streams/<date>-<id>.md
bun run laplace-refine                   # two LLM passes → streams/*.refined.json
bun run laplace-ingest-streams           # → index/stream_chunks.lance
bun run laplace-ingest-facts             # sources/<id>/facts/ → index/persona_facts.lance
bun run laplace-build-stream-catalog     # → index/stream_catalog.json
bun run laplace-prepare-batch <capture> --expected-count <n>   # new videos → lists/batches/
bun run laplace-extract-users <export>   # the names a danmaku export reads aloud, for glossary.toml
```

Each takes `--persona <id>` (default: the active persona), applied before the settings files load,
and defaults its folders to that persona's in the data home
([personas.md](personas.md#the-data-home)); an explicit path still wins, resolved against the
working directory. A persona with no folder, in the data home or among the templates, is a usage
error (exit 2), so a misspelt id never starts a new persona's sources and index. Logs go to
stderr. Stdout carries only the command's report, or with `--json` one
[progress event](#progress-events) per line.

| Module (`packages/ingest/src/`) | Owns |
| --- | --- |
| `progress.ts` | the event types; import-free, so a web app can import them as `@eidolon/ingest/progress` |
| `paths.ts`, `limit.ts` | source folders, the index write path, locks; the limiter, signal handling, killing children |
| `failure.ts` | an error's event code and provider |
| `streams.ts` | transcript parsing, sidecars, audio naming |
| `download/` | managed yt-dlp, URL lists and batches, the argv, the part check, playlists |
| `transcribe/` | the Soniox REST client, glossary context, rendering, slicing, the skip rules |
| `refine/` | prompts, schemas, lenient JSON, validators, scheduling, cost estimates |
| `ingest_streams.ts`, `catalog.ts` | `stream_chunks`' rows and rebuild; `stream_catalog.json` |
| `ingest_facts.ts` | fact rows, `resolveFactFiles`, the rebuild |
| `extract_users.ts` | ranking the names in a danmaku export |
| `pipeline.ts` | the run, a batch's `.done.json`, and the plan |

Things it relies on:

- **Commands take the locks, never library functions.** `acquireLock` holds SQLite's exclusive
  lock on a file in `<home>/locks/`, which the OS releases when the process dies, so a crash
  leaves no stale lock. download, transcribe, refine and the pipeline hold `sources:<persona>`;
  the ingests, the catalog and the pipeline's ingest stage hold `index:<db path>`; the managed
  yt-dlp's update holds `yt-dlp`. Dry runs take none.
- **Cancellation.** `main.ts` runs every command through `runWithSignals`: the first SIGINT or
  SIGTERM aborts the run's signal, a second exits at once unless it comes within `REPEAT_MS`
  (500 ms), as the first delivered twice, and the exit code is 130 or 143. No new item starts,
  children get SIGTERM and then SIGKILL after 5 s, requests and retry waits abort, and cleanup is
  cut off after 10 s, except inside a `criticalSection` (`limit.ts`): an ingest's rebuild, from
  dropping the table to its FTS index and build record, finishes first, since the cut would leave
  no table or an unfinished index. A command that never reads the signal goes in `IGNORE_SIGNAL`
  (`cli.ts`), which exits at the first.
- **Rebuilds never leave a half index.** Every file is written to a temporary file beside it and
  renamed. `writeTable` builds and checks the whole Arrow table, every value and vector, before it
  drops the old table, and after a successful write each ingest records its inputs in
  `index/<table>.meta.json`.
- **The managed yt-dlp** is `<home>/bin/yt-dlp`, installed from yt-dlp's latest GitHub release,
  checked against the release's `SHA2-256SUMS`, and checked for a newer release at most once a
  day, or once in a run that hits an HTTP 412: on Bilibili, a 412 means an outdated yt-dlp.
- **A transcript re-renders for free.** `transcribe.renderPayload` turns any `.soniox.json` back
  into its `.md`; all 1,697 real ones come back byte for byte.

### Progress events

With `--json`, stdout carries one JSON object per line, each with `v: 1` and a timestamp `t` in
ms, and the human summary moves to stderr. The types are in `packages/ingest/src/progress.ts`:

- `stage`: `start`, `done`, `failed`, `skipped` or `cancelled`, for `setup` (yt-dlp), `download`,
  `expand`, `transcribe`, `refine`, `ingest-streams`, `ingest-facts` or `catalog`.
- `item`: one URL, audio file, stream or fact file, with `video` (the yt-dlp id, which is the
  audio's stem: `BV1FbgM6QEw3_p1`), a 1-based `index` within the stage, `costUsd`, and for a
  download the ids it created (`outputs`).
- `progress`: `done` of `total`, in bytes, chunks, rows, files or percent.
- `entry`: one video `download --expand` found: `{url, id, title?, durationSec?}`.
- `plan`: one video of `pipeline --dry-run --json`: where each stage stands, and what the rest
  would cost. A video Soniox heard no speech in has nothing to index: its `indexed` is false, and
  the plan summary's `unindexed` leaves it out.
- `summary`: the last line of every run that didn't crash: `ok`, `cancelled`, `counts` (the keys
  `SUMMARY_COUNTS` lists under the summary's stage), `durationSec`, `failures`, and `costUsd` with
  `costSource` (`reported`, `estimated` or `unpriced`; `costUsd: 0` when nothing was billed). A
  pipeline run's, with stage `pipeline` (`stages`, `failed`, `aborted`), follows each stage's own.
  `pipeline --dry-run --json` ends in one with stage `plan` instead, cancelled or refused too: the
  plan's `videos`, `downloadPending`, `transcribePending`, `noDate`, `refinePending` and
  `unindexed`.

A failed stage or item carries a `code` when the cause is known (a stage only when all its
failures share it), and a `provider` (`soniox`, `refine` or `embeddings`) when the code is about
that provider's key, credit or reach:

| Code | Meaning |
| --- | --- |
| `missing-credential` | a key the step needs is unset; nothing was sent |
| `auth-failed` | the provider refused the key (HTTP 401) |
| `insufficient-credits` | the account is out of credit (HTTP 402) |
| `rate-limited` | HTTP 429 after the retries, or OpenRouter's sustained quota error |
| `network` | the request never got an answer |
| `locked` | another run holds the lock |
| `ytdlp-unavailable` | no yt-dlp to install or find |
| `cookies-unavailable` | yt-dlp couldn't read the browser's cookies, or the site wants them |
| `http-412` | the site refused yt-dlp, usually because it is outdated |
| `ffmpeg-unavailable` | audio over 300 minutes needs ffmpeg to slice it |
| `disk-full` | ENOSPC, or SQLite's or LanceDB's disk-full error |
| `no-upload-date` | audio whose `.info.json` has no upload date, so it has no stream id |
| `no-speech` | Soniox heard nothing; the payload is kept, so it is billed once |
| `cancelled` | the run was cancelled |

yt-dlp's codes are read off its stderr, so they are a best guess. A job runs
`jobArgv(entry, command, args)` from `@eidolon/cli/job`, also import-free, with
`@eidolon/config`'s `cliEntry()` as the entry: `bun --no-env-file <entry> <command> --json …`,
started in the data home. A cancel sends it SIGTERM. Nothing kills it on a timer: only a forced
second cancel (`DELETE jobs/:id?force=1`) of a job this server spawned sends SIGKILL, to its whole
process group ([web-app.md](web-app.md#jobs)).

### Real-data tests

The `*_real.test.ts` files check the code against the real corpus in `EIDOLON_REAL_HOME`
(default: `EIDOLON_HOME`, else `~/.laplace/eidolon`) and never write there: they write to
temporary folders, work on a clone of the embedding cache, and fake every paid request, so they
cost nothing. Without the corpus they skip quietly; `EIDOLON_REQUIRE_PARITY=1` turns each skip
into a failure. Some compare against digests their fixtures store, covering only the files those
digests list; the rest compare against the real files themselves (a re-rendered transcript
against its `.md`, a rebuilt table against the real index, a re-saved sidecar against the
original) or one code path against another (the pipeline's dry run against the plan it emits).

## What keeps it working

- **Only `packages/runtime` imports `@pipedog/*`.** Biome's `noRestrictedImports` enforces it.
  Every other package is testable without a pipeline and reusable by another runtime.
- **`@eidolon/ingest` stays out of the bot image.** Biome forbids importing it under `apps/bot/**`
  and the other packages, because `docker.yml` skips the image build for changes to `apps/cli/**`
  and `packages/ingest/**`. Lift both together, or the image ships without a change it runs.
- **No vendor SDK sends a request.** `packages/providers` has fetch clients for OpenAI-compatible
  chat and Anthropic's Messages API, and `packages/runtime` hands them to pipedog's services in
  place of the SDK clients they would build. A new service gets one too, or bills behind the
  usage ledger's back.
- **`@eidolon/providers/catalog` imports nothing.** The web app bundles it for its provider and
  model pickers; a test keeps it import-free, and Biome lets the web app import it alone.
- **`bunfig.toml` turns Bun's own `.env` loader off.** `load-env.ts`, the first import of each
  entry point, is the only reader, with python-dotenv's rules. Bun's loader would expand bare
  `$VAR` and read `.env.local`, which those rules don't. Tests run with `--no-env-file`.
- **No module reads env at import.** Everything reads at call time, so the order of imports
  against the `.env` load cannot pin a fallback.
- **A child that needs what `.env` set gets `env: process.env`, and lookups
  `Bun.which(name, {PATH: process.env.PATH})`.** `Bun.spawn` without `env`, and `Bun.which`
  without `PATH`, use the environment the process started with, missing everything `load-env.ts`
  applied from `.env`: yt-dlp would miss a proxy the `.env` sets. A child that runs a
  `load-env.ts` of its own, a job's CLI or the server `bun run local` restarts, gets no `env` and
  reads `.env` as it is now. Handed `process.env`, it would keep every key deleted from `.env`
  since, because `override` sets keys and never unsets them.
- **werift needs four corrections, all in `packages/runtime/src/webrtc/handler.ts`.**
  1. It queries `stun.l.google.com` when no STUN server is configured. That put the origin's
     public IP in every non-relay answer and, where UDP to Google is blocked, stalled every
     answer by its 5 s STUN timeout. It now queries only a server the plan names.
  2. It derives the connection state from ICE alone, so a browser hanging up (a DTLS
     close_notify) went unnoticed until ICE consent expired about 30 s later, with the session
     and its STT/TTS sockets still running. It now disconnects once every DTLS transport closes,
     as aiortc does.
  3. Relay-only uses werift's `"relay"` policy, which gathers nothing but the relay candidate.
  4. werift fills a relay candidate's `raddr` with the TURN server's XOR-MAPPED-ADDRESS, which
     is this host's public IP, so every answer is scrubbed to `raddr 0.0.0.0 rport 0`.
- **ICE servers and the Opus bitrate are set per connection without a pipedog seam.** The
  handler assigns them right before `handleWebRequest`, which builds the connection before its
  first await. The interleaved-offer test locks that ordering in; rerun it on every pipedog bump.
- **Golden fixtures are the code's record.** Each holds what a test pins for fixed inputs. A test
  that fails against one means behavior changed: fix the code, or, when the change is on purpose,
  update the golden in the same commit and `bunx biome check --write` it. They hold synthetic
  data only: the real corpus is checked by the real-data tests.

## Deliberate behavior

Choices a reader might take for bugs, and why they stand.

### The bot and the query commands

- The bot reads each role's provider and model from the neutral variables (`LLM_PROVIDER`,
  `LLM_MODEL`, …), and the provider-named ones only while that provider fills the role
  ([providers.md](providers.md)).
- `PATCH /api/offer` with a malformed body answers 400.
- `/`, `/client` and `/start` (the Pipecat demo and its session API) are not served.
- `GET /mcp` answers 405 instead of opening an idle SSE stream; MCP clients fall back.
- The async-tool instructions in the system prompt are pipedog's: a finished `take_selfie` result
  may be delivered on its own once everything the viewer said has been answered.
- Every response, 500s included, carries CORS headers.
- The CLIs' `--db-path` defaults to `LANCEDB_PATH`, else the persona's index.
- `laplace-eval-retrieval`'s `--queries` defaults to `eval/queries.toml` in the persona's
  sources; a missing file's error says to pass `--queries`.
- The missing-table hint names the command and the persona,
  `bun run laplace-ingest-streams --persona <id>`.
- Mem0's extraction may reply with up to 8192 tokens, where mem0 allows 2000. A thinking model's
  reasoning counts toward that cap, and under mem0's cut about 1 in 12 Gemini Flash extractions
  ended mid-JSON, losing that turn's memories. Lowering the thinking effort instead also fixed it,
  but then small talk produced junk memories ("User is referred to as 奶糖花").

### Every offline command

- **Folders come from the persona.** Defaults are the persona's `sources/<id>/` in the data home,
  the embedding cache `<home>/cache/embed_cache.db`, and the index where the bot reads it (below).
  Sources sit apart from `personas/<id>/`, so a deploy that copies that folder never carries them.
- **The settings files apply**, as they do to the bot.
- **Blank means unset** for environment and settings values, as the bot reads them: a blank
  `REFINE_MODEL`, `REFINE_BASE_URL`, `EMBED_MODEL`, `EMBED_DIM` or `INGEST_SKIP_TYPES` means the
  default, and `none` turns off skip types, browser cookies or the language hint. An explicit
  empty flag still means empty: `--skip-types ''` skips nothing, `--cookies-from-browser ''` reads
  no browser, `--language ''` sends no hint, and `--model ''` is sent as "". `EMBED_MODEL` and
  `EMBED_DIM` are read when embedding starts, so `.env` applies to a standalone run.
- **Writers write where the bot reads.** `--db-path` defaults to her `knowledge.index`, else
  `LANCEDB_PATH` (a relative path against the repository root), else
  `<home>/personas/<id>/index`, and never inside a persona template; each writer logs the path
  first. With `--persona` spelled out, a `LANCEDB_PATH` from the environment that her
  `knowledge.index` doesn't replace, and no `--db-path`, a writer exits 2 (`LANCEDB_PATH is set
  in the environment; pass --db-path or set her knowledge.index to write persona <id>'s index.`),
  since that path may be another persona's.
- **Logs go to stderr**, in the logger's format. Stdout holds the command's report, or with
  `--json` events only.
- **`--json` reports [progress events](#progress-events)**, with a code for each failure it can
  classify.
- **Locks** ([above](#the-offline-chain)): a second run exits 1 with `Another <command> is running
  for <target> (pid N).`, or code `locked`, so two runs never interleave their writes.
- **Cancellation** ([above](#the-offline-chain)) ends with each item in flight reporting
  `cancelled` and a summary with `cancelled: true`, and leaves no partial file looking done.
- **Failures are reported, not raised.** A missing key fails with code `missing-credential`
  before any request. Provider errors, unreadable files and LanceDB errors log their message and
  stack, fail their stage with a summary listing them, and exit 1.
- **Transcript frontmatter is YAML 1.2** (Bun's parser), not 1.1: `yes`, `1:30`, `017`, `1_000`
  and unquoted timestamps read as 1.2 reads them. The tools write plain strings there, so no real
  transcript is affected.

### Download and batches

- yt-dlp's argv starts with `--ignore-config`, so a user's yt-dlp config can't redirect the
  files, and puts `--` before the URL, so a URL can't pass as an option. The managed yt-dlp's
  argv, download and `--expand` alike, also carries `--js-runtimes bun:<the running bun>` for
  YouTube's JavaScript challenges; a user's `--no-js-runtimes` in `--yt-dlp-args` still wins. A
  `YT_DLP_PATH` or PATH yt-dlp gets no such flag, since one older than the option would fail every
  URL.
- With `--json`, yt-dlp's stdout is piped (`--newline`, a `--progress-template` carrying the video
  id, `--progress-delta 0.5`) and parsed into `bytes` progress events; every other line goes to
  stderr.
- `url_list` is optional for `laplace-download --expand` and `laplace-pipeline --dry-run`, so a
  missing list is checked after parsing. When it is missing and an option is unknown, the unknown
  option is reported first. Both exit 2.
- **The part check.** A bare `<id>.<ext>` created beside `<id>_p<N>` parts means yt-dlp couldn't
  list the parts and saved the first one again under another name. The run deletes the files it
  created for that id and fails the URL: `yt-dlp could not list the video's parts; it may be
  outdated`. Files that were there before are never touched. Counting such a run a success is
  how two videos' first parts got into the real index twice.
- **Managed yt-dlp.** The tag comes from the `releases/latest` redirect, the binary and
  `SHA2-256SUMS` from that release; it is written to `bin/yt-dlp.<pid>.tmp`, made executable and
  renamed into place (on Windows the old exe is renamed to `.old` first), and
  `yt-dlp.stamp.json` records `{tag, asset, sha256, checkedAt}`. A failed check counts as a check
  and keeps the binary; while the `yt-dlp` lock is held elsewhere, an installed copy runs as it
  is. `YT_DLP_PATH` runs another binary. A platform without a release binary, or a failed first
  install, runs a `yt-dlp` on PATH with a warning; with none there, the run fails with code
  `ytdlp-unavailable`, naming `YT_DLP_PATH`.
- **Cookies.** `--cookies-from-browser` and `--cookies` default to `YT_DLP_COOKIES_FROM_BROWSER`
  (`none`: no browser; blank: chrome) and `YT_DLP_COOKIES`; `--cookies-from-browser ''` still
  disables browser cookies, and `none` on the command line still goes to yt-dlp as is. Its help
  doesn't say the two conflict, and the warning for both says what yt-dlp does: it loads both and
  writes the merged jar back into the file. A failure blaming cookies, the browser, its keyring,
  keychain, DPAPI, kwallet, secretstorage or a missing local state file gets a hint naming both
  settings, as an extra warning, and code `cookies-unavailable`; so does a site that asks for
  cookies (YouTube's bot check).
- `laplace-download` takes `--persona`, `--json` and `--expand <url>`, which prints a playlist's,
  channel's or series' video URLs and exits (with `--json`, an `entry` event per video and an
  `expand` summary). `url_list` is required otherwise. Under `--json`, a missing or empty list
  still ends in a stage event and a summary.
- A cancelled download starts no new URL, stops yt-dlp, and reports the URL in flight as
  `cancelled`, not failed; the summary still prints.
- yt-dlp's stderr is decoded leniently, so a byte that isn't UTF-8 never fails the URL.
- **`laplace-prepare-batch`** takes `--lists-dir`, the persona's `lists/` by default; its prepared
  lists are every `*.txt` directly in it (no dotfiles), and its batches
  `lists/batches/videos-*.txt`; without any, it fails with `No prepared URL lists found in <dir>;
  check --persona`. `--source` writes the `# Source:` line. Another site's http(s) URLs are keyed
  by their exact text, while Bilibili's `m.`, `space.` and `b23.tv` links are refused. It has
  `--persona`, and no `--json`, since its stdout is already JSON.

### Transcribe and extract-users

- Defaults come from the persona: `--out-dir` its `streams/`, `--context-file` its
  `glossary.toml`, `--soniox-model` `transcription.model` (`SONIOX_ASYNC_MODEL`, else
  `stt-async-v5`), `--language` `transcription.language` (`TRANSCRIBE_LANGUAGE`; blank: `zh`,
  `none`: no hint), and `--date` today, read when the command runs.
- It takes `--persona`, `--force` and `--json`. There is no local transcription: `--provider`
  takes only `soniox`.
- **Soniox over fetch.** Every call (upload, create, poll, transcript, delete) retries network
  errors and HTTP 408, 429, 500, 502, 503 and 504 after 1, 2, 4, 8, 16 and 30 s, since one 429 or
  5xx left unretried loses a job already paid for. Requests run under Bun's 600 s idle timeout.
- An upload is deleted when creating its transcription fails, even with `--keep-soniox-files`, so
  it never sits in Soniox's 10 GB quota.
- Soniox's copies are deleted after the payload and transcript are written, so a failed write
  never loses a paid transcript; a payload that can't be written keeps them, and the warning names
  the transcription. A sliced run deletes every part's job at the end, and an upload is deleted
  even when its transcription's delete fails (409 while it is still processing); deletes go
  straight to the known file id. A cancelled run deletes its jobs and uploads within 8 s.
- `.soniox.json` is written first, then the `.md`, each through `<path>.<pid>.tmp` and a rename,
  so a crash never leaves a half transcript that looks done.
- **No speech.** A transcription that renders no segments writes its `.soniox.json` and no
  `.md`, reporting `done` with code `no-speech`; zero tokens is the usual cause. The skip rule,
  standalone and in the pipeline, counts a payload that renders no segments as done, so the audio
  is billed once. A forced run that finds no speech removes the old `.md`.
- A standalone run refuses (exit 1) to transcribe over a transcript or a no-speech payload without
  `--force`, and with `--force` over a refined stream warns that its `.refined.json` is now stale.
  Under `--json`, a refusal reports the item `skipped` and a summary with `ok: false`.
- Without ffprobe, or when it fails, the duration comes from the audio's `.info.json`. Slicing
  checks for ffmpeg before anything is uploaded (code `ffmpeg-unavailable`).
- Bad input fails before any upload: a language hint that isn't two letters, `--window 0`, and a
  glossary of the wrong shape or invalid TOML.
- A Soniox error logs `{message} (HTTP {status}, {error_type})` and exits 1, and
  `client_reference_id` is cut to 256 code points.
- `created_at` is rendered as Python's `datetime.isoformat` writes it, by a pattern; an
  unparseable value is kept as sent. Token dumps keep the corpus's nine fields, then any new ones
  in the API's order.
- The missing-key message names `credentials.json`, and the closing hint is
  `bun run laplace-ingest-streams --persona <id>`.
- Cost is estimated at Soniox's $0.10 per audio hour for `stt-async-v4`, `-v5` and `-v6`, and
  reported `unpriced` for any other model.
- `laplace-extract-users` labels message types 1 and 3 as gift and SC, which is what they hold in
  real exports. Its `--persona` is only checked.

### Refine

- The prompts and the schema descriptions name the persona through `{name}` (identity.name) and
  `{shortName}`; a golden pins milky-green's render.
- A concurrency below 1, from `--concurrency`, `REFINE_CONCURRENCY` or `refine.concurrency`, is a
  usage error (exit 2).
- Under `--force`, each checkpoint keeps the old record of every chunk not yet redone, so an
  interrupted run keeps its old refinements; a finished run's final save holds the new records
  alone.
- A cancelled run starts no chunk or stream, aborts the requests in flight, and saves a final
  checkpoint (`model`, `refined_at`, no stats) when anything finished since the last save. The
  transcripts, and a dry run's sidecars, are read one per turn of the event loop, so a signal
  during those reads, seconds long over the real corpus, also ends in a cancelled summary.
- When a chunk raises an unexpected error, its stream fails: its queued chunks never start, and
  the ones in flight finish, their results dropped, before the next stream begins.
- `REFINE_MODEL` and `REFINE_BASE_URL` treat blank as unset, and the `refine.*` settings apply;
  `--model ''` is sent as "".
- A real run holds `sources:<persona>`; a dry run doesn't wait for it. A missing key logs its
  message and exits 1 (`missing-credential`).
- Under `--json`, the human summary and the dry run's text go to stderr, and a dry run or a run
  with no streams also ends in a summary event, with `costUsd: 0` when no chunk was sent.
- Where the `  ✓` lines fall among the next chunk's lines depends on the scheduler.
- Requests carry no SDK-only headers (`User-Agent`, `X-Stainless-*`), and have one 600 s timeout
  per attempt. `OPENROUTER_APP_NAME` and `OPENROUTER_APP_URL` are read when used, so `.env` values
  apply and blank means the default.
- The dry run reads a sidecar without `chunks` as empty.
- The sidecar's temporary file is `<stem>.refined.json.<pid>.tmp`, so two writers never share one.

### Ingest, the catalog and the write side

- Tables are written in Lance file format 2.2, with lance's newer FTS index format.
- **The old table survives a failed rebuild.** The whole Arrow table is built and checked before
  the drop, so a bad row, a short response or a cancel leaves the old table and its meta file.
  Values the schema can't hold exactly are refused there (a missing column, a non-string text, a
  non-boolean `refined`, an out-of-range or fractional `floor`), where apache-arrow alone would
  coerce them. Once the drop happens, the build finishes.
- `--clear-cache` empties the cache with `DELETE` and `VACUUM` (busy_timeout 5000) and keeps the
  file, since every persona and model shares it; its help says so. `Cleared embedding cache at …`
  is logged only when the file existed.
- A provider vector of the wrong size, or fewer vectors than texts, fails before anything from
  that batch is cached, so a bad vector never poisons later runs. A cached vector of the wrong
  size is a miss and is embedded again, so no one has to clear the shared cache.
- After a successful write, each ingest writes `<db path>/<table>.meta.json` atomically:
  `{embedModel, embedDim, rows, builtAt, sources: [{name, size, mtime}]}`, plus `skipTypes` for
  streams or `patterns` for facts (null with `--files`). `sources` lists every transcript,
  sidecar or fact file read.
- `INGEST_SKIP_TYPES` and `knowledge.archive.skipTypes` mean the default `anime_audio,karaoke`
  when blank or `[]`, and nothing when `none`; a copied `.env.example` sets it blank.
  `--skip-types ''` skips nothing.
- **Fact files and the prefix are persona settings.** The files come from
  `knowledge.facts.files` (default `*.txt`; milky-green sets two patterns), each pattern's files
  in code-point order ([personas.md](personas.md)), and the subject of the stripped prefix from
  `knowledge.facts.subject` (default: `identity.name`, escaped; milky-green sets `明前奶[绿黑]`),
  wrapped as `^(?:subject)`; the verbs and punctuation stay in code.
- A fact pattern matches names directly in the folder, case-sensitively even on a
  case-insensitive disk, and never descends for `/` or `**`.
- `laplace-ingest-facts`'s help is persona-neutral and describes its defaults instead of printing
  computed paths. A dangling symlink passed with `--files` is reported under its own name.
- A fully cached run's summary reports `costUsd: 0`.
- The ingest and the catalog parse one transcript at a time and yield between them, so a signal
  lands within a file: parsing all 1,697 at once took 45 s on a cold disk. Embedding stops
  between batches. On error paths only, a bad transcript is reported after the `Loaded …` lines
  of the files before it, and the catalog reads sidecars in file order, so the first of several
  broken files to be reported can differ.
- The catalog's temporary file is `stream_catalog.json.<pid>.tmp`, so a standalone build and the
  pipeline never share one.

### Pipeline

- Stages run in this process, each item isolated. The `Refining:` and `Ingesting:` lines show the
  equivalent command (`laplace-refine --streams-dir … --model …`), a failed transcription logs
  `  ✗ transcribe failed: <message>`, and parallel transcription logs `Running N transcribe
  job(s) in parallel (concurrency=N)`.
- It takes `--persona`, `--json` and `--db-path`; `--provider` takes only `soniox`.
- `url_list` is optional when `--stages` leaves out download.
- **The dry run plans.** It takes no lock, needs no `--db-path` beside `LANCEDB_PATH`, and creates
  no `streams/` folder. Without a URL list it covers every video the persona's lists, `vods/` and
  `streams/` know, and the human dry run counts every list's URLs. With `--json` it emits one
  `plan` event per video, then a summary with stage `plan` of `{videos, downloadPending,
  transcribePending, noDate, refinePending, unindexed}` with the estimated cost.
- A missing yt-dlp fails only the download stage: logged, noted on its summary line, and the run
  goes on unless `--abort-on-error`. An `.info.json` that doesn't decode fails only its file. A
  missing `SONIOX_API_KEY` is logged once and fails each pending file, and a missing refine key
  fails the refine stage, all with `missing-credential`.
- Audio Soniox hears nothing in counts as `N no speech` on the summary line, not as a failure.
- After a cancel no stage starts, the summary lines say cancelled, and the verdict is
  `⚠  Pipeline cancelled — re-run the same command to resume.`
- The run holds `sources:<persona>`, and `index:<db path>` around the ingest and the catalog. The
  catalog is built at the ingest's index, where the bot reads it.
- **A finished batch records itself.** A URL list under the persona's `lists/batches/` gets
  `<batch>.done.json`, `{finishedAt, ids, parts, exitCode: 0}`, after a clean run of all four
  stages, once every video it lists, part by part, is downloaded and transcribed or found to hold
  no speech.
- The no-date hint names `bun run laplace-transcribe <audio> --date YYYY-MM-DD --persona <id>`.

## Measured

- **Relay-only.** Against a real TURN server (coturn), the answer carries only `typ relay`
  candidates with `raddr 0.0.0.0 rport 0`.
- **Production.** On 2026-11-04 a text call to eidolon.vrp.moe over Cloudflare TURN went through
  relay-only (the browser's 12 LAN, CGNAT, Tailscale and ULA candidates dropped), with
  offer→connected at 2.8 s. A logged-in call from China then validated its token through Workers
  (Bun's User-Agent accepted), and Mem0 read and wrote that viewer's memories; offer→connected
  took 2.5 s, 1.5 s of it ICE and 1 s the DTLS handshake.
- **Transcripts.** All 1,697 real `.soniox.json` payloads re-render to their `.md` byte for byte,
  the 168 sliced ones included.
- **Memory.** A full stream ingest peaks at 5.7 GB (7.9 GB RSS), mostly LanceDB serializing the
  table into one IPC buffer.

Still open:

- 2 of 13 local audio calls took about 4 s longer to connect. The browser's ICE connected at
  once, but werift's own ICE reported connected about 4 s later. It never reproduced with
  tracing on, so the cause is unknown. Watch offer→connected on the Cloudflare TURN call, where
  relay-only leaves far fewer candidate pairs than a multi-interface dev machine.
- yt-dlp has deprecated Bun as a JavaScript runtime and supports it only up to 1.3.14. On
  2026-11-05 the managed yt-dlp 2026.10.26 still solved a live YouTube video's challenge with Bun
  1.4.4 and no deno installed, after printing `bun version 1.4.4 is not supported! 1.3.14 is the
  last supported bun version`; with deno on PATH, yt-dlp uses deno. Bilibili needs no runtime.
- Each FTS index build orders tied-score hits its own way: two builds of the same rows disagreed
  in 7 of 10 queries. Scores and result sets are identical, so comparing two builds' hybrid ranks
  has to allow for ties.
- The refine estimate's history basis (cost over chunks refined) runs low, because a sidecar's
  stats cover only its last run: 24% under for the pro model on the real sidecars.
- `stt-async-v5`, the default transcription model, is deprecated: Soniox's model list says it is
  removed on 2026-12-15 and its requests then go to `stt-async-v6`.
