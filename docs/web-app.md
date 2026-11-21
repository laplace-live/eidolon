# The local web app

Eidolon on your own computer, with a web app to set it up, build personas, and call or text them: a
setup wizard, a persona studio (identity, prompt, voice, facts, videos, glossary, pictures), a call
page, text chats, the tasks she runs on this computer when asked in a chat or on a call in one,
settings, and the offline chain's commands run as jobs. It is a second entry
point beside the bot, `apps/bot/src/local/`, serving the built app from `apps/web/` (Vite, React,
shadcn, Tailwind) on loopback only. The bot that `bun run start` and the Docker image run never
loads it.

## Running it

```bash
bun install
bun run app        # builds apps/web/dist when it has no index.html, then `local --open`
```

| Command | What it runs |
| --- | --- |
| `bun run app` | `bun run build:web` when the app isn't built, then `bun run local --open` |
| `bun run local` | `apps/bot/src/local/main.ts`: the supervisor and the server under it. Without a build it exits 2 and names `bun run build:web` |
| `bun run dev:local` | `apps/bot/src/local/server.ts` alone, under `node --watch` |
| `bun run dev:web` | Vite on `http://127.0.0.1:5173`, proxying `/api` and `/mcp` to the server on `localhost:7860` |
| `bun run build:web` | `apps/web/dist` |

The server's flags: `--host` (default `localhost`; loopback addresses only), `--port` (default
7860; `0` picks a free one), `-v` (DEBUG; `-vv` TRACE; INFO without), and `--open`/`--no-open`
(default open, except over SSH, where `SSH_CONNECTION` is set). Its last boot line, written to
stdout and never through the logger, is the link that signs a browser in:

```text
Eidolon is ready: http://localhost:7860/#1762300800.Lb0Yx…
```

`bun run local` keeps the server in a child process. When the server exits 75, which is what
Restart in the app (`POST /api/local/restart`) does, the supervisor starts a new one on the same
port without opening another tab; that is how settings read once at boot take effect. It passes
SIGINT and SIGTERM on, and otherwise exits with the server's code. On Windows it passes nothing
on: the server shares its console, which gives every process in it Ctrl-C and the window's
closing, and a `kill()` there is TerminateProcess, which would end the server in the middle of its
own stop. A data home runs one server,
which holds a lock in its `locks/`: starting again on the port it serves prints a fresh link to it
and exits 0, and on any other port exits 2, naming its pid and port. A port another program holds
exits 1. Once it listens, the server adds its `port` and `host` to the lock's `.info`
(`locks/4273f434b594.info`, JSON beside its `pid`): `host` is the first loopback address it
bound, as a URL names it (`127.0.0.1`, `[::1]`). The desktop app attaches to a server it finds
there at that address alone, since another local account could hold the port on another loopback
address. A second start reads only the `port`: asked for that port, it probes `127.0.0.1` and
then `[::1]` for a server that proves it holds the token, and prints the link on its own `--host`.

`bun run dev:local` has no supervisor, so Restart stops it, and every reload `--watch` makes
opens another tab unless you pass `--no-open` (`bun run dev:local --no-open`). To work on the
app's pages with hot reload, keep the server on 7860, start `bun run dev:web`, and open
`http://127.0.0.1:5173/#<code>`, where `<code>` is everything after `#` in the server's link. The
proxy rewrites `Origin` only for requests from that dev origin, so the server's Origin rule still
refuses every other page.

### From the npm package

`npx @laplace.live/eidolon` runs the same app with no checkout. The package's launcher,
`bin/eidolon.mjs`, starts its bundles on the Node running it, with `EIDOLON_NO_DOTENV=1` and
`EIDOLON_APP_ROOT` set to the package; on a Node older than 24 it says so and exits.
`dist/app.js` and `dist/server.js` are the supervisor and the server, which serves `web/` in place
of `apps/web/dist`, and jobs run `dist/cli.js` in place of `apps/cli/src/main.ts`.
`eidolon <command>` runs an offline command the same way.

The launcher exits as its child does. A terminal's Ctrl-C reaches the child directly, and SIGTERM
or SIGHUP sent to the launcher reach it as SIGTERM. A SIGINT sent to the launcher's pid alone is
ignored, so that Ctrl-C reaches a running command once. A SIGTERM sent to the whole process group,
as `timeout` sends one, reaches the child twice, directly and through the launcher; a command
counts a second signal within half a second as the first, and only a later one makes it quit
without finishing an index. A tool that stops the app should send SIGTERM.

Windows has no SIGTERM to send and no process groups. Ctrl-C and closing the console window
reach the launcher, the supervisor and the server alike, and the first two wait for the server's
own stop; Windows ends them all some seconds after the window closes. A process the app spawns
without `detached` sits in its parent's job object, which ends it when the parent ends, however
it ends: killing the launcher takes the supervisor and the server with it, without their stop.
The launcher refuses to start without the Visual C++ runtime that LanceDB and onnxruntime-node
load (`VC_RUNTIME_DLLS`), and points to its installer.

## What stays out of production

- **Nothing in production imports it.** `main.ts` and the code it loads never import
  `apps/bot/src/local/`: a Biome rule forbids it and `apps/bot/test/local/boundaries.test.ts`
  follows `main.ts`'s import graph to prove it. `production.test.ts` pins what the bot answers
  without the local extension, the same as before it existed.
- **Nothing turns it on.** Local mode is the separate entry, not a flag, a setting or an
  environment variable, so no `settings.yaml` on a server's mounted data home can switch it on.
- **The image leaves it out.** `apps/bot/Dockerfile.dockerignore` excludes `apps/bot/src/local/`,
  `apps/bot/test/local/`, `apps/bot/scripts/local-smoke.ts` and `apps/web/` except its
  `package.json`, which the frozen install needs. `docker.yml` skips the image build for changes
  under `apps/web/**` and `apps/bot/src/local/**`.
- `local.viewerName` (`EIDOLON_LOCAL_VIEWER_NAME`) and `EIDOLON_LOCAL_ALLOWED_ORIGINS` are read in
  local mode only.
