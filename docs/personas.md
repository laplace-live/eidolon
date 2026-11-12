# Personas and settings

A persona is a folder: who the companion is, how she sounds and what she knows. Settings come in
layers, so a persona can be shared without the keys or the private data of whoever runs it.

## A persona's folder

```text
personas/<id>/
  persona.yaml          identity and the settings this persona changes (below)
  prompt.md             the system prompt — identity and hard rules, no code
  glossary.toml         Soniox transcription vocabulary (Soniox's StructuredContext)
  avatar.{png,jpg,webp} the avatar the web app shows; never a selfie reference
  references/outfits/   what take_selfie redraws; exactly one reaches a render
  references/friends/   one image per person she can be photographed with, named after them
  index/                what the ingests build; derived, rebuildable, never edited
```

`index/` holds the two LanceDB tables (`stream_chunks.lance`, `persona_facts.lance`),
`stream_catalog.json`, and beside each table a `<table>.meta.json` recording what built it: the
embedding model and dimension, the row count, when, and each source file's size and modification
time.

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
  credentials.json      provider accounts, API keys and tokens, mode 0600
  personas/<id>/        the user's own persona folders
  sources/<id>/         what builds a persona's index (below); never deployed
  cache/embed_cache.db  the embedding cache every persona shares; its key holds the model
  bin/yt-dlp            the yt-dlp the offline tools install and keep current, with its stamp
  locks/                the offline tools' locks, released when their process exits
  chats/<id>/           the local web app's text chats, 0700: chat.jsonl, meta.json, files/ (chat.md)
  mem0/history.db       Mem0's change log (the TypeScript bot's default)
```

## A persona's sources

What the offline tools build a persona's index from. The bot reads none of it, a deploy never
copies it, and it never goes in a repository.

```text
<data home>/sources/<id>/
  facts/                fact files, one fact per line (knowledge.facts.files picks them)
  lists/                URL lists, one video per line; batches/ holds batches of new videos
  vods/                 downloaded audio, each with yt-dlp's <id>.info.json
  streams/              transcripts <date>-<id>.md, Soniox payloads .soniox.json, refinements
                        .refined.json
  eval/                 queries.toml and baseline.json for laplace-eval-retrieval
