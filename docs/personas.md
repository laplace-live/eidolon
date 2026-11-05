# Personas and settings

A persona is a folder: who the companion is, how she sounds and what she knows. Settings come in
layers, so a persona can be shared without the keys or the private data of whoever runs it.

## A persona's folder

```text
personas/<id>/
  persona.yaml          identity and the settings this persona changes (below)
  prompt.md             the system prompt — identity and hard rules, no code
  glossary.toml         Soniox transcription vocabulary (Soniox's StructuredContext)
  references/outfits/   what take_selfie redraws; exactly one reaches a render
  references/friends/   one image per person she can be photographed with, named after them
  index/                the LanceDB tables the ingests build; derived, rebuildable, never edited
```

Two copies of that folder exist. The repository ships each persona's template under `personas/`,
and the user keeps their own under `<data home>/personas/<id>/`. Every file resolves from the
user's folder first and the template second, and a folder's listing is the union of both. That
is how one persona is split between what is published and what stays on a machine: 明前奶绿's
template ships her prompt, `persona.yaml`, outfits and glossary, while her index and her friend
images exist only in a data home.

The active persona is `EIDOLON_PERSONA`, else `persona` in `settings.yaml`, else `milky-green`,
else the first folder found.

## The data home

`EIDOLON_HOME`, or `~/.laplace/eidolon`. A deployment mounts it as a volume: both Docker images
set `EIDOLON_HOME=/data`.

```text
<data home>/
  settings.yaml         the install's settings
  credentials.json      API keys and tokens, mode 0600
  personas/<id>/        the user's own persona folders
  mem0/history.db       Mem0's change log (the TypeScript bot's default)
```

## Layers

Code defaults < `settings.yaml` < `persona.yaml` < the environment. A non-empty environment
variable always wins, so a deployment's env stays authoritative; a blank one (`KEY=` from a copied
`.env.example`) counts as unset. Each setting maps to the variable that always configured it, and
a file's value goes through the same reader as that variable would, with the same parsing and
warnings.

Secrets never go in YAML. `credentials.json` holds them, keyed by their variable names, beneath the
environment:

```json
{ "OPENROUTER_API_KEY": "sk-or-…", "SONIOX_API_KEY": "…", "FISH_API_KEY": "…" }
```

The names it accepts: `SONIOX_API_KEY`, `OPENROUTER_API_KEY`, `FISH_API_KEY`, `RERANK_API_KEY`,
`EMBED_API_KEY`, `REFINE_API_KEY`, `OPENAI_API_KEY`, `CLOUDFLARE_TURN_KEY_API_TOKEN`,
`WEBRTC_TURN_CREDENTIAL`, `CF_WAF_BYPASS_TOKEN`.

The Python offline tools read none of these files; they still take the environment only.

A misspelled key (`identity` and the gate questions included), a value of the wrong type, malformed
YAML and a credentials file other users can read each log a warning; the bad value is ignored.

## persona.yaml

```yaml
identity:
  name: 明前奶绿
  shortName: 奶绿
  fans: 奶糖花
  summary: 明前奶绿, a Chinese VTuber who streams on Bilibili, …
  viewerLine: 今天来花店的{fans}叫「{viewer}」（B站UID:{uid}）。
  timezone: Asia/Shanghai
voice:
  model: drama-3
  voiceId: <Fish Audio model id>
  styles:
    gentle: <Fish Audio model id>
```

`identity` is written in the persona's language and lands in prompts verbatim:

| Field | Used in | Default |
| --- | --- | --- |
| `name` | the MCP server's instructions and tool descriptions | the folder name |
| `shortName` | the refine prompts, where they shorten her name | `name` |
| `fans` | the voice and selfie tool texts: what she calls a viewer | 观众 |
| `summary` | the retrieval gate, as who "the streamer" is | empty |
| `viewerLine` | the logged-in viewer line; `{fans}`, `{viewer}`, `{uid}` are filled in, `""` omits it | 正在和你聊天的{fans}叫「{viewer}」（UID:{uid}）。 |

`knowledge.gate.questions.<key>` replaces a retrieval-gate question's text (`about_her`, `her_past`,
`named_thing`); 奶绿's pack tunes `about_her` for her shop. `voice.styles.<name>` adds a voice
style, as `FISH_VOICE_ID_<NAME>` would. Paths resolve in the persona's folder, the user's copy
first.

