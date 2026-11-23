# The desktop app

Eidolon, the desktop app (`apps/desktop`, the private package `laplace-eidolon-desktop`), is the
local app in a window that starts its own backend, on macOS (Apple silicon) and Windows (x64): no
terminal, no Node or Bun to install, and no link to sign in with. The window shows `apps/web` as it
is, served by the same local server `bun run app` and `npx @laplace.live/eidolon` run, in local
mode only, so production never sees it. Electron's own binary runs that server as Node, so the app
ships no other runtime. A release is signed and notarized in CI from its
`laplace-eidolon-desktop@<version>` tag and served from `https://downloads.vrp.moe/eidolon`, where
the app's updater finds the next one ([Releasing](#releasing), [Updates](#updates));
`bun run package:desktop` builds it locally, unsigned.

```text
Eidolon (main process)
 ├─ the single-instance lock: a second launch shows the window, or quits the app with --quit
 ├─ the environment: the login shell's on macOS, the registry's on Windows
 ├─ the data home: EIDOLON_HOME, else ~/.laplace/eidolon
 ├─ the backend controller, one attempt at a time
 │    ├─ attach: locks/4273f434b594.info names a live server that proves it holds local-token
 │    └─ spawn:  <app binary> --disable-sigusr1 --use-system-ca <payload>/dist/server.js
 │                 --host 127.0.0.1 --port 7860 --no-open      (--port 0 when 7860 is taken,
 │                                                             and in background mode)
 ├─ the eidolon-app: scheme
 │    ├─ shell/  the loading and failure pages
 │    └─ app/    forwarded to the backend, with the Bearer only main holds
 ├─ the task watch: the server's tasks, for notifications
 └─ the window at eidolon-app://app/: sandboxed, with the preload's bridge
```

```text
apps/desktop/
  electron-builder.yml   the packaging config: fuses, targets, the payload as an extra resource
  electron-builder.release.mjs
                         the release overlay: notarization, the requirement, Windows' Azure signing
  resources/             build resources: entitlements, installer.nsh, the icon, and the designated
                         requirement release builds carry (designated-requirement.mac)
  assets/                what main loads at run time through process.resourcesPath: the tray icon
  launchers/             the eidolon command's, shipped to the app's resources/bin
  node-shim/             the node shim's launchers, which the stage copies into the payload
  dev-app-update.yml     the release feed for EIDOLON_DESKTOP_DEV_UPDATE, read only unpackaged
  scripts/               build.ts, dev.ts, package.ts; stage-backend.ts with lockfile.ts, pe.ts,
                         zip.ts, natives.ts and node-shim.ts; signed-check.ts, the signed
                         build's checks; vite-common.ts, electron-env.ts;
                         test-on-electron.ts, the Electron lane; system-ca.ts, CI's system CA
                         proof; dev-smoke.ts with dev-smoke/, the dev smoke; smoke.ts, the
                         packaged smoke; smoke/, the kit both share, with the packaged
                         smoke's packaged.ts and nsis.ts; and update-test.ts with update-test/,
                         CI's update test
  src/main/              main: the Electron-free modules that decide (controller, attach, forwarder,
                         backend, environment, login-shell, registry-environment, pages, policy,
                         menus, window-options, quit-check, quit-flow, update-flow,
                         update-signature, strings, shell-pages, log-filter, log-files,
                         background, app-invokes, folder-dialog, system-options, terminal-command,
                         task-notices), and thin Electron layers over them (index, instance,
                         protocol, window, chrome, menu, tray, permissions, navigation, native,
                         quit, updater, log)
  src/preload/           the sandboxed CommonJS preload: the page's marks and its bridge
  src/shared/bridge.ts   the IPC channels and who may send on each; it imports nothing
  src/shared/release-notes.ts
                         changelog.json's types, the manifest's eidolonNotes, and what an update's box
                         shows of them; scripts/changelog.ts writes the notes with them
  src/shell/             the loading, failure and waiting pages
  test/                  Vitest, for the Electron-free modules
```

## Running it

