// A selfie reaches a chat as attachments on her message: each image is copied into the chat as soon
// as take_selfie sends it, while its URL still serves it (SELFIE_TTL_SECONDS).
import type { Attachment } from "@eidolon/chat";
import { SELFIE_PATH, type SelfieStore, selfieStore } from "@eidolon/imagegen";
import type { EngineDeps } from "./types.ts";

/**
 * EngineDeps.fetchImage for take_selfie's URLs, which are root-relative paths into the in-process
 * store `/api/selfie` serves, so the bytes are read from it rather than over HTTP.
 */
export async function fetchStoredSelfie(
  url: string,
  store: SelfieStore = selfieStore,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const prefix = `${SELFIE_PATH}/`;
  if (!url.startsWith(prefix)) throw new Error(`Not a selfie URL: ${url}`);
  const image = store.lookup(url.slice(prefix.length));
  if (image === null) throw new Error(`The selfie at ${url} is gone`);
  return { bytes: image.data, mime: image.mediaType };
}

/** The images a `selfie` server message names, saved; any other message carries nothing to keep. */
export async function saveSelfies(
  data: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  deps: Pick<EngineDeps, "fetchImage" | "saveAttachment">,
): Promise<Attachment[]> {
  if (data.type !== "selfie" || !Array.isArray(data.urls)) return [];
  const saved: Attachment[] = [];
  for (const url of data.urls) {
    if (typeof url !== "string") continue;
    const image = await deps.fetchImage(url, signal);
    signal.throwIfAborted();
    saved.push(await deps.saveAttachment(image.bytes, image.mime));
  }
  return saved;
}
