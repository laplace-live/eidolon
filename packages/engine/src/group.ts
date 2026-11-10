// What changes in her turn while the chat holds other personas: the prefix's line naming them, stop
// sequences and a cut for a line she writes as one of them, and the lines Mem0 may store.
import {
  CHAT_WINDOW_MESSAGES,
  type ChatEvent,
  type ChatHeader,
  type ParticipantId,
  summarize,
} from "@eidolon/chat";
import { readPersonaIdentity } from "@eidolon/config";
import type { GroupMember } from "@eidolon/context";

/** Stop sequences are `\n名字：` and `\n名字:`, and OpenAI takes at most 4. */
const STOP_SPEAKERS = 2;

export interface Group {
  /** The others, as her prefix introduces them. */
  readonly members: readonly GroupMember[];
  /** Ends her reply at a line written as one of the two others heard from last. */
  readonly stop: readonly string[];
  /** Every other's name and short name, which `SpeakerCut` cuts at. */
  readonly names: readonly string[];
  /** What Mem0 stores of the chat: the viewer's lines and hers, never another persona's. */
  readonly memory: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
}

/** Persona `persona`'s group in the chat as it stands, or null while she is its only persona. */
export function groupOf(
  chat: { readonly header: ChatHeader; readonly events: readonly ChatEvent[] },
  persona: ParticipantId,
): Group | null {
  const others = new Map(
    summarize(chat.header, chat.events)
      .participants.filter((id) => id !== persona)
      .map((id) => [id, readPersonaIdentity(id)]),
  );
  if (others.size === 0) return null;
  const heard: ParticipantId[] = [];
  const memory: { role: "user" | "assistant"; content: string }[] = [];
  for (const event of chat.events) {
    if (event.type !== "message" || event.text === "") continue;
    const { speaker } = event;
    if (speaker.kind === "user") {
      memory.push({ role: "user", content: event.text });
    } else if (speaker.id === persona) {
      memory.push({ role: "assistant", content: event.text });
    } else if (others.has(speaker.id)) {
      heard.push(speaker.id);
    }
  }
  const lastHeard = [...new Set([...heard.reverse(), ...others.keys()])].slice(0, STOP_SPEAKERS);
  const identities = [...others.values()];
  return {
    members: identities.map(({ name, summary }) => ({ name, summary })),
    stop: [
      ...new Set(
        lastHeard.flatMap((id) => {
          const name = others.get(id)?.name ?? "";
          return name === "" ? [] : [`\n${name}：`, `\n${name}:`];
        }),
      ),
    ],
    names: identities.flatMap(({ name, shortName }) => [name, shortName]),
    memory: memory.slice(-CHAT_WINDOW_MESSAGES),
  };
}

/**
 * Her text as it streams, with each line held back until it can't be one written as another
 * participant (her name or short name, then `：` or `:`, case-blind), and cut before the first that
 * is. Stop sequences catch most such lines at the provider; this catches the rest.
 */
export class SpeakerCut {
  readonly #labels: readonly string[];
  /** Text not shown yet: the open line, after the line breaks before it. */
  #held = "";
  /** The current line may still turn out to be one of the labels; the text starts as one. */
  #open = true;
  #cut = false;

  constructor(names: readonly string[]) {
    this.#labels = [
      ...new Set(
        names
          .filter((name) => name !== "")
          .flatMap((name) => [`${name}：`, `${name}:`])
          .map((label) => label.toLowerCase()),
      ),
    ];
  }

  /** She wrote a line as someone else; nothing she writes after it is shown. */
  get cut(): boolean {
    return this.#cut;
  }

  /** What of `text` can be shown now. */
  push(text: string): string {
    if (this.#cut) return "";
    let shown = "";
    for (const char of text) {
      if (char === "\n") {
        // A line that ends unlabelled is hers; the breaks after it wait on the next line.
        if (!this.#held.endsWith("\n") && this.#held !== "") {
          shown += this.#held;
          this.#held = "";
        }
        this.#held += "\n";
        this.#open = true;
        continue;
      }
      if (!this.#open) {
        shown += char;
        continue;
      }
      this.#held += char;
      const line = this.#held.slice(this.#held.lastIndexOf("\n") + 1).toLowerCase();
      if (this.#labels.some((label) => line.startsWith(label))) {
        this.#cut = true;
        this.#held = "";
        return shown;
      }
      if (!this.#labels.some((label) => label.startsWith(line))) {
        shown += this.#held;
        this.#held = "";
        this.#open = false;
      }
    }
    return shown;
  }

  /** The text held at a round's end, which never became a label; a line it opened stays open. */
  flush(): string {
    const held = this.#held;
    this.#held = "";
    if (held !== "" && !held.endsWith("\n")) this.#open = false;
    return held;
  }
}
