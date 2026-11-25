# laplace-eidolon-desktop

## 0.5.0

### Minor Changes

- 9bbe563: Tune how far her 2D model turns her head in Appearance's new Motion tab
- 76f362e: Build moods from a 2D model's parameters; she nods and shakes without clips
- 15bb7f2: Let her stand partly off screen, with Reset Position in Settings to bring her back
- 15bb7f2: Add Eidolon's menu bar icon on macOS, and show her model files in Finder or Explorer

### Patch Changes

- 5704a53: Round the video call's buttons and message box to match their bars
- 14154cf: Count a tap near her head as a head tap when her 2D model marks no head

## 0.4.0

### Minor Changes

- a7c2c07: See her model face to face when you call a persona that has one
- 7bfe18b: Keep her on your desktop as a companion above your other windows
- a7c2c07: Keep a call going while you move between the app's pages
- ef13210: Import a persona's PSD2Live models in the studio's new Appearance section

### Patch Changes

- 2521a5a: Hanging up as a call connects ends it within seconds, not about 30 s later
- 21366c4: Eidolon asks before a quit drops unsaved changes, which no longer leave it stuck

## 0.3.0

### Minor Changes

- 2358c39: Open Eidolon at login, in the background
- 2358c39: Get a notification when a task needs you or ends while Eidolon is in the background
- 2358c39: Start MCP servers that run npx, node or pnpm on a computer without Node
- 2358c39: On Windows, Restart picks up PATH and variables changed since Eidolon started
- 2358c39: Install the eidolon command for your terminal from Settings
- 2358c39: Choose an Assistant folder in a native folder dialog

### Patch Changes

- 92f0cfb: Say Assistant Commands run on Windows too, with Git Bash, Cygwin or MSYS2
- abc5aa6: Run only Windows' own PowerShell, never a powershell.exe in the current folder

## 0.2.0

### Minor Changes

- 68a3136: Pick her voice from your own Fish Audio voices, private ones included

## 0.1.0

### Minor Changes

- 3ec20d7: Run Eidolon as a desktop app on macOS and Windows