| Command | What it runs |
| --- | --- |
| `bun run dev:desktop` | `scripts/dev.ts`: watch-builds main, the preload and the shell pages, serves `apps/web` from Vite on `127.0.0.1:5173`, and runs the unpackaged app with `--eidolon-dev-server`, its backend from source. It builds `apps/web/dist` first when there is none, since that backend won't start without one. Arguments after it go to Electron, such as `--user-data-dir=<folder>` |
| `bun run build:desktop` | `scripts/build.ts`: stages this machine's backend in `apps/desktop/.stage/<target>/eidolon` ([The payload](#the-payload)), then Vite-builds `apps/desktop/dist`: main as one ES module with every dependency but `electron` inlined, the preload as CommonJS (a sandboxed preload can't be a module), and the shell pages |
| `bun run package:desktop` | `scripts/package.ts`: electron-builder on `dist/` and this machine's stage, into `apps/desktop/.out`, unsigned, at version `0.0.0-dev` ([Packaging](#packaging)). Arguments after it go to electron-builder, such as `-c.compression=store` |
| `bun run smoke:desktop:dev` | `scripts/dev-smoke.ts`, the dev smoke, on macOS: builds `apps/web/dist` and `apps/desktop/dist` (`--no-build` runs on what is there), then walks the unpackaged app under Playwright on a temporary home and profile with its providers faked, in background mode unless `--headful`, a line per step ([The dev smoke](#the-dev-smoke)). `--keep` keeps its screenshots and results after a pass |
| `bun run smoke:desktop` | `scripts/smoke.ts`, the packaged smoke: the app `package:desktop` left in `apps/desktop/.out`, on a temporary home and profile with its providers faked, in background mode unless `--headful`, driven through its backend's API; on Windows it installs the NSIS setup first and uninstalls it after ([The packaged smoke](#the-packaged-smoke)). It never builds or packages |

Closing the window only hides it. Quit from the menus, ⌘Q, the tray, or a second launch with
`--quit` (and the run's `--user-data-dir`, if it had one), which `dev:desktop` follows by closing
Vite and exiting:

```bash
"$(cd apps/desktop && node -p 'require("electron")' | tail -n 1)" apps/desktop --quit
```

`require("electron")` from `apps/desktop` gives the path to Electron's binary, which its package
downloads on first use, after printing a line of its own to stdout: hence the `tail`. Unpackaged,
the profile is `Eidolon Dev`, never the installed app's, and the dev backend uses the normal data
home: a `bun run app` or `dev:local` already serving it is
[attached to](#attaching-to-a-server-already-on-the-data-home), not replaced. Every test run of
the app is in [background mode](#background-mode).

## The processes

- **Main** (`src/main`, built to `dist/main/index.js`) holds the profile, the single-instance lock,
  the environment and the data home, the backend controller, the `eidolon-app:` scheme and its
  forwarder, the window, the menus, the tray, the task watch and the logs. No backend code runs in
  it or in the window: `apps/desktop/src` loads at run time only `electron`, `electron-updater`,
  `electron-log`, `undici`, `node:*` and its own modules, and takes `@eidolon/*` and `apps/bot` as
  types alone (`test/boundary.test.ts`). So main imports no `@eidolon/config` either: it finds the
  payload through `process.resourcesPath` when packaged, or the checkout when not, and mirrors the
  few things it needs (`jsRuntime().args`, `dataHome()`), each held equal to the original by a
  test.
- **The backend** is the local server, run by the app's own binary as Node
  (`ELECTRON_RUN_AS_NODE=1`): packaged, the payload's `dist/server.js`; unpackaged, the checkout's
  `apps/bot/src/local/server.ts`, whose types the dev Electron's Node strips. Its jobs, grep's
  matcher and the `eidolon` command its tasks run start the same binary through `jsRuntime()`, and
  so does an MCP server through the [node shim](#the-node-shim).
- **The window** is one BrowserWindow: a sandboxed renderer with context isolation, no Node
  integration and no `<webview>`, and the preload, `dist/preload/index.cjs`.

### Startup

`instance.ts` runs first, before any other module can touch the profile or start a log:

1. [Background mode](#background-mode) is read first of all: on macOS it makes the app an
   accessory from main's first line, though macOS has shown the launch's Dock icon for its first
   50–150 ms by then.
2. A packaged launch with `--remote-debugging-port` or `--remote-debugging-pipe`, which no fuse
   covers, exits 1 before the profile, the logs and the lock exist.
3. Unpackaged, the profile (userData) becomes `<appData>/Eidolon Dev`, unless the launch passes
   `--user-data-dir`, as a test run does. Whenever the profile isn't the default, the logs move
   into `<profile>/logs`: on macOS `app.getPath("logs")` is `~/Library/Logs/Eidolon` whatever the
   profile, so a test would append to the installed app's logs.
4. The single-instance lock, scoped to the profile. A second launch shows and focuses the window,
   from hidden or minimized, or makes it again if the page closed it; with `--quit` it quits the
   running app through the normal quit, and with no app running it exits 0 and starts nothing.

Then main registers the scheme and, on Windows, sets the AppUserModelID `live.laplace.eidolon`,
which the installer's shortcut carries, and the installed app's toast activator
([Notifications](#notifications)), before any window. Once Electron is ready it installs the
session's permission handlers, the scheme's handler, the bridges' handlers, the menus and, on
Windows outside background mode, the tray, opens the window on the loading page (kept hidden after
a [launch at login](#open-at-login)), and only then reads the environment, resolves the data home
and starts the controller. The window moves to `eidolon-app://app/` once the backend is ready.
The data home is `EIDOLON_HOME` from that environment, else `~/.laplace/eidolon`
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
  server never falls back by itself. In [background mode](#background-mode) the first spawn asks
  for `--port 0` straight away.
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
  blocked would never reach), and `session-end` waits, blocking, up to about 4 s for every stop
  under way: that one, or a quit's or a failure's begun before the owner signed out, since Electron
  ends main, and the backend in its job object with it, once `session-end` returns. If another app
  vetoes the shutdown, the backend starts again 10 s later.
- **Its waits** (the 60 s after a refused spawn, an attached server's grace, the hold on our own
  backend after a refused connection, and the forwarder's 15 s hold) count the timers' time
  (`performance.now()`), not the wall clock's. A Mac's sleep stops the first and moves the second
  on, so a wait spanning a sleep would end at its first probe after waking, and stop a healthy
  backend as unanswered.

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
  also still name that address and the pid main attached to, alive: a relay on the old port can't
  pass the probe on to a server that moved, and a server restarted at that address, which holds
  the same token, is attached to afresh through a grace period, as the new process it is, whose
  version main reads. A connection that doesn't prove itself is destroyed and handled as a refused
  one. The cost is one loopback round trip per new connection, under the probe's 2 s deadline.
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
  a document answered with a 5xx as a console error, which a walk such as local-smoke's counts as a
  failure.
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
  main never opens the `.lock` itself. A server whose `.info` records no `host`, one from before the
  hint carried it, is never probed: the probe proves only what answers on one address, and with the
  server on `::1`, another local account could bind `127.0.0.1` and relay it.
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
  follows it, for the bridge and the About panel. Main reloads the app's page when a server other
  than the one it loaded the page from is ready next at another version, or at one its 2 s read
  missed: after a grace that ends on our own backend, or a terminal's server restarted onto another
  version. A restart onto the same version keeps the page, which apps/web's restart flow recovers
  without a reload, and so does the page's own server when its version reads only later.

## The window

One window, 1280×820 at first and at least 520×600, never larger than the work area of the display
it opens on (the primary one, centred, when it has no position, as at first), hidden until its first
page is ready to paint, at the bounds it had last: `window-bounds.json` in the profile, written
through a temporary file. A saved position is dropped when no display shows 100×40 px of the
window's top, and a window saved maximized is maximized only at its first showing once it has
painted, since `maximize()` shows a hidden window. Main owns its title.

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
  `setLanguage` and `onCommand`; and five calls the page awaits, each an invoke main answers
  through `ipcMain.handle`: `chooseFolder` (the folder dialog, below), `loginItem` and
  `setLoginItem(on)` ([Open at Login](#open-at-login)), `terminalCommand` and
  `setTerminalCommand(action)` ([the terminal command](#the-terminal-command)). The preload sends
  only what main takes (`true` or `false`, `install` or `remove`) and hands the page main's answers
  only in the shapes `src/shared/bridge.ts` declares. A shell page gets `window.eidolonShell`:
  `retry`, `showLogs` and `quit`. Main takes each message only from the window's own webContents
  and main frame, on the channel's own page, judged by the frame's origin, never its URL: a
  sandboxed document the backend serves has an app URL and an opaque origin (`accepts()` in
  `src/shared/bridge.ts`). An invoke's sender is judged before anything awaits, since its frame
  reads null once the page navigates; one from anyone else, or with another kind of argument,
  throws (`app-invokes.ts`).
- **The theme** the page reports goes to `nativeTheme.themeSource` as it is, `system` included: a
  resolved theme would pin `prefers-color-scheme` and stop the page's System from following the OS.
  Native menus, dialogs and Windows' caption buttons follow it.
- **A command** for the app's page, a menu's Settings… (⌘, on macOS, the tray's on Windows) or a
  notification's click (`tasks`, or `open-task:<chat>:<task>`, which `openTaskCommand` builds from
  two ids alone), goes to it once its script says it listens, so it reaches the page from the
  loading page or a new window too. A page that doesn't know a command ignores it.
- **The folder dialog,** which Settings → Assistant Mode's Choose Folder opens for its folders
  (`folder-dialog.ts`): the native one, for one folder, a sheet on the window on macOS, in the
  shell's language, and opening at the home folder, since Electron opens Downloads otherwise.
  macOS's can make a folder and says what the folders are for, and Windows' keeps the pick off its
  recent list. One shows at a time: an ask while it's open gets its answer (`joinPending`). The
  page adds the pick to the folders' draft; saving decides, and `FolderPolicy` after it.
- **Chrome.** No system title bar. On macOS, `hiddenInset`, the traffic lights at `{x: 16, y: 20}`,
  centred on the web app's 56 px first row, and `titleBarOverlay: true`, without which macOS
  publishes no `env(titlebar-area-*)` for the page's insets. On Windows, a hidden title bar under a
  transparent 56 px overlay, whose caption glyphs main recolours on each theme change.
- **Menus and the tray.** macOS's menu bar is declared in full, since a custom menu replaces
  Electron's: Eidolon (About, Check for Updates…, Settings…, Services, Hide, Hide Others, Show All,
  Quit), Edit (its roles, without which copy and paste break), View (zoom, full screen, and Toggle
  Developer Tools only unpackaged), Window (⌘W hides) and Help (Show Logs, Open Data Folder,
  Licenses). Windows has no menu bar: main sets a menu of View's zoom roles alone, since Electron
  would otherwise install its default one, whose accelerators act even under a hidden title bar,
  and a notification-area icon holds the rest for the whole run (Open Eidolon, Settings…, Check for
  Updates…, Show Logs, Open Data Folder, Licenses, About Eidolon, Quit Eidolon); a click on it
  opens the window. Check for Updates… is there only when the app [updates itself](#updates) or
  runs from a read-only volume, and disabled while a check, a download or the restart runs. Both
  get a context menu, since Electron has none: cut, copy, paste and select all in a field, copy
  over selected text. The About panel names the app's version and the server's.
- **Strings.** The shell's own words (`src/main/strings.ts`: menus, the tray, dialogs,
  notifications, macOS's password prompt and the shell pages) come in English and Simplified
  Chinese, following the language the page reports and the system's until it has. Menus and the
  tray are rebuilt when it changes. Labels are Title Case, which `strings.test.ts` checks with
  apps/web's own rule.
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
  window, stops the task watch, removes the tray icon, stops its backend, and quits. The restart
  that installs an update goes the same way, with its own box ([Updates](#updates)).

## Notifications

While the window isn't focused, the OS's notifications tell the owner of her tasks: one that comes
to wait on them, and one that ends. `task-notices.ts` decides without Electron, and
`test/task-notices.test.ts` covers it on fake answers and a fake clock; `native.ts` shows each
through Electron's `Notification`.

- **The watch** (`TaskWatch`) asks the server ready now, our own or one attached to, for
  `GET /api/local/tasks` with main's Bearer (`Backend.get`, GET alone): every 3 s while a task
  runs and every 30 s otherwise, each request aborted after 10 s. A ready server it doesn't follow
  yet, a restarted one included, starts it on a new baseline: the first answer records every task
  as it stands and tells nothing, closing only the notices it outdates. An attached server's hold
  at each idle close leaves it be (`followBackend`); no server, or an approved quit, stops it. A
  failure logs once a streak (`Eidolon: notifications couldn't read the tasks: …`) and tries again
  in 30 s.
- **What is told,** after the baseline: a task that ended, however it ended, and one that waits on
  the owner for something it didn't wait for at the poll before (its status, its card's question
  and its pause, compared as one key): its start, a path outside its folders to read or write, a
  site, a command, an MCP call, a spend, stall or unpriced pause, an interruption, or anything else
  it waits on. A new wait replaces the task's notice, a wait that's over closes it, and an end
  replaces it and stays.
- **Only while the window isn't focused** at the poll that sees the change: one seen while it is
  focused is recorded, and never told later.
- **What one says:** her name as its title, the task's chat's persona as `GET /api/local/personas`
  names her (read once a baseline, and again for a persona it doesn't know), else `Eidolon`; a fixed
  phrase for its kind in the shell's language; and her goal on a second line, made one line,
  without control, format or bidi characters, and cut at 80 characters. Never what a worker wrote
  or a page it read could have: no command, path, site, tool or arguments, no step, file name,
  report or error.
- **It answers nothing.** A notification has no action and no reply: only the task's card and the
  waiting bar answer a task. A click shows the window and, while the server's status counts no live
  call (a page that leaves a call hangs it up), opens the task in its chat
  (`open-task:<chat>:<task>`), or the Tasks page for a task without one (`noticeCommand`).
- **Its handle** is kept by task until the task's next notice replaces it or its wait ends: Electron
  drops a notification nothing holds, and its click with it.
- **Which copies:** the packaged app, on Windows only its installed copy (`isUpdatableInstall`),
  since another would point the installed app's Start menu shortcut and its COM key at itself; and
  any copy in background mode, which only logs them. Any other runs no watch, and says so once in
  main.log: `Eidolon: notifications are off in this copy of the app`. The installed Windows app
  pins its toast activator's CLSID before any notification: Electron otherwise makes one up
  whenever the shortcut has none, as after each update rewrites it, and registers each under HKCU
  for good.
- **Background mode** runs the watch but makes no `Notification` ([below](#background-mode)), and
  logs each instead:
  `Eidolon: background mode didn't show a notification: <title>: <line> / <line>`.

## Open at Login

Settings → Desktop's switch ([web-app.md](web-app.md#in-the-desktop-app)) has the OS start Eidolon
when the owner logs in, its window hidden. `system-options.ts` decides without Electron, and
`test/system-options.test.ts` covers it. Only the owner's click there changes the login item,
never an install, a launch or an update; a launch reads only whether it was the login item's.

- **Which copies:** the packaged app outside background mode, on macOS in the Applications folder
  (`app.isInApplicationsFolder()`) and on Windows NSIS's per-user install (`isUpdatableInstall`):
  a login item for a copy that moves, or that an update replaces elsewhere, would start the wrong
  app. Any other copy reads nothing and answers `unavailable` with why (`background`,
  `unpackaged`, `outside-applications` or `not-installed`), which Settings says. The [terminal
  command](#the-terminal-command) is offered in the same copies (`optionsUnavailable`).
- **macOS** registers the app itself through SMAppService (`{openAtLogin}`, with no type, and no
  hidden flag, which SMAppService lacks). It reads `on` while enabled, `needs-approval` while the
  owner has it off under System Settings → General → Login Items, where Settings sends them, and
  `unavailable` when SMAppService can't find the app.
- **Windows** writes its HKCU Run entry with `--opened-at-login`, which a read must name to match
  it. It reads `on` only while the entry is there and Startup apps leaves it on, and turning the
  switch on enables one turned off there again.
- **A change** is logged (`Eidolon: Open at Login was turned on`, or `off`), then read back:
  Electron's write answers nothing and only logs a failure.
- **The hidden start.** A launch at login, told by the switch on Windows and by
  `wasOpenedAtLogin` on macOS, makes the window but keeps it hidden (`Eidolon: opened at login, so
  the window stays hidden until it's asked for`), and the backend starts as always. The Dock, the
  tray, a second launch, a menu item or a notification's click shows it, and its first showing
  takes the saved maximize. The window is made all the same because Windows delivers
  `query-session-end` and `session-end` to windows: with none, a sign-out would skip [the backend's
  stop](#the-backend). The updater's launch check, and the box it may open, waits for that first
  showing. NSIS's relaunch after an update passes `--updated`, not the switch, so that start shows.

## The terminal command

Settings → Desktop installs `eidolon` for the owner's own terminals, and removes it, on their click
alone: `eidolon <command>` runs the CLI on the app's binary as Node, and `eidolon` alone opens
Eidolon. It is apart from the `eidolon` a task's commands run, which the backend writes into
`<data home>/bin` ([assistant.md](assistant.md#commands)). `terminal-command.ts`, ported from
deepseek-harness, reads and changes it, and `test/terminal-command.test.ts` covers it on temporary
folders and fake runners.

- **The launchers** ship in the app's resources, never written at run time: the signed bundle is
  sealed, and every update replaces the Windows install folder. `launchers/mac/eidolon` (sh, 0755)
  becomes `Eidolon.app/Contents/Resources/bin/eidolon`, and `launchers/win/eidolon.cmd` (CRLF,
  which cmd.exe needs) `resources\bin\eidolon.cmd`. Given arguments, one sets
  `ELECTRON_RUN_AS_NODE=1`, `EIDOLON_APP_ROOT` to the payload and `EIDOLON_NO_DOTENV=1`, runs the
  app's binary with `--disable-sigusr1 --use-system-ca` on the payload's `dist/cli.js`, and exits
  with its code; `EIDOLON_HOME` is the terminal's, so it finds the data home the app does. Given
  none, it opens the app: `open` on macOS, and on Windows `start`, with `ELECTRON_RUN_AS_NODE`
  cleared. The macOS one follows its links to find its bundle. The Windows one is a `.cmd`, which
  Git Bash runs as `eidolon.cmd`, and on which Ctrl+C asks cmd's `Terminate batch job (Y/N)?`.
- **macOS** links `/usr/local/bin/eidolon` to this copy's launcher. That link reads `installed`;
  nothing there, or a link to another copy's launcher (an app moved since), reads `absent`, which
  Install replaces; anything else, a link into a renamed bundle (`Eidolon 2.app`) or a path it
  can't read included, reads `taken`, and Install leaves it. Where `/usr/local/bin` is writable it
  links or unlinks at once; otherwise `osascript` asks for an administrator's password, with the
  shell's prompt, and runs only `mkdir -p`, `ln -sfh` or `rm -f` on those fixed paths, never
  Eidolon's binary. A cancelled prompt (AppleScript's -128) answers `cancelled`, of which Settings
  says nothing; another failure answers `failed`, which Settings toasts, and main.log says why.
  Remove takes away only Eidolon's link, this copy's or another's.
- **Windows** appends `<install>\resources\bin` to `HKCU\Environment`'s `Path`, so an `eidolon`
  the owner already has stays first, and Remove takes it out, through one PowerShell run each
  (`userPathScript`, encoded by `powershellArgs`). It reads the value raw, compares entries as
  Windows reads them (without case, variables expanded, a trailing backslash or none), adds or
  removes that folder alone, and writes the value back with its kind, never through
  `[Environment]::SetEnvironmentVariable('Path', …)` or `setx`; then it broadcasts the change, so
  the terminals Explorer starts after see it. It reads `installed` or `absent`, the folder being
  its path, and a read that fails reads `absent` and is logged. Each read starts PowerShell, 1–3 s
  cold.
- **Which copies:** those that offer [Open at Login](#open-at-login); any other reads and changes
  nothing. Each install and removal is logged in main.log.
- **What an uninstall leaves:** deleting the app on macOS leaves `/usr/local/bin/eidolon`
  dangling, which works again for a copy put back in its place and reads `absent` for one
  elsewhere, whose Install replaces it; NSIS's uninstaller leaves the folder on the user `Path`.

## The environment

The backend runs on the environment main reads, plus four variables of its own, and never a `.env`.

- **macOS.** An app started from Finder or the Dock inherits only launchd's environment, without the
  `PATH` and variables a terminal has, so main reads the owner's login shell (`login-shell.ts`,
  ported from deepseek-harness): the account's shell (`os.userInfo().shell`), then zsh, bash and sh,
  each run as `-ilc` with delimiters around `env -0`, 10 s apiece, its process group killed on a
  timeout or a quit. When every one fails, the launch environment stands, and main.log names why.
- **Windows.** The launch environment holds the registry's variables as they were when Eidolon
  started, and a `PATH` folder a tool's installer adds later would reach no spawn until a
  relaunch, so main reads the registry (`registry-environment.ts`). One `powershell.exe` run, by
  its full path under `SystemRoot` as main runs every PowerShell (`powershellExe`: Windows looks
  for a bare name in the current folder first, and `eidolon` starts the app in the terminal's), its
  script encoded (`powershellArgs`) and its output UTF-8, prints the raw values and kinds of
  `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, `HKCU\Environment` and
  `HKCU\Volatile Environment`, in Windows' own order. Not reg.exe, whose redirected output follows
  the OEM code page and garbles a path that isn't ASCII. A failure, or no answer in 10 s, leaves
  the launch environment, and main.log says why (`Eidolon: couldn't read the registry's
  variables, so the backend runs on the launch's: …`); a quit kills the run.
- **The merge.** The shell's values win, except `PWD`, `OLDPWD`, `SHLVL`, `_` and the probe's own
  variables; `ELECTRON_*`, which never come from the shell; and an `EIDOLON_*` the launch
  environment sets to a non-blank value, so a test's or a terminal launch's `EIDOLON_HOME` holds.
  The registry's go over the launch environment as Windows builds a new process's, but for the
  same names: key by key, each key's `REG_SZ` values before its `REG_EXPAND_SZ` ones, which expand
  against the variables so far (`%NAME%` without case, an unknown one left as written), and no
  other kind; `Path` is the system's, then the user's, joined by `;` as Windows joins them. The
  system key's `USERNAME` is SYSTEM, and Windows sets the account's before the user's key, so the
  launch's goes back there, and a user value's `%USERNAME%` names the owner. A variable deleted
  from the registry since the launch stays as the launch had it.
- **Windows' names have no case,** but a copy of the environment does, and spawn keeps only the
  first of two spellings, so main reads and writes names without case, one key each: a `Path`
  stays one key.
- **When.** Once at startup, which names the data home. The first spawn within 10 s takes that read,
  so a cold start runs the owner's rc files, or PowerShell, once; every later spawn reads afresh, so
  a Restart sees a `PATH` or a variable changed since, and on Windows every spawn after the first
  waits for PowerShell.
- **`EIDOLON_DESKTOP_LOGIN_SHELL=0`** (or `false`, `no`, `off`, in any case) in the launch
  environment skips the read, the login shell's on macOS and the registry's on Windows, and the
  launch environment is used as it is. A test run of the app sets it, and starts the app with no
  credential, setting or provider variable, as `local-smoke.ts` starts its server: otherwise a key
  the developer's shell or registry holds would reach the backend, win over the test's fake
  accounts (a non-empty variable beats `credentials.json`) and bill.
- **The backend's own variables,** set last: `EIDOLON_HOME`, the data home main resolved, so a
  respawn never serves another; `EIDOLON_APP_ROOT`, the payload, unset unpackaged so files resolve
  from the checkout; `EIDOLON_NO_DOTENV=1`, so no `.env` is read, unpackaged included; and
  `ELECTRON_RUN_AS_NODE=1`.
- **`ELECTRON_RUN_AS_NODE`** makes an Electron binary run as Node at any non-empty value, `0`
  included, so nothing sets it to mean off. Our own JS starts through `jsRuntime()`, which adds it
  inside Electron. A task's commands and MCP servers never get it from the backend, since
  `shellEnv()` passes listed names alone, and neither may any spawn that can start a program the
  owner chose, or an Electron app such as VS Code's `code` would run as Node. A [node
  shim](#the-node-shim) launcher sets it itself, for the process it runs on Eidolon's binary, and
  that process's children inherit it. yt-dlp keeps it on purpose: its JS runtime is the app binary.
  Electron's GUI starts without it: `dev:desktop` through `electronEnv()`
  (`scripts/electron-env.ts`), which deletes it from a copy of the environment, and the smokes on
  the environment `appEnv()` builds, which takes no `ELECTRON_*` name.
- **Node mode's flags.** Every node-mode process the app starts carries `--disable-sigusr1
  --use-system-ca` before its script: `jsRuntime().args` for the jobs, grep's matcher and the
  `eidolon` command, main's own copy, `BACKEND_RUNTIME_ARGS`, for the backend, and the same two in
  the terminal command's launchers, which a test holds to that copy, and the node shim's. With the
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
  the target's LanceDB binary, whose JS is inlined in `dist/`; and, which the npm package never
  holds, the [node shim](#the-node-shim) in `node-shim/`. Main runs `dist/server.js` with
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
  machine without the redistributable couldn't start the backend. Each folder in the payload's
  `node_modules` (not the node shim's) holding a native addon gets the runtime DLLs its natives
  import (their import and delay-import tables, and what those DLLs import in turn): onnxruntime's
  folder five, LanceDB's `vcruntime140.dll`. All come from the newest `Microsoft.VC14*.CRT` folder
  vswhere finds, since whichever copy loads first serves the whole process. Node loads an addon
  with `LOAD_WITH_ALTERED_SEARCH_PATH`, which looks in its own folder first, so an older System32
  copy can't win. The copies shadow System32's, and Windows Update never services them: each
  release refreshes them. The stage test checks their file version is at least the natives' linker
  version.
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
  package's, the node shim's pnpm and the packages its `dist/` bundles included, SPDX's text where
  one ships none, with libvips's LGPL-3.0-or-later text and where its source is for each package
  that ships libvips (on Windows, sharp's own platform package); the VC++ runtime's terms on
  Windows; then the payload's NOTICE, THIRD_PARTY_NOTICES.md (what its bundles and web app include)
  and the license files under `data/`. Main's build writes the licenses of what it inlines to
  `dist/main/THIRD_PARTY_LICENSES.md`, and `apps/desktop`'s `LICENSE-deepseek` and `THIRD_PARTY.md`
  cover the code ported from deepseek-harness.

## The node shim

An `mcp.json` entry that runs `npx`, `node`, `pnpm`, `pnpx` or `pnpm dlx` starts in the desktop app
on a computer with no Node: the payload holds launchers that run each on the app's own binary as
Node, and a pnpm, as deepseek-harness does. Where the owner has Node, theirs wins.

- **Its files,** in the payload's `node-shim/`: in `bin/`, `node`, `npx`, `pnpm` and `pnpx` (sh,
  0755), their `.cmd` twins (CRLF, each under `setlocal`) and `npx.mjs`; in `node_modules/pnpm`,
  the pnpm `apps/desktop` pins as an exact dev dependency, so `bun.lock` pins it as it pins the
  rest. `scripts/node-shim.ts`, ported from deepseek-harness, stages them from
  `apps/desktop/node-shim` and a copy of the installed pnpm, pruned of the natives its `dist/`
  bundles for other platforms (`prunePnpmForeignNativePackages`), its bundled packages' `.bin`
  links, and `dist/vendor`'s fastlist executables, which nothing runs and the Windows release would
  sign as Eidolon's. [The stage test](#the-stage-test) holds them to their sources, the pin and the
  target's natives, with no `.exe`. In a checkout, under `dev:desktop` and in the Electron lane,
  the launchers' folder is `apps/desktop/node-shim` itself, whose `../node_modules/pnpm` is the
  installed one.
- **A server gets it** from `serverEnv` (`packages/assistant/src/mcp/session.ts`) when the backend
  runs on Electron's Node and the launchers' folder is there (`shippedPath`): that folder last on
  the server's `PATH`, added before `shellEnv()`'s filter, which drops it as any other folder the
  task may write, and `EIDOLON_NODE`, the backend's own binary (`jsRuntime().command`). A `node`,
  `npx` or `pnpm` on the owner's `PATH` comes first. A task's commands never get it, and under Node,
  npx's or a checkout's, nothing changes.
- **The launchers** refuse to run without `EIDOLON_NODE`, then set `ELECTRON_RUN_AS_NODE=1` and run
  that binary with `--disable-sigusr1 --use-system-ca`: `node` passes its arguments on, and `pnpm`
  and `pnpx` run the bundled pnpm's own. The server inherits the variable, so one that starts Node
  as `process.execPath` runs Eidolon's binary as Node too. On Windows the launchers are `.cmd`
  files, which a shell or cross-spawn runs.
- **npx** runs `npx.mjs`, which turns npx's arguments into `pnpm --loglevel=error dlx …` and runs
  the bundled pnpm in that same process (`npxToPnpm`): `-y`, `--yes`, `-q` and `--quiet` dropped,
  each `-p X`, `-p=X`, `--package X` or `--package=X` as `--package=X`, then `--` and the first
  other word, with every word after it. pnpm reports dlx on stderr, so stdout, which the MCP
  protocol owns, holds only the server's output. An option it doesn't map exits 1, naming it.
- **pnpm's defaults hold,** not npx's: dlx runs the install scripts of the packages it is given,
  never their dependencies'; it picks no version younger than a day; it always fetches from the
  registry, never a project's own `node_modules/.bin`; and its store and caches are where pnpm
  keeps them, under the owner's home. One `--config.dangerously-allow-all-builds=true` in
  `npxToPnpm` would run every install script.
- **On Electron's Node,** a server's N-API native modules load, while one whose prebuilds are for
  Node's ABI alone looks for an Electron build; and macOS shows a shim-run server's permission
  prompts in Eidolon's name.
- **A pnpm bump** is an exact pin in `apps/desktop/package.json`, under the same 14-day gate as
  [Electron's](#bumping-electron); `bun install` rewrites `bun.lock`, which `docker.yml` doesn't
  skip, so merging it restarts production. Stage and package the app, then run the stage test.

## Packaging

`bun run package:desktop` runs electron-builder with `--publish never`, `-c.mac.identity=-` and
`-c.extraMetadata.version=0.0.0-dev`, and with `CSC_IDENTITY_AUTO_DISCOVERY=false`, so it never
signs with an identity from the keychain or asks for one. It needs `dist/` and warns when there is
no stage. On macOS it writes `.out/mac-arm64/Eidolon.app`, a DMG and a zip; on Windows an NSIS setup
and `.out/win-unpacked`. Its builds are unsigned: ad hoc on macOS, where that signs every Mach-O,
the payload's natives included, with the hardened runtime. The flags stay on the command line,
never in `electron-builder.yml`, which the release overlay extends: an identity there would replace
the release's Developer ID, and `test/release-config.test.ts` fails on one. Only `desktop.yml`
builds signed, from a release's tag or a `sign` dispatch ([Releasing](#releasing)).

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
- **The [terminal command](#the-terminal-command)'s launchers** ship as each platform's extra
  resource too, `launchers/mac` or `launchers/win` as `bin`: `Eidolon.app/Contents/Resources/bin`,
  or `resources\bin`. `launchers/.gitattributes` keeps the `.cmd` CRLF.
- **The fuses,** each one listed, since an unlisted fuse keeps Electron's default: `runAsNode` on,
  for the backend, its jobs, the `eidolon` command and the node shim; the nodeOptions and CLI
  inspect fuses off; asar integrity and loading the app only from the asar on;
  `grantFileProtocolExtraPrivileges` off, since no page loads over `file:`; cookie encryption and
  the browser-process V8 snapshot off, their defaults. `wasmTrapHandlers` keeps its default, on, as
  electron-builder has no key for it. `resetAdHocDarwinSignature`, beside them, re-signs an
  unsigned build ad hoc after the fuses change, so it launches on Apple silicon.
- **macOS:** arm64 DMG and zip, the hardened runtime, the entitlements (`allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`, which ad-hoc signing with the
  hardened runtime needs, and `audio-input`; no camera), and the microphone's usage string. The DMG
  writes no update info: updates will take the zip.
- **Windows:** a per-user, one-click NSIS setup for x64, whose shortcut's AppUserModelID is the
  `appId`. `resources/installer.nsh` carries a workaround for electron-builder#6865; its uninstall
  removes the install folder alone. Installing, updating and uninstalling never touch the data home.
- **`publish`** names the update feed, which electron-builder writes into the app's
  `app-update.yml` for the [updater](#updates); electron-builder uploads nothing (`--publish never`).

`electron-builder.release.mjs`, the release overlay, extends it with the signing; only
`desktop.yml`'s signed builds load it, and `test/release-config.test.ts` checks what it computes and
what electron-builder's own loader and schema make of it:

- **`publish.publisherName`:** `Sparanoid, Inc.` and `LAPLACE Live LLC`, the signer names a Windows
  install accepts updates from ([Signing identities](#signing-identities)).
- **macOS:** `notarize`, with the App Store Connect key from `APPLE_API_KEY`, `APPLE_API_KEY_ID` and
  `APPLE_API_ISSUER` (notarizing staples the app); `forceCodeSigning`, so a build that finds no
  Developer ID fails rather than ships ad hoc; and `requirements`, the designated requirement in
  `resources/designated-requirement.mac`, whose name has no `.txt`: GitHub's dependency graph read
  `requirements.mac.txt` as a package list and failed on it. The DMG stays unsigned and
  unnotarized: electron-builder notarizes and staples only the app inside it, and updates take the
  zip.
- **Windows,** added only when it runs on Windows, since electron-builder's schema requires the
  Azure names only that leg's environment has: `azureSignOptions` (Azure Trusted Signing at
  `https://eus.codesigning.azure.net`, the account and profile from `AZURE_SIGNING_ACCOUNT_NAME` and
  `AZURE_CERTIFICATE_PROFILE_NAME`), `forceCodeSigning`, and `signExts`, the names in
  `.stage/win32-x64/unsigned-pe.json` ([The payload](#the-payload)), without which it throws.
  electron-builder signs only `.exe` files unless told, and signs every file whose path ends with a
  listed entry: an extension would re-sign Microsoft's DLLs over their signatures. Signing made the
  Windows packaging 43–57 s longer on CI's runner, 2–4 s a file.

The app needs macOS 13 or Windows 10 (x64), Electron's minimums.

## Releasing

A desktop release is a `laplace-eidolon-desktop@X.Y.Z` tag, and only the Release workflow makes one
([releasing.md](releasing.md)): a changeset that names `laplace-eidolon-desktop` puts it in the
version PR, which bumps `apps/desktop/package.json` and writes `apps/desktop/CHANGELOG.md`, and
merging that PR pushes the tag with the release bot's token and creates its GitHub Release from the
changelog. The tag runs `desktop.yml` in the tagged commit:

1. **The tag check,** on each leg: it fails unless the commit is on master and the tag names
   `apps/desktop/package.json`'s version. No ruleset guards the tags, so this is what keeps a token
   that can push one from shipping a signed release of any other commit.
2. **The signed build,** on each leg ([In CI](#in-ci)): the release overlay with that leg's own
   secrets alone, then [the signed build's checks](#the-signed-builds-checks), then every check an
   unsigned build gets, the packaged smoke of the signed app included. Once all of them passed, the
   leg keeps its installers, the macOS zip, the blockmaps and `latest*.yml` as `<OS>-installers`,
   for 90 days.
3. **The upload,** a job of its own after both legs, so that a re-run sends the very bytes the legs
   signed, where re-running a leg would sign new ones. Through the S3 API, to the `downloads`
   bucket that `https://downloads.vrp.moe` serves:
   - each installer and blockmap once, to `eidolon/v<version>/`, cached for a year as immutable. It
     reads the SHA-256 the first upload stored with the key, and fails when another object is
     there: Cloudflare would keep serving the first, and electron-updater rejects other bytes on
     their checksum. It fails unless the legs left one DMG, one zip, one setup, the zip's and the
     setup's blockmaps and both manifests, rather than upload less;
   - `latest-mac.yml` and `latest.yml`, uncached, with `url:` and `path:` pointed into
     `v<version>/` (electron-updater resolves both, and the previous version's blockmap it derives
     from them, against the manifest's own URL) and the update dialog's notes appended, the one
     `eidolonNotes:` line `node scripts/changelog.ts manifest` prints: first to `v<version>/`, then
     to flat `eidolon/`, where installs look;
   - the download links, uncached: `eidolon/Eidolon-mac-arm64.dmg` and
     `eidolon/Eidolon-win-x64.exe`, the version's DMG and NSIS setup;
   - `eidolon/changelog.json`, uncached: the repository's `changelog.json`, every release's notes,
     for the website, at `https://downloads.vrp.moe/eidolon/changelog.json`. It changes only with a
     desktop release, so a release of the npm package or the SDK alone reaches the website's copy
     with the next desktop one.

   None of the flat files is written when the flat manifests R2 serves already name a newer
   version: an older release's late upload, a re-run of its failed job or a slower notarization,
   would point the feed, the links and the website back at it. Its `v<version>/` files still go up.
   Uploads run one at a time across releases, queued in the `desktop-r2-upload` concurrency group,
   since two at once could both find R2 serving neither and the older write last; index rebuilds
   queue the same way in `desktop-r2-index`.
4. **The index:** `eidolon/releases.json`, the website's version history at
   `https://downloads.vrp.moe/eidolon/releases.json`, rebuilt from a listing of `eidolon/v*`: each
   version with the date of its first file, and its files but the blockmaps and manifests, each by
   its URL from `eidolon/` and its size. It runs after the upload whatever became of it, so it
   always lists what R2 holds.

Nothing under `eidolon/v<version>/` is ever deleted or changed: installs download from there. A
re-run sends the same bytes: the installers and blockmaps pass the check of the SHA-256 stored with
each, and the manifests are made again from those and the tag's `changelog.json`.
Every check of an object goes through the S3 API, never `https://downloads.vrp.moe`, whose zone
answers curl and scripts with a challenge; electron-updater, whose user agent is `electron-builder`,
gets through.

### Dispatches

A dispatch of `desktop.yml` builds unsigned, at `0.0.0-dev`, unless an input says otherwise:

- **`sign`** builds signed, as a tag does, at `0.0.0-dev` on the `dev` channel, whose manifests are
  `dev-mac.yml` and `dev.yml`. It keeps the installers, zip, blockmaps and manifests a day as
  `<OS>-installers-signed-unreleased`, never on R2: in this public repository any signed-in user can
  download a run's artifacts.
- **`update_test`** builds 0.0.1 and 0.0.2 signed and updates the one to the other through the real
  updater, on both platforms, on a feed of its own ([The update test](#the-update-test)).
- **`release_index`** rebuilds `releases.json`.

A dispatch takes one of the three at most, and the build job runs only without them. All three run
only on `master` and `electron`, and a run elsewhere fails before any secret is read. `electron`
stays a signing ref after the release work merged: it is where a signed build or the update test
runs before a change reaches master.

### Recovery

- **A failed upload:** "Re-run failed jobs". It sends the same bytes again, which the SHA-256 check
  lets through, then the manifests, the links, `changelog.json` and the index. Never "Re-run all
  jobs" once an upload began: the legs would sign new bytes, which the upload refuses.
- **An upload that fails on its own fault** fails again on a re-run, which runs the workflow as the
  tag has it: the fix reaches only the next release. The failed one keeps what went up under
  `v<version>/`, which `releases.json` lists, and the flat feed and links wait for the next.
- **A failed leg** uploaded nothing: "Re-run failed jobs" builds and signs it again, then uploads
  both legs.
- **A missing tag,** when the Release workflow failed before it pushed one: re-running that workflow
  tags it ([releasing.md](releasing.md)).
- **A bad release** is withdrawn by shipping a higher version, since electron-updater never offers a
  lower one. Copying an older version's manifests and the download links back to flat `eidolon/`
  only stops new installs of the bad one.

### Signing identities

- **A Windows install takes updates signed only by a name it already trusts.** Each setup it
  downloads is checked against the signer names frozen into the install's `app-update.yml`, the
  overlay's `publish.publisherName`, and refused otherwise; nothing on the feed widens an installed
  list. The check is the app's own (`update-signature.ts`, electron-updater's
  `verifyUpdateCodeSignature`): `Get-AuthenticodeSignature` must call the setup Valid and its
  signer's CN one of the names. electron-updater's own check takes a PowerShell that fails or
  doesn't answer within 20 s, then a 10 s probe, for an old one, and installs the setup
  unchecked; on a CI runner PowerShell's cold start took that long. The app's waits 120 s and
  refuses the update when the check can't run, and main.log says which: `Eidolon: the update's
  signature is valid`, or why it doesn't check out. Every
  release lists both of the org's names. Signing as a third takes an overlap: add it to
  `PUBLISHER_NAMES`, keep signing as a listed name until installs have moved onto a release that
  lists the new one, then switch the Azure profile secrets. An install that sits the overlap out
  needs a reinstall.
- **macOS pins the Apple team the same way.** Squirrel.Mac, under electron-updater, installs an
  update only when it satisfies the running app's designated requirement, and the microphone grant
  is tied to it too. `resources/designated-requirement.mac` accepts either of the org's teams,
  `B5483RCL5H` or `9H3CCD4YMM`; electron-builder stamps it on every file it signs, helpers included,
  so it names no bundle identifier, which would fail the helpers. Another team takes the same
  overlap: ship a requirement that names it, signed by a team the old one accepts, then switch
  `APPLE_CERTIFICATE` and `APPLE_API_*`.

### The signed build's checks

`scripts/signed-check.ts` (`node apps/desktop/scripts/signed-check.ts`, on what a signed package
step left in `.out`) prints a `PASS` or `FAIL` line per check, as the smokes do, and exits 1 when
one failed. `test/signed-check.test.ts` holds its verdicts to the tools' own output.

- **macOS,** on `.out/mac-arm64/Eidolon.app`: `codesign --verify --deep --strict` passes; `spctl
  --assess` accepts it as a notarized Developer ID; `stapler validate` finds the ticket; every
  `.node` and `.dylib` in the payload has the hardened runtime and a secure timestamp from Apple's
  server, which neither an ad-hoc signature nor `Signed Time` alone gives; and the designated
  requirement of the app and of each helper app and framework is the requirement file's, as `csreq
  -t` prints it.
- **Windows:** it installs the setup silently for the user, refusing where Eidolon is installed
  already, then reads `Get-AuthenticodeSignature` on the setup and on every PE file of the install,
  found by its headers whatever its name. Each must be Valid and timestamped, since a Trusted
  Signing certificate lasts three days and an untimestamped signature lapses with it. The setup,
  every `.exe` in the install (`Eidolon.exe`, the uninstaller, `elevate.exe`) and every name the
  stage listed must be signed by one of `publish.publisherName`'s names; every other file must keep
  the Microsoft signature it came with (`MICROSOFT_SIGNERS`): onnxruntime's, the VC++ runtime and
  Electron's `d3dcompiler_47.dll`. The install must hold each of those and every listed file, so no
  check passes on nothing. Then it uninstalls.

### Secrets

Each leg gets its own platform's alone. `desktop.yml`'s jobs call `desktop-build.yml` (and the update
test's, `desktop-update-test.yml`), which hold the steps: the unsigned `build` passes no secret,
and `signed-mac` and `signed-win`, whose own `if` admits only a tag or a `sign` dispatch on
`master` or `electron`, pass their platform's alone. That `if` is GitHub's, read before a runner is
given; a step's `if` runs on the runner, so a secret any step of a job names reaches every runner
of that job, a pull request's included. A dispatch's inputs are checked first, by the `inputs` job.
In the signed package step:

- **macOS:** `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD`, as `CSC_LINK` and
  `CSC_KEY_PASSWORD`, which on Windows would send electron-builder to signtool (it imports the
  Developer ID certificate into a temporary keychain itself); `APPLE_API_KEY`, written to
  `$RUNNER_TEMP/apple-api-key.p8` by the step before and removed by one after, whatever happened;
  `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
- **Windows:** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_SIGNING_ACCOUNT_NAME` and `AZURE_CERTIFICATE_PROFILE_NAME`.

Those are the org's secrets. The upload and the index take the repository's own:
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and `CLOUDFLARE_ACCOUNT_ID` for the endpoint. Before
the signed package step nothing runs that the run fetched, but the toolchain and what `bun.lock`
pins, and no package's install script, which could rewrite the electron-builder the step runs with
the secrets. In that step electron-builder installs Azure's TrustedSigning module from the
PowerShell Gallery, at its newest version, to sign with.

Only a run proves the release: the overlay and the checks' verdicts have their tests, but signing
needs a `sign` dispatch from `master` or `electron` that passes both legs, the update an
`update_test` dispatch, the index a `release_index` dispatch, which rewrites the live
`releases.json` from R2's listing, and the upload, with the R2 credentials, a release's tag.

## Logs

- **Where:** `app.getPath("logs")`: `~/Library/Logs/Eidolon` on macOS, `%APPDATA%\Eidolon\logs` on
  Windows, or `<profile>/logs` for a profile that isn't the default (unpackaged, or a
  `--user-data-dir`). Show Logs, in the Help menu on macOS and the tray on Windows, opens it.
- **`main.log`:** main's own lines at info and up, `console` included; uncaught errors in main,
  with no dialog; renderers and Electron's helpers going away. Each run starts with a line naming
  the app's version, Electron's, Chromium's and Node's, and the OS. The window's page, a failed
  load, a renderer gone, a landing off the app and background mode's lines give a URL without its
  user name, password, query or fragment (`loggedUrl()` in `policy.ts`), and the forwarder's
  failures only its path.
- **`backend.log`:** the backend's stdout and stderr, each line timestamped, since it carries its
  own level, and echoed to the terminal unpackaged. Main never logs a line that holds a link code:
  `log-filter.ts` drops `Eidolon is ready:` and `Eidolon is already running:` (and any other line
  holding one) after the controller has read them.
- **Rotation:** each file moves aside at 2 MB, to `main.1.log` through `main.5.log` and the like.
  The log moves first, to `main.0.log`, and only then do the archives move along, the oldest
  dropped. A log Windows won't rename, because another program holds it open without delete
  sharing (a tail such as `Get-Content -Wait`, or an antivirus scan), is copied there and emptied
  instead. Nothing in the rotation throws: electron-log would lose the line and, its size count
  still over 2 MB, rotate again at every later line. An archive held open stops the rotation where
  it is, the log left at `main.0.log` until the next rotation replaces it.
- There is no `log.initialize()`, which would inject electron-log's own preload into every session,
  and its IPC transport is off.
- **Lines a test can wait on,** in main.log: `Eidolon: background mode: nothing shows on screen or
  takes the focus, and nothing is heard (--mute-audio)`, right after the first line when it's on;
  `Eidolon: the data home is …`;
  `Eidolon: started the backend (pid N) on port P` or `Eidolon: using the server already on this
  data home, <origin>`; `Eidolon: the backend listens on <origin>`; `Eidolon: the window shows
  <url>`; `Eidolon: the window is shown`, `… is hidden` and `… is closed` as main's own record of
  the window changes, which counts it as shown once it has painted, in background mode too; and at
  a quit `Eidolon: quitting`, then `Eidolon: the backend (pid N) exited (0)`. Background mode also
  logs each thing it keeps off the screen ([below](#background-mode)), and the updater each of its
  steps ([Updates](#updates)).

## Updates

electron-updater checks the release feed, `https://downloads.vrp.moe/eidolon`, which
electron-builder writes into the packaged app's `app-update.yml` from `publish` in
`electron-builder.yml`. `src/main/update-flow.ts` makes every decision without Electron, as
laplace-persona's updater does but in native boxes, and `test/update-flow.test.ts` covers them;
`src/main/updater.ts` runs it on electron-updater's `autoUpdater`.

- **When it runs:** in a packaged install: on macOS anywhere but a read-only volume, and on
  Windows only NSIS's per-user install in `%LOCALAPPDATA%\Programs\eidolon`
  (`isUpdatableInstall`). Its installer installs there whatever runs it, so updating a copy
  anywhere else, such as `win-unpacked`, would leave a second install beside it. Not unpackaged,
  and not in background mode, unless a hook below says otherwise. main.log's `Eidolon: updates
  are …` line says which, and why.
- **A read-only copy on macOS:** run from its mounted DMG, or from the randomized read-only mount
  Gatekeeper translocates a quarantined app to, Squirrel.Mac refuses an update, but only once the
  whole zip has downloaded. So when `fs.accessSync` on the bundle's folder fails with `EROFS`
  (`readOnlyFolder`), nothing is checked, and Check for Updates… stays, to say in a box that Eidolon
  updates itself only from a folder it can write to: move it to the Applications folder, then open
  it again. A folder that is only not the user's to write, `/Applications` for a standard account,
  still updates: Squirrel.Mac asks for an administrator's password there.
- **Checking:** once, quietly, 10 s after the backend is first ready (after a [launch at
  login](#open-at-login), once the window has also shown), and from Check for Updates… (in macOS's
  app menu after About, in Windows' tray menu after Settings…), which is disabled while a check, a
  download or the restart runs. The quiet check only logs that the app is up to date or that the
  check failed; Check for Updates… also says so in a box. A check asked while one runs joins it.
- **Downloading:** nothing downloads unasked (`autoDownload` is off). "Eidolon X.Y.Z is available"
  offers Download, the default, Later and Release Notes, which opens the GitHub Release of
  `laplace-eidolon-desktop@X.Y.Z` in the default browser, through the link policy. After Later or
  Release Notes, Check for Updates… shows the box again without checking. The download's progress
  shows on the Dock or the taskbar, cleared when it ends or fails; a failure offers Try Again, the
  default, and Later. On macOS it is done only once Squirrel.Mac has fetched the zip from
  electron-updater's local proxy, after `update-downloaded`.
- **No box during a quit:** once a quit is under way, the window hidden and the backend stopping,
  a check that lands or a download that ends shows no box, only main.log's `Eidolon: no update box
  while quitting (available X.Y.Z)` or the like.
- **Installing:** "Restart to finish updating" offers Restart, the default, and Later, which leaves
  the update to `autoInstallOnAppQuit` at the next quit, with no relaunch. Restart moves the state
  to installing first, so a second Restart does nothing: `quitAndInstall` twice asks Squirrel to
  relaunch twice, which leaves two copies running. Then it goes the way a [quit](#the-window) goes:
  the quit check, whose box names what a restart stops (on Windows the installer kills any
  `Eidolon.exe` still running from the install folder, a CLI job's included); the latch, after
  which a close no longer hides the window; the backend's graceful stop; and only then
  `quitAndInstall(true, true)`, once. A Cancel there hands the state back to downloaded. None of it
  runs inside `before-quit`: on macOS `quitAndInstall` closes every window before `before-quit`
  fires, so a latch set there would let the hide-on-close window veto the relaunch, as persona's
  did from 0.32.0 to 0.63.2.
- **An error after the download,** such as Squirrel.Mac refusing the update, takes Restart away:
  the update is in error, and the box offers Try Again. One that comes while the restart's quit
  check asks calls the restart off once it's answered, before the latch: nothing is hidden or
  stopped, main.log says `Eidolon: not restarting, since X.Y.Z can't be installed`, and the
  failure's box offers Try Again. One that comes once the restart has stopped the backend, or from
  inside `quitAndInstall`, which then never quits, starts the app again as it was
  (`app.relaunch()`) rather than leave it hidden with its backend stopped.
- **main.log** has a line for each step: `Eidolon: checking for updates`; then `Eidolon: update
  available: X.Y.Z`, `Eidolon: up to date: X.Y.Z is the latest` or `Eidolon: the update check
  failed: <reason>`; `Eidolon: downloading X.Y.Z`; `Eidolon: update downloaded: X.Y.Z` or
  `Eidolon: the download of X.Y.Z failed: <reason>`; `Eidolon: restarting to install X.Y.Z`,
  `Eidolon: quitting to install the update` and `Eidolon: installing X.Y.Z`, or `Eidolon: X.Y.Z
  stays downloaded, to install at the next restart or quit`. A reason is the error's first line.
  electron-updater's own lines go there too, and every URL in either has no query or fragment
  (`loggedText()` in `policy.ts`).

The QA hooks are read from the environment the app starts with, as `.env.example` lists them:

| Variable | What it does |
| --- | --- |
| `EIDOLON_DESKTOP_DEV_UPDATE=1` | An unpackaged build checks the release feed through `apps/desktop/dev-app-update.yml` (`forceDevUpdateConfig`), which electron-updater reads only unpackaged, with a cache of its own, `eidolon-dev-updater`. A download and Restart act on the real release. Not in background mode |
| `EIDOLON_DESKTOP_MOCK_UPDATE=1` | Fakes the whole flow, as persona's `PERSONA_MOCK_UPDATE` does, packaged or not and in background mode too, and reaches no network: the check finds 9.9.9 after 0.6 s, the first download fails at 60 %, Try Again completes it, and Restart only logs, the update back to downloaded after 1.5 s so the run repeats. Nothing is checked, stopped or quit |
| `EIDOLON_DESKTOP_UPDATE_TEST=1` | For CI runners only: the one way the real updater runs in background mode, for [CI's update test](#the-update-test). A packaged install checks the feed its `app-update.yml` names, background mode answers Download, Restart and the quit check's box with their defaults, and the app stops its backend and installs, each step in main.log. Squirrel.Mac or the NSIS installer then starts the updated version outside background mode, on the default profile and the real data home, so a local run would end with a visible Eidolon |

A packaged build reads only its own `resources/app-update.yml`, so a test of an update builds its
older version with the feed it will serve (`-c.publish.url`, which electron-builder writes there),
as [the update test](#the-update-test) builds both.

## Background mode

`EIDOLON_DESKTOP_BACKGROUND` in the environment the app starts with, packaged or not, makes it a
background app: on for `1`, `true`, `yes` or `on` in any case, as the repo reads any flag, and off
otherwise. Local test runs use the machine the owner is working on, so a test must never put a
window, a dialog or a prompt in front of them, nor take the focus: every local test run of the app
sets it, an agent's Playwright walk included. `background.ts` makes each decision without
Electron, and `test/background.test.ts` covers them; `native.ts` puts each of Electron's calls
that could show something through it.

- **macOS:** the app is an accessory from its first module (`app.setActivationPolicy("accessory")`
  in `instance.ts`): no Dock icon past the launch's first 50–150 ms (the limits below), and it
  never becomes the active app.
- **Windows:** no tray icon, so no notice at the first hide either, and no taskbar button for the
  window (`skipTaskbar`).
- **No window is shown.** Main keeps and logs its own record of whether the window shows, as
  always, but calls no `show`, `focus`, `restore` or `maximize` (which shows a hidden window), and
  never `app.focus()`. Measured with Electron 45.4.1 on macOS, a window that is never shown still
  paints (`ready-to-show` fires), runs `requestAnimationFrame` at the display's rate and its timers
  on time, and takes Playwright's screenshots and clicks, with no Chromium switch and no
  `backgroundThrottling` change.
- **Nothing native appears, and main.log names each thing kept off the screen.** A message box is
  answered with its default button, so a quit that stops a call, a task or a job goes ahead. A web
  link, Show Logs, Open Data Folder, Licenses, the About panel and a context menu open nothing. A
  download saves, with no Save dialog, into the profile's `downloads` folder under the name
  Chromium suggests, numbered ` (1)` on while that name is taken. The folder dialog answers as
  Cancel (`Eidolon: background mode didn't open the folder dialog`).
- **No notification:** the task watch runs, but each notice is a line in main.log
  ([Notifications](#notifications)). Electron's `Notification` is never made, nor
  `Notification.isSupported()` called, since its presenter alone asks macOS for permission, and on
  Windows rewrites the Start menu shortcut and a COM key under HKCU; no toast activator is set
  either.
- **Nothing changes the owner's system:** Open at Login and the terminal command answer
  `unavailable` (`background`), which Settings says, and read and write nothing: no login item, no
  `/usr/local/bin` and no user `Path`, so no `osascript`, PowerShell or password prompt. A launch
  reads no login item, so it is never one at login.
- **Nothing is heard:** Chromium's `--mute-audio` is set before `ready`, so no page plays through
  the speakers, a call's reply included. WebRTC still receives that reply, so a test can check it
  arrived. Measured with Electron 45.4.1 on macOS, Chromium hands the switch to its audio service
  (not to the renderer), and a tone the app page plays is never `isCurrentlyAudible()`, where the
  same tone in a window muted only by `setAudioMuted(true)` is.
- **Never port 7860:** the backend's first spawn asks for a free port (`--port 0`), and a restart
  keeps it. The owner's own Eidolon serves on 7860, and while it restarts the port is free for a
  moment: a test run that took it then would leave the owner's next server exiting on a taken port,
  and their `bun run app` with it.
- **The menus:** macOS's About item is the app's own action, which logs the panel, and Toggle
  Developer Tools, which opens a window, isn't offered unpackaged either.
- **No updates:** no check runs and there is no Check for Updates…, unless
  `EIDOLON_DESKTOP_MOCK_UPDATE` fakes the flow or, on a CI runner only,
  `EIDOLON_DESKTOP_UPDATE_TEST` runs the real one ([Updates](#updates)), whose boxes take their
  defaults, Download and Restart.
- **The microphone:** macOS is never asked. A request the [usual rules](#the-window) let through
  is granted only when the app runs with Chromium's `--use-fake-device-for-media-stream`, on any
  platform, and otherwise denied, since a grant would record the owner; main.log says which.
- **Its limits:** macOS registers each launch, a second launch and a `--quit` included, as a
  regular app, Dock icon and all, for about 50–150 ms before main's first line can make it an
  accessory; only `LSUIElement` in the Info.plist would avoid that, and the shipped app needs its
  Dock icon. Chromium opens a file input's chooser, a date field's picker and a datalist's
  suggestions from the page, with no hook in main. A test keeps to [the rules for a
  driver](#driving-it-in-background-mode).

## Testing

### The Vitest project

`bun run test apps/desktop` runs the `desktop` project (`vitest.config.ts`): main's Electron-free
modules, the preload's bridges and the scripts' parts. Nothing it runs loads `electron`, whose
package gives Node the binary's path, not its API: a decision lives in a module that doesn't import
it, with its test, and the Electron code stays a thin layer over it. It covers the controller's
states, races and port fallbacks against fake children and real processes (`test/fake-server.ts`
answers as the local server does); the forwarder's headers, gating, holding, connection proofs and
errors against real local servers and the real local server booted in the test; the login-shell
read, the registry read's script and output, and both merges, Windows' case-blind names and
`%NAME%` expansion included; the quit check and flow; the updater's mode, flow, boxes and mock,
with the restart on the real quit flow; links, navigation, permissions and the debugging switches;
the bounds, chrome, menus and pages; background mode's decisions; both languages' strings; the
shell pages' escaping and CSP; the bridges' sender rule, the invokes' argument checks and the
shapes of main's answers; the folder dialog's options and its one at a time; which copies offer
Open at Login and the terminal command, and the login item's reads and writes; the terminal
command's states, link, password prompt and `Path` script on temporary folders and fake runners,
and its macOS launcher run through links against a stand-in bundle; the task watch's polls,
baselines and notices, their text in both languages and a click's command, on fake answers and a
fake clock; the node shim's npx translation, its launchers run on this Node with the checkout's
pnpm, and the shim the stage writes; the logs' rotation and link filter; stage-backend's parts on
made-up lockfiles, PE files and zips; the release overlay through electron-builder's own loader,
and signed-check's reading of codesign, Gatekeeper, stapler and Authenticode output; the release
notes' parsing, slice and text; the smokes' kit and parts, the fakes over real loopback requests
included; the update test's feed over real loopback requests and against the URLs electron-updater
derives from a manifest, its steps against the lines the real updater logs, and its readings of an
install; the manifest; and the import boundary.

Some files run only on Windows, where `ts.yml`'s Windows job runs them ([In CI](#in-ci)). The two
that touch the registry do it on scratch keys under `HKCU\Software\Eidolon Test`, which each
deletes after, never the real `Environment`: `test/terminal-command-windows.test.ts` drives the
real `Path` script there and runs the `.cmd` launcher against a stand-in install whose
`Eidolon.exe` is a copy of Node, about 80 MB; and `test/registry-environment-windows.test.ts`
reads `REG_SZ`, `REG_EXPAND_SZ` and non-ASCII values there through the real registry read.

### The stage test

`test/stage.test.ts`, in the same project, checks a real stage: its files and manifest, its tree
against `bun.lock`, the pruning, its natives loading from it (a LanceDB table, an onnxruntime
session and sharp, through `scripts/natives.ts`, with every native library and VC++ DLL the
process mapped coming from the payload: `payloadLibraries()` picks them by file name, so Windows'
own `msvcp_win.dll`, mapped in every process with a window, isn't one), the node shim (its
launchers as their sources, the sh ones executable, and its pnpm at `bun.lock`'s pin, licensed,
pruned to the target's natives and with no `.exe`), on a Windows stage the VC++ copies and the
signers, and, once the app was packaged after the stage, that the packaged payload holds the same
files. A target with no stage skips, and so does one staged from another
version or `bun.lock`, whose title then says to run `bun run build:desktop`.
`EIDOLON_REQUIRE_STAGE=1` requires this machine's stage, current, and fails with that hint when it
isn't:

```bash
bun run build:desktop && EIDOLON_REQUIRE_STAGE=1 bun run test apps/desktop/test/stage.test.ts
```

### The Electron lane

The backend runs on Electron's Node, not the Node `bun run test` uses, so after an Electron bump,
a change to `jsRuntime()`, or a test that spawns `process.execPath` with an environment of its
own, the backend suite runs there too. From the repository root:

```bash
node apps/desktop/scripts/test-on-electron.ts [paths] [vitest flags]
```

It runs Vitest's `node` project, or the paths given in it, on the binary `require("electron")`
names from `apps/desktop` (downloaded on the first run), as Node (`ELECTRON_RUN_AS_NODE=1`), and
exits with Vitest's code. `desktop.yml` runs the whole project there on macOS, and on Windows the
`node`-project tests of `ts.yml`'s Windows job ([In CI](#in-ci)). Two things differ on that Node.
`process.execPath` is the Electron binary, which starts its GUI unless the child's environment
carries `ELECTRON_RUN_AS_NODE`: a test that spawns `process.execPath` with an environment of its
own merges `jsRuntime().env` into it, as the app's own spawns do. And a `Date` keeps its local hours
when `TZ` changes at run time, so a test of another time zone runs in a child process started in
it. Only there, off Windows, does `packages/assistant/test/mcp-node-shim.test.ts` start MCP
servers as `node` and `npx` through the [node shim](#the-node-shim)'s launchers.

### The smokes

Two smokes run the app end to end on a temporary data home and profile, every provider it reaches
faked on loopback, so they bill nothing. `bun run smoke:desktop:dev` (`scripts/dev-smoke.ts`, [the
dev smoke](#the-dev-smoke)) walks the unpackaged app as its owner would, under Playwright;
`bun run smoke:desktop` (`scripts/smoke.ts`, [the packaged smoke](#the-packaged-smoke)) checks what
packaging made of the fused app, through its backend's API. Each runs on Node from the repository
root, prints a `PASS` or `FAIL` line for each check with what decided it, and exits 0 only when
every check passed.

- **Background mode.** Each runs the app in [background mode](#background-mode), under the focus
  watch below, and keeps to the [rules for a driver](#driving-it-in-background-mode). `--headful`
  turns background mode and the watches off, for a developer watching on their own screen: the
  window shows, and a call is heard.
- **The run's folder,** printed at the start: `eidolon-smoke-desktop-dev-*` or
  `eidolon-smoke-desktop-*`, under `RUNNER_TEMP` in CI and the OS's temporary folder elsewhere. It
  holds the app's data home (`home`), its `real-home` and `shared-skills`, its profile (`profile`:
  `logs/main.log`, `logs/backend.log` and background mode's `downloads`), and `scratch`, the
  launches' output and the files the smoke sends. A passing run removes it, all but the packaged
  smoke's `results.json`, and a failing one keeps it; Ctrl-C stops whatever the smoke started,
  keeps it and exits 130 (143 on SIGTERM).
- **The kit's last checks,** after the smoke's own: nothing the smoke started is left running
  (anything that is gets stopped by pid), the focus watch saw nothing wrong, and every request to
  the fakes carried their key to a route they serve; after a packaged run on macOS, also that
  `live.laplace.eidolon`'s preferences are as they were.

Both build on the kit in `scripts/smoke/`, which `test/smoke-kit.test.ts` covers without Electron:

- **`fakes.ts`:** loopback stand-ins on `node:http` for every provider the app reaches, ported from
  `local-smoke.ts`'s: her mind's streamed chat completions, with a hold between and after a
  reply's parts, and her tool calls for a selfie and for a task (`start_task`, in a folder the smoke
  names); the retrieval gate's and the director's decisions; embeddings, with a hold;
  OpenAI's speech, transcriptions and realtime transcription sessions, for a voice message and a
  call; OpenRouter's images, for a selfie; and the model listings. They answer one key, and count
  what they answer by route.
- **`env.ts`:** the app's environment, which takes only the OS's own variables from the smoke's,
  never a credential, setting or provider URL (`local-smoke.ts`'s drop list), then adds the fakes'
  accounts, the run's homes and the test switches: no `.env`, no login shell, background mode
  unless `--headful`.
- **`kit.ts`:** `startSmoke()`, which makes the run's folder, starts the fakes and the focus watch
  and catches Ctrl-C, and `finish()`, which adds the last checks and removes or keeps the folder
  (`runSmoke()` wraps the two around a body). It launches the app as its binary or under
  Playwright's `_electron`, reads main.log, backend.log, the server lock's `.info` and
  `local-token`, calls the backend as main's forwarder does, and on macOS puts back the
  `live.laplace.eidolon` preferences a packaged run writes. `checkCanary()` checks that a key the
  smoke puts in its own environment never reaches the backend: only the fakes' accounts take a key
  from the environment, and on macOS `ps` shows the backend's environment without it.
- **`processes.ts`:** what the smoke started and everything under it, from the process table (`ps`,
  or PowerShell's `Win32_Process` on Windows), recorded as it goes so a child that outlives its
  parent is still known, and stopped by pid at the end (`killTree` on Windows).
- **`focus.ts`, the focus watch,** on macOS outside `--headful`: `lsappinfo front` every 50 ms. The
  app in front, by name (Electron or Eidolon) or as a process the smoke started or one under it,
  fails the run, and so does a system prompt in front (SecurityAgent, UserNotificationCenter,
  CoreServicesUIAgent, universalAccessAuthWarn, the Open and Save panel), whoever raised it: one the
  owner opens during a run fails it too. The owner switching between their own apps is no failure.
  Every 500 ms it reads each main process's `ApplicationType`, which must be `UIElement` (an
  accessory) within 10 s of its launch, stay so, and be seen so at least once; and a watch that
  sampled nothing fails.

#### The dev smoke

`bun run smoke:desktop:dev [--no-build] [--keep] [--headful]` runs on macOS: its call speaks through
`say` and `afconvert`, and its window watch reads macOS's window server. It first builds
`apps/web/dist` and `apps/desktop/dist`'s main, preload and shell pages with Vite, in about half a
second, so it never walks a stale build (`--no-build` runs on what is there, and refuses when a
build is missing; the backend runs from source, so the stage isn't one of them). It renders the
call's speech before the app starts: Tingting's Mandarin from `say -v Tingting -o <file>`, never
aloud, converted by `afconvert` to a 48 kHz mono 16-bit WAV and turned down 12 dB, between 1 s and
3 s of silence. Then it drives the unpackaged app with Playwright's `_electron`, with
`--lang=en-US`, so the page's labels are English on any machine, and Chromium's fake microphone
playing that WAV, under the focus watch and a window watch of its own (`dev-smoke/windows.ts`).
The window watch reads the window server's list of on-screen windows every 50 ms through
`osascript`: a window of the app's on screen fails the run, even one never in front or focused,
which the focus watch can't see, and the owner's own windows in the list show that it sees any.

Each step prints one line, made of the checks inside it:

1. **Cold start:** Home at `eidolon-app://app/`, with no sign-in and no console error, its footer
   naming both versions; the backend on a free port, with no try at 7860; main off screen (an
   accessory, its window neither visible nor focused). The kit's canary check follows it, on a line
   of its own: the key the smoke puts in its own environment never reaches the backend.
2. **A chat:** her reply streams through the forwarder, its first part shown about 2 s before the
   rest, as the fake holds it. A picture and a text file sent with a line (set on the composer's
   input, never a click, which opens the file chooser) reach her mind; the picture opens in the
   in-page viewer, whose Save saves it, and the text file saves through `<a download>` under the
   name it was sent with, each whole into the profile's `downloads` folder. Her selfie, from
   `take_selfie` on the fakes' image model, which the chat must offer while the persona has an
   outfit to draw, opens and saves the same way. Each link must be an `<a download>`: main's
   `downloadURL` fallback would save a `target="_blank"` one too, with the same lines in main.log.
3. **Theme and language:** the page's theme setting reaches `nativeTheme.themeSource` as it is, its
   language rebuilds the menus in it, and its `[data-shell]` rows drag while their controls don't,
   the sidebar's clear of the traffic lights on macOS.
4. **Settings' Restart,** from the banner a setting read at boot puts up: main holds requests, the
   backend exits 75 and comes back on the same port, and the page says it's back.
5. **A call** on Chromium's fake microphone: her hearing gets the speech, her answer is in the
   chat's log, her voice arrives over WebRTC and plays in the page, and the window is never audible
   while the audio service runs with `--mute-audio`.
6. **Close and reopen:** closing hides the window while the backend serves on, and a second launch
   shows it again, never on screen or in front, and exits within 30 s; one that doesn't is killed
   and fails the step.
7. **Choose Folder,** in Settings → Assistant Mode, beside a line typed into Assistant Folders:
   main's own handler opens no dialog in background mode, as main.log says, and the draft stays as
   typed; then the smoke replaces the handler through Playwright's `app.evaluate`
   (`ipcMain.removeHandler`, then `ipcMain.handle` answering a folder of the run's), and the folder
   it answers joins the draft as a line of its own, which nothing saves.
8. **Settings → Desktop:** Open at Login and the terminal command each say "Background mode leaves
   this computer as it is.", their switch and button disabled.
9. **A task that waits:** the smoke sets Assistant Mode on the fakes' OpenRouter account (a `PUT`
   of `assistant.provider` and `assistant.model`) and gives the fakes a folder of the run's,
   outside `assistant.folders`, where her answer to the task line in a new chat starts a task with
   `start_task`: its card asks "Start this task?". Within 60 s main.log must read `background mode
   didn't show a notification: <her name>: <the start's words> / <its goal>`, in the words
   `strings.ts` has in English: the watch polls every 30 s while no task runs, and never tells of a
   task already there at its first answer, so the task starts once the server is ready. Deny on
   the card stops it, and within 45 s the watch's notice of that follows, with the stopped task's
   words: two notices in all.
10. **Attach:** after `--quit` ends that launch and its backend, a server started first on the
    same home (`apps/bot/src/local/main.ts` on Node, with its supervisor) is used, not replaced:
    Settings' Restart there waits for the supervisor's next server, a restart from outside the app
    is survived, and quitting leaves the server running until the smoke stops it.
11. **Quit:** a last launch spawns its own backend again, and `--quit` ends main and the backend
    with exit 0, leaving nothing running and no error line in either log.

After the steps come the window watch's line and the kit's. The run's folder keeps
`results/results.json`, with every check and each step's time, and `results/screenshots`; a pass
removes them with the rest of the folder, unless `--keep` first copies them to
`<run's folder>-results`. A run takes about 80 s, 50 of them the wait for the task's notices. With
`--headful`, the checks that only background mode makes true (off screen, never audible, main.log's
background lines, the folder dialog's line and the notices: the unpackaged app shows none) are
skipped, Choose Folder gets the replaced handler alone, Settings → Desktop says the options are for
the installed app only, and a hook the smoke adds in main saves downloads into the same folder
instead of asking.

#### The packaged smoke

`bun run smoke:desktop [--headful]` smokes the fused app `bun run package:desktop` left in
`apps/desktop/.out`: on macOS `mac-arm64/Eidolon.app`, on Windows the NSIS setup, the only `.exe`
there. It never builds or packages: with no build it says how to make one (`bun run build:web &&
bun run build:desktop && bun run package:desktop`) and exits 1 before starting anything.
Playwright and CDP can't drive a fused build, so it calls the backend's API with the Bearer, as
main's forwarder does, and runs the app's binary in node mode beside it, as main runs the backend:

- **The payload's natives,** before the app starts: `scripts/natives.ts` on the binary writes and
  opens a LanceDB table, runs Silero on an onnxruntime CPU session and makes a JPEG with sharp,
  every library mapped from the payload. The tray icon's file is in the app's resources, since
  background mode shows no tray.
- **The launchers,** run as a terminal runs them (on Windows the `.cmd` files through
  `cmd /d /s /c`), before the app starts. The eidolon command, `bin/eidolon` in the app's
  resources (`bin\eidolon.cmd` on Windows), with `search --help`, exits 0 with laplace-search's
  usage on stdout, its CLI writing to the `EIDOLON_HOME` it was given, a folder of the run's; never
  with no arguments, which opens the app outside background mode. The node shim's launchers, in
  the payload's `node-shim/bin`, first run a stand-in as `EIDOLON_NODE` that prints the
  `ELECTRON_RUN_AS_NODE` it got, which must be 1 from each: one that left it unset would start
  Eidolon itself on the installed app's profile, so none runs on the app's binary then. After it,
  they run with `EIDOLON_NODE` naming the app's binary, a home of the run's, and a `PATH` of the
  OS's own folders, which must hold no node, then the shim's: `node -p process.versions.electron`
  prints the pinned Electron, `pnpm --version` the payload's pnpm, and `npx -y file:<a package of
  the run's>` its command's line alone on stdout, that command run on the app's Electron through
  the shim's node; `npx` without `EIDOLON_NODE` exits 1 with its reason. They stay offline: a
  `file:` package needs no registry, and `pnpm_config_registry` names a closed port, with pnpm's
  fetch retries off so a request fails at once.
- **The app:** it starts on the run's home and profile; its backend is the binary in node mode on
  the payload's `server.js`, under main, with no key from the smoke's own environment; main.log
  names a packaged build on the pinned Electron, and the server reports the payload's version; the
  Bearer gets a session, a wrong one or none a 401, and main's probe proves the token; the status
  answers and `/` is the web app.
- **Its natives in use:** a photo with EXIF orientation 6 comes back from a chat upright and bare,
  through the backend's sharp; the backend maps LanceDB from its start and sharp with the photo,
  from the payload (`lsof` on macOS, the process's modules on Windows); an `ingest-facts` job, the
  binary in node mode under the backend, writes her facts through the fakes' embeddings, and a
  search on the binary reads them back.
- **A restart** through Settings' route keeps the port and changes the backend's pid.
- **`--quit`:** the second launch and main exit 0, the backend stops on its stop trigger rather
  than being killed, nothing the app started is left running, and neither log holds an error line,
  a link code or the token. What runs under the app is tracked at each step, and on macOS so is
  any process whose environment names the run's folder, wherever it was reparented: `ps` shows
  the environment of any but Apple's own binaries. The backend's error lines include a JavaScript
  error printed past its logger.

On Windows it first installs the NSIS setup silently for the user (`/S`), and smokes the
installed `%LOCALAPPDATA%\Programs\eidolon\Eidolon.exe`. After the quit it runs, with `/S`, the
HKCU uninstall command that names the install folder's uninstaller, and none at all when no entry
does, which fails the check, so another app's entry named Eidolon never runs. It then checks that
the install folder and its entry are gone and the data homes are as they were, file for file by
hash: the run's, and on a CI runner (`CI=true`) the default one, `%USERPROFILE%\.laplace\eidolon`,
where it puts a marker before the install. The uninstaller never learns the run's home, so only the
default one would show it touching a data home; the smoke writes there on a CI runner alone, and
removes the marker and the folders it made after. Where Eidolon is installed for the user already,
it refuses to run rather than replace and remove that install. Each step has a time limit of its
own, so a hung run still ends in failed checks, its uninstall and results included, well inside
`desktop.yml`'s 15 minutes. After `finish()` it writes `results.json`, every check with the timings,
into the run's folder, which a pass leaves holding that file alone. A run takes about 12 s on
macOS.

### In CI

`ts.yml` runs the Vitest project with the rest of `bun run test`, where the stage test skips, and
its Windows job the project's Windows-only tests: `terminal-command-windows.test.ts` (the PATH
script on a scratch key under HKCU, and the eidolon command's `.cmd`),
`registry-environment-windows.test.ts` (the registry read, on scratch keys) and
`node-shim-windows.test.ts` (the node shim's `.cmd` launchers, on Node).
`.github/workflows/desktop.yml`, which `docker.yml` skips, builds and checks the app on every pull
request that changes more than docs, on a dispatch, and from a release's tag
([Releasing](#releasing)): the payload comes from `bun.lock` and the backend's packages, so a filter
on `apps/desktop` would miss the changes it checks. Its build runs on `macos-latest` (macOS
arm64) and `windows-latest` (Windows x64), neither cancelling the other, in bash on both, with Bun
from `package.json` and Node 24. The steps are `desktop-build.yml`'s, which `desktop.yml` calls
unsigned for a pull request or a dispatch and signed for a tag or a `sign` dispatch, one job per
platform with its secrets alone ([Secrets](#secrets)):

1. **The checks before anything installs:** a tag's ([Releasing](#releasing)), or a dispatch's
   inputs ([Dispatches](#dispatches)), the latter in `desktop.yml`'s `inputs` job.
2. **Install:** `bun install --frozen-lockfile --ignore-scripts`, as `release.yml` installs: no
   build step needs a package's install script, and the signing step must follow none.
3. **Build:** `bun run build:desktop` stages the runner's backend and builds `dist/`.
4. **Package:** unsigned, `bun run package:desktop -c.compression=store`, at `0.0.0-dev`, ad hoc on
   macOS and never with a keychain identity, an NSIS setup on Windows, stored uncompressed, which
   packs faster. From a tag or a `sign` dispatch, signed instead: electron-builder with the release
   overlay and that leg's secrets ([Secrets](#secrets)), then [the signed build's
   checks](#the-signed-builds-checks).
5. **The stage test,** with `EIDOLON_REQUIRE_STAGE=1`, so a stage that is missing or stale fails
   instead of skipping; run after packaging, it also holds the app's payload to the stage.
6. **The Electron lane,** through `test-on-electron.ts`: the whole `node` project on macOS, and on
   Windows the `node`-project tests of `ts.yml`'s Windows job, with its filters.
7. **The packaged smoke,** in background mode, within 15 minutes, installing and uninstalling the
   NSIS setup on Windows. When it fails, its `results.json`, the profile's logs and the launches'
   output are uploaded as `<OS>-smoke-desktop`, kept 7 days: never the run's home, which holds
   `local-token`.
8. **`--use-system-ca` on the packaged binary:** `scripts/system-ca.ts` puts a throwaway CA in the
   runner's machine trust store (the System keychain through `sudo -n security` on macOS,
   LocalMachine's Root through `certutil` on Windows), serves https on loopback with a certificate
   it signed, and checks that the packaged binary in node mode reaches it with `--use-system-ca`
   and not without, from the backend and from a job the backend runs. Then it deletes the CA, while
   macOS keeps its admin trust entry, orphaned: removing that waits on a dialog no runner answers.
   It runs only where `CI=true`, and refuses anywhere else: it changes the machine's trust store.
9. **The installers:** unsigned, the DMG and the NSIS setup, uploaded as `<OS>-installers-dev` and
   kept 14 days; not the macOS zip, which only updates read. Signed, once every check passed, the
   installers, the zip, the blockmaps and `latest*.yml`: a tag's as `<OS>-installers` for the
   upload, a `sign` dispatch's as `<OS>-installers-signed-unreleased`.

Each check runs once the step it needs succeeded, so one that fails hides none of the others. A
push to a pull request cancels the run it replaces, a tag's run is never cancelled, and a dispatch
neither waits nor cancels. A pull request's run and an unsigned dispatch sign nothing, and send
nothing anywhere but the run's own artifacts.

#### The update test

The `update_test` dispatch proves, with no one at a screen, that a signed install updates itself
through its real updater: electron-updater against a feed, then Squirrel.Mac on macOS and the NSIS
setup on Windows. Its own job runs on `macos-latest` and `windows-latest`, neither cancelling the
other, in bash, within three hours:

1. **The ref check,** in `desktop.yml`'s `inputs` job and the update-test jobs' own `if`, before
   any secret is read: `master` or `electron` only, and no other dispatch input beside it. Each
   platform's job calls `desktop-update-test.yml` with its own secrets alone.
2. **Install and build,** as the build job does: no package's install script runs before signing.
3. **0.0.1 and 0.0.2, signed:** the release overlay with that leg's secrets alone, twice, both
   builds reading the feed `http://127.0.0.1:8765/` (`-c.publish.url`, which goes into
   `app-update.yml`). 0.0.1's outputs move to `$RUNNER_TEMP/eidolon-update-0.0.1`, and the App Store
   Connect key goes before anything runs the app. Neither can be an unsigned build: Squirrel.Mac
   installs only an update that meets the running app's designated requirement, and
   electron-updater on Windows only a setup signed by a name in `publish.publisherName`.
4. **[The signed build's checks](#the-signed-builds-checks)** on 0.0.2.
5. **`node apps/desktop/scripts/update-test.ts <0.0.1's outputs> apps/desktop/.out`,** which refuses
   to run where `CI` isn't `true`: it installs the app for the user, and the app the update starts
   again runs on the default profile and data home.
   - **The feed:** a `node:http` server on `127.0.0.1:8765` with 0.0.2's `latest*.yml`, zip or setup
     and blockmaps, and 0.0.1's blockmap, for the differential download electron-updater tries on
     Windows against the setup the install cached. It answers whole or one range a request
     (`useMultipleRangeRequest` is off), and refuses any other range with a 416 rather than send
     the whole file where electron-updater writes the part. It starts only once it holds every file
     electron-updater will ask for: those the manifest names, the update's blockmap, and the old
     one's, named by putting the old version where the new one is.
   - **0.0.1 installed:** on macOS the DMG attached read-only and its app copied into the run's
     folder, since Squirrel.Mac replaces the bundle in place; on Windows the NSIS setup with `/S`
     for the user, refusing where Eidolon is installed already. Its version is read back: the
     bundle's `CFBundleShortVersionString` through `plutil`, or the uninstall entry's
     `DisplayVersion` and `Eidolon.exe`'s `FileVersion`.
   - **The update:** 0.0.1 starts in background mode with `EIDOLON_DESKTOP_UPDATE_TEST=1`, on a
     temporary home and profile and with no account (`appEnv()`), and main.log must show each
     [step's line](#updates) in order, from `updates are on in background mode` to `installing`,
     each within its own limit of the one before: 10 minutes for the download, a few for the rest.
     On Windows the steps include the setup's [signature check](#signing-identities), `the
     update's signature is valid`, which a refusal stops.
     A line after which the update can't go on without a person, such as `up to date`, a failed
     check or download, or an update that can't be installed, fails it at once, as does main
     exiting first; the failure names the last step's line and prints main.log's tail, with
     ShipIt's on macOS. Then the feed must have served the manifest and the update, and main must
     exit 0. On Windows that is both blockmaps and the setup in ranges alone: electron-updater
     downloads the whole setup when its differential download fails, which the test would
     otherwise pass. A Mac's first update downloads the zip whole, having none of its own to diff
     against.
   - **0.0.2 installed:** on Windows the setup electron-updater started, from
     `%LOCALAPPDATA%\eidolon-updater\pending`, must end first, uninstalling 0.0.1 and installing
     0.0.2. Then the same readings must say 0.0.2 within 10 minutes, a reading that fails while the
     setup writes or PowerShell is slow only counting as no answer. A failure prints the install
     folder's and the pending folder's files and `reg query`'s uninstall entries.
   - **The app the update starts again,** if one starts: Squirrel.Mac and the NSIS setup start the
     new version themselves, outside the test's environment, so on the default profile and, on
     macOS, outside background mode. Found by its executable in the install, it must name 0.0.2 in
     the start line it writes to the default profile's main.log; then a `--quit` through that
     profile's lock stops it, and its processes by pid after.
   - **Then** the uninstall entry's own command with `/S` on Windows or the copy deleted on macOS,
     and nothing the test started left running.
6. **On a failure,** the run's folder (`eidolon-update-test-*`) uploaded as `<OS>-update-test` for 7
   days: the profile's logs, the launch's output, `feed.log` with every request the feed answered,
   and copies of the default profile's logs and ShipIt's. Never the run's home, which holds
   `local-token`.
7. **Always,** whatever a failed or cancelled run left installed removed: through its uninstaller on
   Windows, the copy on macOS.

Dispatch it from `electron`, or from `master` once it is merged:

```bash
gh workflow run desktop.yml --ref electron -f update_test=true
```

What it can't see:

- **The boxes.** Background mode answers each with its default button, so how they look and read,
  the release's notes in the first, Later, Release Notes, Check for Updates…, and the progress on
  the Dock or the taskbar go unchecked.
- **The release's own feed.** It serves electron-builder's manifests as built, flat, without the
  upload's `v<version>/` paths or `eidolonNotes` line, and with no R2 or Cloudflare in between.
- **What a person's machine adds:** the microphone grant kept across the update on macOS, an install
  in `/Applications` opened from Finder, SmartScreen and Smart App Control on Windows, and a call,
  task or job running when Restart's quit check asks.
- **A later update on macOS,** which downloads only the zip's changed blocks against the one the
  last update cached: the first update has none, so it downloads the whole zip.
- **The app it starts again on its own terms,** which runs outside background mode and on the
  default profile, so it is only checked for its version and stopped.

### Driving it in background mode

Anything that drives the app on a machine someone is working on, the smokes and an agent's walk
alike, runs it in background mode on a temporary home and profile ([below](#running-it-by-hand)),
and keeps to these rules:

- **The microphone:** only Chromium's `--use-fake-device-for-media-stream`, with
  `--use-file-for-fake-audio-capture=<wav>` and `--disable-features=AudioServiceSandbox` to feed a
  call a file (without the last it captures silence). Never `--use-fake-ui-for-media-stream`, which
  answers a request past main's permission handler, the camera included: the kit refuses it.
- **Files** go up through Playwright's `setInputFiles` or its `filechooser` event, never a click on a
  file input, and nothing opens a date field's picker or types into a datalist's field: Chromium
  opens those from the page, with no hook in main to keep them off the screen.
- **After a navigation main cancelled,** such as a link to the web, Playwright's locator clicks wait
  forever: use `page.mouse` or `page.evaluate`.
- **Off screen** is checked by main's pid: `lsappinfo` gives its `ApplicationType` as `UIElement`,
  and every window's `isVisible()` and `isFocused()` are false. `app.dock.isVisible()` can read true
  while a second launch's process exists, and `isVisible()` reads false for a window behind
  another's, which is why the dev smoke also watches the window server's list.
- **Nothing is heard:** background mode mutes Chromium, and a call's reply still arrives over
  WebRTC for a check to find. Speech for a call comes from `say -o <file>`, never aloud, and nothing
  runs `afplay`.
- **macOS's preferences:** a packaged run writes `~/Library/Preferences/live.laplace.eidolon.plist`
  whatever its profile, so put it back as it was: `defaults export live.laplace.eidolon <file>`
  before, then `defaults import` it after, or where there was none, `defaults delete
  live.laplace.eidolon` and delete the file, which cfprefsd leaves behind empty. The packaged smoke
  does this itself. An unpackaged run writes `com.github.Electron.plist`, which predates these
  runs: leave it.
- **The one thing on screen:** a watch from outside sees the Dock flicker of each launch,
  [background mode's limit](#background-mode), as a regular app for 50–150 ms that never comes to
  the front. The focus watch gives main 10 s to become an accessory.

### Running it by hand

A test run of the app gets a temporary `EIDOLON_HOME`, a profile of its own
(`--user-data-dir=<profile>`, which keeps the logs inside it) and `EIDOLON_DESKTOP_BACKGROUND=1`.
It also gets `EIDOLON_DESKTOP_LOGIN_SHELL=0` and an environment with no credential, setting,
provider or other `EIDOLON_*` variable, with an `EIDOLON_SHARED_SKILLS` of its own so the owner's
shared skills stay out too ([The environment](#the-environment)): `appEnv()` in
`scripts/smoke/env.ts` builds one, from `local-smoke.ts`'s drop list. Leave `local-smoke.ts`
itself alone: it isn't paths-ignored, so a change to it deploys production. A call needs Chromium's
fake microphone, or background mode denies it ([above](#driving-it-in-background-mode)).

- **Unpackaged,** after `bun run build:desktop` (or only its Vite builds) and `bun run build:web`,
  `"$(cd apps/desktop && node -p 'require("electron")' | tail -n 1)" apps/desktop --user-data-dir=<profile>`
  runs it with its backend from source serving `apps/web/dist`; the `tail` drops the line the first
  `require` prints as it downloads the binary, which neither build fetches on macOS. Playwright's
  `_electron` drives it the same way.
- **Packaged,** run `apps/desktop/.out/mac-arm64/Eidolon.app/Contents/MacOS/Eidolon
  --user-data-dir=<profile>` (`.out\win-unpacked\Eidolon.exe` on Windows), and drive its backend
  once main.log says the window shows `eidolon-app://app/`:

  ```bash
  curl -H "authorization: Bearer $(cat "$EIDOLON_HOME/local-token")" \
    "http://127.0.0.1:$(jq .port "$EIDOLON_HOME/locks/4273f434b594.info")/api/local/status"
  ```

- **Stop** either with the same command and `--quit`, then put macOS's preferences back after a
  packaged run ([above](#driving-it-in-background-mode)).

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
     only the OS store holds, which `desktop.yml`'s `--use-system-ca` step proves on both
     platforms ([In CI](#in-ci));
   - the fuses: a new one keeps Electron's default unless `electron-builder.yml` lists it, so read
     the packaged binary's fuse wire with a current `@electron/fuses`;
   - its Node's major, which Vite's `node24` target (`scripts/vite-common.ts`) and the repo's Node
     24 assume, and its system minimums, which this doc restates;
   - on Windows, the unsigned-PE list, which takes Electron's own DLLs from its zip.
5. Run the backend suite on its Node ([the Electron lane](#the-electron-lane)) and `bun run test
   apps/desktop`; stage and package the app, then run [the stage test](#the-stage-test) and both
   [smokes](#the-smokes), `bun run smoke:desktop` and, on macOS, `bun run smoke:desktop:dev`.
   Then let `desktop.yml` run on the pull request: the system CA proof runs only there, and so does
   the packaged smoke on Windows, with its install and uninstall.

## Measured

On an Apple silicon Mac (macOS 27), 2026-11-21, every run of the app with the login-shell read
off:

- **The stage** (darwin-arm64): 4,967 files and 392 MiB, of which LanceDB 250, onnxruntime 43, the
  node shim 20, sharp and libvips 19, `dist/` 7.5 and the web app 2; about 11 s with npm's cache
  warm. The node shim, added on 2026-11-23, is 451 of those files, about 4.9 MB as a tar.gz. A
  win32-x64 payload, installed for that target from a Mac, is about 447 MiB before its VC++ copies
  and its node shim.
- **Packaging** takes 61–64 s: Eidolon.app is 628 MiB, the DMG 261 MB and the zip 255 MB, before
  the node shim.
- **Starting:** the packaged app shows its page about 1.1 s after launch, and the unpackaged app
  paints Home in 1.3–1.8 s. The first run after packaging is slower: the packaged binary's backend
  listened 3.6–4.2 s after it started, against 0.55 s warm.
- **Streaming** through the forwarder: a chat reply's first chunk 25–28 ms after sending, the rest
  as the fake sent it, nothing buffered. Inside Electron, an aborted stream's socket to the backend
  closed within 2 ms.

A prototype measured on 2026-11-20 and 21, whose main forwarded through Node's global fetch, adds
what this app hasn't measured yet: with the login-shell read on, Home painted at 1.5 s, about
0.6 s of it the read (fish); a restart was back on its port in about 0.5 s; memory with Home open
was about 760 MB, the backend 277 MB of it; and a freshly signed app's first launch on a CI runner
listened at 5.5 s.
