// The composer's commands: /focus, /normal and /verbose set how much of her tasks the chat shows,
// and /stop stops one. A command never reaches her as a line.
import { CHAT_DISPLAYS } from "@eidolon/chat";

export const CHAT_COMMANDS = [...CHAT_DISPLAYS, "stop"] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];

export type Parsed =
  /** One of the commands alone: it runs. */
  | { readonly kind: "command"; readonly command: ChatCommand }
  /** A command with more after it, which it can't take: refused, the draft kept. */
  | { readonly kind: "trailing"; readonly command: ChatCommand }
  /** A slash and a word of ASCII letters alone that names no command: refused, the draft kept. */
  | { readonly kind: "unknown"; readonly typed: string }
  /** Anything else, a path or a sentence that starts with a slash included: a line for her. */
  | { readonly kind: "line" };

// A Chinese input method in full-width punctuation types ／ for /.
const SLASH_WORD = /^[/／]([A-Za-z]+)(\s[\s\S]*)?$/;

/** What the composer does with `draft`. */
export function parseCommand(draft: string): Parsed {
  const typed = draft.trim();
  const match = SLASH_WORD.exec(typed);
  if (match === null) return { kind: "line" };
  const [, word = "", rest] = match;
  const command = CHAT_COMMANDS.find((known) => known === word.toLowerCase());
  if (command !== undefined) {
    return rest === undefined ? { kind: "command", command } : { kind: "trailing", command };
  }
  return rest === undefined ? { kind: "unknown", typed } : { kind: "line" };
}
