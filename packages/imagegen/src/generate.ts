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
import { ImageGenError } from "./errors.ts";
import type { ReferenceImage } from "./references.ts";

export const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
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

// A max-quality render runs for minutes, and fetch gives up on headers or a body idle for 5 minutes
// by default; Bun's fetch ignores the dispatcher that lifts it. The bot bounds itself far lower,
// through the tool timeout.
export const IMAGE_REQUEST_IDLE_TIMEOUT_MS = 600_000;

/** One decoded image off the API, with the media type it reported. */
export interface GeneratedImage {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

/** Everything one `/images` call produced. */
export interface Generation {
  readonly images: readonly GeneratedImage[];
  readonly costUsd: number | null;
}

export interface GenerateOptions {
  readonly apiKey: string;
  /** The images endpoint; OpenRouter's by default. */
  readonly url?: string;
  readonly prompt: string;
  readonly references?: readonly ReferenceImage[] | null;
  readonly model?: string;
  readonly n?: number;
  readonly aspectRatio?: string;
  readonly quality?: string;
  /** Aborts the request; the call then rejects with `signal.reason`, never an ImageGenError. */
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
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

/**
 * One OpenRouter `/images` call, shared by the selfie tool and the CLI. No retries. Throws
 * ImageGenError on a transport failure, a non-200 status, or a response without an image; a 200
 * whose body isn't JSON, or whose `b64_json` isn't base64 text, throws as it parses.
 */
export async function generate(options: GenerateOptions): Promise<Generation> {
  const { signal } = options;
  const payload: Record<string, unknown> = {
    model: options.model ?? DEFAULT_IMAGE_MODEL,
    prompt: options.prompt,
    n: options.n ?? 1,
  };
  if (options.references && options.references.length > 0) {
    payload.input_references = options.references;
  }
  // "auto" is the model's own default; omitting it keeps the body valid for models whose enums
  // differ.
  const aspectRatio = options.aspectRatio ?? "auto";
  if (aspectRatio !== "auto") payload.aspect_ratio = aspectRatio;
  const quality = options.quality ?? "auto";
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
    const response = await (options.fetch ?? fetch)(options.url ?? OPENROUTER_IMAGES_URL, init);
    status = response.status;
    text = await response.text();
  } catch (e) {
    // A cancelled call aborts the fetch with the task's CancelledError; rethrow that reason untouched
    // so the framework settles the call as cancelled rather than as a failed render.
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
  return { images, costUsd: extractCostUsd(isJsonObject(parsed) ? parsed.usage : undefined) };
}
