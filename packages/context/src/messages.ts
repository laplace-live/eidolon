// The live context holds OpenAI-shaped messages next to pipedog's LLMSpecificMessage objects,
// which carry no `role`, so every check tests the shape before trusting a field.
import { pyStr } from "@eidolon/config";
import type { ConversationContext } from "@eidolon/core";

export type Message = Record<string, unknown>;

export function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Two frames belong to one user turn iff both fields match; a repeated text is a new turn. */
export interface TurnKey {
  readonly userCount: number;
  readonly latestContent: string;
}

export function turnKeyOf(messages: readonly unknown[]): TurnKey {
  let userCount = 0;
  let latest: Message | undefined;
  for (const message of messages) {
    if (isMessage(message) && message.role === "user") {
      userCount++;
      latest = message;
    }
  }
  // Python's str(users[-1].get("content", "")): list content keys by its repr.
  const content = latest?.content;
  return { userCount, latestContent: content === undefined ? "" : pyStr(content) };
}

export function sameTurn(a: TurnKey | null, b: TurnKey): boolean {
  return a !== null && a.userCount === b.userCount && a.latestContent === b.latestContent;
}

/** The last user message with string content, unstripped. */
export function latestUserText(messages: readonly unknown[]): string | null {
  return recentUserTexts(messages, 1)[0] ?? null;
}

/** The last `n` user messages with string content, newest first, unstripped. */
export function recentUserTexts(messages: readonly unknown[], n: number): string[] {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < n; i--) {
    const message = messages[i];
    if (isMessage(message) && message.role === "user" && typeof message.content === "string") {
      texts.push(message.content);
    }
  }
  return texts;
}

/**
 * Replaces every system block starting with `prefix`, wherever it sits, with one at
 * `min(position, length)`; an empty `text` only removes. Always writes the context back.
 */
export function setBlock(
  context: ConversationContext,
  prefix: string,
  text: string,
  position: number,
): void {
  const kept = context
    .getMessages()
    .filter(
      (message) =>
        !(
          isMessage(message) &&
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith(prefix)
        ),
    );
  if (text) {
    kept.splice(Math.min(position, kept.length), 0, { role: "system", content: prefix + text });
  }
  context.setMessages(kept);
}
