# laplace-eidolon-desktop

## 0.8.0

### Minor Changes

- 9e76a97: Unlimit task context and raise the default spend pause to $10
- 6f28164: Show unread badges in the chat list and keep background chats updated
- 9e76a97: Add desktop chat notifications with custom avatars and group avatar grids
- 7720a5d: Pair with remote Eidolon servers via Subspace direct links or stateless JWKS relay

## 0.7.0

### Minor Changes

- 51bf389: Add group roll-call, silent-member, and @all triggers with 0–100 hop presets

## 0.6.1

### Patch Changes

- ac97b72: Align the group chat decision button beside voice and photo replies
- 1510512: Upgrade the bundled pnpm in the node shim to v12

## 0.6.0

### Minor Changes

- d65edf4: Add a desktop title bar with Back and Forward, and show pages in a card
- 8c164e8: Setup recommends the speech recognition and voice keys instead of requiring them
- d0b28e2: Store viewer memories and knowledge indexes locally on disk with Zvec

### Patch Changes

- 8f4aad8: Name the desktop app LAPLACE Eidolon
- 51aaead: Discard Changes now goes back from unsaved studio edits instead of asking again
- 8887905: Keep tooltips, popovers and menus clear of the window edge

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