```

The offline commands (`bun run laplace-*`, [typescript.md](typescript.md#the-offline-chain)) take
`--persona <id>`, default to these folders and to the persona's `index/`, and accept a path flag
for each. `laplace-pipeline <list>` downloads a list's videos into `vods/`, transcribes and
refines whatever in `vods/` and `streams/` still needs it, then rebuilds `stream_chunks` from
**every** transcript in `streams/`: a transcript removed from there drops out of the index at the
next ingest. `laplace-ingest-facts` rebuilds `persona_facts` from `facts/`.

`laplace-prepare-batch` writes the videos no list in `lists/` has yet into a new batch,
`lists/batches/videos-<YYYY-MM-DD-HHMMSS>.txt`. A clean pipeline run of all four stages over a
batch writes `<batch>.done.json` beside it once every video the batch lists is downloaded and
transcribed; a batch without one is still pending. A `.soniox.json` without its `.md` is audio
Soniox heard no speech in: it counts as transcribed, so the audio isn't billed again.

## Layers

Each setting maps to the variable that always configured it, and a file's value goes through the
same reader as that variable would, with the same parsing and warnings. A blank value, in the
environment (`KEY=` from a copied `.env.example`) or in a file, counts as unset.

- **The install's settings** (`settings.yaml`): code defaults < `settings.yaml` < the environment.
  A deployment's environment stays authoritative.
- **A persona's settings** (`persona.yaml`): code defaults < the local web app's own defaults <
  the environment < her `persona.yaml`. What she sets is hers, whatever the environment says; the
  environment's value is the default for every persona that leaves the setting unset. The local
  app's one default is `memory.agentId`, her id.
- **A model or voice goes with its provider.** The environment's `LLM_MODEL` belongs to its
  `LLM_PROVIDER`, and so on for every role ([providers.md](providers.md)): a persona whose file
  picks another provider doesn't inherit it. The provider-named variables (`OPENROUTER_MODEL`,
  `SONIOX_MODEL`, `FISH_MODEL`, `FISH_VOICE_ID`, `SONIOX_ASYNC_MODEL`) apply only while that
  provider fills the role, and the neutral name wins where both are set.
- **Voice styles go with the voice.** The environment's `TTS_VOICE_ID_<STYLE>` voices (Fish's
  `FISH_VOICE_ID_<STYLE>`) are moods of the environment's voice, so they skip a persona whose
  `voice.voiceId` is her own: she has only the styles her `voice.styles` gives her. A persona
  without one keeps the environment's styles, and a style her `voice.styles` names replaces the
  environment's of that name.

Whenever it loads the settings, the bot logs each environment variable a persona's file overrides,
by name. `EIDOLON_PERSONA`, which picks the persona, is an install setting: the environment's wins.

Secrets never go in YAML. `credentials.json` holds them beneath the environment, as the install's
settings are: the provider accounts under `accounts` (one per key, each with its API base and the
provider's settings; [providers.md](providers.md#accounts)), and other secrets under their
variable names:

```json
{
  "accounts": {
    "openrouter": { "provider": "openrouter", "apiKey": "sk-or-…" },
    "openai-2": { "provider": "openai", "name": "OpenAI (work)", "apiKey": "sk-…" }
  },
  "SONIOX_API_KEY": "…",
  "FISH_API_KEY": "…"
}
```

A provider's variable still keys its default account, below that account's entry; the local app
moves it into the entry when it saves a new one. The names it accepts: each provider's key (`SONIOX_API_KEY`, `OPENROUTER_API_KEY`, `FISH_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`,
`DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `ZHIPU_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`,
`ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `MINIMAX_API_KEY`, `COHERE_API_KEY`),
a role's own (`RERANK_API_KEY`, `EMBED_API_KEY`, `REFINE_API_KEY`), and production's
(`CLOUDFLARE_TURN_KEY_API_TOKEN`, `WEBRTC_TURN_CREDENTIAL`, `CF_WAF_BYPASS_TOKEN`).

`EIDOLON_CHAT_SECRET`, the key the production chat endpoint signs with, comes from the environment
alone: `credentials.json` ignores it with a warning, and no YAML file has a setting for it. While
it is unset, or shorter than 32 characters, the endpoint stays off ([chat.md](chat.md)).

The offline commands read these files as the bot does, for the persona `--persona` names.

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
  localViewerLine: 今天来花店的{fans}叫「{viewer}」。
  timezone: Asia/Shanghai
voice:
  model: drama-3
  voiceId: <Fish Audio model id>
  styles:
    gentle: <Fish Audio model id>
    nai_hei:
      voiceId: <Fish Audio model id>
      hint: 奶黑/黑化/腹黑一点
```

`identity` is written in the persona's language and lands in prompts verbatim:

| Field | Used in | Default |
| --- | --- | --- |
| `name` | the MCP server's instructions and tool descriptions | the folder name |
| `shortName` | the refine prompts, where they shorten her name | `name` |
| `fans` | the voice and selfie tool texts: what she calls a viewer | 观众 |
| `summary` | the retrieval gate, as who "the streamer" is | empty |
| `viewerLine` | the logged-in viewer line; `{fans}`, `{viewer}`, `{uid}` are filled in, `""` omits it | 正在和你聊天的{fans}叫「{viewer}」（UID:{uid}）。 |
| `localViewerLine` | the same line for the local web app's viewer, who has no UID; `{fans}` and `{viewer}` are filled in, `""` omits it | 正在和你聊天的{fans}叫「{viewer}」。 |

`knowledge.gate.questions.<key>` replaces a retrieval-gate question's text (`about_her`, `her_past`,
`named_thing`); 奶绿's pack tunes `about_her` for her shop. `voice.styles.<name>` adds a voice
style that `change_voice_style` switches her to when a viewer asks, as `TTS_VOICE_ID_<NAME>` would.
It is a voice id, or a `voiceId` and a `hint`: the words that ask for it, which replace the built-in
ones (`gentle`, `lively`, `calm`, `sweet` and `playful` have them; any other style goes by its name
alone). The studio's Voice tab edits them, and drops them when it saves her voice on another
provider, whose voice ids they aren't. Paths resolve in the persona's folder, the user's copy first.

Each role's `provider` picks one from [the catalog](providers.md#roles) and its `model` is that
provider's id for it, the provider's default when unset; `realtime.provider` is off until set.
Memory is the exception: unset, it takes her chat model while both use one provider, so changing
`mind.model` changes what extracting memories does and costs too.
`hearing.language` is the language viewers speak, as a two-letter code: Soniox detects it when it
is unset, and the other providers use `transcription.language`, else `zh`.

