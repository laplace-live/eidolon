// Decision models: one request answers named questions about one state, each with the probability
// of yes. The retrieval gate and a group chat's director ask them through this interface alone.
import type { ProviderId } from "../catalog.ts";
import { hasKey, missingKey, ProviderConfigError, type Selection, trySelect } from "../resolve.ts";
import { decisionsUrl, openRouterDecisions } from "./openrouter.ts";

export interface DecisionQuestion {
  /** Answered with the probability of yes. */
  readonly type: "noul";
  readonly instructions: string;
}

export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

/** One answer to every question asked, read a question at a time. */
export interface DecisionAnswers {
  /** Question `name`'s probability of yes; throws when the answer lacks it, or holds a bad one. */
  probability(name: string): number;
}

export interface DecisionModel {
  /** Its provider's catalog id, as the usage ledger names it. */
  readonly provider: string;
  readonly model: string;
  /** Asks every question in one request; rejects on any failure, `signal`'s abort included. */
  decide(
    state: unknown,
    questions: DecisionQuestions,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers>;
}

export interface DecisionModelOptions {
  /** How long one request may take before it fails. */
  readonly timeoutSec: number;
  readonly fetch?: typeof fetch;
}

type KeyedSelection = Selection & { readonly apiKey: string };

/** Each provider's decision models, by catalog id: one for every provider whose offer has them. */
export const DECISION_MODELS: {
  readonly [P in ProviderId]?: (
    selection: KeyedSelection,
    options: DecisionModelOptions,
  ) => DecisionModel;
} = {
  openrouter: (selection, options) =>
    openRouterDecisions({
      ...options,
      apiKey: selection.apiKey,
      model: selection.model,
      url: decisionsUrl(selection.baseUrl as string),
    }),
};

/** `selection`'s decision model; throws before any request when it has no key. */
export function decisionModel(selection: Selection, options: DecisionModelOptions): DecisionModel {
  const open = DECISION_MODELS[selection.provider.id];
  if (open === undefined) {
    throw new ProviderConfigError(`${selection.provider.name} has no decision models in Eidolon`);
  }
  if (!hasKey(selection)) throw missingKey(selection);
  return open(selection as KeyedSelection, options);
}

/**
 * The active persona's gate role as a decision model: null when its key is unset, or when its
 * settings name no decision model, which `onError` hears.
 */
export function gateDecisionModel(
  options: DecisionModelOptions,
  onError: (error: Error) => void,
): DecisionModel | null {
  const selection = trySelect("gate", undefined, onError);
  if (selection === null || !hasKey(selection)) return null;
  return decisionModel(selection, options);
}