| Setting | Variable | Kind | What |
| --- | --- | --- | --- |
| `prompt` | `PERSONA_FILE` | path | System prompt file |
| `identity.timezone` | `PERSONA_TIMEZONE` | string | Time zone |
| `voice.model` | `FISH_MODEL` | string | Fish Audio model |
| `voice.voiceId` | `FISH_VOICE_ID` | string | Voice |
| `hearing.model` | `SONIOX_MODEL` | string | Soniox model |
| `mind.model` | `OPENROUTER_MODEL` | string | Chat model |
| `memory.searchLimit` | `MEM0_SEARCH_LIMIT` | int | Memories per turn |
| `memory.searchThreshold` | `MEM0_SEARCH_THRESHOLD` | float | Memory score threshold |
| `memory.agentId` | `MEM0_AGENT_ID` | string | Mem0 agent id |
| `memory.runId` | `MEM0_RUN_ID` | string | Mem0 run id |
| `memory.model` | `MEM0_LLM_MODEL` | string | Memory extraction model |
| `knowledge.index` | `LANCEDB_PATH` | path | Knowledge index |
| `knowledge.factsCandidates` | `PERSONA_FACTS_CANDIDATES` | int | Fact candidates |
| `knowledge.archiveCandidates` | `STREAM_ARCHIVE_CANDIDATES` | int | Stream candidates |
| `knowledge.rerank.enabled` | `RERANK_ENABLED` | flag | Rerank results |
| `knowledge.rerank.model` | `RERANK_MODEL` | string | Reranker model |
| `knowledge.gate.enabled` | `RETRIEVAL_GATE_ENABLED` | flag | Retrieval gate |
| `knowledge.gate.model` | `RETRIEVAL_GATE_MODEL` | string | Retrieval gate model |
| `knowledge.facts.files` | `FACTS_FILES` | list | Fact files |
| `knowledge.facts.subject` | `FACTS_SUBJECT` | string | Fact subject pattern |
| `knowledge.archive.skipTypes` | `INGEST_SKIP_TYPES` | list | Scene types left out of the index |
| `transcription.model` | `SONIOX_ASYNC_MODEL` | string | Transcription model |
| `refine.model` | `REFINE_MODEL` | string | Refine model |
| `refine.concurrency` | `REFINE_CONCURRENCY` | int | Refine concurrency |
| `selfie.model` | `SELFIE_MODEL` | string | Selfie model |
| `selfie.aspectRatio` | `SELFIE_ASPECT_RATIO` | string | Selfie aspect ratio |
| `selfie.quality` | `SELFIE_QUALITY` | string | Selfie quality |
| `selfie.ttlSeconds` | `SELFIE_TTL_SECONDS` | int | Selfie lifetime |
| `selfie.timeoutSeconds` | `SELFIE_TIMEOUT_SECONDS` | int | Selfie timeout |
| `selfie.references` | `SELFIE_REFERENCE_IMAGES` | paths | Selfie references |

`knowledge.facts.files` lists the name patterns of the persona's fact files (default `*.txt`; quote
a pattern that starts with `*`). `knowledge.facts.subject` is a regex for the name most facts open
with, which their embeddings leave out (default: `identity.name`, matched literally).
`knowledge.archive.skipTypes` defaults to `anime_audio,karaoke`; `none` keeps every scene.
`transcription.model` defaults to `stt-async-v5`, `refine.model` to `~google/gemini-pro-latest` and
`refine.concurrency` to 8.

## settings.yaml

The install's settings, for every persona. Paths resolve in the data home.

