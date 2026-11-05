// What a refine run is configured with, read at call time, so laplace-refine and the pipeline
// build the same client.
import {
  envInt,
  envOptional,
  envStr,
  OpenAIClient,
  type OpenAIClientOptions,
  openrouterHeaders,
} from "@eidolon/config";

export const DEFAULT_MODEL = "~google/gemini-pro-latest";
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_CONCURRENCY = 8;

export const MISSING_API_KEY =
  "Refinement needs an API key. Set OPENROUTER_API_KEY (reused from the LLM config) or " +
  "REFINE_API_KEY for a different provider.";

/** `refine.model` (REFINE_MODEL), else the default. */
export function refineModel(): string {
  return envStr("REFINE_MODEL", DEFAULT_MODEL);
}

/** `refine.concurrency` (REFINE_CONCURRENCY), else the default. */
export function refineConcurrency(): number {
  return envInt("REFINE_CONCURRENCY", DEFAULT_CONCURRENCY);
}

/** REFINE_API_KEY, else OPENROUTER_API_KEY; undefined when neither is set. */
export function refineApiKey(): string | undefined {
  return envOptional("REFINE_API_KEY") ?? envOptional("OPENROUTER_API_KEY");
}

/** The client refine.py built: `refine.baseUrl` (REFINE_BASE_URL), else OpenRouter. */
export function refineClient(
  apiKey: string,
  options: Pick<OpenAIClientOptions, "signal" | "fetch"> = {},
): OpenAIClient {
  return new OpenAIClient(
    { baseUrl: envStr("REFINE_BASE_URL", DEFAULT_BASE_URL), apiKey },
    // Offline batch work: ride out a provider's flakes.
    { ...options, maxRetries: 4, headers: openrouterHeaders() },
  );
}
