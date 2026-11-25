// OpenRouter's Decisions API, which routes Jev and the other decision models it lists: one POST asks
// every question, and each answer is a `noul`, the probability of yes.
import {
  extractCostUsd,
  httpxStatusMessage,
  isJsonObject,
  isPlainObject,
  openrouterHeaders,
  pyError,
  pyParseFloat,
  pyStrRepr,
  pyTypeName,
  withoutTrailingSlashes,
} from "@eidolon/config";
import { reportUsage } from "../usage.ts";
import type { DecisionAnswers, DecisionModel, DecisionModelOptions } from "./index.ts";

export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** OpenRouter's Decisions route sits beside its v1 API, not under it. */
export function decisionsUrl(baseUrl: string): string {
  return `${withoutTrailingSlashes(baseUrl).replace(/\/v1$/, "")}/alpha/decisions`;
}

/** Reports one Decisions answer's usage to the ledger, as the gate's role. */
export function reportDecision(provider: string, model: string, body: unknown): void {
  const usage = isPlainObject(body) && isPlainObject(body.usage) ? body.usage : null;
  if (usage === null) return;
  const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
  const served = isPlainObject(body) && typeof body.model === "string" ? body.model : model;
  reportUsage({
    role: "gate",
    provider,
    model: served,
    units: { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) },
    costUsd: extractCostUsd(usage),
  });
}

// Python float(): a malformed noul must fail its caller open, and Number(null) === 0 would read as
// a no.
function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = pyParseFloat(value);
    if (parsed !== null) return parsed;
    throw pyError("ValueError", `could not convert string to float: ${pyStrRepr(value)}`);
  }
  throw pyError(
    "TypeError",
    `float() argument must be a string or a real number, not '${pyTypeName(value)}'`,
  );
}

function subscript(container: unknown, key: string): unknown {
  if (!isJsonObject(container)) {
    throw pyError("TypeError", `'${pyTypeName(container)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(container, key)) throw pyError("KeyError", key);
  return container[key];
}

/** Question `name`'s noul in a Decisions answer; throws on a missing or malformed one. */
function noulOf(body: unknown, name: string): number {
  return pyFloat(subscript(subscript(subscript(body, "answers"), name), "noul"));
}

export interface OpenRouterDecisionsOptions extends DecisionModelOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly url?: string;
}

/** One model on OpenRouter's Decisions API, billed to the gate's role. */
export function openRouterDecisions(options: OpenRouterDecisionsOptions): DecisionModel {
  const url = options.url ?? OPENROUTER_DECISIONS_URL;
  const post = options.fetch ?? fetch;
  const headers = {
    ...openrouterHeaders(),
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
  };
  return {
    provider: "openrouter",
    model: options.model,
    async decide(state, questions, signal): Promise<DecisionAnswers> {
      const timeout = AbortSignal.timeout(options.timeoutSec * 1000);
      // The connection must outlive the gap between turns: with httpx's 5 s keep-alive, turns
      // 15-40 s apart paid a fresh TLS session each, ~1.4 s a call instead of ~0.5 s.
      // installHttpDefaults keeps fetch's sockets 90 s.
      const response = await post(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: options.model, state, questions }),
        // httpx follows no redirects, so a 3xx failed open there too.
        redirect: "manual",
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
      if (!response.ok) {
        throw pyError(
          "HTTPStatusError",
          httpxStatusMessage(response, url, { statusLineOnly: true }),
        );
      }
      const body: unknown = await response.json();
      reportDecision("openrouter", options.model, body);
      return { probability: (name) => noulOf(body, name) };
    },
  };
}
