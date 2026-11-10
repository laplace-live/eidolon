// A turn's ConversationContext: her view as a message list. Each take records what providers and
// tools changed in it since the last: the log's blocks they took out as a `context-removed`, then
// each block they put in as a `context` at its position.
import type { ChatEventDraft, ParticipantId } from "@eidolon/chat";
import { isPlainObject, logger } from "@eidolon/config";
import type { ConversationContext } from "@eidolon/core";

type ContextRole = Extract<ChatEventDraft, { type: "context" }>["role"];

const CONTEXT_ROLES: ReadonlySet<string> = new Set<ContextRole>(["system", "user", "developer"]);

/** A message the log can hold as a `context` block. */
function blockOf(message: unknown): { role: ContextRole; content: string } | null {
  return isPlainObject(message) &&
    typeof message.role === "string" &&
    CONTEXT_ROLES.has(message.role) &&
    typeof message.content === "string"
    ? { role: message.role as ContextRole, content: message.content }
    : null;
}

const keyOf = (block: { role: string; content: string }): string =>
  `${block.role}\n${block.content}`;

/** What the log keeps of `before` is still in its order in `messages`. */
function keepsOrder(messages: readonly unknown[], before: ReadonlyMap<unknown, number>): boolean {
  let last = -1;
  for (const message of messages) {
    const at = before.get(message);
    if (at === undefined) continue;
    if (at < last) return false;
    last = at;
  }
  return true;
}

export class TurnConversation implements ConversationContext {
  readonly #persona: ParticipantId;
  readonly #turn: string;
  /** Her context blocks from the log, by the seq each came from. */
  readonly #blocks: ReadonlyMap<unknown, number>;
  /** The list as the log has it, once what was taken is stored. */
  #taken: unknown[];
  #messages: unknown[];
  #hidden: readonly string[] = [];

  constructor(
    messages: readonly unknown[],
    options: {
      persona: ParticipantId;
      turn: string;
      blocks?: ReadonlyMap<unknown, number>;
    },
  ) {
    this.#messages = [...messages];
    this.#taken = [...messages];
    this.#persona = options.persona;
    this.#turn = options.turn;
    this.#blocks = options.blocks ?? new Map();
  }

  /** A copy: providers splice into what they get, then hand it back through setMessages. */
  getMessages(): unknown[] {
    return [...this.#messages];
  }

  setMessages(messages: unknown[]): void {
    this.#messages = [...messages];
  }

  setHiddenTools(names: readonly string[]): void {
    this.#hidden = [...names];
  }

  get hiddenTools(): readonly string[] {
    return this.#hidden;
  }

  /** Adds what the turn itself says and calls, which its own events record. */
  append(...messages: unknown[]): void {
    this.#messages.push(...messages);
    this.#taken.push(...messages);
  }

  /** The context drafts that turn the list as the log has it into the list as it is. */
  takeRecorded(): ChatEventDraft[] {
    const messages = this.#unchangedRestored();
    const taken = new Set(this.#taken);
    const kept = new Set(messages);
    const recorded: ChatEventDraft[] = [];
    const removed = this.#taken.flatMap((message) => {
      const seq = this.#blocks.get(message);
      return seq === undefined || kept.has(message) ? [] : [seq];
    });
    if (removed.length > 0) {
      recorded.push({
        type: "context-removed",
        persona: this.#persona,
        turn: this.#turn,
        seqs: removed,
      });
    }
    messages.forEach((message, position) => {
      if (taken.has(message)) return;
      const block = blockOf(message);
      if (block === null) {
        logger.warning(
          `[chat] Not recording an inserted message the log can't hold, at ${position}`,
        );
        return;
      }
      recorded.push({
        type: "context",
        persona: this.#persona,
        turn: this.#turn,
        position,
        ...block,
      });
    });
    this.#messages = messages;
    this.#taken = [...messages];
    return recorded;
  }

  /**
   * The list, with each block put back exactly as a log block it replaced swapped for that block,
   * so the archive re-setting an unchanged overview every turn records nothing. A swap that would
   * move the block among what the log keeps is left out.
   */
  #unchangedRestored(): unknown[] {
    const now = new Set(this.#messages);
    const replaced = new Map<string, unknown[]>();
    for (const message of this.#taken) {
      const block = this.#blocks.has(message) && !now.has(message) ? blockOf(message) : null;
      if (block === null) continue;
      const key = keyOf(block);
      replaced.set(key, [...(replaced.get(key) ?? []), message]);
    }
    if (replaced.size === 0) return this.#messages;
    const before = new Map(this.#taken.map((message, i) => [message, i]));
    let messages = this.#messages;
    for (const [i, message] of this.#messages.entries()) {
      if (before.has(message)) continue;
      const block = blockOf(message);
      const candidates = block === null ? undefined : replaced.get(keyOf(block));
      const old = candidates?.[0];
      if (old === undefined) continue;
      const swapped = messages.with(i, old);
      if (keepsOrder(swapped, before)) {
        messages = swapped;
        candidates?.shift();
      }
    }
    return messages;
  }
}
