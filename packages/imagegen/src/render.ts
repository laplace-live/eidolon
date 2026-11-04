import { logger, pyFixed } from "@eidolon/config";
import { ImageGenError } from "./errors.ts";
import { DEFAULT_IMAGE_MODEL, type Generation, generate, MAX_REFERENCES } from "./generate.ts";
import type { PersonaClock } from "./prompt.ts";
import { loadReferences, type ReferenceImage } from "./references.ts";
import { type SelfieStore, selfieStore } from "./store.ts";

export interface RenderSelfieOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly aspectRatio: string;
  readonly quality: string;
  readonly ttlSeconds: number;
  readonly prompt: string;
  /** Friends, sent after the persona's outfit: the order the prompt tells the model to expect. */
  readonly extraReferences?: readonly ReferenceImage[];
  /** Picks the outfit; pass the clock the prompt was filled from. */
  readonly clock?: PersonaClock;
  /** One references directory; the persona's referenceRoots() by default. */
  readonly root?: string;
  readonly signal?: AbortSignal;
  readonly store?: SelfieStore;
  readonly fetch?: typeof fetch;
}

export type SelfieRender =
  | { readonly ok: true; readonly urls: readonly string[]; readonly costUsd: number | null }
  | {
      readonly ok: false;
      /** `Selfie generation failed: <ImageGenError message>`. */
      readonly error: string;
    };

/**
 * Generate one selfie and publish it to the store. The outfit is resolved per call, not held from
 * startup: the choice follows the clock, and a bot that boots in daylight runs into the night.
 * Only ImageGenError becomes `ok: false`; an abort rejects with the signal's reason.
 */
export async function renderSelfie(options: RenderSelfieOptions): Promise<SelfieRender> {
  let result: Generation;
  try {
    const references = [
      ...loadReferences({ clock: options.clock, root: options.root }),
      ...(options.extraReferences ?? []),
    ].slice(0, MAX_REFERENCES);
    result = await generate({
      apiKey: options.apiKey,
      prompt: options.prompt,
      references,
      model: options.model || DEFAULT_IMAGE_MODEL,
      aspectRatio: options.aspectRatio,
      quality: options.quality,
      signal: options.signal,
      fetch: options.fetch,
    });
  } catch (e) {
    if (!(e instanceof ImageGenError)) throw e;
    return { ok: false, error: `Selfie generation failed: ${e.message}` };
  }
  const cost = result.costUsd;
  logger.info(
    `[selfie] Generated ${result.images.length} image(s)` +
      (cost !== null && cost !== 0 ? `, cost $${pyFixed(cost, 4)}` : ""),
  );
  const store = options.store ?? selfieStore;
  const urls = result.images.map((image) => store.publish(image, options.ttlSeconds));
  return { ok: true, urls, costUsd: cost };
}
