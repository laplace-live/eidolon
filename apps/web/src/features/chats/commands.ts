// The composer's commands: /focus, /normal and /verbose set how much of her tasks the chat shows,
// and /stop stops one. A command never reaches her as a line; a skill's name after a slash does,
// as the owner naming the skill for her task.
import { CHAT_DISPLAYS } from "@eidolon/chat";

export const CHAT_COMMANDS = [...CHAT_DISPLAYS, "stop"] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];

/** One of the owner's skills she can be asked for by name. */
export interface SlashSkill {
  readonly name: string;
  readonly description: string;
}

/** What a `/` offers: a command, which runs, or a skill, which her line names. */
export type SlashEntry =
  | { readonly kind: "command"; readonly name: ChatCommand }
  | ({ readonly kind: "skill" } & SlashSkill);

function commandNamed(name: string): ChatCommand | undefined {
  return CHAT_COMMANDS.find((command) => command === name);
}

/**
 * What a `/` offers: the commands while nothing follows the slash word, since a command runs only
 * alone, then `skills`, but for one named as a command, whose line the command would refuse.
 */
export function slashEntries(skills: readonly SlashSkill[], alone: boolean): SlashEntry[] {
  return [
    ...(alone ? CHAT_COMMANDS.map((name) => ({ kind: "command" as const, name })) : []),
    ...skills
      .filter(({ name }) => commandNamed(name) === undefined)
      .map(({ name, description }) => ({ kind: "skill" as const, name, description })),
  ];
}

export type Parsed =
  /** One of the commands alone: it runs. */
  | { readonly kind: "command"; readonly command: ChatCommand }
  /** A command with more after it, which it can't take: refused, the draft kept. */
  | { readonly kind: "trailing"; readonly command: ChatCommand }
  /** A slash and ASCII letters alone that name no command or skill: refused, the draft kept. */
  | { readonly kind: "unknown"; readonly typed: string }
  /** Anything else, a path, a sentence or a skill's name after a slash included: a line for her. */
  | { readonly kind: "line" };

// A Chinese input method in full-width punctuation types ／ for /.
const SLASH_WORD = /^[/／]([A-Za-z]+)(\s[\s\S]*)?$/;

/** What the composer does with `draft`, where she can be asked for `skills`. */
export function parseCommand(draft: string, skills: readonly SlashSkill[] = []): Parsed {
  const typed = draft.trim();
  const match = SLASH_WORD.exec(typed);
  if (match === null) return { kind: "line" };
  const [, word = "", rest] = match;
  const name = word.toLowerCase();
  const command = commandNamed(name);
  if (command !== undefined) {
    return rest === undefined ? { kind: "command", command } : { kind: "trailing", command };
  }
  return rest === undefined && !skills.some((skill) => skill.name === name)
    ? { kind: "unknown", typed }
    : { kind: "line" };
}