| Setting | Variable | Kind | What |
| --- | --- | --- | --- |
| `prompt` | `PERSONA_FILE` | path | System prompt file |
| `identity.timezone` | `PERSONA_TIMEZONE` | string | Time zone |
| `voice.provider` | `TTS_PROVIDER` | string | Voice provider |
| `voice.model` | `TTS_MODEL` | string | Voice model |
| `voice.voiceId` | `TTS_VOICE_ID` | string | Voice |
| `hearing.provider` | `STT_PROVIDER` | string | Speech recognition provider |
| `hearing.model` | `STT_MODEL` | string | Speech recognition model |
| `hearing.language` | `STT_LANGUAGE` | string | Spoken language |
| `mind.provider` | `LLM_PROVIDER` | string | Chat provider |
| `mind.model` | `LLM_MODEL` | string | Chat model |
| `realtime.provider` | `REALTIME_PROVIDER` | string | Realtime provider |
| `realtime.model` | `REALTIME_MODEL` | string | Realtime model |
| `realtime.voice` | `REALTIME_VOICE` | string | Realtime voice |
| `memory.searchLimit` | `MEM0_SEARCH_LIMIT` | int | Memories per turn |
| `memory.searchThreshold` | `MEM0_SEARCH_THRESHOLD` | float | Memory score threshold |
| `memory.agentId` | `MEM0_AGENT_ID` | string | Mem0 agent id |
| `memory.runId` | `MEM0_RUN_ID` | string | Mem0 run id |
| `memory.provider` | `MEM0_LLM_PROVIDER` | string | Memory extraction provider |
| `memory.model` | `MEM0_LLM_MODEL` | string | Memory extraction model |
| `knowledge.index` | `LANCEDB_PATH` | path | Knowledge index |
| `knowledge.factsCandidates` | `PERSONA_FACTS_CANDIDATES` | int | Fact candidates |
| `knowledge.archiveCandidates` | `STREAM_ARCHIVE_CANDIDATES` | int | Stream candidates |
| `knowledge.rerank.enabled` | `RERANK_ENABLED` | flag | Rerank results |
| `knowledge.rerank.provider` | `RERANK_PROVIDER` | string | Reranker provider |
| `knowledge.rerank.model` | `RERANK_MODEL` | string | Reranker model |
| `knowledge.gate.enabled` | `RETRIEVAL_GATE_ENABLED` | flag | Retrieval gate |
| `knowledge.gate.provider` | `RETRIEVAL_GATE_PROVIDER` | string | Retrieval gate provider |
| `knowledge.gate.model` | `RETRIEVAL_GATE_MODEL` | string | Retrieval gate model |
| `knowledge.facts.files` | `FACTS_FILES` | list | Fact files |
| `knowledge.facts.subject` | `FACTS_SUBJECT` | string | Fact subject pattern |
| `knowledge.archive.skipTypes` | `INGEST_SKIP_TYPES` | list | Scene types left out of the index |
| `transcription.provider` | `TRANSCRIBE_PROVIDER` | string | Transcription provider |
| `transcription.model` | `TRANSCRIBE_MODEL` | string | Transcription model |
| `transcription.language` | `TRANSCRIBE_LANGUAGE` | string | Transcription language |
| `refine.provider` | `REFINE_PROVIDER` | string | Refine provider |
| `refine.model` | `REFINE_MODEL` | string | Refine model |
| `refine.concurrency` | `REFINE_CONCURRENCY` | int | Refine concurrency |
| `selfie.provider` | `SELFIE_PROVIDER` | string | Selfie provider |
| `selfie.model` | `SELFIE_MODEL` | string | Selfie model |
| `selfie.aspectRatio` | `SELFIE_ASPECT_RATIO` | string | Selfie aspect ratio |
| `selfie.quality` | `SELFIE_QUALITY` | string | Selfie quality |
| `selfie.ttlSeconds` | `SELFIE_TTL_SECONDS` | int | Selfie lifetime |
| `selfie.timeoutSeconds` | `SELFIE_TIMEOUT_SECONDS` | int | Selfie timeout |
| `selfie.references` | `SELFIE_REFERENCE_IMAGES` | paths | Selfie references |
| `chat.interests` | `CHAT_INTERESTS` | string | Chat interests |
| `chat.talkativeness` | `CHAT_TALKATIVENESS` | float | Chat talkativeness |
| `chat.replyMode` | `CHAT_REPLY_MODE` | string | Chat reply mode |

