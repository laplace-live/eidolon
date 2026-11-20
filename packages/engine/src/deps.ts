import { newId } from "@eidolon/config";
import { fetchStoredSelfie } from "./attachments.ts";
import { createMind } from "./mind/index.ts";
import { personaParts } from "./parts.ts";
import type { EngineDeps } from "./types.ts";
import { batchSpeech } from "./voice.ts";

// One cache for the process: deps are made per chat, since `saveAttachment` names the chat.
const parts = personaParts();

/**
 * The real engine, storing a turn's files through `saveAttachment` and reading the viewer's through
 * `readAttachment`.
 */
export function defaultEngineDeps(
  files: Pick<EngineDeps, "saveAttachment" | "readAttachment">,
): EngineDeps {
  return {
    createMind,
    parts,
    ...files,
    fetchImage: (url) => fetchStoredSelfie(url),
    newId,
    speech: batchSpeech,
  };
}
