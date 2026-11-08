// What a refine run is configured with, read at call time, so laplace-refine and the pipeline
// build the same client: the refine role's provider and model, with REFINE_API_KEY and
// REFINE_BASE_URL still pointing it somewhere of its own.
import { envInt, type JsonPoster, type OpenAIClientOptions } from "@eidolon/config";
import {
  billingProvider,
  chatPoster,
  missingKey,
  type Selection,
  selectRequired,
  usageHook,
} from "@eidolon/providers";

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_CONCURRENCY = 8;

/** The refine role: `refine.provider` and `refine.model`. */
export function refineSelection(): Selection {
  return selectRequired("refine");
}

/** `refine.model` (REFINE_MODEL), else the refine provider's default. */
export function refineModel(): string {
  return refineSelection().model;
}

/** `refine.concurrency` (REFINE_CONCURRENCY), else the default. */
export function refineConcurrency(): number {
  return envInt("REFINE_CONCURRENCY", DEFAULT_CONCURRENCY);
}

/** What a run without its key logs and reports: which key to set. */
export function missingApiKey(): string {
  return missingKey(refineSelection()).message;
}

/** The client refine.py built, for the refine role's provider, reporting what each call used. */
export function refineClient(
  options: Pick<OpenAIClientOptions, "signal" | "fetch"> = {},
): JsonPoster {
  const selection = refineSelection();
  // Offline batch work: ride out a provider's flakes.
  return chatPoster(
    selection,
    { ...options, maxRetries: 4 },
    usageHook("refine", billingProvider(selection.provider.id, selection.baseUrl)),
  );
}
