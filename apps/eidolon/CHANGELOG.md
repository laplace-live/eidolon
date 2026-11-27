# @laplace.live/eidolon

## 0.20.0

### Minor Changes

- 9e76a97: Unlimit task context and raise the default spend pause to $10
- 6f28164: Show unread badges in the chat list and keep background chats updated
- 9e76a97: Add desktop chat notifications with custom avatars and group avatar grids
- 7720a5d: Pair with remote Eidolon servers via Subspace direct links or stateless JWKS relay

## 0.19.0

### Minor Changes

- 51bf389: Add group roll-call, silent-member, and @all triggers with 0–100 hop presets

## 0.18.1

### Patch Changes

- ac97b72: Align the group chat decision button beside voice and photo replies

## 0.18.0

### Minor Changes

- d65edf4: Add a desktop title bar with Back and Forward, and show pages in a card
- 8c164e8: Setup recommends the speech recognition and voice keys instead of requiring them
- 818dd8c: Run the Docker image on Node 24 instead of Bun
- d0b28e2: Store viewer memories and knowledge indexes locally on disk with Zvec

### Patch Changes

- 8f4aad8: Name the desktop app LAPLACE Eidolon
- 51aaead: Discard Changes now goes back from unsaved studio edits instead of asking again
- 8887905: Keep tooltips, popovers and menus clear of the window edge

## 0.17.0

### Minor Changes

- 9bbe563: Tune how far her 2D model turns her head in Appearance's new Motion tab
- 76f362e: Build moods from a 2D model's parameters; she nods and shakes without clips

### Patch Changes

- 5704a53: Round the video call's buttons and message box to match their bars

## 0.16.0

### Minor Changes

- a7c2c07: See her model face to face when you call a persona that has one
- 7bfe18b: Keep her on your desktop as a companion above your other windows
- a7c2c07: Keep a call going while you move between the app's pages
- ef13210: Import a persona's PSD2Live models in the studio's new Appearance section

### Patch Changes

- 2521a5a: Hanging up as a call connects ends it within seconds, not about 30 s later

## 0.15.1

### Patch Changes

- 92f0cfb: Say Assistant Commands run on Windows too, with Git Bash, Cygwin or MSYS2

## 0.15.0

### Minor Changes

- 68a3136: Pick her voice from your own Fish Audio voices, private ones included

## 0.14.0

### Minor Changes

- ea544a4: Pick any supported provider for hearing, chat, voice, embeddings and decisions in setup

### Patch Changes

- 13ad749: Estimate refinement costs at each provider's current prices, not outdated ones
- db02978: Starting Eidolon again links to the running one at the address it listens on
- b9cf40b: Say Eidolon's log, not just the terminal, has an internal error's details
- e2e6262: Stop a cancelled ingest at once, even while it waits out an embedding quota error
- 04d0e3f: Estimate memory's embedding spend when the provider reports none, as knowledge search does

## 0.13.0

### Minor Changes

- db9d808: Run on Windows x64, where tasks run their commands in Git Bash
- 096fb88: Send her images and text files in chats, in the app and through the SDK

### Patch Changes

- bc0e211: A floating message box in chats, its buttons and permission picker inside it

## 0.12.0

### Minor Changes

- b7bd371: Run on Node 24 with no Bun to download
- 37f1484: A built-in persona-update skill finds a persona's new streams to transcribe

### Patch Changes

- 72fdd19: Update undici to 7.30.2 and minimatch to 11.0.5 for their security fixes

## 0.11.0

### Minor Changes

- e4da444: Choose per chat how much her tasks ask you, from Ask for Approval to Full Access
- 3579673: Find the app's pages and your chats in a sidebar on the left, as in a chat app
- 9e7d364: Type / in a chat to pick a command, or one of your skills for her task
- 727445b: Manage skills in Settings, use ~/.agents/skills, and name a skill to her

### Patch Changes

