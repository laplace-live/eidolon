# Desktop spike (Phase 0)

Throwaway code. This is the Phase 0 spike of the Eidolon desktop app: the local app in an Electron
window that starts its own backend, on macOS arm64 and Windows x64. Phase 1's `apps/desktop`
replaces all of it. Nothing here ships, nothing outside this folder imports it, and it lives on the
`electron` branch only.

What it holds:

- `app/`: the shell. `main.cjs` spawns the staged npm build's `dist/server.js` on the app's own
  binary in node mode, forwards `eidolon-app://app/` to it with the local token, and quits through a
  second launch with `--quit`. It refuses to start without `EIDOLON_SPIKE_RUN`, a run file whose data
  home, profile and logs sit in the run's own folder; the CDP port and Chromium's fake microphone
  come from that file too.
- `scripts/stage.mjs`: stages the backend payload for this machine in `.stage/<platform>-<arch>/`,
  from `bun run build:npm`'s `apps/eidolon/pack`: npm installs its dependencies as real files,
  onnxruntime is pruned to the target (without DirectML on Windows), and on Windows the VC++ runtime
  the natives import is copied beside them, and the unsigned PE files are listed in
  `unsigned-pe.json` for the release overlay's `signExts`.
- `electron-builder.yml` and `electron-builder.release.mjs`: the base config and persona's signing
  overlay (Developer ID with notarization, Azure Trusted Signing).
- `scripts/checks.mjs`: the packaged smoke. It drives one launch over CDP with every provider faked
  on loopback (`scripts/fakes.ts`, on Bun): Home, a streamed chat, an upload, a LanceDB job, an
  onnxruntime session, a call on the fake microphone, a restart and `--quit`.
  `scripts/windows.mjs` installs, uninstalls and checks signatures on Windows; `scripts/mac-verify.mjs`
  checks the signed and notarized app; `scripts/ytdlp.mjs` runs yt-dlp on the app's Node.
- `scripts/experiments/`: the one-off Mac experiments behind the spike's first results (cold start,
  fuses and SIGUSR1, `window.close()`, tampering), as they ran against a local build. They need the
  fakes running in `<runs>/fakes` first.

`.github/workflows/desktop-spike.yml` runs it on pushes to `electron`: the npm build on Ubuntu, an
unsigned NSIS build installed and walked on `windows-latest` and then an Azure-signed one, and a
signed, notarized build walked on `macos-latest`. It uploads evidence and the unsigned installer
only.

Locally (macOS, never on port 7860 while the app runs there):

```bash
bun run build:npm                                   # at the repository root
cd spikes/desktop
node scripts/stage.mjs
npm ci --ignore-scripts && node node_modules/electron/install.js
node scripts/checks.mjs --suite local --name local --port 17862   # the unpackaged app
```

`app/drop-names.json`, the credential and provider names a backend never inherits, comes from
`bun scripts/drop-names.ts` after a `bun install` at the root.
