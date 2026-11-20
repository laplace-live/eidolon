// OpenRouter's image route is not chat completions and has no OpenAI SDK binding: references go in
// `input_references`, results come back as raw base64 in `data[].b64_json`, not as data URLs.
import {
  errorText,
  extractCostUsd,
  isJsonObject,
  openrouterHeaders,
  patientDispatcher,
  pyStr,
  pyStrip,
  pyTruthy,
} from "@eidolon/config";
import { reportUsage } from "../usage.ts";
import { ImageGenError } from "./errors.ts";
import type { GeneratedImage, Generation, ImageModel, ImageModelOptions } from "./index.ts";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

// A max-quality render runs for minutes, and fetch gives up on headers or a body idle for 5 minutes
// by default; Bun's fetch ignores the dispatcher that lifts it. The bot bounds itself far lower,
// through the tool timeout.
const IMAGE_REQUEST_IDLE_TIMEOUT_MS = 600_000;

/** The images route under an API base. */
export function imagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images`;
}

/** OpenRouter's `{"error": {"message": ...}}`, falling back to the raw body. */
function errorMessage(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return pyStrip(text);
  }
  const error = isJsonObject(body) ? body.error : undefined;
  if (isJsonObject(error)) return pyStr(pyTruthy(error.message) ? error.message : error);
  return pyStr(pyTruthy(error) ? error : body);
}

/**
 * `text` decoded as `Uint8Array.fromBase64` decodes it, which Node lacks: ASCII whitespace
 * skipped, padding optional but whole, and any other character outside the standard alphabet a
 * SyntaxError, where Buffer would skip it and decode the rest.
 */
function fromBase64(text: unknown): Uint8Array {
  if (typeof text !== "string") throw new TypeError("b64_json is not a string");
  const compact = text.replace(/[\t\n\f\r ]/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const body = compact.slice(0, compact.length - padding);
  const tail = body.length % 4;
  if (/[^A-Za-z0-9+/]/.test(body) || tail === 1 || (padding > 0 && tail + padding !== 4)) {
    throw new SyntaxError("b64_json is not base64");
  }
  return new Uint8Array(Buffer.from(body, "base64"));
}

// A truthy `data` that isn't a list: a string or an object yields no image rows, and a number or a
// boolean raises the TypeError Python raises iterating one.
function rowsOf(data: unknown): unknown[] {
  if (typeof data === "number" || typeof data === "boolean") {
    const type = typeof data === "boolean" ? "bool" : Number.isInteger(data) ? "int" : "float";
    throw new TypeError(`'${type}' object is not iterable`);
  }
  return Array.isArray(data) ? data : [];
}

export interface OpenRouterImagesOptions extends ImageModelOptions {
  readonly apiKey: string;
  readonly model: string;
  /** The images endpoint; OpenRouter's by default. */
  readonly url?: string;
}

/**
 * One model on OpenRouter's `/images` route, each render billed to the selfie role. No retries.
 * Throws ImageGenError on a transport failure, a non-200 status, or a response without an image; a
 * 200 whose body isn't JSON, or whose `b64_json` isn't base64 text, throws as it parses.
 */
export function openRouterImages(options: OpenRouterImagesOptions): ImageModel {
  const url = options.url ?? OPENROUTER_IMAGES_URL;
  const { model } = options;
  return {
    provider: "openrouter",
    model,
    async generate(request, signal): Promise<Generation> {
      const payload: Record<string, unknown> = { model, prompt: request.prompt, n: request.n ?? 1 };
      if (request.references && request.references.length > 0) {
        payload.input_references = request.references;
      }
      // "auto" is the model's own default; omitting it keeps the body valid for models whose enums
      // differ.
      const aspectRatio = request.aspectRatio ?? "auto";
      if (aspectRatio !== "auto") payload.aspect_ratio = aspectRatio;
      const quality = request.quality ?? "auto";
      if (quality !== "auto") payload.quality = quality;
      const body = JSON.stringify(payload);
      const headers = {
        ...openrouterHeaders(),
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      };

      let status: number;
      let text: string;
      try {
        const init: RequestInit & { readonly dispatcher: unknown } = {
          method: "POST",
          headers,
          body,
          signal,
          dispatcher: patientDispatcher(IMAGE_REQUEST_IDLE_TIMEOUT_MS),
        };
        const response = await (options.fetch ?? fetch)(url, init);
        status = response.status;
        text = await response.text();
      } catch (e) {
        // A cancelled call aborts the fetch with the task's CancelledError; rethrow that reason
        // untouched so the framework settles the call as cancelled rather than as a failed render.
        if (signal?.aborted) throw signal.reason;
        throw new ImageGenError(`request failed: ${errorText(e)}`);
      }
      if (status !== 200) throw new ImageGenError(`${status}: ${errorMessage(text)}`);

      const parsed: unknown = JSON.parse(text);
      const data = isJsonObject(parsed) && pyTruthy(parsed.data) ? parsed.data : [];
      const images: GeneratedImage[] = [];
      for (const row of rowsOf(data)) {
        if (!isJsonObject(row) || !pyTruthy(row.b64_json)) continue;
        const mediaType = row.media_type;
        images.push({
          // A non-string b64_json throws TypeError here, as b64decode does.
          data: fromBase64(row.b64_json),
          mediaType: typeof mediaType === "string" && mediaType !== "" ? mediaType : "image/png",
        });
      }
      if (images.length === 0) throw new ImageGenError("the response carried no image");
      const costUsd = extractCostUsd(isJsonObject(parsed) ? parsed.usage : undefined);
      reportUsage({
        role: "selfie",
        provider: "openrouter",
        model,
        units: { images: images.length },
        costUsd,
      });
      return { images, costUsd };
    },
  };
}
