// What the owner can change at a start's approval, its model and web access, and the answer the
// card and the waiting bar send.
import type { TaskApproveRequest, TaskModel, TaskSnapshot, TaskWebMode } from "@/lib/api";

/** In the order the card offers them. */
export const WEB_MODES: readonly TaskWebMode[] = ["ask", "any", "off"];

/** An account and model picked over the task's own; "" keeps the task's. */
export interface ModelChoice {
  readonly account: string;
  readonly model: string;
}

/**
 * The model a choice picks: null for the task's own, or `missing` for another account with no
 * model named, since the task's model is another provider's.
 */
export function chosenModel(choice: ModelChoice, base: TaskModel): TaskModel | null | "missing" {
  const account = choice.account || base.account;
  const model = choice.model.trim() || (account === base.account ? base.model : "");
  if (model === "") return "missing";
  return account === base.account && model === base.model ? null : { account, model };
}

/**
 * POST approve's body: the answer and the question shown, which the server refuses once the task
 * asks another; a start's Allow carries the model and web access the owner changed too. Null while
 * an Allow can't go, its account having no model named.
 */
export function approveBody(
  answer: TaskApproveRequest["answer"],
  task: Pick<TaskSnapshot, "pending" | "model" | "web">,
  choice: ModelChoice,
  web: TaskWebMode,
): TaskApproveRequest | null {
  const { pending } = task;
  if (answer === "deny" || pending?.kind !== "start") return { answer, pending };
  const model = chosenModel(choice, task.model);
  if (model === "missing") return null;
  return {
    answer,
    pending,
    ...(model === null ? {} : { model }),
    ...(web === (task.web?.mode ?? "ask") ? {} : { web }),
  };
}