| Setting | Variable | Kind | What |
| --- | --- | --- | --- |
| `persona` | `EIDOLON_PERSONA` | string | Active persona |
| `access.workersBaseUrl` | `WORKERS_BASE_URL` | string | LAPLACE Workers URL |
| `access.validateTtlSec` | `EIDOLON_VALIDATE_TTL_SEC` | int | Login cache seconds |
| `access.anonRateLimitPerHour` | `EIDOLON_ANON_RATE_LIMIT_PER_HOUR` | int | Anonymous calls per window |
| `access.anonRateLimitWindowSec` | `EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC` | int | Anonymous window seconds |
| `access.realIpHeader` | `EIDOLON_REAL_IP_HEADER` | string | Client IP header |
| `access.allowedOrigins` | `PIPECAT_ALLOWED_ORIGINS` | list | Allowed browser origins |
| `network.cloudflareTurn.keyId` | `CLOUDFLARE_TURN_KEY_ID` | string | Cloudflare TURN key id |
| `network.cloudflareTurn.ttlSec` | `CLOUDFLARE_TURN_TTL_SEC` | int | TURN credential lifetime |
| `network.stunUrl` | `WEBRTC_STUN_URL` | string | STUN URL |
| `network.turnUrl` | `WEBRTC_TURN_URL` | string | TURN URL |
| `network.turnUsername` | `WEBRTC_TURN_USERNAME` | string | TURN username |
| `audio.opusBitrateBps` | `EIDOLON_OPUS_BITRATE_BPS` | int | Default Opus bitrate |
| `audio.opusBitrate.best` | `EIDOLON_OPUS_BITRATE_BEST_BPS` | int | Opus bitrate: best |
| `audio.opusBitrate.medium` | `EIDOLON_OPUS_BITRATE_MEDIUM_BPS` | int | Opus bitrate: medium |
| `audio.opusBitrate.low` | `EIDOLON_OPUS_BITRATE_LOW_BPS` | int | Opus bitrate: low |
| `audio.opusBitrate.lowest` | `EIDOLON_OPUS_BITRATE_LOWEST_BPS` | int | Opus bitrate: lowest |
| `mcp.anonRateLimitPerHour` | `EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR` | int | MCP anonymous calls per window |
| `mcp.authRateLimitPerHour` | `EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR` | int | MCP logged-in calls per window |
| `mcp.rateLimitWindowSec` | `EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC` | int | MCP window seconds |
| `mcp.allowedHosts` | `EIDOLON_MCP_ALLOWED_HOSTS` | list | MCP allowed hosts |
| `memory.qdrant.host` | `MEM0_QDRANT_HOST` | string | Qdrant host |
| `memory.qdrant.port` | `MEM0_QDRANT_PORT` | int | Qdrant port |
| `memory.qdrant.collection` | `MEM0_QDRANT_COLLECTION` | string | Qdrant collection |
| `memory.historyDb` | `MEM0_HISTORY_DB_PATH` | path | Mem0 history database |
| `providers.openrouter.apiBase` | `OPENROUTER_API_BASE` | string | OpenRouter API base |
| `providers.openrouter.appName` | `OPENROUTER_APP_NAME` | string | OpenRouter app name |
| `providers.openrouter.appUrl` | `OPENROUTER_APP_URL` | string | OpenRouter app URL |
| `providers.openai.baseUrl` | `OPENAI_BASE_URL` | string | OpenAI-compatible base URL |
| `embeddings.model` | `EMBED_MODEL` | string | Embedding model |
| `embeddings.dim` | `EMBED_DIM` | int | Embedding dimension |
| `embeddings.baseUrl` | `EMBED_BASE_URL` | string | Embedding API base |
| `rerank.baseUrl` | `RERANK_BASE_URL` | string | Reranker API base |
| `refine.baseUrl` | `REFINE_BASE_URL` | string | Refine API base |
| `sources.ytDlp` | `YT_DLP_PATH` | path | yt-dlp binary |
| `sources.cookiesFromBrowser` | `YT_DLP_COOKIES_FROM_BROWSER` | string | Browser to read cookies from |
| `sources.cookiesFile` | `YT_DLP_COOKIES` | path | Cookies file |

`sources.ytDlp` replaces the yt-dlp the tools install and update under `<data home>/bin/`.
`sources.cookiesFromBrowser` defaults to `chrome`; `none` reads no browser's cookies. yt-dlp writes
the merged cookie jar back into `sources.cookiesFile`.

## Deploying a persona

Mount a data home holding `personas/<id>/index/` (and any private references) at `/data`, and
configure the rest through the environment as before. Copy a persona's folder to the server the
first time, and again after every re-ingest:

```sh
rsync -a --checksum --delete-after --delay-updates \
  <data home>/personas/<id>/ <host>:<mounted path>/personas/<id>/
```

The bot keeps serving calls through the copy and picks up the new tables without a restart, as
long as the command keeps all three options:

- `--delay-updates` holds the new files back until the transfer ends. Without it, a call that
  starts mid-transfer can open a new manifest whose data hasn't arrived, and gets no recall.
- `--delete-after` removes the old files last. A search still holding an old table then fails on
  a missing file and reopens the new one, logging a "hit stale table" warning. Without it,
  long-lived handles such as the MCP server's keep serving the old tables until a restart.
- `--checksum`, because a re-ingest writes the same manifest file names again, and rsync's default
  check (size, and modification time to the second) can skip a changed one.

`--delete-after` makes the server's folder match yours, so preview with `--dry-run` first: an
empty or mistyped source folder would empty the server's.

Mem0 writes its change log to `<data home>/mem0/history.db`, so mount the data home writable, or
mount it read-only and point `MEM0_HISTORY_DB_PATH` at a writable volume; a read-only home without
that runs every call without memory. Set `EIDOLON_HOME: /data` in the service's `environment`
too: an `env_file` copied from `.env.example` carries a blank `EIDOLON_HOME=`, which would replace
the image's value.