- b7f210e: The local app is now LAPLACE Eidolon, with a new logo and tab icon
- 2ed56dc: A blue theme for the local app
- 1205a07: Hear and transcribe with Soniox's v6 models by default

## 0.10.0

### Minor Changes

- 99d38b4: Let her tasks use the MCP servers you add, asking you before each call
- 99d38b4: Let you pick a model for each kind of task: quick, coding or research
- 99d38b4: Let her tasks run commands on your computer once you allow them
- 99d38b4: Let her tasks use Agent Skills from your data home and the task's folder
- 99d38b4: Let her tasks search the web through an OpenRouter account you pick
- aa03ebb: Ask her in a chat to work in your folders and read the web, with your approval
- aba36d6: Pick /focus, /normal or /verbose for a chat's tasks, and stop one with /stop
- aba36d6: Keep what she says before a tool call in its place; a voice reply speaks the rest
- 2259c57: Run an assistant task in a folder from the command line with laplace-task
- aba36d6: Let her use up to 8 tool rounds a reply (chat.maxRounds), then still answer
- 4b1e84d: Ask her how a task is going, change or stop it, and give her tasks on a call

### Patch Changes

- b4b2484: Her reply on a thinking Claude model no longer fails after several tool rounds
- c2f2402: Run on Bun 1.4.5, which fixes security issues in TLS, HTTP/3 and DNS
- b4b2484: A reply OpenRouter ends with an error no longer counts as finished
- aba36d6: Tool results no longer push her older lines out of production chats
- 875e147: Answer instead of staying silent when Gemini sends back a malformed reply

## 0.9.1

### Patch Changes

- a62824d: Muting your mic on a call in the local app stops sending your voice
- 3acd3da: A cough or noise on a call no longer leaves the thinking dots up with no reply coming

## 0.9.0

### Minor Changes

- 9310a28: Let sites listed in EIDOLON_LOCAL_ALLOWED_ORIGINS call the local app's bot API

## 0.8.0

### Minor Changes

- afca3c8: Set up a persona's voice styles in the studio, each with its trigger words

### Patch Changes

- 07258aa: A group call no longer sits waiting for a greeting no one gives
- 07258aa: A call inside a chat shows what is said as it is said, not once she has finished

## 0.7.0

### Minor Changes

- 9f0e5cc: Call a persona from inside a chat, with the conversation carried over
- a994c23: A chat endpoint for the web client, off until a secret is set
- 5d16254: Group chats where personas answer you and each other
- 039a620: A new voice engine for calls: replies end on time and keep only what you heard
- 039a620: Call everyone in a group chat at once
- 8db1350: Voice messages in chats: she can answer with her voice, and you can talk back
- 3d04686: Chat with a persona in text, and keep many chats

### Patch Changes

- dbb00af: Saving memory or reranker settings in the local app no longer needs a restart
- 2ee1cb4: Messages sent mid-reply no longer cut off whoever is typing or go unanswered
- 67b2c0e: Turn off onnxruntime's telemetry to Microsoft, which could crash Eidolon on exit
- 816901c: Remove the old voice engine

## 0.6.0

### Minor Changes

- dea23e1: Talk through an OpenAI or xAI realtime voice model (experimental)
- dea23e1: Add several accounts of one provider, and pick each role's account per persona
- dea23e1: List the models each provider offers now, in a searchable picker
- dea23e1: Choose any supported provider for each persona's hearing, chat and voice
- dea23e1: See what each provider costs on the new Usage page, for one persona or all
- 03d372e: Answer when she last or first streamed something, and how often

## 0.5.0

### Minor Changes

- 4ecd91e: Persona settings now override environment variables, which become her defaults
- 6714428: Install and run Eidolon with npx @laplace.live/eidolon
- c41a712: A new look for the local app: settings by persona in her studio, and avatars

### Patch Changes

- 7333ff4: Offline commands stop gracefully when one Ctrl-C or SIGTERM reaches them twice
