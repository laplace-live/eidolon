// One persona's turn in a chat, run the way a call runs one: her view of the log, the retrieval
// gate and context providers, then the mind and its tool loop. It all runs as her, inside
// withPersona, and its events come out as drafts for the caller to number and store.
import {
  type Attachment,
  CHAT_WINDOW_MESSAGES,
  type ChatEventDraft,
  type CutOff,
  type ParticipantId,
  toolCallMessages,
  viewWithBlocks,
} from "@eidolon/chat";
import { errorText, logger, raceAbort, readPersonaIdentity, withPersona } from "@eidolon/config";
import { buildGreetingKickoff } from "@eidolon/context";
import type { FrameMetadata, ToolEffects, ToolResult } from "@eidolon/core";
import { MEM0_STORE_KEY } from "@eidolon/memory";
import { withUsageScope } from "@eidolon/providers";
import { saveSelfies } from "./attachments.ts";
import { TurnConversation } from "./context.ts";
import { type Group, groupOf, SpeakerCut } from "./group.ts";
import type {
  EngineDeps,
  Mind,
  MindToolCall,
  PersonaParts,
  TurnOutput,
  TurnRequest,
} from "./types.ts";

/** Mind calls per turn; tool calls the last one asks for are not run. */
export const MAX_ROUNDS = 4;

/** pipedog's tool results for a call with no handler, and for one whose handler threw. */
const missingResult = (name: string): ToolResult => ({
  error: `The function \`${name}\` is not currently available.`,
});
const failedResult = (name: string): ToolResult => ({
  error: `The function \`${name}\` failed and returned no result.`,
});

/** The finish reasons that stop her short: OpenAI's and Anthropic's names for each. */
const CUT_OFF = new Map<string | null, CutOff>([
  ["length", "length"],
  ["max_tokens", "length"],
  ["content_filter", "refusal"],
  ["refusal", "refusal"],
]);

/** How a tool call ended: the result the mind sees, null when it timed out. */
interface ToolOutcome {
  readonly result: ToolResult | null;
  readonly failed: boolean;
}

/** The outputs a running turn has produced and its reader hasn't taken yet. */
class Outputs implements AsyncIterable<TurnOutput> {
  readonly #queue: TurnOutput[] = [];
  #closed = false;
  #wake: (() => void) | null = null;

  readonly push = (output: TurnOutput): void => {
    if (this.#closed) return;
    this.#queue.push(output);
    this.#wake?.();
  };

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TurnOutput> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}

/**
 * Persona `request.persona`'s reply to the chat as it stands. It starts on the first read, always
 * ends with `ended`, and never rejects for the turn's own failures: those become a `turn-failed`
 * event. A reader that stops reading aborts it.
 */
export async function* runTurn(request: TurnRequest, deps: EngineDeps): AsyncGenerator<TurnOutput> {
  const outputs = new Outputs();
  const left = new AbortController();
  const signal = AbortSignal.any([request.signal, left.signal]);
  const crash: { error?: unknown } = {};
  // The turn runs as a promise rather than in this generator, whose body would run in whatever
  // async context reads it next, outside both scopes.
  void withPersona(request.persona, () =>
    withUsageScope({ source: "chat", session: request.chat.header.id }, () =>
      new Turn(request, deps, signal, outputs.push).run(),
    ),
  )
    .catch((error: unknown) => {
      crash.error = error;
    })
    .finally(() => outputs.close());
  let drained = false;
  try {
    yield* outputs;
    drained = true;
  } finally {
    if (!drained) left.abort();
  }
  if ("error" in crash) throw crash.error;
}

class Turn {
  readonly #request: TurnRequest;
  readonly #deps: EngineDeps;
  readonly #signal: AbortSignal;
  readonly #emit: (output: TurnOutput) => void;
  readonly #persona: ParticipantId;
  readonly #id: string;
  #text = "";
  readonly #attachments: Attachment[] = [];
  #cutOff: CutOff | undefined;
  /** Her message is built: photos saved from now on go out on a later one. */
  #sealed = false;

  constructor(
    request: TurnRequest,
    deps: EngineDeps,
    signal: AbortSignal,
    emit: (output: TurnOutput) => void,
  ) {
    this.#request = request;
    this.#deps = deps;
    this.#signal = signal;
    this.#emit = emit;
    this.#persona = request.persona;
    this.#id = deps.newId();
  }

