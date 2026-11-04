// Persona text runtime sends at two fixed points of a session: the greeting turn and the
// recovery after an empty interrupting turn.
import { pyStr, pyTruthy } from "@eidolon/config";

export const GREETING_KICKOFF = "用一两句话简短自然地打个招呼。";

/** The greeting's user message, mentioning up to three of `memories` (newest first). */
export function buildGreetingKickoff(
  memories: readonly { readonly memory?: unknown }[] | null | undefined,
): string {
  const snippets = (memories ?? [])
    .map((item) => item.memory)
    .filter((memory) => pyTruthy(memory))
    .map((memory) => pyStr(memory));
  if (snippets.length === 0) return GREETING_KICKOFF;
  return (
    `${GREETING_KICKOFF}你之前跟ta聊过这些事：${snippets.slice(0, 3).join("; ")}` +
    "。如果合适的话自然地提一两件，不要全念出来。"
  );
}

/**
 * EmptyUserTurnConfig.interrupted_prompt: sent when a turn that cut the bot off ends with no
 * transcript (a cough, noise, speech Soniox couldn't make out). Pipecat's own wording is English.
 */
export const INTERRUPTED_EMPTY_TURN_PROMPT: string =
  "你刚才说话的时候，好像说了句什么，但没听清。" +
  "你的话在那儿被打断了，对话里只留下ta听到的部分，也可能一句都没听到。" +
  "用一句话自然地请ta再说一遍；" +
  "如果你刚才问了问题，ta可能没听到，就顺带再问一次。";
