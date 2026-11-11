# @laplace.live/eidolon

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
