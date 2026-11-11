import { fetchStoredSelfie } from "./attachments.ts";
import { createMind } from "./mind/index.ts";
import { personaParts } from "./parts.ts";
import type { EngineDeps } from "./types.ts";
import { batchSpeech } from "./voice.ts";

// One cache for the process: deps are made per chat, since `saveAttachment` names the chat.
const parts = personaParts();

/** The real engine, storing a turn's files through `saveAttachment`. */
export function defaultEngineDeps(options: {
  readonly saveAttachment: EngineDeps["saveAttachment"];
}): EngineDeps {
  return {
    createMind,
    parts,
    saveAttachment: options.saveAttachment,
    fetchImage: (url) => fetchStoredSelfie(url),
    newId: () => Bun.randomUUIDv7(),
    speech: batchSpeech,
  };
}