`knowledge.facts.files` lists name patterns for the fact files in `sources/<id>/facts/` (default
`*.txt`). A pattern matches a file name as Python's pathlib glob does: `*`, `?`, `[…]` and `[!…]`,
case-sensitive, dotfiles included. Each pattern's files are taken in code-point order, the
patterns in list order, and a file two patterns match is read once. Quote a pattern that starts
with `*`, which YAML would read as an alias. `knowledge.facts.subject` is a regex, in Python's
syntax, for the name most facts open with (default: `identity.name`, matched literally); the
ingest leaves it out of what it embeds, together with a reporting verb after it (声称, 表示, …)
and the punctuation that follows.

`knowledge.archive.skipTypes` defaults to `anime_audio,karaoke`; `none` keeps every scene.
`transcription.model` defaults to `stt-async-v5`, `refine.model` to `~google/gemini-pro-latest` and
`refine.concurrency` to 8. `transcription.language` is the two-letter language hint Soniox gets for
the persona's videos (default `zh`; `none` sends none), as `--language` sets it for one run.

`chat.*` is how she joins a chat ([chat.md](chat.md)). `chat.interests` names the
topics she cares about, separated by commas or 、 (`游戏、猫、深夜聊天`); the director reads them
with `identity.summary` to judge whether a line is something she'd join in on, and reads the
summary alone when they're unset. `chat.talkativeness`, from 0 to 1 (default 0.5; a value
outside is clamped), weighs that interest: the director ranks the personas who weren't addressed
by interest times talkativeness. At 0 she joins in only when a line mentions or addresses her,
or when everyone else there is at 0 too, since someone always answers the viewer.
`chat.replyMode` is how she answers in a chat: `text`, `voice` (a voice message in her voice role,
with its transcript), or `auto` (the default), where the director judges whether a line suits a
voice message. A chat's own reply mode, from its settings, overrides hers. `voice` and `auto` fall
back to text while her voice role has no key or its provider can't speak a whole reply; any other
value reads as `auto`, with a warning.

## settings.yaml

The install's settings, for every persona. Paths resolve in the data home.

| Setting | Variable | Kind | What |
| --- | --- | --- | --- |
| `persona` | `EIDOLON_PERSONA` | string | Active persona |
| `local.viewerName` | `EIDOLON_LOCAL_VIEWER_NAME` | string | Your name |
| `access.workersBaseUrl` | `WORKERS_BASE_URL` | string | LAPLACE Workers URL |
| `access.validateTtlSec` | `EIDOLON_VALIDATE_TTL_SEC` | int | Login cache seconds |
| `access.anonRateLimitPerHour` | `EIDOLON_ANON_RATE_LIMIT_PER_HOUR` | int | Anonymous calls per window |
| `access.anonRateLimitWindowSec` | `EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC` | int | Anonymous window seconds |
| `access.realIpHeader` | `EIDOLON_REAL_IP_HEADER` | string | Client IP header |
| `access.allowedOrigins` | `PIPECAT_ALLOWED_ORIGINS` | list | Allowed browser origins |
| `access.chatPersonas` | `EIDOLON_CHAT_PERSONAS` | list | Public chat personas |
| `access.chatAnonQuota` | `EIDOLON_CHAT_ANON_QUOTA` | int | Anonymous chat turns per hour |
| `access.chatUserQuota` | `EIDOLON_CHAT_USER_QUOTA` | int | Logged-in chat turns per hour |
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
| `providers.openai.baseUrl` | `OPENAI_BASE_URL` | string | OpenAI API base |
| `embeddings.provider` | `EMBED_PROVIDER` | string | Embedding provider |
| `embeddings.model` | `EMBED_MODEL` | string | Embedding model |
| `embeddings.dim` | `EMBED_DIM` | int | Embedding dimension |
| `embeddings.baseUrl` | `EMBED_BASE_URL` | string | Embedding API base |
| `rerank.baseUrl` | `RERANK_BASE_URL` | string | Reranker API base |
| `refine.baseUrl` | `REFINE_BASE_URL` | string | Refine API base |
| `sources.ytDlp` | `YT_DLP_PATH` | path | yt-dlp binary |
| `sources.cookiesFromBrowser` | `YT_DLP_COOKIES_FROM_BROWSER` | string | Browser to read cookies from |
| `sources.cookiesFile` | `YT_DLP_COOKIES` | path | Cookies file |
| `usage.db` | `EIDOLON_USAGE_DB` | path | Usage ledger |

