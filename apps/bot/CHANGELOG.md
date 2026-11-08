# laplace-eidolon

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

- f5c448c: A local web app to set up Eidolon, build personas from their videos, and call them
- 4ecd91e: Persona settings now override environment variables, which become her defaults
- 6714428: Install and run Eidolon with npx @laplace.live/eidolon
- c41a712: A new look for the local app: settings by persona in her studio, and avatars
- ef39e62: Build a persona's knowledge from videos and fact files with the new TypeScript tools

### Patch Changes

- 7333ff4: Offline commands stop gracefully when one Ctrl-C or SIGTERM reaches them twice

## 0.4.0

### Minor Changes

- ffb6538: Configure personas and settings in YAML files, with keys kept apart

## 0.3.1

### Patch Changes

- bf8747f: Save viewers' memories reliably when the model thinks at length

## 0.3.0

### Minor Changes

- d78cf45: Add a TypeScript runtime on Bun that runs beside the Python bot
