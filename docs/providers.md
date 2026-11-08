# Providers

Every outside service a persona talks to is a provider in one catalog,
`packages/providers/src/catalog.ts`, reached through an account: a key, an API base and the
provider's own settings. Every part of her work is a role that names an account and a model.
Persona A can hear with Soniox, think with Claude on Anthropic's API and speak with Fish Audio,
while persona B hears with Deepgram, thinks with DeepSeek through OpenRouter and speaks with
ElevenLabs, and two personas can think with OpenAI on two keys. The TypeScript bot, the offline
chain, the MCP server and the local web app all resolve roles the same way, through `select()` in
`packages/providers/src/resolve.ts`.

Nothing calls a vendor SDK. `packages/providers/src/http/` holds fetch clients for the two wire
formats there are (OpenAI-compatible chat and Anthropic's Messages API), and `packages/runtime`
hands them to pipedog's services in place of the SDK clients those would build. pipedog's
`@pipedog/openai` and `@pipedog/anthropic` still install the `openai` and `@anthropic-ai/sdk`
packages, for their types; no request goes through them.

## Roles

| Role | Settings | Variables | Default | Spends |
| --- | --- | --- | --- | --- |
| hearing | `hearing.provider`, `hearing.model`, `hearing.language` | `STT_PROVIDER`, `STT_MODEL`, `STT_LANGUAGE` | Soniox `stt-rt-v5` | in a call |
| mind | `mind.provider`, `mind.model` | `LLM_PROVIDER`, `LLM_MODEL` | OpenRouter `~google/gemini-flash-latest` | in a call |
| voice | `voice.provider`, `voice.model`, `voice.voiceId` | `TTS_PROVIDER`, `TTS_MODEL`, `TTS_VOICE_ID` | Fish Audio `drama-3` | in a call |
| realtime | `realtime.provider`, `realtime.model`, `realtime.voice` | `REALTIME_PROVIDER`, `REALTIME_MODEL`, `REALTIME_VOICE` | off | in a call |
| gate | `knowledge.gate.provider`, `.model` | `RETRIEVAL_GATE_PROVIDER`, `RETRIEVAL_GATE_MODEL` | OpenRouter `~typesafe/jev-latest` | in a call |
| rerank | `knowledge.rerank.provider`, `.model` | `RERANK_PROVIDER`, `RERANK_MODEL` | OpenRouter `cohere/rerank-4-fast` | in a call, MCP |
| memory | `memory.provider`, `memory.model` | `MEM0_LLM_PROVIDER`, `MEM0_LLM_MODEL` | her chat provider and model | after a turn |
| selfie | `selfie.provider`, `selfie.model` | `SELFIE_PROVIDER`, `SELFIE_MODEL` | OpenRouter `openai/gpt-image-2.5-flare` | in a call |
| transcription | `transcription.provider`, `.model` | `TRANSCRIBE_PROVIDER`, `TRANSCRIBE_MODEL` | Soniox `stt-async-v5` | jobs |
| refine | `refine.provider`, `.model` | `REFINE_PROVIDER`, `REFINE_MODEL` | OpenRouter `~google/gemini-pro-latest` | jobs |
| embeddings | `embeddings.provider`, `.model` (app-wide) | `EMBED_PROVIDER`, `EMBED_MODEL` | OpenRouter `google/gemini-embedding-2-preview` | jobs, calls, MCP |

The decision models the retrieval gate asks are a category of their own, `decision`: OpenRouter
lists them under `output_modalities=decisions` (Jev, Reflex, d1 and others), and the catalog
carries their prices. The gate's threshold was set on Jev; run the gate benchmark before trusting
another one.

Memory follows the mind: unset, it uses her chat account, and her chat model while the two
accounts' providers match, as `modelFor` resolves it. Embeddings are app-wide, because every
persona's index and the memory collection share one vector space.

## Accounts

A role's `provider` setting names an account. Every provider has a default account under its own
id, so `LLM_PROVIDER=openai` and `mind.provider: openai` mean OpenAI's, and Settings → Providers
in the local app adds more, as many of one provider as there are keys: the second OpenAI account
is `openai-2`, and `mind.provider: openai-2` picks it. A persona picks an account per role in her
studio.

A default account is the one the environment configures, so a server needs no file:

| | Key | API base |
| --- | --- | --- |
| Default account | its variable (`OPENAI_API_KEY`), then its entry's `apiKey`, then the same variable in `credentials.json` | its variable (`OPENAI_BASE_URL`), then its entry's `baseUrl`, then `settings.yaml` where a row holds it (OpenRouter's and OpenAI's), then the provider's own |
| Added account | its entry's `apiKey` | its entry's `baseUrl`, then the provider's own |

A provider's own settings work the same way: MiniMax's group id is `MINIMAX_GROUP_ID` for the
default account and `options.groupId` in an entry. The entries live in `credentials.json`, under
`accounts` ([personas.md](personas.md#layers) has the file):

```json
{
  "accounts": {
    "openai": { "provider": "openai", "apiKey": "sk-…" },
    "openai-2": {
      "provider": "openai",
      "name": "OpenAI (work)",
      "apiKey": "sk-…",
      "baseUrl": "https://proxy.example.com/v1"
    },
    "minimax": { "provider": "minimax", "apiKey": "…", "options": { "groupId": "…" } }
  }
}
```

An id is lowercase letters, digits and dashes, and an entry under a provider's id must be that
provider's. Saving a default account's key in the app moves it out of the variable it was saved
under into the entry. `EMBED_API_KEY` with `EMBED_BASE_URL`, and rerank's and refine's, still move
one role alone, over its account's. Removing an account a settings file names is refused
(`account-in-use`) until no role names it.

Ollama takes no key and costs nothing; `openai-compatible` is any other server that speaks
OpenAI's chat or embeddings API, which needs an API base and has no default model, so naming it
means naming one.

## Model lists

The local app's model fields list what the account's provider offers now, from its API:
OpenRouter's public lists (chat, embeddings, rerankers, decision models and image models), the
`/models` of every OpenAI-compatible API (OpenAI's and Gemini's split by kind from the ids),
Anthropic's, Soniox's, ElevenLabs', Deepgram's and Cohere's. Cartesia and MiniMax have no
listing, and an account without a key, a refused key or a failed request leaves a plain field
with the reason under it. Any id typed is used as typed.

Fish Audio has no listing either, but its models are a closed set: its API reference names them
as the values of the `model` header, and a request naming any other runs on `s2.1-pro` without a
word. Its offer is `openModels: false`, so its field is a choice among the catalog's models,
which mirror that list; the key check in the app warns about an unknown one saved by hand. `GET /api/local/accounts/:id/models`
keeps a list for ten minutes, a failure for thirty seconds, and forgets an account's when the
account changes.

The catalog's models are not a picker's list. They carry prices (the providers' published
pay-as-you-go rates as of 2026-11-08), an embedding model's largest dimension, a model's call-time
fields and default models; a model the catalog doesn't know runs all the same, priced from the
response where the provider reports a cost, and unpriced elsewhere.

## Where a role's settings come from

The layers are the ones [personas.md](personas.md#layers) describes, with one rule
added: **a model or voice belongs to its provider.** An environment variable such as `LLM_MODEL`
belongs to the environment's `LLM_PROVIDER`; a persona whose `persona.yaml` picks an account of
another provider doesn't inherit it, and the local app shows the row as hers alone. Saving an
account of another provider in the app clears the model and voice that belonged to the old one;
two accounts of one provider share their models.

The variables that named a provider before roles had providers still work, but only while that
provider fills the role: `SONIOX_MODEL` (hearing), `OPENROUTER_MODEL` (mind), `FISH_MODEL` and
`FISH_VOICE_ID` (voice), `FISH_VOICE_ID_<STYLE>` (voice styles) and `SONIOX_ASYNC_MODEL`
(transcription). The neutral name wins where both are set. The Python bot reads only these.

One model can be reached two ways. Claude runs on an OpenRouter account as
`anthropic/claude-sonnet-5.5`, or on an Anthropic account as `claude-sonnet-5-5`. On OpenRouter
the response carries what the request cost; on a maker's API the catalog's price estimates it.

## Requests

- **Anthropic** goes through `AnthropicClient`: `x-api-key`, `anthropic-version`, prompt caching,
  and the server-side fallback beta with `fallbacks: "default"` on the models that offer one. It
  sends no `temperature`, `top_p` or `top_k`, which the current models refuse.
- **Every OpenAI-compatible chat API** goes through `OpenAIChatClient`, a fetch-based stand-in
  for the slice of the OpenAI SDK pipedog calls. A model's `live` fields in the catalog
  (`reasoning_effort`, `enable_thinking`) keep thinking low in a call, where the first word's
  latency is what the viewer hears. Gemini's API takes one system message, so later ones are sent
  as user messages, and recalled memories go as a `developer` message only to OpenAI's own API,
  as a user message everywhere else.
- **Both chat clients retry as the SDKs they replace did:** twice, on a dropped connection or a
  408, 409, 429 or 5xx, after the server's `retry-after` or a short backoff, and never once a
  reply has started streaming.
- **OpenAI's own API** gets `max_completion_tokens` for `max_tokens`, and no `temperature` or
  `top_p` for its reasoning models, which refuse them; OpenRouter makes that translation itself.
- **The rest** (embeddings, reranking, the decision API, image generation, memory extraction and
  refinement) post plain JSON with `fetch` and report what they used the same way.

## Speech without a WebSocket

Fish Audio, ElevenLabs, Cartesia and Soniox stream speech over a WebSocket that stays open for the
call; MiniMax and OpenAI answer one HTTP request per sentence (`transport` in the catalog). Both
kinds are supported, and both are interruptible: when the viewer talks over her, the pipeline
cancels the reply, which aborts a request in flight and drops the audio queued behind it, whatever
the transport. What an HTTP voice costs instead:

- a request's round trip before each sentence starts, rather than one connection's setup per call;
- no prosody carried across sentences, since each is synthesized alone;
- no word timestamps, which nothing in a call relies on today.

A provider whose API can neither stream nor be cancelled (one that returns a whole reply's audio
in one response) would hold an interrupted reply's audio until it arrived, and is better left out
of the catalog than added.

Delivery cues are the other difference between voices. Her prompt may teach Fish Drama 3's
`[…]` directions and paired tags; `stripMarkup` takes out what a model can't perform before it is
spoken (`markup` in the catalog says which a model reads), and the studio says so beside the
voice model.

## Realtime models

A realtime model hears, thinks and speaks in one session: OpenAI's `gpt-realtime` models and
xAI's Grok voice agent. `realtime.provider` turns one on for a persona, in place of the hearing,
mind and voice roles, which stop applying until it is turned off. It is experimental: the session
code is in `createRealtime` (`packages/runtime/src/session/services.ts`), but no call has been
made through it with a live key.

In the local app, the studio's Mind section opens with **How she talks**, a choice between three
models and a realtime provider. Choosing one swaps the three-model card for the realtime model and
voice, and lists what changes:

- she speaks in one of the realtime model's own voices, not the voice picked for her, and the
  Voice section says so;
- the delivery cues in her prompt aren't performed: `REALTIME_DELIVERY_LINE` tells her to put
  them in her voice instead;
- she can't switch voice styles, so the `change_voice_style` tool isn't offered;
- her facts, archive and memories reach the model from the transcript of what the viewer said,
  so they can trail a quick reply.

The model detects turns itself, so no local VAD runs beside it. Its key replaces the three call
keys in Settings and the wizard, and home's readiness drops the voice item.

## Usage and cost

Every request that spends money reports what it used (tokens in, cached and out, characters,
bytes, seconds of audio, images, searches) through `reportUsage`. A call, a job and an MCP request
each run inside `withUsageScope`, so the code that spends needn't know who asked. A record's cost
is, in order: what the provider's response says it billed (OpenRouter's `usage.cost`, the
decisions API's), else the catalog's list price for that model on that day, promotions included,
else the caller's own estimate, else none, and it is kept as `unpriced` with its usage.

`@eidolon/usage` keeps the records in SQLite, at `EIDOLON_USAGE_DB` or `<data home>/usage.db`, in
WAL mode with a busy timeout, because the bot, the local app and every job's CLI write to one file.
Each record carries the persona active in the process that spent it. A ledger that can't be opened
logs one warning and records nothing; a request never fails for it.

The local app's **Usage** page reads it through `GET /api/local/usage?from=&to=&persona=`: spend
per day or month stacked by provider, then tables by provider, by model and task, and by persona.
Estimated spend is marked `≈`, and the totals say how much of it is estimated and how many records
had no price. A provider keeps its color whatever the filter, from its place in the catalog among
every provider the ledger knows.

## Production

Nothing has to change. Every default reproduces the old behavior, and the provider-named
variables in production's `.env` keep working: they configure each provider's default account,
and a role that names a provider names that account. A second account of one provider is an entry
in the mounted data home's `credentials.json`, which the environment can't express. Two things are
worth doing:

- **Keep the provider-named variables while the Python rollback image exists.** It reads only
  those, so a role moved to another provider with the neutral names would roll back to the old
  defaults. Once Python is retired, `SONIOX_MODEL` can become `STT_MODEL`, and so on.
- **Give the ledger a writable path** if production's spend should be recorded. The mounted data
  home is read-only, so the default path logs a warning and records nothing. Point
  `EIDOLON_USAGE_DB` at a writable volume, such as the one holding `MEM0_HISTORY_DB_PATH`, and read
  it with `sqlite3`, or copy it over a local data home's `usage.db` for the Usage page.
