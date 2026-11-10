# The local web app

Eidolon on your own computer, with a web app to set it up, build personas, and call or text them: a
setup wizard, a persona studio (identity, prompt, voice, facts, videos, glossary, pictures), a call
page, text chats, settings, and the offline chain's commands run as jobs. It is a second entry
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
| `bun run dev:local` | `apps/bot/src/local/server.ts` alone, under `bun --watch` |
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
SIGINT and SIGTERM on, and otherwise exits with the server's code. A data home runs one server,
which holds a lock in its `locks/`: starting again on the port it serves prints a fresh link to it
and exits 0, and on any other port exits 2, naming its pid and port. A port another program holds
exits 1.

`bun run dev:local` has no supervisor, so Restart stops it, and every reload `--watch` makes
opens another tab unless you pass `--no-open` (`bun run dev:local --no-open`). To work on the
app's pages with hot reload, keep the server on 7860, start `bun run dev:web`, and open
`http://127.0.0.1:5173/#<code>`, where `<code>` is everything after `#` in the server's link. The
proxy rewrites `Origin` only for requests from that dev origin, so the server's Origin rule still
refuses every other page.

### From the npm package

`npx @laplace.live/eidolon` runs the same app with no checkout. The package's launcher,
`bin/eidolon.mjs`, starts its bundles on the Bun it installs, with `EIDOLON_NO_DOTENV=1` and
`EIDOLON_APP_ROOT` set to the package. `dist/app.js` and `dist/server.js` are the supervisor and
the server, which serves `web/` in place of `apps/web/dist`, and jobs run `dist/cli.js` in place of
`apps/cli/src/main.ts`. `eidolon <command>` runs an offline command the same way.

