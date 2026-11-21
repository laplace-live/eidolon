# The desktop app

Eidolon, the desktop app (`apps/desktop`, the private package `laplace-eidolon-desktop`), is the
local app in a window that starts its own backend, on macOS (Apple silicon) and Windows (x64): no
terminal, no Node or Bun to install, and no link to sign in with. The window shows `apps/web` as it
is, served by the same local server `bun run app` and `npx @laplace.live/eidolon` run, in local
mode only, so production never sees it. Electron's own binary runs that server as Node, so the app
ships no other runtime. It has no release yet: `bun run package:desktop` builds it unsigned, and
signing, updates and releases come later.

```text
Eidolon (main process)
 ├─ the single-instance lock: a second launch shows the window, or quits the app with --quit
 ├─ the environment: the login shell's on macOS, the launch's on Windows
 ├─ the data home: EIDOLON_HOME, else ~/.laplace/eidolon
 ├─ the backend controller, one attempt at a time
 │    ├─ attach: locks/4273f434b594.info names a live server that proves it holds local-token
 │    └─ spawn:  <app binary> --disable-sigusr1 --use-system-ca <payload>/dist/server.js
 │                 --host 127.0.0.1 --port 7860 --no-open      (--port 0 when 7860 is taken)
 ├─ the eidolon-app: scheme
 │    ├─ shell/  the loading and failure pages
 │    └─ app/    forwarded to the backend, with the Bearer only main holds
 └─ the window at eidolon-app://app/: sandboxed, with the preload's bridge
```

```text
apps/desktop/
  electron-builder.yml   the packaging config: fuses, targets, the payload as an extra resource
  resources/             build resources: entitlements, installer.nsh, the icon, and the designated
                         requirement release builds will carry
  assets/                what main loads at run time through process.resourcesPath: the tray icon
  scripts/               build.ts, dev.ts, package.ts; stage-backend.ts with lockfile.ts, pe.ts,
                         zip.ts and natives.ts; vite-common.ts, electron-env.ts; smoke.ts and
                         dev-smoke.ts
  src/main/              main: the Electron-free modules that decide (controller, attach, forwarder,
                         backend, environment, login-shell, pages, policy, menus, window-options,
                         quit-check, quit-flow, strings, shell-pages, log-filter, log-files), and
                         thin Electron layers over them (index, instance, protocol, window, chrome,
                         menu, tray, permissions, navigation, quit, log)
  src/preload/           the sandboxed CommonJS preload: the page's marks and its bridge
  src/shared/bridge.ts   the IPC channels and who may send on each; it imports nothing
  src/shell/             the loading, failure and waiting pages
  test/                  Vitest, for the Electron-free modules
```

## Running it

