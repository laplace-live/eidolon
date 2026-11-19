// Assistant Mode's settings, beside its role's provider and model, which @eidolon/providers resolves
// with the other roles'.
import { resolve } from "node:path";
import { envFlag, envFloat, envInt, envOptional } from "./env.ts";
import { expandUser } from "./paths.ts";
import { pyStrip } from "./py.ts";

export const DEFAULT_ASSISTANT_SPEND_PAUSE_USD = 1;
export const DEFAULT_ASSISTANT_CONTEXT_TOKENS = 128_000;

/**
 * What she says a task is when she starts it. Each kind but `other` may have an account and model
 * of its own; `other` runs on the assistant's.
 */
export const TASK_KINDS = ["quick", "coding", "research", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface AssistantSettings {
  /** Assistant Mode: whether she offers tasks at all. */
  readonly enabled: boolean;
  /** Absolute folders every task may read and write besides its own. */
  readonly folders: readonly string[];
  /** Tasks may ask to run commands, each waiting for the owner's OK, on macOS and Linux. */
  readonly bash: boolean;
  /** A task pauses each time its spend crosses a multiple of this; 0 never. */
  readonly spendPauseUsd: number;
  /** The context window a task's requests are kept within, in tokens. */
  readonly contextTokens: number;
}

export function assistantSettings(): AssistantSettings {
  const spendPauseUsd = envFloat("ASSISTANT_SPEND_PAUSE_USD", DEFAULT_ASSISTANT_SPEND_PAUSE_USD);
  const contextTokens = envInt("ASSISTANT_CONTEXT_TOKENS", DEFAULT_ASSISTANT_CONTEXT_TOKENS);
  return {
    enabled: envFlag("ASSISTANT_ENABLED", true),
    folders: (envOptional("ASSISTANT_FOLDERS") ?? "")
      .split(",")
      .map((folder) => pyStrip(folder))
      .filter((folder) => folder !== "")
      .map((folder) => resolve(expandUser(folder))),
    bash: envFlag("ASSISTANT_BASH", true),
    // A value that is no amount mustn't turn the spend pauses off: only 0 does.
    spendPauseUsd:
      Number.isFinite(spendPauseUsd) && spendPauseUsd >= 0
        ? spendPauseUsd
        : DEFAULT_ASSISTANT_SPEND_PAUSE_USD,
    contextTokens: contextTokens > 0 ? contextTokens : DEFAULT_ASSISTANT_CONTEXT_TOKENS,
  };
}