- **The app's chats stay out too.** Only `apps/bot/src/local` imports the JSONL chat store
  (`@eidolon/chat/jsonl`); the same Biome rule and `boundaries.test.ts` hold it. Production runs
  the turn engine only for its own chat endpoint, which keeps no transcripts and is off until
  `EIDOLON_CHAT_SECRET` is set ([chat.md](chat.md#production-the-browser-keeps-the-chat)). Until
  then, production's offer never binds a call to a chat, whatever its request data says, which
  `production.test.ts` pins.
- **So does the assistant.** Only `apps/bot/src/local` and `apps/cli` import `@eidolon/assistant`,
  which Biome and `boundaries.test.ts` hold, and production's chat endpoint never offers her task
  tools or the status block of her tasks ([assistant.md](assistant.md)).

## Security

A session runs programs as you (every job is the CLI, and downloads run yt-dlp), spends your
providers' credit, and can send your keys to whatever API base it saves. The checks below, and
the secret behind them, are the only boundary, so treat the link, the cookie, the proof and
`local-token` like a password for this computer.

- **Loopback only.** Every address `--host` resolves to must be loopback (127.0.0.0/8 or `::1`),
  or the server exits 2. There is no remote mode. From another computer, forward the port and open
  the printed link there:

  ```bash
  ssh -L 7860:localhost:7860 <host>
  ```

  Through the tunnel the browser still talks to `localhost`, which passes the Host check and is
  the secure context the microphone needs; SSH encrypts the rest.
- **The guard** runs before any route, on every request:
  - the socket's peer must be loopback; forwarded-for headers never count;
  - `Host` must be `localhost`, `127.0.0.1` or `[::1]` (or the bound IP literal) with the bound
    port, else 421 `misdirected`, which stops DNS rebinding;
  - every `OPTIONS` gets 405, and no answer carries a CORS header, except a listed origin's
    (below);
  - under `/api` and `/mcp`, an `Origin` other than `http://<Host>` gets 403, and so does a
    `Sec-Fetch-Site` other than `same-origin` or `none`, since every localhost port is the same
    site to a browser;
  - a change (any method but GET and HEAD) made with the cookie must carry `Origin`;
  - HEAD on a GET API route gets 405, and `/api/local` answers are `Cache-Control: no-store`.
- **Listed origins.** `EIDOLON_LOCAL_ALLOWED_ORIGINS`, comma-separated and read at boot, lets
  another site's pages, such as one built on `@laplace.live/eidolon-sdk` at
  `http://localhost:3000`, call the bot's API: `/api/ice-servers`, `/api/offer`,
  `/api/memories`, `/api/chat/*`, `/api/selfie` and `/mcp`, with their preflights answered and CORS
  headers on every answer. It gets them as a deployment serves them: an offer is a stranger's,
  within the anonymous quota, or a LAPLACE login's, and memories take a LAPLACE token, so the
  cookie that rides along never makes it the local viewer. `/api/local` stays the app's own, its
  chats and tasks included, and the app's own origin stays the local viewer's even when listed. An
  entry with no http(s) origin, `null` included, is ignored with a warning. While any origin is
  listed, a selfie also loads as an `<img>`, which sends no `Origin`, from any page: its
  unguessable id is the key, as on a deployment. Blank, the default, lists none.
- **The secret** is `<data home>/local-token`, made at the first start, mode 0600 from creation.
  The server refuses to start (exit 1) when it isn't a regular file, another user owns it, its
  mode lets other users in, or it holds no valid token. It never reaches a browser.
- **The link code** in the printed link's fragment is `<unix seconds>.<HMAC(secret, "link:" +
  seconds)>`: good for 10 minutes, survives restarts, and never reaches an access log or a
  `Referer`. The page trades it for the cookie and the proof once (`POST /api/local/session`) and
  removes it from the address bar. A refused code sets nothing, so a stale link never signs out a
  working session.
- **The cookie** is `eidolon_session_<port>=<HMAC(secret, "session")>; HttpOnly;
  SameSite=Strict; Path=/; Max-Age=2592000`, so the app stays signed in for 30 days across browser
  restarts. Every copy of it in the `Cookie` header is checked, because cookies ignore ports and
  another localhost app can plant a decoy. No token is ever read from a query string.
- **The proof.** Cookies ignore ports, so a service on any other localhost port receives the
  cookie with every request a page makes to it, and could replay it with a forged `Origin`. So
  `POST /api/local/session` also answers with a proof, `{"ok": true, "proof": "…"}`, where the
  proof is `HMAC(secret, "proof")`. The page keeps it in `localStorage` under
  `eidolon_proof_<port>`, which no page on another port can read, since storage is per origin, and
  sends it as `X-Eidolon-Proof` on every request under `/api`, `/api/offer` and `/api/memories`
  included. Every route that takes the session needs the cookie and the proof, compared as SHA-256
  digests in constant time; the cookie alone is 401 `proof-missing`, and the page shows the
  sign-in screen, which asks for the link. The two pictures the page shows as `<img>`, which can't
  send a header, take the cookie alone: a persona's avatar and her reference images, and only to
  read them. A Bearer token needs neither, and `/api/selfie/:id` stays gated by its own unguessable
  id.
- **Bearer.** A CLI or a test that can read `local-token` sends it as `Authorization: Bearer
  <secret>`; a header can't ride along on a cross-site request, so it needs no `Origin`:

  ```bash
  curl -H "Authorization: Bearer $(cat ~/.laplace/eidolon/local-token)" \
    http://localhost:7860/api/local/status
  ```

- **Rotation.** Delete `local-token` and restart: every browser, link, proof and Bearer caller is
  signed out, and the next start makes a new secret.
- **The app's own files** are read into memory from `apps/web/dist` once at boot. A request path
  is looked up in that map, never joined to a filesystem path; an unknown one gets `index.html`.
  Every page carries a strict `Content-Security-Policy` (`frame-ancestors 'none'`),
  `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: same-origin`.
- **What a request may name on disk.** Persona ids are slugs, `^[a-z0-9][a-z0-9_-]{0,63}$`; job
  ids are minted by the server and only looked up; a fact or picture name is one plain path
  segment with an allowed extension: `.txt` for a fact, `.png`, `.jpg`, `.jpeg` or `.webp` for an
  upload, and any image type the selfie tool reads for a picture listed, shown or deleted. Writes
  go only into the data home, never into a template under `personas/`, through a temporary file
  and a rename. Uploads are recognized by their bytes (PNG, JPEG, WebP) and capped at 20 MiB, and
  only a picture whose bytes are one of the three is served. A persona's path settings must stay
  inside her folder, and `sources.ytDlp` can't be set through the API.
- **Secrets at rest.** `credentials.json` is written 0600 from creation; no answer returns a key
  or quotes what a request sent; the data home, `jobs/`, `locks/` and `chats/` are created
  0700, and a chat's files 0600.

## The API

Under `/api/local`, JSON in and out; the wire types are `apps/bot/src/local/api.ts`, which the app
imports type-only. An error is `{"error": {"code": "…", "message": "…"}}`: the app shows its own
string for `code`, in English or 简体中文, and the English `message` only as detail. A 5xx's
message is fixed and never carries an exception's text or stack; it adds `"id"`, which names the
terminal's log line that holds what went wrong, and the app shows it beside the detail.

| Area | Routes | What |
| --- | --- | --- |
| Session | `POST session`, `GET session` | Trades a link code for the cookie and the proof; GET says whether the caller is signed in, or with `?probe=` proves this server holds the secret, for a second start |
| Status | `GET status`, `POST restart` | Readiness, polled by the home page and never waiting on a remote probe: the keys her call roles need, each role's provider and model or what is wrong with them, her voice, and `assistant: { enabled, ready, problem, running, search, kinds }`, Assistant Mode's state, why it isn't ready, how many tasks run, whether tasks can search the web (`{ on, problem }`), and why each kind of task runs on Assistant Mode's own model, if it does; restart is refused during a call, or while one is connecting |
| Settings | `GET settings?persona=`, `PUT settings` | Every `SETTINGS` row: the value the files give it and which file, the environment's value and the variable it comes from, and whether that overrides the file's, as only an app row's does (a persona's own value wins, and without one she inherits the environment's, a model or voice only while the environment's provider is hers); and her voice styles, with each one the environment sets and whether she inherits it, replaces it with one of hers, or ignores it while her voice isn't the environment's; PUT `{scope, persona?, values}` is checked by kind, a provider against the catalog, the time zone as an IANA zone, and written to `settings.yaml` or her `persona.yaml`; one that turns Assistant Mode off, as the environment and the file decide it, answers once every live task is cancelled |
| Accounts | `GET`, `POST accounts`, `PUT`, `DELETE accounts/:id`, `POST accounts/check`, `GET accounts/:id/models?category=` | Every provider account: `credentials.json`'s, and each provider's default that the environment configures or her calls need, with where its key comes from and never the key, its API base and settings, and which settings name it; a new one takes its provider's id while that is free, else `<provider>-2` and on; an API base is refused for a provider without a base variable; DELETE is refused while a settings file names it; the check asks the provider about a typed or the saved key, where the catalog says how: a free listing, never a model call; models lists what the provider's API offers now ([providers.md](providers.md#model-lists)) |
| Credentials | `GET`, `PUT credentials`, `POST credentials/check` | The secrets `credentials.json` keeps under variable names, `{NAME: {set, source}}`, never a value; the check is Qdrant's for the memory step and home |
| Personas | `GET`, `POST personas`, `PUT personas/active` | List, create (with a voice, the providers and models the active persona's `persona.yaml` sets for `hearing`, `mind`, `voice` and `knowledge.gate`, and a starter `prompt.md`), switch (refused during a call, or while one is connecting). A new persona's voice is her voice provider's: a Fish Audio voice id, or for another provider one line of text |
| Persona files | `GET`, `PUT personas/:id/{prompt,glossary,identity}` | Her copy in the data home, copied from the template on the first write; a glossary that doesn't parse isn't saved |
| Voice styles | `PUT personas/:id/voice-styles` | `{styles}`: all of hers, in order, each with a name of its own, a voice and a hint, replacing her `persona.yaml`'s `voice.styles`; answers as `GET settings` does. Any name her file can hold passes, since a save sends back those a hand-written file gave her; the studio names a new style with a lowercase letter, then letters, digits or `_`, never `default` |
| Pictures | `personas/:id/references/:kind/:name`, `personas/:id/avatar` | Outfits and friends under `references/`, and the avatar, `avatar.*` at the root of her folder, where selfies never take it for an outfit; a template's pictures can't be deleted |
| Knowledge | `personas/:id/facts[/:file]`, `GET personas/:id/index` | Fact files with whether the patterns pick them and whether they changed since the last index; the index from its build records |
| Videos | `POST personas/:id/batches` | `{urls}` → a new batch of the URLs her lists don't have yet |
| Voices | `GET voices/search?q=&language=&page=` | Fish Audio's public voices, searched without your key |
| Jobs | `POST jobs`, `GET jobs`, `GET jobs/:id`, `…/events?after=`, `…/log`, `DELETE jobs/:id`, `POST jobs/:id/resume` | [Jobs](#jobs) |
| Memories | `GET`, `DELETE memories?persona=` | One persona's memories of you |
| Usage | `GET usage?from=&to=&persona=` | The usage ledger's spend summed by day, persona, provider, task and model, every persona and provider it knows, and whether it records at all ([providers.md](providers.md#usage-and-cost)) |
| Chats | `GET`, `POST chats`, `GET`, `PATCH`, `DELETE chats/:id`, `POST chats/:id/messages`, `GET chats/:id/live`, `POST chats/:id/stop`, `POST chats/:id/participants`, `GET chats/:id/files/:name` | [Chats](#chats) |
| Tasks | `GET tasks?chat=`, `GET tasks/:id`, `GET tasks/:id/events?after=`, `POST tasks/:id/approve`, `POST tasks/:id/continue`, `DELETE tasks/:id` | The app's tasks, which she starts in a chat with `start_task`, and the answers and Stop of each one's card; no route starts, steers or deletes a task ([assistant.md](assistant.md#the-routes)) |
| Commands and MCP | `GET assistant/commands`, `DELETE assistant/commands/:id`, `GET mcp`, `PUT mcp/servers/:name` | The commands tasks run without asking, and taking one back; the MCP servers `mcp.json` gives tasks, never an `env` value or a secret, and turning one on or off or taking back a tool's Always, which only a card adds ([assistant.md](assistant.md#the-routes)) |

The bot's own routes stay, behind the guard: `POST /api/offer` and `/api/offer/preflight` take
the session and call as [the local viewer](#the-local-viewer-and-memory), with no quota;
`GET /api/memories` and `POST /api/memories/forget` take the session and act on the active
persona; `PATCH /api/offer`, `/api/selfie/:id`, `/api/ice-servers` and `/mcp` are unchanged. An
offer counts as a call from the moment it is admitted, before its session starts, so a persona
switch, a `persona` setting or a restart sent meanwhile is refused `call-active` too. An offer
whose `requestData` names a `chatId` and a `persona` calls her inside that chat, as herself,
whether or not she is the active persona ([chat.md](chat.md#calls)).

`ERROR_CODES` in `api.ts`:

| Code | Status | When |
| --- | --- | --- |
| `bad-json` | 400 | The body isn't JSON |
| `bad-request` | 400 | A body, query or path segment of the wrong shape: for a task, an id that isn't a lowercase UUID, an `after` that isn't a byte offset, a model `createMind` refuses, or an Always on a folder `assistant.folders` can't hold |
| `unauthorized` | 401 | No session and no Bearer token, or a link code that isn't this Eidolon's |
| `link-expired` | 401 | A link code over 10 minutes old |
| `proof-missing` | 401 | The session cookie without its `X-Eidolon-Proof`, or with a wrong one |
| `forbidden` | 403 | The guard: a peer off this computer, another page's `Origin` or `Sec-Fetch-Site`, a cookie change without `Origin` |
| `misdirected` | 421 | A `Host` other than a loopback name with the bound port |
| `not-found` | 404 | No such route, file or picture |
| `method-not-allowed` | 405 | Another method, any `OPTIONS`, HEAD on a GET route; `Allow` names the right one |
| `conflict` | 409 | A file that doesn't read as it should (`credentials.json`, a `persona.yaml`, a hand-made URL list, a `settings.yaml` an Always answer would write), a persona `EIDOLON_PERSONA` pins, a job an earlier server started |
| `payload-too-large` | 413 | A body or upload over its cap |
| `unsupported-media-type` | 415 | An upload that isn't one of the image or text types its route takes, by its bytes |
| `unavailable` | 503 | Memory is off or Qdrant doesn't answer; Fish Audio doesn't answer a voice search |
| `upstream-failed` | 502 | Mem0 or Fish Audio failed |
| `internal` | 500 | A bug; the server log's line with the answer's `id` has the details |
| `invalid-persona-id` | 400 | A persona id that isn't a slug |
| `unknown-persona` | 404, 400 | No persona has that id; 400 in a job's body |
| `persona-exists` | 409 | Creating a persona with an id in use |
| `call-active` | 409 | Switching persona or restarting during a call, or while one is connecting |
| `unknown-setting` | 400 | A path no setting of that scope has |
| `invalid-setting` | 400 | A value its setting's kind refuses, or a voice style without a name of its own or a voice |
| `read-only-setting` | 400 | `sources.ytDlp` |
| `invalid-path` | 400, 409 | A persona path that is absolute or leaves her folder; 409 when her saved `prompt` setting does |
| `unknown-credential` | 400 | A name `credentials.json` doesn't take |
| `unknown-account` | 404, 400 | No provider account has that id; 400 for a provider the catalog doesn't have, or an account a task's approval picks that Eidolon doesn't know |
| `account-in-use` | 409 | Removing an account a persona's or the install's settings name |
| `invalid-file-name` | 400 | A fact or picture name that isn't one plain segment with an allowed extension |
| `template-file` | 409 | Deleting a picture the template ships |
| `invalid-toml` | 400 | A glossary that doesn't parse |
| `invalid-url` | 400 | A link that isn't http(s), holds whitespace or a control character, or is over 2048 characters |
| `unknown-command` | 400, 404 | A job command outside `JOB_COMMANDS`; 404 for taking back a command no longer allowed for good |
| `invalid-option` | 400 | A job option the command doesn't take, of the wrong type, starting with `-`, or naming an unknown batch or video |
| `unknown-job` | 404 | No job has that id |
| `job-not-running` | 409 | Cancelling a job that ended |
| `job-not-resumable` | 409 | Resuming a running or succeeded job, or one resumed already |
| `unknown-chat` | 404 | No chat has that id |
| `missing-key` | 409 | Starting a chat, or sending in one, while her mind's provider takes a key and has none |
| `chat-in-call` | 409 | Sending a message or a voice message, deleting the chat, or calling into it while it is in a call |
| `assistant-off` | 409 | Answering a task's card while Assistant Mode is off; Stop and a Deny at its start still work |
| `assistant-not-ready` | 409 | Allowing a start, answering a path, a site, a command or an MCP call, or Continue while the assistant role lacks an account, a model or a key, or an assistant folder is or holds the home folder; the message is status' `assistant.problem` |
| `unknown-task` | 404 | No app task has that id, a `laplace-task` task's included |
| `task-locked` | 409 | Another process, such as `laplace-task`, holds the task |
| `nothing-pending` | 409 | Approving a task that waits for no answer, runs, or asks something other than the question the answer names |
| `not-paused` | 409 | Continuing a task that isn't paused or interrupted |
| `pending` | 409 | Continuing a task that waits for an answer |
| `range-not-satisfiable` | 416 | A task's events asked for from past the transcript's end |
| `unknown-mcp-server` | 404 | Changing a server `mcp.json` doesn't hold; the message never names what was sent |
| `invalid-mcp-config` | 409 | Changing `mcp.json` from Settings, or answering Always on an MCP call's card, while it doesn't parse |
| `linked-mcp-config` | 409 | The same, while `mcp.json` is a symbolic or hard link to another file, which a write would replace with a copy |

## The setup wizard

`/setup` runs five steps: keys, persona, voice, memory and done. While a key the active persona's
calls need is missing, every page but Settings sends you to its first.

- **Keys** picks an account for each role a call needs (who hears, thinks and speaks) and for the
  optional ones (embeddings, for every persona, and her retrieval gate's decision model), from each
  provider in the catalog that offers the role ([providers.md](providers.md#roles)), its default
  marked Recommended, and the other accounts Settings → Providers has. An OpenAI-compatible
  endpoint is listed once an account of it has an API base, and a pick with no default model asks
  for one. A role whose provider or model the environment sets is locked, naming the variable:
  the environment's model would go to whichever provider took the role. Then it asks for one key per account the picks name, and the accounts her reranking
  (unless turned off) and selfies (once she has an outfit) run on, saying what each is used for:
  an account a call's role uses is required; any other is optional and says what stays off without
  it. Ollama takes no key and MiniMax also takes its group id. Saving writes the picks to her
  `persona.yaml` and `embeddings.provider` to `settings.yaml`, clears the models and voice the
  replaced providers owned, asks before another embedding provider on an install that isn't new,
  then saves and checks every key. A persona on a realtime model is asked for its account's key in
  place of the three.
- **Persona** keeps the active persona, takes the demo, or creates one.
- **Voice** offers the voices of the provider she speaks through: Fish Audio's public library, one
  of OpenAI's fixed set, or for another provider the id of a voice in its library. A new persona
  starts on the active persona's providers, so hers is that persona's voice provider, as it is in
  **New Persona** outside the wizard.

## The local viewer and memory

Whoever holds the session is the local viewer: a logged-in viewer with UID 0, which no Bilibili
account has, so a Qdrant shared with production can't mix their memories with anyone's. Only a
valid cookie or Bearer token grants it, never a request body. Their name is `local.viewerName`,
read at every call, and the persona's prompt names them through `identity.localViewerLine`, which
has no UID. The anonymous quota doesn't apply.

Memories are kept per persona: Mem0's user id is `0`, and while `memory.agentId` is unset its
agent id is the active persona's id. That default is set in code, never written into a
`persona.yaml`, because production's milky-green memories carry no agent id. Home lists what the
active persona remembers and forgets it on request, through `GET` and
`DELETE /api/local/memories?persona=<id>`; other personas keep theirs.

Memory needs Qdrant; without it calls run without memory. The wizard's memory step
(`/setup?step=memory`) shows this command, which publishes on loopback only (Qdrant has no auth),
turns CORS off and keeps the data in a named volume:

```bash
docker run -d --name eidolon-qdrant --restart unless-stopped -p 127.0.0.1:6333:6333 \
  -v eidolon-qdrant:/qdrant/storage -e QDRANT__SERVICE__ENABLE_CORS=false \
  -e QDRANT__TELEMETRY_DISABLED=true qdrant/qdrant:v1.19.1
```

Keep the tag in step with `docker-compose.yml`'s; if compose's `qdrant` already answers on 6333,
use it instead. The step checks an address (127.0.0.1:6333 unless you change it) and saves it as
`memory.qdrant.host` and `memory.qdrant.port` only when Qdrant answers; once memory is on, an
edited address is checked and saved the same way. No address needs a restart: the next call opens
memory at the saved one.

## The layout

The app is a sidebar and the page beside it, as a desktop chat app is (`components/app-shell.tsx`
and `components/app-sidebar.tsx`, on shadcn's `Sidebar`):

- **The sidebar**, top to bottom: the logo, which leads home, and the button that collapses it;
  the persona calls reach, whose menu switches her and has **New Persona** and **Open the
  Studio**; **New Chat**; Home, Call, Studio, Tasks ([Tasks](#tasks)), Jobs and Usage; the chats
  ([Chats](#chats)), under a heading that leads to `/chats`; and at its foot Settings, the language
  and the theme.
- **Collapsed**, it keeps the icons and the chats' avatars, each named in a tooltip. The logo, its
  edge, and ⌘B on a Mac or Ctrl+B elsewhere toggle it, and the browser remembers which it was
  (`localStorage`'s `eidolon.sidebar.collapsed`).
- **On a phone**, below 768 px, it is a sheet, opened from the bar above each page or the button in
  a chat's or the call's header, and following a link in it closes it.
- **The page:** a chat, `/chats` and the call page fill the window beside it under their own
  headers; every other page scrolls in a column there, and the window itself never scrolls. A
  layout that sits side by side when wide, such as the studio's and Settings' sections, goes by the
  width it is given, through a container query, not the window's, which the sidebar shares.

## Chats

`/chats` talks with the personas, one or several at once, in text and voice messages or on a call
inside the chat, and keeps every chat in the data home (`<data home>/chats/`). The format, the
turn, the director, voice messages, calls and the API are in [chat.md](chat.md).

- **The page:**
  - The chats are in the sidebar ([The layout](#the-layout)), newest first, each with who it is
    with, its name, its last line and when, and the open chat fills the rest of the window, its
    lines in a centered column. With none open, `/chats` offers **New Chat**.
  - **The message box** floats at the foot of the column, with no bar behind it: the lines scroll
    under it and fade out above it, and the waiting bar, the call's dock and a reply that couldn't
    start stack above it. Under the text is a row: the chat's permission picker
    ([Tasks](#tasks)) or whom the line mentions, then **Stop** while a reply runs, and the
    microphone or **Send**. A press anywhere in the box off its buttons puts the caret in the text.
  - **New Chat**, in the sidebar or on `/chats`, ticks one to six personas, the active one listed
    first, then **Start Chat** or **Start Group Chat**. One persona's greeting then streams in, the
    way a call greets; a group starts quiet, named by the short names of whoever is in it until it
    is renamed.
  - A row and the chat's header each have a menu with **Rename** and **Delete**; a row's shows in
    place of its time while the pointer is over it or it has the keyboard's focus, and always on a
    touch screen. Delete confirms in the page. The header's menu also has **Chat Settings**, a
    sheet saved as soon as a value is picked: **Reply Mode** (Auto, Text or Voice), which overrides
    every persona's own until it is changed; **Task Display** (Focus, Normal or Verbose), how much
    of her tasks the chat shows ([Tasks](#tasks)), which until it is chosen names the display
    Settings gives it; **Task Permissions** (Ask for Approval, Approve for Me or Full Access), what
    her tasks there may do without asking ([Tasks](#tasks)), which until it is chosen names the
    level Settings gives it; and **Replies between Personas**, 0 to 6, the chain limit. Task
    Display shows in every chat, and is the one way to change it during a call.
- **Commands:** the composer runs `/focus`, `/normal`, `/verbose` and `/stop` typed alone, in any
  case, after `/` or `／` ([Tasks](#tasks)). A command is never sent to her: a display command
  stores the chat's display, with a toast, and starts no reply, and one for the display the chat
  has set already only says so. A known command with anything after it (`/stop 2`), or a slash and
  ASCII letters alone that name no command and no skill the list below offers (`/foo`), is refused
  with a toast, and the draft stays. Anything else that starts with a slash, a path, a slash before
  words or a skill's name, is a line like any other (`features/chats/commands.ts`).
- **The `/` list:** a `/` or `／` that starts the draft opens a list above the box: the commands,
  each with what it does, while nothing follows the slash word, since they run alone; then, in a
  chat of hers alone while Assistant Mode is on and ready, the owner's skills her `start_task` can
  name, each with its description (`nameableSkills`, from `GET skills`), less one named as a
  command. Typing narrows it to the names that begin with what follows the slash, then those that
  hold it. The arrow keys move through it, Enter runs a command or puts a skill in, Tab puts either
  in, a click is Enter, and Escape closes it. A skill goes in as `/name ` before what the draft
  says, so the line names it for her task ([assistant.md](assistant.md#skills)); a pick closes the
  list, as a mention's does. A slash anywhere else, a path's or a sentence's, opens nothing
  (`slashAt`, `features/chats/autocomplete.ts`).
- **A group chat:**
  - The header's avatars open **In This Chat**, with **Add Persona** and **Remove Persona**.
  - Each run of a persona's lines starts with her avatar and short name, and the streaming text
    and the thinking dots name whoever answers next, from the decision before her turn.
  - The composer offers the participants' names after `@` (arrow keys, Enter or Tab, Escape),
    inserting one `parseMentions` reads back: her short name, or her name when another
    participant answers to the short one too. A pick closes the list, so the next Enter sends, and
    a quiet line in the box names whom the message mentions.
  - **Stop** and the thinking dots stay up across the whole chain, while the director decides
    between turns.
  - A chain that ends with no one answering shows nothing more.
- **Why She Answered:** a quiet info button beside each reply the director chose opens
  **Why <name> Answered**, its decision: the source (mention, model or fallback), whose line she answered, and each persona's
  Addressed and Interested scores, with Invites a Reply.
- **Voice messages** ([chat.md](chat.md#voice-messages)):
  - **Recording:** while the text box is empty, a microphone takes the Send button's place.
    Holding it 350 ms or more records until it is let go, then sends; letting go off the button,
    Escape (unless it closes a menu or sheet) or the cancel button throws the take away. A shorter
    press is a click: it records until the next click, Enter or Space. A bar replaces the text box
    while it records, with its time out of 2:00, where it sends itself. A take under 0.5 s is
    dropped with a toast.
  - **What is recorded:** `audio/webm;codecs=opus`, else `audio/mp4` on Safari, sent to
    `POST voice` with the recorder's clock as `durationMs`.
  - **Without a hearing key** (`ChatContents.hearingRefusal`) or a browser that records, the
    microphone is disabled, with a tooltip linking to Settings → Providers. A take already
    recording can still be sent.
  - **The bubble:** play and pause, a seekable bar and the length, and the transcript folded under
    it, her cues as chips. Only one bubble plays at a time. The viewer's own shows **Transcribing…**
    until it is stored, then its transcript, or that no words could be heard in it; one the server
    refused stays, marked **Not sent**, with **Retry** sending the same recording again.
  - **Her voice replies** show **Recording a voice message…** while her voice speaks them, and
    play on their own, in order, when they answer a send from this tab while it has the focus.
    Pausing one, or playing another, stops the rest. One whose voice failed is text, marked
    **Sent as text**.
  - **Retry** after a failed reply sends a voice message's transcript as text.
- **Images and text files** ([chat.md](chat.md#the-viewers-files)):
  - **Adding one:** the paperclip in the message box's row picks images and text files, a paste of
    a copied image or file into the text adds it (a copied page's words still paste), and a drop
    anywhere on the chat adds what is dropped, under a **Drop to Attach** cover while it is dragged
    over. A call takes none.
  - **On its way:** each is sent to `POST files` at once, as it is (`use-draft-files.ts`), a text
    file as `text/plain`, and the server makes an image ready, upright, stripped and scaled, and
    checks a text file is UTF-8. It shows over the text, an image as a thumbnail and a text file by
    its name, with a spinner until it is kept and an × to take it out. One the server refuses is
    dropped with a toast saying why; past 8, the rest are left out with a toast to send them with
    the next message.
  - **Sending:** Enter or Send takes the words and the files, or the files alone, once every file is
    up; the microphone shows only while there are neither. The line shows its images and files above
    its words, each opening its file from the chat's `files/`, and **Retry** sends them again.
- **The studio's Chats section** edits a persona's `chat.replyMode`, `chat.interests` and
  `chat.talkativeness` ([personas.md](personas.md#personayaml)), showing where each value
  comes from. Her `chat.maxRounds`, **Rounds per Reply**, is in its Advanced card.
- **Her lines** render through the SDK's `parseMarkup` like a call's transcript: cues as chips and
  directions as small labels, never as HTML. A selfie shows as a photo, served from the chat's
  `files/`.
- **While she replies:**
  - Her words stream in, and a quiet line names the tool she is using, her task tools' included
    ([Tasks](#tasks)). Once a round of hers ends in a tool call, its words stay where she said
    them, as a line of hers above the tool's card, with no Why She Answered, and her next words
    stream in below it.
  - **Stop** cuts everyone off at once, even one finishing her message before a line just sent:
    what she said stays, marked **Interrupted**, and no line still waiting is answered.
  - Sending while she replies is allowed, and cuts no one off mid-sentence: a persona whose words
    have started streaming finishes her message, voice included, and the reply stops there; a
    reply still thinking or deciding who answers stops at once. Everyone chosen still answers:
    whoever an earlier line chose and hadn't answered goes first in the next reply, oldest line
    first, then whoever the new line chooses, each once. A line the director hadn't decided is
    decided again, and in a chat of one her next reply answers them all. A server restart forgets
    what it owes.
  - Each line sent shows below her words until it is stored, after the message she finishes, and
    one that fails stays, marked **Not sent**, with **Retry**.
  - A send supersedes the streams open before it once its own starts, with the viewer's stored
    line: until then the older one carries the words she is finishing, and after it only stores
    what it brings.
  - A selfie she was taking when Stop or a send stops her keeps rendering. Its quiet line stays,
    and the photo arrives later as a message of its own ([chat.md](chat.md#the-local-api)).
- **When a reply goes wrong:**
  - A failed reply shows its error with **Retry**, which sends the viewer's last line again.
  - A reply her provider stopped short, at its token limit or refusing, is marked **Cut off**, with
    the same **Retry**.
  - Neither offers **Retry** once that reply started a task: sending the line again would start
    another. A failure offers it only when no line of hers stands between it and the viewer's,
    her words before a tool call included; a reply cut off offers it past those words.
  - A mind with no key shows a notice with a link to Settings → Providers.
- **Reopening a chat mid-reply** picks the reply up again through `GET chats/:id/live`. The reply
  keeps running when the tab closes.
- **A call in the chat** ([chat.md](chat.md#calls)):
  - **Call** in the header calls her in a chat of one; in a group it opens **Who to Call**. She
    needn't be the active persona. It is disabled while the chat is in a call, by this page's word
    or by `ChatContents.call`.
  - **The dock** above the composer shows her avatar, ringed while she speaks, the call's state
    line, the call's notices, the mic's mute toggle and **Hang Up**. Hanging up closes it. A call
    that ends any other way stays docked with why, **Call Again** and **Close**.
  - **A group call** is answered as it connects, since no one greets on one: its state line never
    waits for an answer, and until the viewer speaks the log says everyone can hear them.
  - **The composer** waits, disabled and reading **In a call**, keeping any draft; Stop and the
    microphone are hidden, and a recording under way is thrown away. It takes the focus back when
    the call ends.
  - **What is said** shows as it is said, on the page that placed the call: below the call's start,
    the call's own transcript (`call-live.ts`) stands in for its stored lines, the viewer's words
    as they are heard and hers sentence by sentence as she says them, the rest dimmed until she
    has, with the thinking dots and the stuck notice of `/call`. The chat stores a line only once
    it is finished, her reply once all of it has played.
  - **What is stored** arrives through `GET chats/:id/live` as call lines, and takes the
    transcript's place once the call's end is stored after them: messages with a small phone mark,
    her cut-off ones marked **Interrupted**, with no Why She Answered, and her selfies as photos.
    The call's start and end are quiet centred lines, "Call with 奶绿 · 3:12" and "Call ended".
  - **Voice messages** stay quiet, since the microphone would hear them: a call starting pauses the
    one playing and drops those waiting to play on their own, and none plays on its own until the
    call ends. Play still plays one.
  - **Another tab** that learns of the call from `ChatContents.call`, as a refused send rereads it,
    follows it too, and gets its composer back when the call ends.
  - **Her tasks on a call,** in a chat of hers alone: she starts, checks, steers and stops them by
    voice ([assistant.md](assistant.md#calls)). The card of a task she starts on the call is stored
    at its place in the log, which while this page holds the call is under the call's separator,
    above its transcript, and among the call's lines once its end is stored. The waiting bar sits
    above the dock, with the card's buttons. A group call, a realtime one and `/call` have no
    tasks.
  - **Leaving the page,** or opening another chat, hangs up, as leaving `/call` does.
  - `/call` stays the standalone call to the active persona, with no chat.
- **Spend:** a chat's requests are recorded in the usage ledger with `source: "chat"`.

## Tasks

Assistant Mode's tasks ([assistant.md](assistant.md)) start only in a chat, or on a call in one:
the owner asks her, and she calls `start_task`. Everything a task asks of the owner is answered in
that chat. She answers how it is going herself, and checks, steers and stops it with her task
tools.

- **The task card** (`features/tasks/task-card.tsx`) sits in the chat's log at her `start_task`
  call, found by the call's `started` result:
  - the goal, a status badge, the folder, its kind (**Kind**: Quick, Coding or Research, absent
    for any other), the model and its account, and the spend against the next pause;
  - while it waits on the owner, its question, **Start this task?**, whether it may read or write
    outside its folders, or whether it may fetch from a site, with **Deny**, **Always Allow This
    Folder** (**Allow Any Site** for a site) and **Allow Once**. A path's question shows the path
    it asked for and what an Allow grants: "Allow Once lets this task read everything in
    <folder> until it ends" ("read and write" for a write), or "<path> alone" when the question
    names no folder. A request to read outside its folders, or to write a path granted alone,
    offers only **Deny** and **Allow Once**: every task may read and write in a folder Always
    Allow adds, and tasks start there without asking, which the card's write question says,
    naming that folder. Each answer names the question it answers. At a start the account and model (the role's
    picker, with a live listing) and the web access (**Ask for Each Site**, **Any Site**, **No
    Web**) can be changed first;
  - for a command, **Let it run this command?**: the command whole, in one bounded box that
    scrolls rather than cuts, its hidden and control characters spelled out (`\u{202E}`,
    `visibleCommand`, `labels.ts`), its size above it ("312 characters · 15 lines") and, while
    more of it is below what the box shows, a fade and a line saying so, since an overlay scrollbar
    shows only once the box is scrolled (`CommandText`, `parts.tsx`, as on the bar and in
    Allowed Commands); the folder it runs in; that a command runs as the owner with
    no sandbox; **Stops at** the time its timeout would stop it, counted from now; and what each
    answer grants. **Deny**, **Always in This Folder** and **Run Once**. When the owner allowed it
    for good but the task has read outside content (`granted`), the card says why it asks again;
  - for an MCP call, **Let it run <tool> on <server>?**: the server's hint, as the server's own
    claim; every argument, shortest first, with its size ("3,000 characters · 40 lines") and its
    head in a box, a cut head marked "…", and **Show All**, which reads the call from the task's
    transcript and shows each argument whole, escaped all the same; what each answer does, and,
    under No Web or once the task has read outside content, that tools always allowed ask again.
    **Deny**, **Always Allow This Tool** and **Run Once**;
  - when Approve for Me's review sent the question to the owner (`review`), a line naming why,
    such as "Approve for Me asks you: this could send data off this computer." (`REVIEW_TEXT`,
    `features/tasks/labels.ts`), above the question's details;
  - for a spend, stall or unpriced pause, or an interrupted task, **Continue**, with the spend
    pause's amount at a spend pause;
  - while it waits on the owner (awaiting approval, paused or interrupted), the lines she passed
    on with `steer_task` that it hasn't read, under "She passed these on, and it reads them first
    when it goes on:", each quoted as plain text, never Markdown or HTML, without her `The
    assistant updates the brief: ` prefix (`QueuedLines`, `parts.tsx`, over `queuedLines`,
    `state.ts`). They sit between the card's details and its question, so an Allow or a Continue
    covers them, and the waiting bar lists them too. The manager's own answer lines aren't listed,
    and a running task, which reads hers before its next request, lists none;
  - the plan, the latest step (the tool and the head of its argument) on the card of the chat's
    newest running task, and the files it wrote;
  - **In the Background**, while the task is live: each command running in the background on one
    line, how long it has run, and when its timeout stops it;
  - notes on MCP servers the task works without, and why, and on tools the limits left out;
  - **Show Steps**, the transcript, followed live while it runs and read once otherwise: the
    worker's words in Markdown-light, a row per tool call whose result folds out, errors marked,
    the lines it was told (hers with their prefix) and the runtime's notices (a command's end, with
    a terminal icon), pauses, compaction as a divider, and its end. A `bash` row's head starts
    with the command's `#id`, as `bash_output` and `bash_kill` name it; an MCP row reads
    `server · tool`, and a `skill` row `name · path`.
    Only the newest running task's card, and a card whose steps are open, follows
    `GET tasks/:id/events`: a follow holds one of the browser's six connections to the app while
    its task runs;
  - **Stop**, after a confirmation in the page, while it is live.
  - While Assistant Mode is off or not ready, Continue and every answer but a Deny at the start are
    disabled, as the server would refuse them, and a note says why, with a link to Settings; Stop
    still works.
- **The chat's display** ([assistant.md](assistant.md#display)) changes only what the page draws
  from the same events, and is set by the composer's commands or Chat Settings
  ([Chats](#chats)):
  - **Focus** leaves the cards out of the log (`displayedItems`, `features/chats/items.ts`), but
    for one Show Task or the Tasks list's `?task=` brings into view, which stays until the display
    changes. Her words before her calls and the waiting bar stay, and Retry still reads every item.
  - **Normal** is the card as above.
  - **Verbose** opens the steps of the newest running task's card by itself, on the follow it
    holds anyway. They stay shown through its pauses and its end while the page watched them, but
    close while it runs behind a newer running task, so the page follows one running task at most.
    A card read afresh keeps Show Steps, so a page never reads every ended task's transcript at
    once.
  - The owner's own Show Steps or Hide Steps holds until the display changes.
- **The chat's permission level** ([assistant.md](assistant.md#permission-levels)) is the picker
  in the composer, under the text, in a chat of hers alone while Assistant Mode is on
  (`features/chats/permissions-picker.tsx`): the level's icon and name, Full Access in the warning
  color, opening a menu of **Ask for Approval**, **Approve for Me** and **Full Access**, each with
  what it lets her tasks do, and, while the chat has none of its own, that it follows Settings.
  Chat Settings carries the same as **Task Permissions**, and Settings → Assistant Mode the app's.
  A pick is a `PATCH chats/:id` with `{ permissions }`; it stays usable during a call, when the
  composer takes nothing.
- **`/stop`** reads the chat's tasks afresh and opens a dialog of the live ones, newest first:
  **Stop this task?**, or **Stop which task?** with several, each row with its goal, its status
  and the card's **Stop**, and **Cancel**. A Stop closes it; with no live task, a toast says so
  (`features/tasks/stop-picker.tsx`).
- **The waiting bar** sits above the composer, in every display, while a task of the open chat
  waits on the owner: awaiting approval, paused or interrupted. It says what the oldest one waits
  for ("Waiting for your OK to work in ~/Git/x"; for a path, what an Allow grants: "Waiting for
  your OK to read everything in ~/Documents", "read and write" for a write, or the path alone;
  "Waiting for your OK to run a command in ~/Git/x", with the command in the card's box, shorter;
  "Waiting for your OK to run <tool> on <server>", with each argument's name and size) and how
  many more wait, with the card's buttons, which share the card's model, web access and
  spend-pause field, and **Show Task**, which scrolls to the card. Above its buttons it lists her
  queued lines as the card does, since its Allow or Continue lets the task read them too. During a
  call it sits above the dock. The Tasks list's waiting row says the same line.
- **Her task tools** show in the page's log only as `start_task`'s card. While one runs, her
  reply's quiet line reads **Starting a task…**, **Passing it on to the task…**, **Stopping the
  task…** or **Checking on the task…**, each with its icon (`TOOL_STATES`,
  `features/chats/labels.ts`).
- **Refresh:** once her log holds a `start_task` call, the chat page reads `GET tasks?chat=`, and
  polls it while a task is live, every 2 s while one runs and 5 s while one waits, so a line she
  passes on to a waiting task, and her stop, show at the next poll. When it sees a task end, it
  asks `GET live` every 2 s, reading the log again each time, until her report is in the log
  (`reportStored`, [assistant.md](assistant.md#calls)), or 60 s pass with no reply on the page; a
  cancelled `final` counts as her report, since it gets no turn, and so does a call's end that
  names it as told. Her report turn starts only once no reply runs in the chat, so the page
  doesn't ask while it carries a reply, and the 60 s count from the end of the last reply it
  carried. Her report turn streams in like any reply.
- **The Tasks list** (`/tasks`) is read-only: what she is working on and has done. A **Tasks** nav
  entry before Jobs, shown while Assistant Mode is on, counts the tasks waiting on the owner.
  - Live tasks come first, then ended ones, each newest first. A row has the goal, the status, her
    name and the chat's title (an untitled chat's day), the folder, its kind and the model, the
    spend and the age, and a waiting row says what it waits for.
  - A row opens `/chats/<id>?task=<task>`, which scrolls the card into view and rings it. A
    deleted chat's row reads **Chat deleted** and opens nothing.
  - There is no New Task, no button and no steps. While the mode is on but not ready, the problem
    shows above the rows, with **Open Settings**; while it is off, `/tasks` leads home.
  - The nav polls the list, every 2 s while a task runs, 5 s while one waits and 30 s otherwise.
- **Settings → Assistant Mode** holds the switch, the account and model (the role's picker),
  **Web Search Provider** and **Web Search Engine** ("Off: No Web Search" until an OpenRouter
  account is picked, then `exa`, with "Web search is off: …" while the chosen one can't search),
  the folders (full paths, never `/` or `~`; PUT settings also refuses, 400 `invalid-setting` with
  `GrantRefused`'s reason, any folder that is or holds home on disk, such as `/Users/<you>`,
  `/Users`, `~/.` or `~/..`), **Assistant Commands** (`assistant.bash`), the spend pause, the
  context and **Task Display**, the display each chat shows until it picks its own, says she starts
  tasks when asked in a chat, shows the problem while the mode isn't ready, and links to the Tasks
  list while it is on. Saving the switch off asks first while any task hasn't ended, counted from a
  fresh `GET tasks` ("2 tasks are running or waiting for you. Turning Assistant Mode off stops
  them."), and asks anyway when the list can't be read. Web Access's help on a start's card says a
  task may search without asking while search is on, and No Web's that each MCP call asks. Three
  cards follow it, whose buttons act at once:
  - **Models by Kind**: an account and model for quick, coding and research tasks, each "Same as
    Assistant Tasks" until set, and for a kind that falls back, why
    (`features/settings/assistant.tsx`);
  - **Allowed Commands**: each command allowed for good, escaped in its box with its size, with its
    folder and **Remove** (`commands-card.tsx`); the help says what sets the grants aside: a page
    fetched, a web search or an MCP call, never what a command downloads;
  - **MCP Servers**: "Only Add Programs You Trust", which says too that every task reads a
    server's tool descriptions and that, unlike a web page, they don't make a grant ask again;
    each server with its description and command line as `mcp.json` writes it, an **Enabled**
    switch, its **Always Allowed** tools as chips whose × takes one back ("Stop Always Allowing
    <tool>"), each `${NAME}` it needs that isn't set, and its problem; a switch or a chip is
    refused while `mcp.json` doesn't parse or is a link; a file that doesn't parse says no server
    starts until it is fixed; with none, where
    `mcp.json` goes and an example with `npx` and `docker run -i --rm --init` (`mcp-card.tsx`).
    The list is read again on focus, since the file is edited by hand.
- **Settings → Skills** (`skills-card.tsx`) lists the owner's skills from the data home's folder
  and the shared one, and the built-in ones ([assistant.md](assistant.md#skills)), searched by
  name, description or folder and filtered by source or by those switched off. A row has the name,
  its source as a badge (**Eidolon**, **Shared** or **Built In**), **Only When Named** for one that
  opts out of model use, its
  folder, the start of its description and its switch, and below, where a link leads, the skill of
  the same name that hides it (which has no switch), the catalog or her 150 names leaving it out,
  and its problems; the card warns once tasks' catalog is full, lists the `SKILL.md` files left
  out and why, and shows both folders in its footer. **Refresh** reads the folders again, as a
  focused tab does, and **Add Skill** writes a new one into the data home's folder from its name,
  description and instructions, checked as the server checks them (`new-skill-dialog.tsx`). A
  switch's or a new skill's answer replaces the list only after any read still under way is
  cancelled, so an older read can't put the old switches back.
- **Spend:** a task's requests are recorded with `source: "task"` and the task's id.

## Jobs

`POST /api/local/jobs` takes `{command, persona, options}`. Each command maps its typed options
to a fixed set of the CLI's flags; only the server adds `--persona`, a batch or a video is named
by id and looked up among her files, and an option the command doesn't take, or a string starting
with `-`, is refused. No request reaches `--yt-dlp-args`, a path flag, `--cookies`, `--force` or
`--clear-cache`.

| Command | Options | Runs |
| --- | --- | --- |
| `pipeline` | `batch`, `stages`, `abortOnError`, `transcribeConcurrency` (1–25) | `laplace-pipeline`; the batch is needed only with the download stage, the later stages take every video she has |
| `download` | `batch` | `laplace-download` over the batch |
| `expand` | `url` | `laplace-download --expand <url>`: one `entry` event per video a link lists |
| `transcribe` | `video`, `date` | one downloaded video without an upload date, as streamed on `date` |
| `refine`, `ingest-streams`, `ingest-facts`, `build-stream-catalog` | none | the command, for her |
| `plan` | `refresh` | `laplace-pipeline --dry-run` over every video she has |

A job is `node apps/cli/src/main.ts <command> --json …`, on the Node running the server
(`jobArgv` in `@eidolon/cli/job`), started in the data home, detached in its own process group,
so Ctrl-C in the terminal reaches only the server (on Windows, detached means without a console,
and outside the server's job, so a job outlives the server there too). Its files are in
`<data home>/jobs/` (0700): the record `<id>.json`, its stdout `<id>.ndjson` (the
[progress events](typescript.md#progress-events)) and its stderr `<id>.log`, both 0600. The
server tails the files, so a job outlives a reloaded page and the server itself. `GET jobs/:id`
is a snapshot reduced from the events (status, each stage's done and total, cost so far,
failures, the end of stderr, and whether the run's summary arrived); `events?after=<byte offset>`
streams the events from there; `log` is stderr, or its last MiB.

A job ends `succeeded` by its run's summary; `cancelled` when you stopped it; `interrupted` when
the server's own stop or restart stopped it, another signal did, or it ended while no server
watched; and `failed` when it died on its own.

- **Cancel and force stop.** `DELETE jobs/:id` saves why, then sends the CLI `STOP_MESSAGE` over
  its IPC channel, which the CLI takes as SIGTERM (`relayStopMessages`), since Windows has no
  SIGTERM to send: it starts nothing new, cancels what runs, and first finishes an index rebuild
  it is in, so a table is never left half built. The snapshot says `stopping` until it exits, and
  a repeat sends nothing, since a second stop makes the CLI quit at once.
  `DELETE jobs/:id?force=1` on a job already stopping kills it and what it started (`killTree`:
  its process group, or on Windows its tree through taskkill), which can leave an index without
  its table or its full-text index until the next ingest; the job page offers it as Force stop
  once a cancel has hung for 20 s. Nothing is killed on a timer. A job an earlier server started
  can't be stopped from here (409 `conflict`), since a server signals only the processes it
  spawned: its snapshot says `signalable: false`, and its page offers neither Cancel nor Force stop
  and says instead that it will finish on its own or be marked interrupted.
- **Interrupted and Resume.** Stopping the server asks its jobs to stop and kills none: one
  finishing an index rebuild runs on in its own process group (on Windows, as a detached process),
  and the next start watches it to its end. At a start, a record still `running` whose process is
  gone, or that began before the computer booted, ends as its events say, else `interrupted`.
  `POST jobs/:id/resume` reruns an interrupted, failed or cancelled job's request once, as a new
  job linked to it (`resumedFrom`, `resumedBy`); each stage skips the work already done.
- **Kept.** The newest 50 jobs. Plans and link previews (`plan`, `expand`) don't count: only the
  newest of each per persona is kept, and none survives a restart.
- **Plans** are cached per persona: a running or finished plan is answered again until a
  `pipeline`, `download`, `transcribe`, `refine` or `ingest-streams` job of hers ends, a batch is
  written, or a setting the plan reads (`PLAN_SETTINGS`: `transcription.model`, `refine.model`
  and `knowledge.index`) changes, in her files or the environment; `refresh: true` plans anew. A
  plan takes no lock. Saving one of those settings in the Videos tab asks for the plan again, and
  the paid run waits until the new plan is in.
- **Locks** are the CLI's, and the server never probes one: a job and a terminal run that need
  the same lock can't both run, and the second fails `locked`.

## The videos flow

The studio's Videos tab builds a persona's stream archive from links: a Bilibili series, a
YouTube playlist, or single videos. Personas speak Mandarin, and their videos should be Mandarin
streams; `transcription.language` sets the hint Soniox gets.

1. Each link runs an `expand` job, and its entries show as a preview: how many are new, their
   total length, and the disk their audio would take against the free space.
2. Confirming writes the new URLs as a batch (`POST personas/:id/batches`), in
   `<data home>/sources/<id>/lists/batches/`.
3. **Download**, which costs nothing: a `pipeline` job with `stages: ["download"]` over the batch.
   Before the first one the tab shows where yt-dlp reads cookies from
   (`sources.cookiesFromBrowser`, which the wizard sets to `none` on a new install).
4. A plan prices the rest: transcription and refinement, and what's left to index.
5. **The paid stages** run after you confirm, over every video of hers that still needs them,
   those in hand-made lists included, transcribing four at a time unless Advanced says otherwise.
   A video without an upload date waits for you to give the day it was streamed, which runs a
   `transcribe` job.

The table comes from the plan and follows the running job's item events as they arrive.

## Only the process environment: EIDOLON_NO_DOTENV

Both `load-env.ts` files, the server's and the CLI's, walk up from their folder to the first
`.env` and apply it over the environment. In a checkout inside another, that is the outer
checkout's `.env`; a git worktree without a `.env` of its own reads its main checkout's, wherever
the worktree lives. Either way it brings that checkout's keys and maybe its `EIDOLON_HOME`. `EIDOLON_NO_DOTENV=1`
skips it: the process environment is all there is, layered with the data home's settings files
as always ([personas.md](personas.md#layers)). Jobs inherit the environment the server started
with, the flag included, and the CLI's own `load-env.ts` applies the `.env` when the flag is
unset. Use it for smoke tests and clean runs:

```bash
EIDOLON_NO_DOTENV=1 EIDOLON_HOME=/tmp/eidolon-try bun run local
```

## Strings and languages

The app speaks English and 简体中文 (`zh-Hans`), through [Lingui](https://lingui.dev). Strings are
the English source text, written inline in its macros: `` t`Save` `` from `useLingui()` in a
component, `t` from `@lingui/core/macro` in other code, a `msg` descriptor for a label a code picks
(`ROLE_LABELS`, `COMMAND_LABELS`, a `*labels.ts` module beside the feature), and `<Trans>` for a
sentence with a link or `<code>` inside it. A label keyed by a union type (`Record<JobCommand, …>`)
fails to compile when the union grows without it.

`bun run i18n` (`lingui extract --clean`) writes every message into
`apps/web/src/locales/en.po` and `zh-Hans.po`; each new one then needs its `msgstr` in
`zh-Hans.po`, or it shows in English. A message's id is its English text, with any `context` that
sets two meanings of one word apart (`t({ message: "Done", context: "job status" })`), so a reworded
string loses its translation unless `zh-Hans.po` is changed with it. Nothing compiles the catalogs
by hand: the Vite plugin turns `.po` imports into one chunk per language, and `locales/i18n.ts`
loads the one in use before the first render. The language is the one the viewer last picked in
this browser (`localStorage`'s `eidolon.lang`), else the first Chinese or English entry in the
browser's languages, else English.

`src/locales/catalog.test.ts` checks that both catalogs hold the same messages, none obsolete, and
that every Chinese one has the English one's placeholders and tags.

In Chinese a task is 任务, a job is 作业, and Assistant Mode is 助手模式. A task's statuses come
from `STATUS_LABELS` in `features/tasks/labels.ts`, and its plan's **Plan** carries the context
`task plan`, apart from the jobs' Plan command. A task's kind is 类型 (**Kind**, its labels with the
context `task kind`), **Run Once** 运行一次, **Always in This Folder** 在这个文件夹里始终允许,
**Always Allow This Tool** 始终允许这个工具, **In the Background** 后台运行中, and "Stops at
{time}" reads "{time} 自动停止". The task card's copy of the bot's `STEER_PREFIX`
(`features/tasks/state.ts`) is typed by the bot's constant, so changing one fails typecheck until
the other follows.

The English capitalizes as laplace-chat's does. A short label is Title Case, with articles,
conjunctions and prepositions lowercased whatever their length and a phrasal verb's particle
capitalized: a button, a menu item, a heading, a setting's name, a tab or column label, an
`aria-label` (`Add Provider`, `Browser to Read Cookies From`, `Turn On Memory`). Everything else is
sentence case: tooltips, descriptions, toasts, placeholders, errors, statuses, and a heading phrased
as a sentence or a question (`Change the embedding model?`). `src/locales/title-case.test.ts` finds
every label by where it is written, through `apps/web/scripts/title-case.ts`: the elements and props
that take one, `label:` keys, and the `*_LABELS`, `*_TITLES` and `*_NAMES` maps, where an entry's
`body`, `help`, `hint`, `note` or `description` is prose (a map of sentences or statuses is named
otherwise: `EVENT_REASONS`, `OUTCOME_TEXT`). A heading phrased as a sentence with nothing in its
text to say so is listed in the test. A module whose test can't avoid
a macro stubs `@lingui/core/macro` with `src/test/lingui-macro.ts`, which gives the English text.

## The browser smoke test

`bun apps/bot/scripts/local-smoke.ts` (`--headful` to watch it; headless Chrome is killed on some
Macs) boots the server with `EIDOLON_NO_DOTENV=1`, a temporary data home and no provider key, and
walks the app in Chrome: `EIDOLON_CHROME` if it names a browser, else Google Chrome in
`/Applications` on macOS, and elsewhere the Chrome Playwright finds (its `chrome` channel).

- sign-in: the fragment removed, the cookie set, the proof in `localStorage` under the port's
  key and no other token in web storage; the cookie alone refused `proof-missing`, and taken with
  the proof;
- the wizard's keys step in English and 简体中文, with fake keys the providers refuse for free
  (`--offline` saves them without the checks); it finds each string by its English source text, in
  `zh-Hans.po` for the Chinese, so a string reworded without its catalog fails here;
- an OpenAI-compatible account for a fake embeddings server, added and checked in Settings →
  Providers, then picked for embeddings with a model from the server's own list;
- `credentials.json` at 0600, each key in its account, and no answer or log line holding a key;
- a saved prompt landing in the temporary home, with `personas/` byte-identical;
- an `ingest-facts` job over two fact lines against that server, with the model picked, and the
  jobs page showing it done;
- a text chat with milky-green, her mind pointed at that server's streaming `/chat/completions`:
  New Chat and her greeting, a reply that streams in with its cue as a chip, the history after a
  reload, a picture and a text file added with the paperclip, shown over the text, kept with
  `201`s and sent with a line, which reaches her mind as an image part and the file's text and
  shows both, and Rename and Delete from the chat's menus, with `chats/` at 0700 and its log at
  0600;
- a group chat with a second persona made from no template, the director's Decisions requests
  answered by that server through an OpenRouter account pointed at it (the text chat already
  asks it `voice_moment`): no greeting, an @-mention the composer completes, the second persona's
  answer with her stop sequences and the group line in her request, the first's answer to her a
  hop later, and each line under its persona's name, before and after a reload;
- voice messages, with milky-green's voice and hearing on an OpenAI account pointed at that
  server's `/audio/speech` and `/audio/transcriptions` (OpenAI-compatible accounts offer
  neither): the microphone held down through Chrome's fake microphone, which plays a WAV the walk
  writes, the upload heard as `voice.webm` and its transcript shown, her text answer, then
  **Voice** in the chat's settings, her voice reply spoken with its cue taken out, playing on its
  own to its end, its file answering the player's `Range` request with a `206`, both bubbles after
  a reload, and the voice and hearing spend in the ledger;
- a call inside a chat, on the same OpenAI account, whose realtime transcription session the
  server accepts and hears nothing on, and whose speech it answers as a call's PCM: a line typed
  first, then **Call**, the dock, her greeting answering that line from the call's history and
  landing in the log with its phone mark under its separator, the composer waiting and a send
  refused `chat-in-call`, then **Hang Up**, the log's `call-ended` with `hangup`, the separators
  with the call's length, the composer back, and no server error during the call;
- tasks in a new chat with milky-green, last, since her answers in a chat of one are offered
  `start_task` once the assistant has a model: Settings → Assistant Mode set to the OpenRouter
  account at that server and a model typed into its picker, and her greeting offered neither
  `start_task` nor its hint; then
  - a task she starts for the viewer's line, offered `start_task` and her hint but none of her
    other task tools, and her line after it, reading the started result
    `{"task": …, "status": "awaiting-approval"}`; the card and the waiting bar asking to start it;
    弄好了吗 before **Allow Once** on the card, offered all four of her task tools, after a status
    block saying it hasn't started and ending on the line that names them, and again while the
    worker's first request waits, the block saying it runs;
  - the worker, answered by that server turn by turn with usage blocks that carry a cost, writing
    `index.html` in the task's temporary folder, then reading `notes.txt` in a second one outside
    its grant, which pauses the task, the card and the waiting bar naming that second folder as
    what Allow Once grants;
  - at that question, 具体到哪了 after a block saying it asks to read outside its folders, and
    `check_task`'s detail: the card's question, `index.html` written, and the `read` step with the
    path's head, the whole path reaching her mind only in `tool` messages; then a change she passes
    on through `steer_task`, queued in the task's inbox with her prefix and listed on the card
    (`[data-queued] blockquote`) until **Allow Once** on the path question lets the run read it,
    ahead of the owner's answer;
  - the task done with its spend as reported, the page on disk and `assistant.folders` unchanged;
    **Show Steps**' rows, her line among the lines the task was told; her call's `final` in the
    log, then her report turn, asked by the runner's nudge and offered none of her task tools,
    reading the worker's report only in her call's `tool` message, the page showing it, and the
    task marked reported;
  - a second task she starts, then stops with `stop_task` before it was allowed, after a block
    that lists it alone, waiting to start: cancelled and not denied, its `final` after her answer
    and no turn telling of it, the waiting bar gone, and the card showing it stopped with no Stop;
  - the chat's display, each command storing one `settings` event and asking her mind nothing:
    `/verbose`; a third task she starts with words before her call, stored as its `said`, read on
    her call message by her next round, which ends on its result, and shown once, above its card,
    whose steps stay closed while it waits; `/focus`, leaving no card in the log while her words,
    the waiting bar and her status block stay; **Allow Once** on the bar, then `/verbose` again,
    opening the steps of its card alone while it runs; `/stop`'s dialog of that one task, its
    **Cancel** leaving it running, then its **Stop** cancelling it with no line of hers and no
    mind request, its steps still shown; `/stop` with nothing left; `/foo` and `/stop 2` refused
    with the draft kept; then `/focus`;
  - the Tasks list showing the first done and the second stopped, with no button or field, the
    first's row opening the chat with the card in view, in focus its card alone, until `/normal`
    brings every card back;
  - a call in that chat, whose greeting holds none of the status blocks the chat stored, and no
    task tool; a line its fake hearing hears (`say`), and her `start_task` for it, with the hint,
    her next round reading the started result, and her call and its result stored in the chat
    under the call's id, between the call's lines; the card, and the waiting bar above the dock,
    asking to start it; **Allow Once** on the bar, then her pointer to the card at the path
    question, answering the waiting nudge with no task tool and a block ending on the line for no
    tools; **Allow Once** again, then her word on the end on the call, answering the ended nudge
    with the worker's report only in her call's `tool` message; and after **Hang Up**, the call's
    lines and her call's events in order, no turn telling it again, the page on disk, and the
    Tasks list showing it done;
  - Models by Kind's Coding Task Model set to a second model at that server; a coding task she
    starts, her `start_task` schema requiring `profile`, whose card shows **Coding** and runs it on
    that model; its worker loading the owner's skill, written into the temporary home, from its
    prompt's catalog; then commands, each appending to a file in the task's folder: the first's
    card (the command in its box, padded with comment lines past what the box shows, with its size
    and, on the card and the bar, the line saying more is below, gone once the card's box is
    scrolled to its end; the folder, **Stops at**, **Deny**, **Always in This Folder** and **Run
    Once**, the waiting bar naming the folder, and her answer meanwhile after a block saying it
    asks to run a command) answered **Run Once**; the same command asking again,
    answered **Deny**, which `task.json` keeps; the next answered **Always in This Folder**, which
    `GET assistant/commands` lists, and run again unasked; online, a fetch of example.com allowed
    once, after which that command asks again with `granted` and the card says why; and a
    `sleep 20` that moves to the background, listed under **In the Background** and in her block
    while it runs, whose end's notice wakes the worker, who reads it with `bash_output`. **Show
    Steps** lists the skill, the commands and the notice; Settings' **Allowed Commands** lists the
    one allowed for good, whose **Remove** empties `allowed-commands.json`;
  - an `mcp.json` naming `packages/assistant/test/fixtures/mcp-server.mjs`, run on the smoke's
    Bun with `echo` its one tool: a task whose worker calls it twice, its card naming the tool, the
    server, the server's read-only hint and the argument with its size, answered **Run Once**, then
    **Always Allow This Tool**, which `mcp.json` keeps at 0600, the server's process gone once the
    task ends; a second task, called `other` and showing no kind, whose call runs unasked; then
    Settings' **MCP Servers** taking the Always back;
  - the chat's permission picker in its message box: **Approve for Me**, stored as the chat's
    `settings` event, under which a task outside `assistant.folders` starts with no card and
    runs the command its fake review allows, then asks about the one writing outside its folder,
    the card saying why, answered **Deny**; **Full Access**, in the warning color, her
    `start_task` description saying commands run unasked, under which a task starts and runs its
    command with no review and no pause; then **Ask for Approval** again;

then stops the server and deletes the home. It refuses to start when either `load-env.ts` would
apply a `.env` or use another data home, and exits 0 when every check passes, else 1, after the
server's last warnings.

### A real call: `--call`

`--call` calls the active persona from the call page itself, with real keys. It rebuilds the app,
leaves `EIDOLON_NO_DOTENV` unset so the server applies the `.env` above the checkout, and keeps the
temporary data home: it refuses to start when that `.env` sets `EIDOLON_HOME`, or puts
`MEM0_HISTORY_DB_PATH` outside the home, naming the variable and never its value. Chrome always
shows (with a fake, silent microphone) and plays the bot through the speakers. The persona must be
milky-green, whose template needs no index: recall is simply off. It checks:

- the call connecting, the greeting in the transcript, and the bot's audio playing;
- a typed question and its reply, text and audio;
- with `--selfie`, a same-origin `/api/selfie/` picture in its 3:4 box within 90 s;
- Fish markup shown as chips and notes, never as `[…]` or `<tag>`;
- no bot error, page error, console error or CSP violation, and the page showing the call ended
  after Hang up;

then prints the transcript and each turn's stages (LLM runs, tool calls, speech, audio, the
picture) timed from the turn's start. When the `.env`'s Qdrant answers, the call is remembered like
any other: as the local viewer's, for that persona.

**Which checks.** `--call` is paid and uses the real keys in the `.env`: about one short call to
Soniox, OpenRouter and Fish, and `--selfie` adds one image. Run it after changing the call page
(`apps/web/src/features/call`), the offer or ICE routes, or anything a call runs through, with
`--selfie` when selfies are involved. The walk without `--call` stays free; run it for everything
else.

## Troubleshooting

- **"The web app is not built"** (exit 2): `bun run build:web`, or start with `bun run app`.
- **The page asks you to open Eidolon from your terminal**: the link is over 10 minutes old, or
  the cookie or the proof is gone (cleared site data, another browser profile). Run the same
  command again: a running Eidolon prints a fresh link and exits. Pasting the link into that page
  works too.
- **421**: the app was opened through a name other than `localhost`, `127.0.0.1` or `[::1]`, or
  another port. From another computer, use `ssh -L`.
- **403 "Only Eidolon's own pages … may call its API"**: the request came from another page, such
  as a browser extension, another app on localhost, or `dev:web` talking to a server not on 7860.
  A site built on `@laplace.live/eidolon-sdk` needs its origin in `EIDOLON_LOCAL_ALLOWED_ORIGINS`,
  then a restart ([listed origins](#security)).
- **"local-token is readable by other users"** (exit 1): `chmod 600` it, or delete it to sign
  everything out and make a new one.
- **"port 7860 is taken by another program"** (exit 1): pass `--port`.
- **"Eidolon is already running on this data home"** (exit 2): another start serves it, on the
  port the message names. Use that one, or stop it first.
- **Keys, or a data home, you didn't expect**: a `.env` further up was applied. Set
  `EIDOLON_NO_DOTENV=1`.
- **Memory is off, or 503 `unavailable`**: Qdrant isn't set or doesn't answer; start it with the
  command above and check it in the wizard's memory step.
- **A restart banner**: a saved value is read only at boot. Restart from Home or Settings; it is
  refused during a call, or while one is connecting, and it interrupts running jobs, after asking.
  Setting the value back doesn't clear it: a call may have read the changed one.
- **A job reads `interrupted`**: the server stopped or restarted while it ran. Resume it from its
  page.
- **A task reads `interrupted`**: the server stopped while it ran. The next start resumes it while
  Assistant Mode is on and ready; otherwise press **Continue** on its card in the chat.
- **She says she can't use the computer, or never offers a task**: Assistant Mode is off or not
  ready (Settings → Assistant Mode says why), or the chat holds more than her, or the call is a
  realtime or group call.
- **A cancelled job stays `stopping`**: it is finishing an index rebuild, which can take a while
  on a large archive. Wait, or Force stop it and run that ingest again. A job an earlier start
  of Eidolon ran has no Force stop: it will finish on its own or be marked interrupted.