  async run(): Promise<void> {
    const turn = this.#id;
    this.#emit({ type: "started", turn, persona: this.#persona });
    let failure: string | null = null;
    try {
      await this.#respond();
    } catch (error) {
      if (this.#signal.aborted) {
        logger.info(`[chat] ${this.#persona}'s turn ${turn} was interrupted`);
      } else {
        failure = errorText(error);
        logger.error(`[chat] ${this.#persona}'s turn ${turn} failed: ${failure}`, error);
      }
    }
    const events: ChatEventDraft[] = [];
    this.#sealed = true;
    // A reply cut off before any words is kept too, so the chat shows it.
    if (this.#text !== "" || this.#attachments.length > 0 || this.#cutOff !== undefined) {
      const interrupted = this.#signal.aborted || failure !== null;
      events.push({
        type: "message",
        id: this.#deps.newId(),
        speaker: { kind: "persona", id: this.#persona },
        text: this.#text,
        ...(this.#attachments.length > 0 ? { attachments: [...this.#attachments] } : {}),
        ...(interrupted ? { interrupted: true } : {}),
        ...(this.#cutOff !== undefined ? { cutOff: this.#cutOff } : {}),
      });
    }
    if (failure !== null) {
      events.push({ type: "turn-failed", persona: this.#persona, turn, error: failure });
    }
    this.#record(events);
    this.#emit({ type: "ended", turn });
  }

  #record(events: readonly ChatEventDraft[]): void {
    if (events.length > 0) this.#emit({ type: "events", events });
  }

  async #respond(): Promise<void> {
    const { chat, viewer, kickoff } = this.#request;
    const signal = this.#signal;
    const viewerName = viewer.uname ?? "";
    const group = groupOf(chat, this.#persona, viewerName);
    const parts = await raceAbort(
      this.#deps.parts(this.#persona, viewer, chat, group?.others ?? []),
      signal,
    );
    const mind = this.#deps.createMind();
    const { messages, blocks } = viewWithBlocks(chat.header, chat.events, this.#persona, {
      windowMessages: CHAT_WINDOW_MESSAGES,
      nameOf: (id) => readPersonaIdentity(id).name,
      viewerName,
    });
    const conversation = new TurnConversation(messages, {
      persona: this.#persona,
      turn: this.#id,
      blocks,
    });
    if (kickoff) {
      const content = buildGreetingKickoff(await this.#greetingMemories(parts));
      this.#record([{ type: "kickoff", persona: this.#persona, turn: this.#id, content }]);
      conversation.append({ role: "user", content });
    }
    await this.#enrich(parts, conversation, group);
    await this.#converse(parts, mind, conversation, group);
  }

  async #greetingMemories(parts: PersonaParts): Promise<readonly { readonly memory?: unknown }[]> {
    try {
      return await raceAbort(parts.memories(), this.#signal);
    } catch (error) {
      if (this.#signal.aborted) throw this.#signal.reason;
      logger.warning(`Could not load Mem0 memories for greeting: ${errorText(error)}`);
      return [];
    }
  }

  /** The gate, then each provider in turn, as a call's pipeline runs them ahead of the LLM. */
  async #enrich(
    parts: PersonaParts,
    conversation: TurnConversation,
    group: Group | null,
  ): Promise<void> {
    const signal = this.#signal;
    const metadata: FrameMetadata = {};
    if (group !== null) metadata[MEM0_STORE_KEY] = group.memory;
    parts.gate?.attach(conversation.getMessages(), metadata, conversation.turn);
    for (const { label, provider } of parts.providers) {
      try {
        await raceAbort(
          provider.onContext({
            context: conversation,
            metadata,
            signal,
            spawn: (name, job) => {
              // Outlives the turn, still in her persona and usage scopes.
              Promise.resolve()
                .then(job)
                .catch((error: unknown) => {
                  logger.error(`[chat] ${name} failed: ${errorText(error)}`, error);
                });
            },
          }),
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        logger.error(`${label}: ${provider.errorMessage(error)}`);
      }
    }
    this.#record(conversation.takeRecorded());
  }

  async #converse(
    parts: PersonaParts,
    mind: Mind,
    conversation: TurnConversation,
    group: Group | null,
  ): Promise<void> {
    const signal = this.#signal;
    const cut = group === null ? null : new SpeakerCut(group.names);
    for (let round = 1; ; round++) {
      const hidden = conversation.hiddenTools;
      let text = "";
      let calls: MindToolCall[] = [];
      let finishReason: string | null = null;
      const say = (said: string): void => {
        if (said === "") return;
        text += said;
        this.#text += said;
        this.#emit({ type: "delta", turn: this.#id, text: said });
      };
      for await (const chunk of mind.stream({
        system: parts.systemInstruction,
        messages: conversation.getMessages(),
        tools: parts.tools
          .filter((tool) => !hidden.includes(tool.schema.name))
          .map((tool) => tool.schema),
        ...(group === null ? {} : { stop: group.stop }),
        signal,
      })) {
        signal.throwIfAborted();
        if (chunk.type === "text") {
          say(cut === null ? chunk.text : cut.push(chunk.text));
          // What follows a line written as someone else is theirs too, tool calls included.
          if (cut?.cut) break;
        } else if (chunk.type === "tool-calls") {
          calls = [...calls, ...chunk.calls];
        } else if (chunk.type === "done") {
          finishReason = chunk.finishReason;
        }
      }
      signal.throwIfAborted();
      if (cut?.cut) {
        logger.info(`[chat] ${this.#persona}'s reply was cut where she wrote as someone else`);
        return;
      }
      if (cut !== null) say(cut.flush());
      if (calls.length === 0) {
        this.#cutOff = CUT_OFF.get(finishReason);
        return;
      }
      if (round === MAX_ROUNDS) {
        logger.warning(
          `[chat] ${this.#persona} called ${calls.map((call) => call.name).join(", ")} ` +
            `after ${MAX_ROUNDS} rounds; not run`,
        );
        return;
      }
      this.#record(
        calls.map((call) => ({
          type: "tool-call",
          persona: this.#persona,
          turn: this.#id,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      );
      // pipedog runs a round's calls in parallel too.
      const results = await Promise.all(
        calls.map((call) => this.#runTool(parts, call, conversation)),
      );
      calls.forEach((call, i) => {
        conversation.append(...toolCallMessages({ callId: call.id, ...call }, results[i] ?? null));
      });
      // A call's text lands after its tool messages, as pipedog's assistant aggregator orders it.
      if (text !== "") conversation.append({ role: "assistant", content: text });
      this.#record(conversation.takeRecorded());
    }
  }

  /** The result the mind sees, or null for a call that timed out, which a call's view cancels. */
  async #runTool(
    parts: PersonaParts,
    call: MindToolCall,
    conversation: TurnConversation,
  ): Promise<ToolResult | null> {
    const turnSignal = this.#signal;
    const state = (s: "running" | "done" | "failed"): void =>
      this.#emit({ type: "tool", turn: this.#id, name: call.name, state: s });
    const settle = (result: ToolResult, s: "done" | "failed"): ToolResult => {
      this.#record([this.#toolResult(call, result)]);
      state(s);
      return result;
    };
    state("running");
    const tool = parts.tools.find((candidate) => candidate.schema.name === call.name);
    if (tool === undefined) {
      logger.warning(`[chat] ${this.#persona} called ${call.name}, which she doesn't have`);
      return settle(missingResult(call.name), "failed");
    }
    // A tool that runs on past an interruption answers only to its timeout and `late.signal`.
    const late = tool.cancelOnInterruption ? undefined : this.#request.late;
    const cancel = late?.signal ?? turnSignal;
    const timeout = tool.timeoutSecs ? AbortSignal.timeout(tool.timeoutSecs * 1000) : null;
    const signal = timeout === null ? cancel : AbortSignal.any([cancel, timeout]);
    const later: Attachment[] = [];
    const effects: ToolEffects = {
      switchVoice: async () => {
        throw new Error("A text chat has no voice to switch");
      },
      sendServerMessage: async (data) => {
        const saved = await saveSelfies(data, signal, this.#deps);
        (this.#sealed ? later : this.#attachments).push(...saved);
      },
    };
    const running = (async (): Promise<ToolOutcome> => {
      try {
        const run = tool.run({ arguments: call.arguments, context: conversation, signal }, effects);
        return { result: await raceAbort(run, signal), failed: false };
      } catch (error) {
        if (cancel.aborted) throw cancel.reason;
        if (timeout?.aborted) {
          logger.warning(
            `[chat] ${call.name} timed out after ${tool.timeoutSecs} seconds and was cancelled`,
          );
          return { result: null, failed: true };
        }
        logger.error(`[chat] ${call.name} failed: ${errorText(error)}`, error);
        return { result: failedResult(call.name), failed: true };
      }
    })();
    let outcome: ToolOutcome;
    try {
      outcome = await (late === undefined ? running : raceAbort(running, turnSignal));
    } catch (error) {
      if (!turnSignal.aborted) throw error;
      if (late !== undefined) {
        logger.info(
          `[chat] ${call.name} runs on after ${this.#persona}'s turn ${this.#id} stopped`,
        );
        late.add(call.name, this.#lateEvents(call, running, later));
      }
      throw turnSignal.reason;
    }
    if (outcome.result === null) {
      state("failed");
      return null;
    }
    return settle(outcome.result, outcome.failed ? "failed" : "done");
  }

  /** What a tool her interrupted turn left running adds once it ends: its result, then `photos`. */
  async #lateEvents(
    call: MindToolCall,
    running: Promise<ToolOutcome>,
    photos: readonly Attachment[],
  ): Promise<readonly ChatEventDraft[]> {
    const outcome = await running.catch(() => null);
    const events: ChatEventDraft[] = [];
    if (outcome?.result) events.push(this.#toolResult(call, outcome.result));
    if (photos.length > 0) {
      events.push({
        type: "message",
        id: this.#deps.newId(),
        speaker: { kind: "persona", id: this.#persona },
        text: "",
        attachments: [...photos],
      });
    }
    return events;
  }

  #toolResult(call: MindToolCall, result: ToolResult): ChatEventDraft {
    return { type: "tool-result", persona: this.#persona, turn: this.#id, callId: call.id, result };
  }
}
