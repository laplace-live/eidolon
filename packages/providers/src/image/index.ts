// Image models: one request draws images from a prompt and reference images. @eidolon/imagegen's
// generate(), which the selfie tool and laplace-generate-image share, draws through this interface.
import type { ProviderId } from "../catalog.ts";
import { type KeyedSelection, openModel, type Selection } from "../resolve.ts";
import { imagesUrl, openRouterImages } from "./openrouter.ts";

/** One reference image: an http(s) URL, or a `data:` URL carrying its real media type. */
export interface ReferenceImage {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
}

export interface ImageRequest {
  readonly prompt: string;
  readonly references?: readonly ReferenceImage[] | null;
  /** How many images; 1 by default. */
  readonly n?: number;
  /** "auto", the default, leaves it to the model. */
  readonly aspectRatio?: string;
  /** "auto", the default, leaves it to the model. */
  readonly quality?: string;
}

/** One decoded image off the API, with the media type it reported. */
export interface GeneratedImage {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

/** Everything one request produced. */
export interface Generation {
  readonly images: readonly GeneratedImage[];
  readonly costUsd: number | null;
}

export interface ImageModel {
  /** Its provider's catalog id, as the usage ledger names it. */
  readonly provider: string;
  readonly model: string;
  /**
   * One request, never retried, its usage reported as the selfie role's. Throws ImageGenError when
   * the request fails, is refused or brings no image; an abort rejects with `signal`'s reason.
   */
  generate(request: ImageRequest, signal?: AbortSignal): Promise<Generation>;
}

export interface ImageModelOptions {
  readonly fetch?: typeof fetch;
}

/** Each provider's image models, by catalog id: one for every provider whose offer has them. */
export const IMAGE_MODELS: {
  readonly [P in ProviderId]?: (
    selection: KeyedSelection,
    options: ImageModelOptions,
  ) => ImageModel;
} = {
  openrouter: (selection, options) =>
    openRouterImages({
      ...options,
      apiKey: selection.apiKey,
      model: selection.model,
      url: imagesUrl(selection.baseUrl as string),
    }),
};

/** `selection`'s image model; throws before any request when it has no key. */
export function imageModel(selection: Selection, options: ImageModelOptions = {}): ImageModel {
  return openModel(IMAGE_MODELS, "image models", selection, options);
}