| Command | What it runs |
| --- | --- |
| `bun run dev:desktop` | `scripts/dev.ts`: watch-builds main, the preload and the shell pages, serves `apps/web` from Vite on `127.0.0.1:5173`, and runs the unpackaged app with `--eidolon-dev-server`, its backend from source. It builds `apps/web/dist` first when there is none, since that backend won't start without one. Arguments after it go to Electron, such as `--user-data-dir=<folder>` |
| `bun run build:desktop` | `scripts/build.ts`: stages this machine's backend in `apps/desktop/.stage/<target>/eidolon` ([The payload](#the-payload)), then Vite-builds `apps/desktop/dist`: main as one ES module with every dependency but `electron` inlined, the preload as CommonJS (a sandboxed preload can't be a module), and the shell pages |
| `bun run package:desktop` | `scripts/package.ts`: electron-builder on `dist/` and this machine's stage, into `apps/desktop/.out`, unsigned, at version `0.0.0-dev` ([Packaging](#packaging)). Arguments after it go to electron-builder, such as `-c.compression=store` |
| `bun run smoke:desktop:dev` | the dev smoke: the unpackaged app under Playwright ([The smokes](#the-smokes)) |
| `bun run smoke:desktop` | the packaged smoke: the fused app, through its backend's API |

Closing the window only hides it. Quit from the menus, ⌘Q, the tray, or a second launch with
`--quit` (and the run's `--user-data-dir`, if it had one), which `dev:desktop` follows by closing
Vite and exiting:

```bash
"$(cd apps/desktop && node -p 'require("electron")')" apps/desktop --quit
```

`require("electron")` from `apps/desktop` gives the path to Electron's binary, which its package
downloads on first use. Unpackaged, the profile is `Eidolon Dev`, never the installed app's, and
the dev backend uses the normal data home: a `bun run app` or `dev:local` already serving it is
[attached to](#attaching-to-a-server-already-on-the-data-home), not replaced. Every test run of
the app is in [background mode](#background-mode).

## The processes

- **Main** (`src/main`, built to `dist/main/index.js`) holds the profile, the single-instance lock,
  the environment and the data home, the backend controller, the `eidolon-app:` scheme and its
  forwarder, the window, the menus, the tray and the logs. No backend code runs in it or in the
  window: `apps/desktop/src` loads at run time only `electron`, `electron-updater`, `electron-log`,
  `undici`, `node:*` and its own modules, and takes `@eidolon/*` and `apps/bot` as types alone
  (`test/boundary.test.ts`). So main imports no `@eidolon/config` either: it finds the payload
  through `process.resourcesPath` when packaged, or the checkout when not, and mirrors the few
  things it needs (`jsRuntime().args`, `dataHome()`), each held equal to the original by a test.
- **The backend** is the local server, run by the app's own binary as Node
  (`ELECTRON_RUN_AS_NODE=1`): packaged, the payload's `dist/server.js`; unpackaged, the checkout's
  `apps/bot/src/local/server.ts`, whose types the dev Electron's Node strips. Its jobs, grep's
  matcher and the `eidolon` command its tasks run start the same binary through `jsRuntime()`.
- **The window** is one BrowserWindow: a sandboxed renderer with context isolation, no Node
  integration and no `<webview>`, and the preload, `dist/preload/index.cjs`.

### Startup

`instance.ts` runs first, before any other module can touch the profile or start a log:

1. A packaged launch with `--remote-debugging-port` or `--remote-debugging-pipe`, which no fuse
   covers, exits 1 before the profile, the logs and the lock exist.
2. Unpackaged, the profile (userData) becomes `<appData>/Eidolon Dev`, unless the launch passes
   `--user-data-dir`, as the smokes do. Whenever the profile isn't the default, the logs move into
   `<profile>/logs`: on macOS `app.getPath("logs")` is `~/Library/Logs/Eidolon` whatever the
   profile, so a test would append to the installed app's logs.
3. The single-instance lock, scoped to the profile. A second launch shows and focuses the window,
   from hidden or minimized, or makes it again if the page closed it; with `--quit` it quits the
   running app through the normal quit, and with no app running it exits 0 and starts nothing.

Then main registers the scheme and, on Windows, sets the AppUserModelID `live.laplace.eidolon`,
which the installer's shortcut carries, before any window. Once Electron is ready it installs the
session's permission handlers, the scheme's handler, the bridges' handlers, the menus and the
tray, opens the window on the loading page, and only then reads the environment, resolves the data
home and starts the controller. The window moves to `eidolon-app://app/` once the backend is
ready. The data home is `EIDOLON_HOME` from that environment, else `~/.laplace/eidolon`
(`%USERPROFILE%\.laplace\eidolon`), the one npx and `bun run app` use; the backend gets it as its
`EIDOLON_HOME`, so the two never read different homes.

### The backend

Main spawns its own backend as the diagram shows, with [its environment](#the-environment), stdio
`ignore`, `pipe`, `pipe` and `ipc`, the home folder as its working folder (so it holds no handle on
the install folder), its console hidden, and not detached.

- **Ready** is the IPC message `{kind: "listening", port}`; any other message is logged and
  ignored. Main reads `local-token` after every listening, since a first start writes it and
  deleting it makes the next start write another.
- **The port** is 7860 first. Main test-binds `127.0.0.1:7860` and, when that fails with
  `EADDRINUSE` or `EACCES` (a Hyper-V or WinNAT excluded range on Windows), spawns with `--port 0`
  at once: the server would meet the error only after loading everything. A race lost anyway, an
  exit 1 on `port … is taken by another program` or `listen EACCES`, respawns on `--port 0`. The
  server never falls back by itself.
- **Its exits:** 0, stopped, or before any listening, this home's server already serves the port
  asked for; 75, a restart; 1, an unusable token, a port another program holds, or a crash at boot;
  2, a usage error, a missing web build, or a home another server holds on another port. The two
  refusals are [attaching's](#attaching-to-a-server-already-on-the-data-home).
- **A restart** (exit 75, as Settings' Restart asks) respawns on the same port. From a forwarded
  `POST /api/local/restart` answering 2xx, or the exit itself, until the new listening, the
  forwarder holds requests and sends no Bearer, so whatever binds the freed port in the gap gets
  nothing.
- **A failure** shows the failure page: a spawn that fails, any other exit, an exit 75 before any
  listening, no listening within 60 s, no `local-token` to read once it listens, or 60 s without an
  answer after a connection to it was refused. Main stops a backend that failed while it ran.
- **The stop:** `child.disconnect()`, which the server takes as its stop on every platform: main
  keeps the IPC channel open for the backend's whole life, so its closing is the trigger. After
  10 s main sends `kill()` (SIGTERM on macOS, TerminateProcess on Windows), after 5 s more, off
  Windows, SIGKILL, and after 5 s more it logs and gives up. It never kills a tree: the server's
  own stop asks its jobs to stop and ends its commands' and MCP servers' trees, and a detached job
  outlives a forced stop, as under npx. No request carries the Bearer once the stop begins, and
  main never stops a server it attached to.
- **If main dies** on macOS, its IPC channel closes and the server stops itself, even one still
  booting; on Windows the backend sits in main's job object and ends with it, without its own
  stop, as under npx's launcher.
- **Windows' session end** never reaches `before-quit`: Electron emits `session-end` to each window
  and then ends the process. So the stop starts on the window's `query-session-end`, whose handler
  only disconnects and returns (Node closes the channel on the next tick, which a handler that
  blocked would never reach), and `session-end` waits, blocking, up to about 4 s for that exit. If
  another app vetoes the shutdown, the backend starts again 10 s later.

## The forwarder

The window loads `eidolon-app://app/`, and main answers every request to that host by forwarding it
to the server it proved ([Attaching](#attaching-to-a-server-already-on-the-data-home)), adding
`Authorization: Bearer <local-token>`. The page never holds a credential: no link code, cookie or
proof, nor the token.

- **The scheme,** `eidolon-app`, is registered once, before Electron is ready, as `standard` (a
  tuple origin, with localStorage and IndexedDB), `secure` (the secure context `getUserMedia`
  needs), `supportFetchAPI`, `corsEnabled`, `stream` (so `<audio>` plays a streamed answer: voice
  bubbles, the voice picker) and `codeCache`; with no `bypassCSP` and no service worker. Its
  handler, on the default session, serves the shell host's pages, forwards the app host, and
  answers any other host 404. The default session loads only `eidolon-app://` pages; anything
  embedded from elsewhere would need a partition of its own. Electron turns Chromium's Local Network
  Access checks off, so the page's loopback traffic (WebRTC to werift, Vite's HMR in dev) asks for
  no permission.
- **Who gets the Bearer:** only a request whose `initiatorOrigin` is `eidolon-app://app`, or is
  absent, as main's own loads and downloads are. Electron fills it in from the frame that made the
  request, which the page can't change. Any other initiator, another host of the scheme or an
  opaque origin (`null`) such as a sandboxed attachment, gets 403 and is never forwarded. The
  `Origin` header can't decide this: Electron hands the scheme's handler none for a fetch, and
  Chromium applies no CORS to the scheme, so an Origin check would make any document in the session
  a full API client. Origins compare by protocol and host, since Node's `URL` gives a custom
  scheme's origin as `null`.
- **The proof on every new connection.** A server restarted elsewhere while no connection was open
  gives no sign at all, and whatever binds its port next, another local account included, would
  get the next connection. So each new connection the forwarder opens to the backend first carries
  the probe ([below](#attaching-to-a-server-already-on-the-data-home)) over that same socket, and
  only one that proves itself carries a request; for an attached server, its lock's `.info` must
  also still name that address and a live pid, so a relay on the old port can't pass the probe on
  to a server that moved. A connection that doesn't prove itself is destroyed and handled as a
  refused one. The cost is one loopback round trip per new connection, under the probe's 2 s
  deadline.
- **Holding.** From a forwarded `POST /api/local/restart` that answers 2xx, our own backend's exit
  75, a refused or unproven connection, or an [attached server's grace
  period](#attaching-to-a-server-already-on-the-data-home), requests wait, with no Bearer, until a
  server is ready again: our new child's listening, or a fresh proof. A request still held after
  15 s gets the no-backend answer below and is never forwarded; apps/web's restart poll, which
  waits 60 s, rides that out. A refused request without a body is sent again once a server is
  ready; one with a body gets the no-backend answer at once, since undici has already taken its
  body and the forwarder never buffers one.
- **No backend,** at startup, after a failure, or when a fetch fails otherwise: a document request
  (a GET or HEAD whose `Accept` names `text/html`: a navigation through the scheme carries no
  `Sec-Fetch-*`) gets the waiting page, served in place at the app's address; every other request
  gets 503 `{"error":{"code":"unreachable","message":"Eidolon's server isn't running"}}`, which
  apps/web reads as its `unreachable` error while its restart poll keeps polling. The waiting page
  is passive, and main reloads the window once a server answers. It is a 200, because Chromium logs
  a document answered with a 5xx as a console error, which the smokes count as a failure.
- **Requests** go through undici's `fetch` with `redirect: "manual"`, so no redirect is followed
  with the Bearer, and an `Agent` whose `bodyTimeout` and `headersTimeout` are 0: undici's 300 s
  defaults would cut an NDJSON stream that idles, such as a task card waiting on the owner.
  `host`, `origin`, `cookie`, `sec-fetch-site`, `x-eidolon-proof` and the page's own
  `authorization` are dropped: the server's guard answers 421 to a Host that isn't its loopback
  address and 403 to a foreign `Origin` or `Sec-Fetch-Site`, and the page's cookie, proof and
  `Authorization` are no credentials here. The rest passes, and a body goes on as the stream it
  came as.
- **Answers** pass through with their status and streaming body, without `set-cookie`, which would
  fill the page's cookie jar, `content-encoding` and `content-length`, since undici decodes the
  body, and the hop-by-hop headers. The scheme's request has no signal: when the page aborts,
  Electron cancels the body it relays, which is the upstream body itself, never a copy, and that
  ends the upstream request.
- **What goes through it:** chat and job NDJSON streams and their cancellation, uploads, range
  requests, `/api/ice-servers` and the WebRTC offer. A call's media flows peer to peer, to werift on
  loopback, outside it.
- **Three connection pools:** the page's, whose closing connections tell the controller an attached
  server may have changed; main's own, for its quit check and version reads, whose idle closes tell
  it nothing, or an attached app would re-prove the server every few seconds; and in dev Vite's,
  which carries no Bearer and needs no proof.
- **In dev** (`--eidolon-dev-server`, which `dev:desktop` passes and main honours only unpackaged),
  every path but `/api` and `/mcp` goes to Vite on `127.0.0.1:5173`, or gets 502 when Vite doesn't
  answer. Vite's HMR socket names that address, since the page is at `eidolon-app://app`. Without
  the switch, an unpackaged backend serves the checkout's `apps/web/dist`.

## Attaching to a server already on the data home

A data home runs one server, whichever started it: the desktop app, `bun run app` or npx
([web-app.md](web-app.md#running-it)). The app uses a server that already holds its data home,
and leaves it running when it quits.

- **The hint.** `<home>/locks/4273f434b594.info` is JSON with the holder's `pid`, and once it
  listens its `port` and `host`, the first loopback address it bound (`127.0.0.1`, `[::1]`). It is
  only a hint, written in place and left behind by a crash: one that doesn't parse is no hint, and
  main never opens the `.lock` itself. A server older than the recorded `host` is never attached to:
  the probe proves only what answers on one address, and with the server on `::1`, another local
  account could bind `127.0.0.1` and relay it.
- **The probe.** When the hint names a pid that is alive, a port and a host, and `local-token`
  holds a token, main sends `GET http://<host>:<port>/api/local/session?probe=<nonce>` over a
  connection of its own, with a 2 s deadline, and compares the answer's `proof` with
  HMAC-SHA256(local-token, `"probe:" + nonce`) in constant time; neither side sends the token. A
  match attaches: the forwarder targets exactly that address with that token, and main spawns
  nothing.
- **A refused spawn.** A server can start between the probe and main's spawn, which then refuses:
  exit 0 after printing `Eidolon is already running:` (the holder serves the port asked for), or
  exit 2 naming the holder's pid and port, or its pid alone while it hasn't recorded its port. After
  a refusal main never spawns again on its own: it re-reads the hint and probes every 500 ms for up
  to 60 s, attaches to the first server that proves itself, and otherwise shows the failure page
  naming the holder, with Try Again. A holder can keep the lock without answering (a server whose
  listener closed while its jobs stop, or one whose `local-token` was deleted under it), and
  respawning in a loop would boot a whole backend each round, or take the lock from a terminal
  supervisor's next child, which would then exit 2 and end `bun run app`.
- **While attached,** quitting leaves the server running and asks nothing. A refused or unproven
  connection, a forwarded restart answering 2xx, or one of the page's connections to it closing
  starts a grace period, never a takeover: requests wait without the Bearer while main re-reads the
  hint and probes every 500 ms for up to 60 s, and a fresh proof resumes forwarding, which after an
  ordinary idle close costs one round trip. Only after 60 s with no server on the data home does
  main spawn its own, on that port, under the refusal rule above; spawning sooner would race the
  terminal supervisor's new child for the lock, and replace the owner's server if it won.
- **The page matches the server.** It comes from whichever server answers, so its UI and API match
  even when a terminal's server runs another version; only the desktop's chrome can be missing
  then. Main reads each server's version from `GET /api/local/status` once, before the window
  follows it, for the bridge and the About panel.

## The window

One window, 1280×820 at first and at least 520×600, hidden until its first page is ready to paint,
at the bounds it had last: `window-bounds.json` in the profile, written through a temporary file. A
saved position is dropped when no display shows 100×40 px of the window's top, and a window saved
maximized is maximized only once it has painted, since `maximize()` shows a hidden window. Main
owns its title.

- **Its pages.** The window shows `eidolon-app://shell/loading` until the backend is ready, then
  `eidolon-app://app/`. The failure page, `eidolon-app://shell/failed`, says why in the shell's
  language, shows the backend's last stderr lines under Details (those since it listened, if it
  did), and offers Try Again, Show Logs and Quit. It shows when the backend fails or the window's
  own page does: a main frame's load failing other than by an abort, the preload erroring, or the
  renderer gone. Try Again starts the backend again only when it failed; after the page's own
  failure it goes back to the app, or to the loading page until the backend is ready. Shell pages
  navigate nowhere: main moves the window, and never loads the failure page again from its own
  failure.
- **The shell pages** are Vite's build of `src/shell`, filled in when main serves them, each under a
  CSP that allows its own inline style by hash and, on the failure page alone, its script from the
  shell host: no `'unsafe-inline'`, and `frame-ancestors 'none'`. The waiting page is served at the
  app's address, so its style must stay inline and it has no script: a path there reaches the
  backend. Each has a drag strip at the top as tall as the web app's header row, or the title-bar
  area if that's taller.
- **The bridges.** The preload marks `<html>` (`data-shell`, and on macOS `data-fullscreen`) for
  apps/web's chrome ([web-app.md](web-app.md#in-the-desktop-app)), and gives each page its own
  bridge, in its main frame alone. The app's page gets `window.eidolonDesktop`: `platform`,
  `version` and `serverVersion`, read before the page's first script over a synchronous message
  main answers from what it already knows (`version` is `0.0.0-dev` unpackaged), and `setTheme`,
  `setLanguage` and `onCommand`. A shell page gets `window.eidolonShell`: `retry`, `showLogs` and
  `quit`. Main takes each message only from the window's own webContents and main frame, on the
  channel's own page, judged by the frame's origin, never its URL: a sandboxed document the backend
  serves has an app URL and an opaque origin (`accepts()` in `src/shared/bridge.ts`).
- **The theme** the page reports goes to `nativeTheme.themeSource` as it is, `system` included: a
  resolved theme would pin `prefers-color-scheme` and stop the page's System from following the OS.
  Native menus, dialogs and Windows' caption buttons follow it.
- **A menu's command,** Settings… (⌘, on macOS, the tray's on Windows), goes to the app's page
  once its script says it listens, so it reaches the page from the loading page or a new window too.
- **Chrome.** No system title bar. On macOS, `hiddenInset`, the traffic lights at `{x: 16, y: 20}`,
  centred on the web app's 56 px first row, and `titleBarOverlay: true`, without which macOS
  publishes no `env(titlebar-area-*)` for the page's insets. On Windows, a hidden title bar under a
  transparent 56 px overlay, whose caption glyphs main recolours on each theme change.
- **Menus and the tray.** macOS's menu bar is declared in full, since a custom menu replaces
  Electron's: Eidolon (About, Settings…, Hide, Hide Others, Show All, Quit), Edit (its roles,
  without which copy and paste break), View (zoom, full screen, and Toggle Developer Tools only
  unpackaged), Window (⌘W hides) and Help (Show Logs, Open Data Folder, Licenses). Windows has no
  menu bar: main sets a menu of View's zoom roles alone, since Electron would otherwise install its
  default one, whose accelerators act even under a hidden title bar, and a notification-area icon
  holds the rest for the whole run (Open Eidolon, Settings…, Show Logs, Open Data Folder,
  Licenses, About Eidolon, Quit Eidolon); a click on it opens the window. Both get a context menu,
  since Electron has none: cut, copy, paste and select all in a field, copy over selected text. The
  About panel names the app's version and the server's.
- **Strings.** The shell's own words (`src/main/strings.ts`: menus, the tray, dialogs and the shell
  pages) come in English and Simplified Chinese, following the language the page reports and the
  system's until it has. Menus and the tray are rebuilt when it changes. Labels are Title Case,
  which `strings.test.ts` checks with apps/web's own rule.
- **Links and navigation.** The window never leaves `eidolon-app://`. A link the page opens in a new
  window goes to the default browser when it is `https:` or `http:`; one to the app's own address,
  such as an attachment, saves through Electron's Save dialog (`downloadURL`: the window has no
  tabs); anything else, `file:` and other apps' schemes included, goes nowhere, and no window ever
  opens. A navigation off the app's address is cancelled, and opened in the browser if it is to the
  web; a redirect off it is cancelled. `about:blank` raises no `will-navigate` (Chromium runs no
  navigation throttle for it), so a main frame that lands anywhere off `eidolon-app://` is put back
  on main's page. A `<webview>` is never attached.
- **Permissions.** Both of the session's handlers are set before the first load; with none,
  Electron grants every request and passes every check. The microphone goes only to the app
  window's main frame whose `securityOrigin` is `eidolon-app://app`, asking for audio alone, and the
  check handler answers the same by `requestingOrigin`. On macOS main then asks the OS when it
  hasn't been asked, and once the owner has denied it, which macOS never asks again, says where to
  turn it on; macOS ties a grant to the app's signature, so each ad-hoc build asks again. Clipboard
  writes go to that frame too. Everything else, the camera included, is denied. Windows has no
  per-app prompt: with its privacy setting off, `getUserMedia` fails and apps/web shows its
  microphone error.
- **Close.** Closing hides the window, and calls, tasks and jobs run on. On macOS it leaves
  fullscreen first, since a hidden fullscreen window leaves a black Space behind; on Windows the
  first hide says once that Eidolon is in the tray (`tray-notice-shown` in the profile). Electron
  reports an occluded window as hidden and fires show and hide events as fullscreen comes and goes,
  so main keeps its own record of whether the window shows, which only its own calls change. A
  page's own `window.close()` destroys the window with no `close` event; the app stays, and a
  second launch, the Dock or the tray makes a new window.
- **Quit.** Every quit, ⌘Q, a menu, the Dock, the tray or a second launch's `--quit`, goes through
  `before-quit`. While our own backend is ready, main first asks it what would stop
  (`GET /api/local/status` and `GET /api/local/jobs`, with the Bearer, 2 s for both). When a call, a
  task or a job runs, or it couldn't tell, a "Quit Eidolon?" box names what stops, Quit being the
  default and Esc cancelling; it has no owner window, so a hidden window stays hidden, and a quit
  while it is open joins it. An attached server is never asked or stopped. On macOS a power-off
  skips the box until the window has attention again. Once the quit is approved, main hides the
  window, removes the tray icon, stops its backend, and quits.

## The environment

The backend runs on the environment main reads, plus four variables of its own, and never a `.env`.

- **macOS.** An app started from Finder or the Dock inherits only launchd's environment, without the
  `PATH` and variables a terminal has, so main reads the owner's login shell (`login-shell.ts`,
  ported from deepseek-harness): the account's shell (`os.userInfo().shell`), then zsh, bash and sh,
  each run as `-ilc` with delimiters around `env -0`, 10 s apiece, its process group killed on a
  timeout or a quit. When every one fails, the launch environment stands, and main.log names why.
- **The merge.** The shell's values win, except `PWD`, `OLDPWD`, `SHLVL`, `_` and the probe's own
  variables; `ELECTRON_*`, which never come from the shell; and an `EIDOLON_*` the launch
  environment sets to a non-blank value, so a smoke's or a terminal launch's `EIDOLON_HOME` holds.
- **When.** Once at startup, which names the data home. The first spawn within 10 s takes that read,
  so a cold start runs the owner's rc files once; every later spawn reads afresh, so a Restart sees
  a changed `PATH`.
- **`EIDOLON_DESKTOP_LOGIN_SHELL=0`** (or `false`, `no`, `off`) in the launch environment skips the
  read, and the launch environment is used as it is. Both smokes set it, and remove local-smoke's
  credential, setting and provider variables: otherwise a key the developer's shell exports would
  reach the backend, win over the smoke's fake accounts (a non-empty variable beats
  `credentials.json`) and bill.
- **Windows** takes the launch environment as it is; an Explorer launch carries the registry's user
  and system variables. Git for Windows installed later is found after a Restart, because
  `windowsBash()` checks its install folders first, but a tool found only on a newer `PATH` needs
  the app relaunched. Its names have no case, but a copy of the environment does, and spawn keeps
  only the first of two spellings, so main reads and writes names without case, one key each: a
  `Path` stays one key.
- **The backend's own variables,** set last: `EIDOLON_HOME`, the data home main resolved, so a
  respawn never serves another; `EIDOLON_APP_ROOT`, the payload, unset unpackaged so files resolve
  from the checkout; `EIDOLON_NO_DOTENV=1`, so no `.env` is read, unpackaged included; and
  `ELECTRON_RUN_AS_NODE=1`.
- **`ELECTRON_RUN_AS_NODE`** makes an Electron binary run as Node at any non-empty value, `0`
  included, so nothing sets it to mean off. Our own JS starts through `jsRuntime()`, which adds it
  inside Electron. A task's commands and MCP servers never get it, since `shellEnv()` passes listed
  names alone, and neither may any spawn that can start a program the owner chose, or an Electron
  app such as VS Code's `code` would run as Node. yt-dlp keeps it on purpose: its JS runtime is the
  app binary. Electron's GUI starts through `electronEnv()` (`scripts/electron-env.ts`), which
  deletes it, as `dev:desktop` does.
- **Node mode's flags.** Every node-mode process the app starts carries `--disable-sigusr1
  --use-system-ca` before its script: `jsRuntime().args` for the jobs, grep's matcher and the
  `eidolon` command, and main's own copy, `BACKEND_RUNTIME_ARGS`, for the backend. With the
  packaged app's nodeOptions fuse off, node mode ignores `NODE_OPTIONS` and drops
  `NODE_EXTRA_CA_CERTS`, so a CA file npx honours never reaches the backend; `--use-system-ca`
  trusts the OS store instead, a corporate CA included. The inspect fuse doesn't reach node mode,
  where SIGUSR1 would open an inspector; `--disable-sigusr1` closes it. yt-dlp, which starts its JS
  runtime itself, can't pass them on.

## The payload

`scripts/stage-backend.ts` stages the backend in `apps/desktop/.stage/<target>/eidolon`, for
`darwin-arm64` or `win32-x64`: `bun run build:desktop` stages this machine's, and
`node apps/desktop/scripts/stage-backend.ts --target <target>` names one. A failed stage leaves
none, and `win32-x64` stages only on Windows, whose Visual Studio redistributable supplies its
VC++ copies.

- **What it holds:** what the npm package stages, through `apps/eidolon/scripts/build.ts`'s
  `stage()` (`dist/{server,cli,app}.js`, `web/`, `personas/`, `data/`, the built-in skills,
  `bin/eidolon.mjs`, the README, LICENSE, NOTICE and THIRD_PARTY_NOTICES.md), plus its runtime
  dependencies in `node_modules`: onnxruntime-node, werift, libopus-wasm, apache-arrow, sharp and
  the target's LanceDB binary, whose JS is inlined in `dist/`. Main runs `dist/server.js` with
  `EIDOLON_APP_ROOT` set to the payload, so `shippedPath` finds everything in it.
- **Pinned to bun.lock.** The payload's `package.json` is the npm package's manifest plus
  `overrides` for every package its dependencies reach in `bun.lock`, nested where bun.lock nests a
  second version. `npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock
  --os=<os> --cpu=<cpu>` installs it for the target, and the stage fails unless `npm ls --all
  --json` shows exactly bun.lock's tree, the target's LanceDB binary included: npm skips an
  optional dependency it fails to fetch and still exits 0. An npx install resolves afresh, and
  drifts from what the tests ran. `--ignore-scripts` loses nothing on macOS or Windows.
- **Pruned:** npm's `.bin` links and its record of the install, and onnxruntime-node down to the
  target's binding and the one library it loads: on darwin-arm64 `libonnxruntime.1.dylib`, without
  a second, identical copy; on win32-x64 `onnxruntime.dll`, without DirectML's DLLs, which CPU
  sessions never load. Type-only packages stay, or `npm ls` would call them missing.
- **The VC++ runtime on Windows.** LanceDB, which loads at boot, and onnxruntime import it, so a
  machine without the redistributable couldn't start the backend. Each folder holding a native addon
  gets the runtime DLLs its natives import (their import and delay-import tables, and what those
  DLLs import in turn): onnxruntime's folder five, LanceDB's `vcruntime140.dll`. All come from the
  newest `Microsoft.VC14*.CRT` folder vswhere finds, since whichever copy loads first serves the
  whole process. Node loads an addon with `LOAD_WITH_ALTERED_SEARCH_PATH`, which looks in its own
  folder first, so an older System32 copy can't win. The copies shadow System32's, and Windows
  Update never services them: each release refreshes them. The stage test checks their file
  version is at least the natives' linker version.
- **The unsigned-PE list.** `.stage/win32-x64/unsigned-pe.json` names, by basename, each `.node` and
  `.dll` with an empty certificate table, in the payload and in the Electron zip electron-builder
  packs (`electron_wer.dll` under its packaged name, `Eidolon_wer.dll`), for a signed release to
  sign: electron-builder signs only `.exe` unless told, and a whole extension would re-sign
  Microsoft's files. On a Windows stage, the stage test fails on a `.node` or `.dll` that is neither
  listed nor signed by Microsoft (`MICROSOFT_SIGNERS`). The list matches by basename, and Electron's
  unsigned `dxcompiler.dll` shares its name with onnxruntime's signed one, which is safe only while
  the prune drops onnxruntime's.
- **Licenses.** `THIRD_PARTY_LICENSES.txt` in the payload, which Licenses opens (the Help menu on
  macOS, the tray on Windows), holds every license the payload carries: each `node_modules`
  package's, SPDX's text where one ships none, with libvips's LGPL-3.0-or-later text and where its
  source is for each package that ships libvips (on Windows, sharp's own platform package); the
  VC++ runtime's terms on Windows; then the payload's NOTICE, THIRD_PARTY_NOTICES.md (what its
  bundles and web app include) and the license files under `data/`. Main's build writes the
  licenses of what it inlines to `dist/main/THIRD_PARTY_LICENSES.md`, and `apps/desktop`'s
  `LICENSE-deepseek` and `THIRD_PARTY.md` cover the code ported from deepseek-harness.

## Packaging

`bun run package:desktop` runs electron-builder with `--publish never`, `-c.mac.identity=-` and
`-c.extraMetadata.version=0.0.0-dev`, and with `CSC_IDENTITY_AUTO_DISCOVERY=false`, so it never
signs with an identity from the keychain or asks for one. It needs `dist/` and warns when there is
no stage. On macOS it writes `.out/mac-arm64/Eidolon.app`, a DMG and a zip; on Windows an NSIS setup
and `.out/win-unpacked`. The flags stay on the command line, never in `electron-builder.yml`, which
a release config will extend: an identity there would replace the release's. Builds are unsigned
(ad hoc on macOS, where that signs every Mach-O, the payload's natives included, with the hardened
runtime): signing, notarization, the updater and releases come later, so the update hooks
`.env.example` lists do nothing yet.

`electron-builder.yml`:

- **Names.** `appId` `live.laplace.eidolon`, `productName` `Eidolon`, which names the profile
  (`~/Library/Application Support/Eidolon`, `%APPDATA%\Eidolon`) and scopes the single-instance
  lock, and `extraMetadata.name` `eidolon`, which names the per-user install folder,
  `%LOCALAPPDATA%\Programs\eidolon`. Upgrades keep the first install's folder, so the name is fixed.
- **The asar** holds `dist/` and `package.json`, without source maps; `npmRebuild` is off, since
  main and the preload are bundles and the app has no dependencies. The output is `.out`, and build
  resources are in `resources/`, since the root `.gitignore` ignores `build/` at any depth.
- **The payload** is an extra resource, outside the asar so onnxruntime and LanceDB open real files:
  `Eidolon.app/Contents/Resources/eidolon`, or `resources\eidolon` beside `Eidolon.exe`. Its source
  is the folder above the payload, `.stage/<target>` with the filter `eidolon/**/*`, because
  electron-builder skips a source folder's own top-level `node_modules` whatever the filter. Asar
  integrity doesn't cover it. `assets/`, with the tray icon, ships the same way.
- **The fuses,** each one listed, since an unlisted fuse keeps Electron's default: `runAsNode` on,
  for the backend, its jobs and the `eidolon` command; the nodeOptions and CLI inspect fuses off;
  asar integrity and loading the app only from the asar on; `grantFileProtocolExtraPrivileges` off,
  since no page loads over `file:`; cookie encryption and the browser-process V8 snapshot off, their
  defaults. `wasmTrapHandlers` keeps its default, on, as electron-builder has no key for it.
  `resetAdHocDarwinSignature`, beside them, re-signs an unsigned build ad hoc after the fuses
  change, so it launches on Apple silicon.
- **macOS:** arm64 DMG and zip, the hardened runtime, the entitlements (`allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`, which ad-hoc signing with the
  hardened runtime needs, and `audio-input`; no camera), and the microphone's usage string. The DMG
  writes no update info: updates will take the zip.
- **Windows:** a per-user, one-click NSIS setup for x64, whose shortcut's AppUserModelID is the
  `appId`. `resources/installer.nsh` carries a workaround for electron-builder#6865; its uninstall
  removes the install folder alone. Installing, updating and uninstalling never touch the data home.
- **`publish`** names the update feed, which electron-builder writes into the app's
  `app-update.yml` for the updater to come; nothing is uploaded.

The app needs macOS 13 or Windows 10 (x64), Electron's minimums. Intel Macs have no LanceDB or
onnxruntime build; Windows on Arm runs the x64 build under emulation, untested.

## Logs

- **Where:** `app.getPath("logs")`: `~/Library/Logs/Eidolon` on macOS, `%APPDATA%\Eidolon\logs` on
  Windows, or `<profile>/logs` for a profile that isn't the default (unpackaged, or a
  `--user-data-dir`). Show Logs, in the Help menu on macOS and the tray on Windows, opens it.
- **`main.log`:** main's own lines at info and up, `console` included; uncaught errors in main,
  with no dialog; renderers and Electron's helpers going away. Each run starts with a line naming
  the app's version, Electron's, Chromium's and Node's, and the OS. A URL is logged without its
  query or fragment.
- **`backend.log`:** the backend's stdout and stderr, each line timestamped, since it carries its
  own level, and echoed to the terminal unpackaged. Main never logs a line that holds a link code:
  `log-filter.ts` drops `Eidolon is ready:` and `Eidolon is already running:` (and any other line
  holding one) after the controller has read them.
- **Rotation:** each file moves aside at 2 MB, to `main.1.log` through `main.5.log` and the like.
- There is no `log.initialize()`, which would inject electron-log's own preload into every session,
  and its IPC transport is off.
- **Lines a test can wait on,** in main.log: `Eidolon: the data home is …`; `Eidolon: started the
  backend (pid N) on port P` or `Eidolon: using the server already on this data home, <origin>`;
  `Eidolon: the backend listens on <origin>`; `Eidolon: the window shows <url>`; and at a quit
  `Eidolon: quitting`, then `Eidolon: the backend (pid N) exited (0)`.

## Background mode

`EIDOLON_DESKTOP_BACKGROUND=1` in the environment the app starts with, packaged or not, makes it a
background app. Local test runs use the machine the owner is working on, so a test must never put
a window, a dialog or a prompt in front of them, nor take the focus: both smokes set it unless run
with `--headful`, and so does every other local test run of the app, an agent's Playwright walk
included.

- **macOS:** the app is an accessory from module load (`app.setActivationPolicy("accessory")`): no
  Dock icon, and it never activates.
- **No window is shown.** Main keeps and logs its own shown state, but calls no `show`, `focus`,
  `restore`, `maximize` (which shows a hidden window) or `moveTop`, and never `app.focus()`; on
  Windows the window skips the taskbar too. A window that is never shown still paints
  (`ready-to-show` fires), runs `requestAnimationFrame` at the display's rate and its timers on
  time, and takes Playwright's screenshots and clicks, with no Chromium switch and no
  `backgroundThrottling` change.
- **Nothing native appears.** A message box is logged with its text and answered with its default
  button; `openExternal`, `openPath` and `showItemInFolder` are logged, not opened; the About panel
  is logged; a download saves into the profile's `downloads` folder, logged, with no Save dialog;
  macOS's microphone prompt is skipped, so a call needs Chromium's fake media switches, which the
  smokes pass; and Windows gets no tray icon and no notice.

## Testing

### The Vitest project

`bun run test apps/desktop` runs the `desktop` project (`vitest.config.ts`): main's Electron-free
modules, the preload's bridges and the scripts' parts. Nothing it runs loads `electron`, whose
package gives Node the binary's path, not its API: a decision lives in a module that doesn't import
it, with its test, and the Electron code stays a thin layer over it. It covers the controller's
states, races and port fallbacks against fake children and real processes (`test/fake-server.ts`
answers as the local server does); the forwarder's headers, gating, holding, connection proofs and
errors against real local servers and the real local server booted in the test; the login-shell
read and the merge, Windows' case-blind names included; the quit check and flow; links,
navigation, permissions and the debugging switches; the bounds, chrome, menus and pages; both
languages' strings; the shell pages' escaping and CSP; the bridges' sender rule; the logs'
rotation and link filter; stage-backend's parts on made-up lockfiles, PE files and zips; the
manifest; and the import boundary.

### The stage test

`test/stage.test.ts`, in the same project, checks a real stage: its files and manifest, its tree
against `bun.lock`, the pruning, its natives loading from it (a LanceDB table, an onnxruntime
session and sharp, through `scripts/natives.ts`), on a Windows stage the VC++ copies and the
signers, and, once the app was packaged after the stage, that the packaged payload holds the same
files. A target with no stage, or one staged from another version or `bun.lock`, skips, its title
saying to run `bun run build:desktop`; `EIDOLON_REQUIRE_STAGE=1` requires this machine's, current:

```bash
bun run build:desktop && EIDOLON_REQUIRE_STAGE=1 bun run test apps/desktop/test/stage.test.ts
```

### The Electron lane

The backend runs on Electron's Node, not the Node `bun run test` uses, so the backend suite runs
there too, from the repository root and with temporary homes, as any test run:

```bash
ELECTRON=$(cd apps/desktop && node -p 'require("electron")')
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" node_modules/vitest/vitest.mjs run --project node
```

The first `require("electron")` downloads the binary and says so on stdout, so let it finish once
before taking the path. Two things differ on that Node. `process.execPath` is the Electron binary,
which starts its GUI unless the child's environment carries `ELECTRON_RUN_AS_NODE`: a test that
spawns `process.execPath` with an environment of its own merges `jsRuntime().env` into it, as the
app's own spawns do. And a `Date` keeps its local hours when `TZ` changes at run time, so a test of
another time zone runs in a child process started in it.

### The smokes

Both run on a temporary `EIDOLON_HOME` and a profile of their own (`--user-data-dir`, which keeps
the logs inside it), with `EIDOLON_DESKTOP_LOGIN_SHELL=0` and local-smoke's credential and provider
variables removed, in background mode unless run with `--headful`.

- **The dev smoke** (`bun run smoke:desktop:dev`) drives the unpackaged app with Playwright's
  Electron driver, against loopback fakes ported from `apps/bot/scripts/local-smoke.ts`, which it
  never edits: that file isn't paths-ignored, so a change to it deploys production. It walks Home,
  a chat's stream, an upload and opening it, a picture, Restart, a call on Chromium's fake
  microphone, close and reopen, attaching to a server started first on the same home (Restart while
  attached, and a restart of that server from outside the app), and Quit, after which the backend
  has exited 0.
- **The packaged smoke** (`bun run smoke:desktop`) runs the fused app, which Playwright and CDP
  can't drive, through its backend's API with the Bearer: the version, session and status;
  LanceDB, onnxruntime and sharp loading; the tray icon shipped; a restart keeping the port; and
  `--quit` giving main's exit 0 and the backend's clean stop, with nothing left running and no error
  line in either log. On Windows it first installs the setup silently and smokes the installed
  `Eidolon.exe`, then uninstalls it and checks the data home is untouched.

`.github/workflows/desktop.yml` builds, packages and runs the packaged smoke on macOS (arm64) and
Windows (x64), for pull requests and on dispatch.

### Running it by hand

A test run of the app by hand takes the smokes' setup: a temporary `EIDOLON_HOME`, a profile of its
own, `EIDOLON_DESKTOP_LOGIN_SHELL=0` and `EIDOLON_DESKTOP_BACKGROUND=1`.

- **Unpackaged,** after `bun run build:desktop` (or only its Vite builds) and `bun run build:web`,
  `"$ELECTRON" apps/desktop --user-data-dir=<profile>` runs it with its backend from source serving
  `apps/web/dist`; Playwright's `_electron` drives it the same way.
- **Packaged,** run `apps/desktop/.out/mac-arm64/Eidolon.app/Contents/MacOS/Eidolon
  --user-data-dir=<profile>` (`.out\win-unpacked\Eidolon.exe` on Windows), and drive its backend
  once main.log says the window shows `eidolon-app://app/`:

  ```bash
  curl -H "authorization: Bearer $(cat "$EIDOLON_HOME/local-token")" \
    "http://127.0.0.1:$(jq .port "$EIDOLON_HOME/locks/4273f434b594.info")/api/local/status"
  ```

- **Stop** either with the same command and `--quit`. On macOS a packaged run writes
  `~/Library/Preferences/live.laplace.eidolon.plist` whatever the profile: run
  `defaults delete live.laplace.eidolon`, then delete the file, which cfprefsd leaves behind empty.

## Bumping Electron

A bump moves the backend's Node and V8 as well as the shell, so it is a backend change too.

1. Change `electron` in `apps/desktop/package.json`, an exact pin, and `electronVersion` in
   `electron-builder.yml` together: a Windows stage refuses Electron's zip when they differ.
   `packages/config/test/electron.ts` names the version `asElectron()` reports.
2. `bunfig.toml`'s `minimumReleaseAge` holds back any release younger than 14 days: give the new one
   an exact `minimumReleaseAgeExcludes` entry (`electron@<version>`), and drop it, and any old one,
   once the gate passes it. Add no `trustedDependencies`: Electron's package has no install script
   (the binary downloads on the first `require("electron")`, or through electron-builder when
   packaging), and the field would replace Bun's default list.
3. `bun install` rewrites `bun.lock`, which `docker.yml` doesn't skip, so merging any Electron or
   electron-builder bump restarts production: merge it at a quiet time.
4. Recheck what Electron decides for the app:
   - its Local Network Access exemption: a call still connects, and Vite's HMR still reaches the
     page in dev, with no permission asked;
   - node mode's flags: its Node still takes `--disable-sigusr1` and `--use-system-ca`, SIGUSR1 to
     the backend opens no inspector, and an https fetch from the backend and from a job trusts a CA
     only the OS store holds;
   - the fuses: a new one keeps Electron's default unless `electron-builder.yml` lists it, so read
     the packaged binary's fuse wire with a current `@electron/fuses`;
   - its Node's major, which Vite's `node24` target (`scripts/vite-common.ts`) and the repo's Node
     24 assume, and its system minimums, which this doc restates;
   - on Windows, the unsigned-PE list, which takes Electron's own DLLs from its zip.
5. Run the backend suite on its Node ([the Electron lane](#the-electron-lane)), `bun run test
   apps/desktop`, the dev smoke, and the packaged smoke, here and on desktop.yml's Windows leg.

## Measured

On an Apple silicon Mac (macOS 27), 2026-11-21, unless said otherwise:

- **The stage** (darwin-arm64): 4,515 files and 372 MiB, of which LanceDB 250, onnxruntime 43, sharp
  and libvips 19, `dist/` 7.5 and the web app 2; about 11 s with npm's cache warm. A win32-x64
  payload is about 447 MiB before its VC++ copies.
- **Packaging** takes about 63 s: Eidolon.app is 628 MiB, the DMG 261 MB and the zip 255 MB.
- **Cold start,** packaged: the loading page at about 0.4 s, the backend listening at 1.3 s, Home
  painted at 1.5 s, of which the login-shell read (fish) is about 0.6 s. The first launch after
  packaging listened only at 3.6–4.2 s, and a freshly signed app on CI at 5.5 s.
- **Streaming** through the forwarder: a chat reply's first chunk 27–51 ms after sending, the rest
  as the fake sent it, nothing buffered; an aborted reply's socket to the backend was gone within
  about 100 ms. A restart is back on its port in about 0.5 s.
- **Memory** with Home open: about 760 MB, the backend 277 MB of it.