`local.viewerName` is what the persona calls you in the local web app's calls; the bot that
`bun run start` and the Docker image run never reads it.
`sources.ytDlp` replaces the yt-dlp the tools install and update under `<data home>/bin/`.
`sources.cookiesFromBrowser` defaults to `chrome`; `none` reads no browser's cookies. yt-dlp writes
the merged cookie jar back into `sources.cookiesFile`. `usage.db` is the SQLite file every call,
chat turn, job and MCP search records its spend in (default `<data home>/usage.db`;
[providers.md](providers.md#usage-and-cost)).
Each `providers.<id>` base moves that provider's API, for a proxy or another region; blank uses its
own.
The `access.chat*` rows apply only once `EIDOLON_CHAT_SECRET` turns the production chat endpoint on
([chat.md](chat.md)). `access.chatPersonas` lists the persona ids it serves, by default the
installed persona alone. Each viewer line costs one turn of a quota counted over the last hour:
`access.chatAnonQuota` (default 20) per client IP for anonymous viewers, and `access.chatUserQuota`
(default 200) per mid for logged-in ones. Both quotas are read once, on the first chat turn.

## Deploying a persona

Mount a data home holding the persona's folder at `/data`, and configure the rest through the
environment as before: the environment sets what her `persona.yaml` leaves unset
([layers](#layers)). What goes in that folder depends on where the persona comes from:

- **A template persona**, one the repository ships under `personas/` (milky-green): its `index/`
  and `references/friends/` only. Its `prompt.md`, `persona.yaml`, `glossary.toml` and outfits
  come from the image, so each release brings the published ones. A copy on the server would
  override them file by file, and they are what the local web app's studio edits in your data
  home, so copying them would ship those edits to production; a copied `persona.yaml` would also
  override the environment for every setting it sets, a voice included. Remove any that an
  earlier copy of the whole folder left there.
- **A persona of your own**: its whole `personas/<id>/` folder, the avatar at its root included.
- **Never** `sources/`: the bot reads none of it.

Copy the first time, and again after every re-ingest:

```sh
# a template persona: each folder on its own (leave out one you don't have). rsync makes only
# the last folder of a destination, so the first copy needs the persona's references/ there.
ssh <host> mkdir -p "<mounted path>/personas/<id>/references"
for folder in index references/friends; do
  rsync -a --checksum --delete-after --delay-updates \
    "<data home>/personas/<id>/$folder/" "<host>:<mounted path>/personas/<id>/$folder/"
done

# a persona of your own
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

## Moving sources out of a checkout

Sources once lived in the checkout: `data/`, `streams/` and `vods/`, and the embedding cache in
`data/embed_cache.db`. The offline commands read them from the data home only. To move them, for
a persona `<id>`, with nothing running that uses them:

```sh
home=${EIDOLON_HOME:-$HOME/.laplace/eidolon}
src=$home/sources/<id>
lsof data/embed_cache.db    # must print nothing
sqlite3 data/embed_cache.db 'PRAGMA wal_checkpoint(TRUNCATE)'
mkdir -p "$home/cache" "$home/mem0" "$src/facts" "$src/lists/batches" "$src/eval" \
  "$src/streams" "$src/vods"
mv data/embed_cache.db* "$home/cache/"
mv data/*设定集.txt data/*事件集.txt "$src/facts/"
mv data/video*.txt "$src/lists/"
mv data/auto-embed/* "$src/lists/batches/"
mv data/eval/* "$src/eval/"
mv streams/* "$src/streams/"
mv vods/* "$src/vods/"
mv data/mem0-cloud-export.json "$home/mem0/cloud-export.json"   # if you have one
```

`*` skips dotfiles, so each folder's tracked `.gitignore` stays. On one volume each `mv` is
instant; the cache moves with its `-wal` and `-shm` once checkpointed. Then
`bun run laplace-pipeline --persona <id> --dry-run` should find every transcript already done.