The launcher exits as Bun does. A terminal's Ctrl-C reaches Bun directly, and SIGTERM or SIGHUP
sent to the launcher reach it as SIGTERM. A SIGINT sent to the launcher's pid alone is ignored,
so that Ctrl-C reaches a running command once. A SIGTERM sent to the whole process group, as
`timeout` sends one, reaches Bun twice, directly and through the launcher; a command counts a
second signal within half a second as the first, and only a later one makes it quit without
finishing an index. A tool that stops the app should send SIGTERM.

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
- `local.viewerName` (`EIDOLON_LOCAL_VIEWER_NAME`) is read in local mode only.
- **Chats stay out too.** Only `apps/bot/src/local` imports the turn engine (`@eidolon/engine`) and
  the JSONL chat store (`@eidolon/chat/jsonl`); the same Biome rule and `boundaries.test.ts` hold
  it. Production's offer never binds a call to a chat, whatever its request data says, which
  `production.test.ts` pins.

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
  - every `OPTIONS` gets 405, and no answer carries a CORS header;
  - under `/api` and `/mcp`, an `Origin` other than `http://<Host>` gets 403, and so does a
    `Sec-Fetch-Site` other than `same-origin` or `none`, since every localhost port is the same
    site to a browser;
  - a change (any method but GET and HEAD) made with the cookie must carry `Origin`;
  - HEAD on a GET API route gets 405, and `/api/local` answers are `Cache-Control: no-store`.
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
| Status | `GET status`, `POST restart` | Readiness, polled by the home page and never waiting on a remote probe: the keys her call roles need, each role's provider and model or what is wrong with them, her voice; restart is refused during a call, or while one is connecting |
| Settings | `GET settings?persona=`, `PUT settings` | Every `SETTINGS` row: the value the files give it and which file, the environment's value and the variable it comes from, and whether that overrides the file's, as only an app row's does (a persona's own value wins, and without one she inherits the environment's, a model or voice only while the environment's provider is hers); PUT `{scope, persona?, values}` is checked by kind, a provider against the catalog, the time zone as an IANA zone, and written to `settings.yaml` or her `persona.yaml` |
| Accounts | `GET`, `POST accounts`, `PUT`, `DELETE accounts/:id`, `POST accounts/check`, `GET accounts/:id/models?category=` | Every provider account: `credentials.json`'s, and each provider's default that the environment configures or her calls need, with where its key comes from and never the key, its API base and settings, and which settings name it; a new one takes its provider's id while that is free, else `<provider>-2` and on; an API base is refused for a provider without a base variable; DELETE is refused while a settings file names it; the check asks the provider about a typed or the saved key, where the catalog says how: a free listing, never a model call; models lists what the provider's API offers now ([providers.md](providers.md#model-lists)) |
| Credentials | `GET`, `PUT credentials`, `POST credentials/check` | The secrets `credentials.json` keeps under variable names, `{NAME: {set, source}}`, never a value; the check is Qdrant's for the memory step and home |
| Personas | `GET`, `POST personas`, `PUT personas/active` | List, create (with a voice and a starter `prompt.md`), switch (refused during a call, or while one is connecting) |
| Persona files | `GET`, `PUT personas/:id/{prompt,glossary,identity}` | Her copy in the data home, copied from the template on the first write; a glossary that doesn't parse isn't saved |
| Pictures | `personas/:id/references/:kind/:name`, `personas/:id/avatar` | Outfits and friends under `references/`, and the avatar, `avatar.*` at the root of her folder, where selfies never take it for an outfit; a template's pictures can't be deleted |
| Knowledge | `personas/:id/facts[/:file]`, `GET personas/:id/index` | Fact files with whether the patterns pick them and whether they changed since the last index; the index from its build records |
| Videos | `POST personas/:id/batches` | `{urls}` → a new batch of the URLs her lists don't have yet |
| Voices | `GET voices/search?q=&language=&page=` | Fish Audio's public voices, searched without your key |
| Jobs | `POST jobs`, `GET jobs`, `GET jobs/:id`, `…/events?after=`, `…/log`, `DELETE jobs/:id`, `POST jobs/:id/resume` | [Jobs](#jobs) |
| Memories | `GET`, `DELETE memories?persona=` | One persona's memories of you |
| Usage | `GET usage?from=&to=&persona=` | The usage ledger's spend summed by day, persona, provider, task and model, every persona and provider it knows, and whether it records at all ([providers.md](providers.md#usage-and-cost)) |
| Chats | `GET`, `POST chats`, `GET`, `PATCH`, `DELETE chats/:id`, `POST chats/:id/messages`, `GET chats/:id/live`, `POST chats/:id/stop`, `POST chats/:id/participants`, `GET chats/:id/files/:name` | [Chats](#chats) |

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
| `bad-request` | 400 | A body, query or path segment of the wrong shape |
| `unauthorized` | 401 | No session and no Bearer token, or a link code that isn't this Eidolon's |
| `link-expired` | 401 | A link code over 10 minutes old |
| `proof-missing` | 401 | The session cookie without its `X-Eidolon-Proof`, or with a wrong one |
| `forbidden` | 403 | The guard: a peer off this computer, another page's `Origin` or `Sec-Fetch-Site`, a cookie change without `Origin` |
| `misdirected` | 421 | A `Host` other than a loopback name with the bound port |
| `not-found` | 404 | No such route, file or picture |
| `method-not-allowed` | 405 | Another method, any `OPTIONS`, HEAD on a GET route; `Allow` names the right one |
| `conflict` | 409 | A file that doesn't read as it should (`credentials.json`, a `persona.yaml`, a hand-made URL list), a persona `EIDOLON_PERSONA` pins, a job an earlier server started |
| `payload-too-large` | 413 | A body or upload over its cap |
| `unsupported-media-type` | 415 | An upload that isn't PNG, JPEG or WebP by its bytes |
| `unavailable` | 503 | Memory is off or Qdrant doesn't answer; Fish Audio doesn't answer a voice search |
| `upstream-failed` | 502 | Mem0 or Fish Audio failed |
| `internal` | 500 | A bug; the terminal's line with the answer's `id` has the details |
| `invalid-persona-id` | 400 | A persona id that isn't a slug |
| `unknown-persona` | 404, 400 | No persona has that id; 400 in a job's body |
| `persona-exists` | 409 | Creating a persona with an id in use |
| `call-active` | 409 | Switching persona or restarting during a call, or while one is connecting |
| `unknown-setting` | 400 | A path no setting of that scope has |
| `invalid-setting` | 400 | A value its setting's kind refuses |
| `read-only-setting` | 400 | `sources.ytDlp` |
| `invalid-path` | 400, 409 | A persona path that is absolute or leaves her folder; 409 when her saved `prompt` setting does |
| `unknown-credential` | 400 | A name `credentials.json` doesn't take |
| `unknown-account` | 404, 400 | No provider account has that id; 400 for a provider the catalog doesn't have |
| `account-in-use` | 409 | Removing an account a persona's or the install's settings name |
| `invalid-file-name` | 400 | A fact or picture name that isn't one plain segment with an allowed extension |
| `template-file` | 409 | Deleting a picture the template ships |
| `invalid-toml` | 400 | A glossary that doesn't parse |
| `invalid-url` | 400 | A link that isn't http(s), holds whitespace or a control character, or is over 2048 characters |
| `unknown-command` | 400 | A job command outside `JOB_COMMANDS` |
| `invalid-option` | 400 | A job option the command doesn't take, of the wrong type, starting with `-`, or naming an unknown batch or video |
| `unknown-job` | 404 | No job has that id |
| `job-not-running` | 409 | Cancelling a job that ended |
| `job-not-resumable` | 409 | Resuming a running or succeeded job, or one resumed already |
| `unknown-chat` | 404 | No chat has that id |
| `missing-key` | 409 | Starting a chat, or sending in one, while her mind's provider takes a key and has none |
| `chat-in-call` | 409 | Sending a message or a voice message, deleting the chat, or calling into it while it is in a call |

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

## Chats

`/chats` talks with the personas, one or several at once, in text and voice messages or on a call
inside the chat, and keeps every chat in the data home (`<data home>/chats/`). The format, the
turn, the director, voice messages, calls and the API are in [chat.md](chat.md).

- **The page:**
  - The list of chats is on the left, newest first, and the open chat on the right. On a phone the
    list is the page until a chat opens, and a sheet after.
  - **New Chat** ticks one to six personas, the active one listed first, then **Start Chat** or
    **Start Group Chat**. One persona's greeting then streams in, the way a call greets; a group
    starts quiet, named by the short names of whoever is in it until it is renamed.
  - A row and the chat's header each have a menu with **Rename** and **Delete**. Delete confirms in
    the page. The header's menu also has **Chat Settings**, a sheet saved as soon as a value is
    picked: **Reply Mode** (Auto, Text or Voice), which overrides every persona's own until it is
    changed, and **Replies between Personas**, 0 to 6, the chain limit.
- **A group chat:**
  - The header's avatars open **In This Chat**, with **Add Persona** and **Remove Persona**.
  - Each run of a persona's lines starts with her avatar and short name, and the streaming text
    and the thinking dots name whoever answers next, from the decision before her turn.
  - The composer offers the participants' names after `@` (arrow keys, Enter or Tab, Escape),
    inserting one `parseMentions` reads back: her short name, or her name when another
    participant answers to the short one too. A pick closes the list, so the next Enter sends, and
    a quiet line names whom the message mentions.
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
- **The studio's Chats section** edits a persona's `chat.replyMode`, `chat.interests` and
  `chat.talkativeness` ([personas.md](personas.md#personayaml)), showing where each value
  comes from.
- **Her lines** render through `lib/markup.ts` like a call's transcript: cues as chips and
  directions as small labels, never as HTML. A selfie shows as a photo, served from the chat's
  `files/`.
- **While she replies:**
  - Her words stream in, and a quiet line names the tool she is using.
  - **Stop** ends the reply, and what she said stays, marked **Interrupted**.
  - Sending while she replies is allowed: the server stops her first. Each line sent shows until
    it is stored, and one that fails stays, marked **Not sent**, with **Retry**.
  - A send supersedes the streams open before it: its own carries her reply from its start, so
    the older ones only store what they bring.
  - A selfie she was taking keeps rendering through either. Its quiet line stays, and the photo
    arrives later as a message of its own ([chat.md](chat.md#the-local-api)).
- **When a reply goes wrong:**
  - A failed reply shows its error with **Retry**, which sends the viewer's last line again.
  - A reply her provider stopped short, at its token limit or refusing, is marked **Cut off**, with
    the same **Retry**.
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
  - **The composer** waits, disabled and reading **In a call**, keeping any draft; Stop and the
    microphone are hidden, and a recording under way is thrown away. It takes the focus back when
    the call ends.
  - **What is said** arrives through `GET chats/:id/live` as call lines: messages with a small
    phone mark, her cut-off ones marked **Interrupted**, with no Why She Answered. The call's start
    and end are quiet centred lines, "Call with 奶绿 · 3:12" and "Call ended".
  - **Another tab** that learns of the call from `ChatContents.call`, as a refused send rereads it,
    follows it too, and gets its composer back when the call ends.
  - **Leaving the page,** or opening another chat, hangs up, as leaving `/call` does.
  - `/call` stays the standalone call to the active persona, with no chat.
- **Spend:** a chat's requests are recorded in the usage ledger with `source: "chat"`.

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

A job is `bun --no-env-file apps/cli/src/main.ts <command> --json …` (`jobArgv` in
`@eidolon/cli/job`), started in the data home, detached in its own process group, so Ctrl-C in the
terminal reaches only the server. Its files are in `<data home>/jobs/` (0700): the record
`<id>.json`, its stdout `<id>.ndjson` (the [progress events](typescript.md#progress-events)) and
its stderr `<id>.log`, both 0600. The server tails the files, so a job outlives a reloaded page and
the server itself. `GET jobs/:id` is a snapshot reduced from the events (status, each stage's
done and total, cost so far, failures, the end of stderr, and whether the run's summary arrived);
`events?after=<byte offset>` streams the events from there; `log` is stderr, or its last MiB.

A job ends `succeeded` by its run's summary; `cancelled` when you stopped it; `interrupted` when
the server's own stop or restart stopped it, another signal did, or it ended while no server
watched; and `failed` when it died on its own.

- **Cancel and force stop.** `DELETE jobs/:id` saves why, then sends the CLI one SIGTERM: it
  starts nothing new, cancels what runs, and first finishes an index rebuild it is in, so a table
  is never left half built. The snapshot says `stopping` until it exits, and a repeat sends
  nothing, since a second SIGTERM makes the CLI quit at once. `DELETE jobs/:id?force=1` on a job
  already stopping kills its whole process group, which can leave an index without its table or
  its full-text index until the next ingest; the job page offers it as Force stop once a cancel
  has hung for 20 s. Nothing is killed on a timer. A job an earlier server started can't be
  stopped from here (409 `conflict`), since a server signals only the processes it spawned: its
  snapshot says `signalable: false`, and its page offers neither Cancel nor Force stop and says
  instead that it will finish on its own or be marked interrupted.
- **Interrupted and Resume.** Stopping the server sends its jobs SIGTERM and kills none: one
  finishing an index rebuild runs on in its own process group, and the next start watches it to
  its end. At a start, a record still `running` whose process is gone, or that began before the
  computer booted, ends as its events say, else `interrupted`. `POST jobs/:id/resume` reruns an
  interrupted, failed or cancelled job's request once, as a new job linked to it (`resumedFrom`,
  `resumedBy`); each stage skips the work already done.
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
  reload, and Rename and Delete from the chat's menus, with `chats/` at 0700 and its log at 0600;
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
- **403 "Only Eidolon's own pages may call its API"**: the request came from another page, such
  as a browser extension, another app on localhost, or `dev:web` talking to a server not on 7860.
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
- **A cancelled job stays `stopping`**: it is finishing an index rebuild, which can take a while
  on a large archive. Wait, or Force stop it and run that ingest again. A job an earlier start
  of Eidolon ran has no Force stop: it will finish on its own or be marked interrupted.
