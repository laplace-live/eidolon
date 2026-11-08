// What home's readiness list says: each item's title, the sentence readiness.ts picks for it by
// code, and the label of the action that fixes it.
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** Titles by item id. */
export const CHECK_TITLES = {
  restart: msg`Restart`,
  call: msg`Calls`,
  "models-hearing": msg`Speech Recognition`,
  "models-mind": msg`Chat Model`,
  "models-voice": msg`Voice Model`,
  "models-realtime": msg`Realtime Model`,
  keys: msg`API Keys`,
  voice: msg`Voice`,
  memory: msg`Memory`,
  facts: msg`Facts`,
  streams: msg({ message: "Stream Archive", context: "readiness check" }),
  selfies: msg`Selfies`,
  ytdlp: msg`yt-dlp`,
  ffmpeg: msg`ffmpeg`,
  disk: msg`Disk Space`,
  lastError: msg`Last Call`,
} satisfies Record<string, MessageDescriptor>;
export type CheckId = keyof typeof CHECK_TITLES;

/** Sentences by the code readiness.ts gives an item, with `{name}` filled from its values. */
export const READY_TEXT = {
  "home.ready.restart": msg`Saved settings wait for a restart.`,
  "home.ready.mcpRestart": msg`The MCP server still serves the settings it started with.`,
  "home.ready.inCall": msg`In progress: {count}.`,
  "home.ready.models.problem": msg`Calls can't start until this setting is fixed.`,
  "home.ready.keys.missing": msg`Missing: {names}. Calls can't start without them.`,
  "home.ready.keys.ok": msg`Saved for {names}.`,
  "home.ready.keys.none": msg`Her providers take no key.`,
  "home.ready.voice.none": msg`She has no voice yet, so calls can't start.`,
  "home.ready.voice.bad": msg`Fish Audio can't use her voice ({id}): it is private or gone.`,
  "home.ready.voice.badEnv": msg`The voice she inherits from the environment ({id}) isn't usable on Fish Audio. Pick her own.`,
  "home.ready.voice.unchecked": msg`Her voice ({id}) hasn't been checked with Fish Audio yet.`,
  "home.ready.voice.uncheckedEnv": msg`She inherits a voice from the environment ({id}), which hasn't been checked with Fish Audio yet.`,
  "home.ready.voice.ok": msg`Her own voice works with Fish Audio.`,
  "home.ready.voice.env": msg`Inherited from the environment, and works with Fish Audio.`,
  "home.ready.voice.provider": msg`{provider} speaks with voice {id}.`,
  "home.ready.voice.providerNone": msg`{provider} needs a voice for her, so calls can't start.`,
  "home.ready.memory.off": msg`Off: she won't remember you between calls.`,
  "home.ready.memory.down": msg`Qdrant isn't answering, so memory is off for now.`,
  "home.ready.memory.unchecked": msg`Set up, but Qdrant hasn't been checked yet.`,
  "home.ready.memory.on": msg`On: she remembers you from one call to the next.`,
  "home.ready.facts.none": msg`No index yet: she knows only her prompt.`,
  "home.ready.facts.stale": msg`Built with other embedding settings: build it again.`,
  "home.ready.facts.built": msg`The index is built.`,
  "home.ready.facts.ok": msg`{rows} indexed, built {date}.`,
  "home.ready.streams.none": msg`Not built yet: she can't recall past broadcasts.`,
  "home.ready.streams.stale": msg`Built with other embedding settings: build it again.`,
  "home.ready.streams.built": msg`The archive is built.`,
  "home.ready.streams.ok": msg`{rows} passages, built {date}.`,
  "home.ready.streams.noCatalog": msg`Built, but the broadcast overview isn't.`,
  "home.ready.selfies.none": msg`No outfit references, so she can't take selfies.`,
  "home.ready.selfies.ok": msg`Outfit references: {count}.`,
  "home.ready.ytdlp.installed": msg`Version {tag} is installed.`,
  "home.ready.ytdlp.onFirstDownload": msg`Installs itself on the first download.`,
  "home.ready.ytdlp.unavailable": msg`Unavailable, so videos can't be downloaded. Install it with brew install yt-dlp or pip install yt-dlp: Eidolon then uses the one on your PATH.`,
  "home.ready.ffmpeg.ok": msg`Installed.`,
  "home.ready.ffmpeg.missing": msg`Not installed. Only videos over 5 hours need it: brew install ffmpeg, apt install ffmpeg or winget install ffmpeg.`,
  "home.ready.disk.low": msg`Only {free} free on the data home's disk. Downloaded audio takes a lot of space.`,
  "home.ready.disk.ok": msg`{free} free on the data home's disk.`,
  "home.ready.lastError": msg`Ended with an error ({when}).`,
} satisfies Record<string, MessageDescriptor>;
export type ReadyCode = keyof typeof READY_TEXT;

/** Fix labels by the code readiness.ts gives a fix. */
export const FIX_LABELS = {
  "home.fix.setup": msg`Add Keys`,
  "home.fix.memory": msg`Turn On`,
  "home.fix.facts": msg`Add Facts`,
  "home.fix.streams": msg`Add Videos`,
  "home.fix.reingest": msg`Rebuild`,
  "home.fix.catalog": msg`Build It`,
  "home.fix.references": msg`Add Outfits`,
  "home.fix.pickVoice": msg`Pick a Voice`,
  "home.fix.changeVoice": msg({ message: "Change", context: "voice" }),
  "home.fix.voice": msg`Set Her Voice`,
  "home.fix.models": msg`Open Her Models`,
  "home.fix.check": msg`Check`,
  "home.fix.restart": msg`Restart`,
} satisfies Record<string, MessageDescriptor>;
export type FixCode = keyof typeof FIX_LABELS;
