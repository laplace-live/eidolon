// One request through a task's mind, with no tools and no retry, for a short answer: Approve for
// Me's review of an action that would wait on the owner. Its usage is the caller's to bill.
import type { Mind } from "../types.ts";
import { readReply } from "./loop.ts";

/** `mind`'s whole text answer to `prompt`; throws when the request fails or its reply never ends. */
export async function completeText(
  mind: Mind,
  request: { readonly system: string; readonly prompt: string; readonly signal: AbortSignal },
): Promise<string> {
  const { system, prompt, signal } = request;
  const messages = [{ role: "user", content: prompt }];
  return (await readReply(mind, { system, messages, tools: [], signal }, signal)).text;
}
