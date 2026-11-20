import type { Generation, ImageModel, ImageRequest } from "@eidolon/providers";

export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2.5-flare";

export const ASPECT_RATIOS = [
  "auto",
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "21:9",
] as const;
export const QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export const MAX_REFERENCES = 16;
export const MAX_IMAGES = 10;

export interface GenerateOptions extends ImageRequest {
  /** The selfie role's image model, as `imageModel` makes it. */
  readonly model: ImageModel;
  /** Aborts the request; the call then rejects with `signal.reason`, never an ImageGenError. */
  readonly signal?: AbortSignal;
}

/**
 * One render on `options.model`, shared by the selfie tool and the CLI, its usage reported as the
 * selfie role's. Throws ImageGenError when the request fails, is refused or brings no image.
 */
export function generate(options: GenerateOptions): Promise<Generation> {
  const { model, signal, ...request } = options;
  return model.generate(request, signal);
}
