// One persona's turn in a chat, run the way a call runs one: her view of the log, the retrieval
// gate and context providers, then the mind and its tool loop, and for a voice message her voice
// role speaking what she wrote. It all runs as her, inside withPersona, and its events come out as
// drafts for the caller to number and store. In a call, her reply is spoken as it streams and she
// keeps what was heard, and an async tool's result arrives after her turn.
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
import type {
  ConversationContext,
  FrameMetadata,
  LlmTool,
  ToolEffects,
  ToolResult,
} from "@eidolon/core";
import { MEM0_STORE_KEY } from "@eidolon/memory";
import { withUsageScope } from "@eidolon/providers";
import { callInstruction, isAsyncTool } from "./async_tool.ts";
import { saveSelfies } from "./attachments.ts";
import { TurnConversation } from "./context.ts";
import { type Group, groupOf, SpeakerCut } from "./group.ts";
import type {
  CallHooks,
  CallTurnOutput,
  CallTurnRequest,
  EngineDeps,
  LateTools,
  Mind,
  MindToolCall,
  PartsOptions,
  PersonaParts,
  TurnOutput,
  TurnRequest,
} from "./types.ts";
import { timed, withUnheard } from "./voice.ts";

/** The `tool` stream line's name while her voice role speaks a voice message. */
const SPEAKING = "voice";

/** Mind calls per turn; tool calls the last one asks for are not run. */
export const MAX_ROUNDS = 4;

/** pipedog's tool results for a call with no handler, and for one whose handler threw. */
const missingResult = (name: string): ToolResult => ({
  error: `The function \`${name}\` is not currently available.`,
});
const failedResult = (name: string): ToolResult => ({
  error: `The function \`${name}\` failed and returned no result.`,
});

/** pipedog's RTVI error text for a mind request that failed. */
const completionError = (error: unknown): string => `Error during completion: ${errorText(error)}`;

/** The finish reasons that stop her short: OpenAI's and Anthropic's names for each. */
const CUT_OFF = new Map<string | null, CutOff>([
  ["length", "length"],
  ["max_tokens", "length"],
  ["content_filter", "refusal"],
  ["refusal", "refusal"],
]);

/** Her view of `chat` as her turn reads it, with the seq each of her blocks came from. */
export function turnView(
  chat: TurnRequest["chat"],
  persona: ParticipantId,
  viewerName: string,
): ReturnType<typeof viewWithBlocks> {
  return viewWithBlocks(chat.header, withUnheard(chat.events), persona, {
    windowMessages: CHAT_WINDOW_MESSAGES,
    nameOf: (id) => readPersonaIdentity(id).name,
    viewerName,
  });
}

/** How a tool call ended: the result the mind sees, null when it timed out. */
interface ToolOutcome {
  readonly result: ToolResult | null;
  readonly failed: boolean;
}

/** A call's async tool, still running when its round ends. */
const RUNS_ON: unique symbol = Symbol("runs on");

type ToolState = "running" | "done" | "failed" | "cancelled";

type ToolResultDraft = Extract<ChatEventDraft, { readonly type: "tool-result" }>;

type AnyOutput = TurnOutput | CallTurnOutput;

/** The outputs a running turn has produced and its reader hasn't taken yet. */
class Outputs implements AsyncIterable<AnyOutput> {
  readonly #queue: AnyOutput[] = [];
  #closed = false;
  #wake: (() => void) | null = null;
  /** The reader has taken every output and asked for the next. */
  #parked = false;
  #idle: (() => void)[] = [];

  readonly push = (output: AnyOutput): void => {
    if (this.#closed) return;
    this.#queue.push(output);
    this.#wake?.();
  };

  /** Resolves once the reader has handled every output pushed so far, or they are closed. */
  readonly read = (): Promise<void> =>
    this.#isIdle() ? Promise.resolve() : new Promise((resolve) => this.#idle.push(resolve));

  close(): void {
    this.#closed = true;
    this.#wake?.();
    this.#release();
  }

  #isIdle(): boolean {
    return this.#closed || (this.#parked && this.#queue.length === 0);
  }

  #release(): void {
    if (this.#isIdle()) for (const resolve of this.#idle.splice(0)) resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AnyOutput> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      this.#parked = true;
      this.#release();
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#parked = false;
      this.#wake = null;
    }
  }
}

/**
 * A call's hooks, each called only once every output before it has been read: the call speaks
 * what its reader hands on, so a switch of voice, the end of her speech or an async result that
 * overtook her last words would cut them off. `aborted` skips the wait where her turn awaits it,
 * since a reader that stopped never reads the rest.
 */
function inOrder(hooks: CallHooks, read: () => Promise<void>, aborted: AbortSignal): CallHooks {
  const flushed = (): Promise<void> => raceAbort(read(), aborted).catch(() => {});
  const { effects } = hooks;
  return {
    ...hooks,
    effects: {
      switchVoice: async (voice) => {
        await flushed();
        await effects.switchVoice(voice);
      },
      sendServerMessage: async (data) => {
        await flushed();
        await effects.sendServerMessage(data);
      },
    },
    heard: async () => {
      await flushed();
      return hooks.heard();
    },
    onAsyncResult: (events) => {
      void read().then(() => hooks.onAsyncResult(events));
    },
  };
}

/** Runs `fn` as `request.persona`, in the request's usage scope. */
function scoped<T>(request: Pick<TurnRequest, "chat" | "persona" | "usage">, fn: () => T): T {
  const usage = request.usage ?? { source: "chat", session: request.chat.header.id };
  return withPersona(request.persona, () => withUsageScope(usage, fn));
}

/**
 * Persona `request.persona`'s reply to the chat as it stands. It starts on the first read, always
 * ends with `ended`, and never rejects for the turn's own failures: those become a `turn-failed`
 * event. A reader that stops reading aborts it.
 */
export function runTurn(request: CallTurnRequest, deps: EngineDeps): AsyncGenerator<CallTurnOutput>;
export function runTurn(request: TurnRequest, deps: EngineDeps): AsyncGenerator<TurnOutput>;
export async function* runTurn(
  request: TurnRequest | CallTurnRequest,
  deps: EngineDeps,
): AsyncGenerator<AnyOutput> {
  const outputs = new Outputs();
  const left = new AbortController();
  const signal = AbortSignal.any([request.signal, left.signal]);
  const crash: { error?: unknown } = {};
  // The turn runs as a promise rather than in this generator, whose body would run in whatever
  // async context reads it next, outside both scopes.
  void scoped(request, () => new Turn(request, deps, signal, outputs.push, outputs.read).run())
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

/** What a turn on a realtime model reads before it answers: everything but the mind. */
export type PrepareRequest = Pick<
  TurnRequest,
  "chat" | "persona" | "viewer" | "kickoff" | "nudge" | "usage" | "signal"
>;

/**
 * Her parts and recall for a call on a realtime model, which is its own mind: the parts' realtime
 * variant with the async guidance, and the events her kickoff, nudge and providers add, for the
 * caller to store and mirror. `context` is her view as they left it, for `runTool`. Rejects with
 * the signal's reason on an abort, and with anything that fails before her providers run.
 */
export function prepareTurn(
  request: PrepareRequest,
  deps: EngineDeps,
): Promise<{
  readonly parts: PersonaParts;
  readonly events: readonly ChatEventDraft[];
  readonly context: ConversationContext;
}> {
  return scoped(request, async () => {
    const events: ChatEventDraft[] = [];
    const turn = new Turn(
      request,
      deps,
      request.signal,
      (output) => {
        if (output.type === "events") events.push(...output.events);
      },
      async () => {},
      true,
    );
    const { parts, conversation } = await turn.prepare();
    return { parts, events, context: conversation };
  });
}

/**
 * Runs her tool `call` from `parts`: its result, pipedog's error result for a tool she doesn't have
 * or one that threw, or null when it timed out. Rejects with `signal`'s reason when it aborts.
 */
export async function runTool(
  call: MindToolCall,
  parts: PersonaParts,
  effects: ToolEffects,
  signal: AbortSignal,
  context: ConversationContext,
): Promise<ToolResult | null> {
  const tool = parts.tools.find((candidate) => candidate.schema.name === call.name);
  if (tool === undefined) return missingResult(call.name);
  return (await invoke(tool, call, context, () => effects, signal)).result;
}

/**
 * `tool`'s outcome for `call`, under its own timeout, with the effects made for the signal it runs
 * under; rejects with `cancel`'s reason.
 */
async function invoke(
  tool: LlmTool,
  call: MindToolCall,
  context: ConversationContext,
  effects: (signal: AbortSignal) => ToolEffects,
  cancel: AbortSignal,
): Promise<ToolOutcome> {
  const timeout = tool.timeoutSecs ? AbortSignal.timeout(tool.timeoutSecs * 1000) : null;
  const signal = timeout === null ? cancel : AbortSignal.any([cancel, timeout]);
  try {
    const run = tool.run({ arguments: call.arguments, context, signal }, effects(signal));
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
}

/** Each value once all have settled, so none reports after the turn; the first rejection, if any. */
async function allSettled<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(promises);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
}

class Turn {
  readonly #request: TurnRequest | CallTurnRequest;
  readonly #deps: EngineDeps;
  readonly #signal: AbortSignal;
  readonly #emit: (output: AnyOutput) => void;
  readonly #persona: ParticipantId;
  readonly #id: string;
  /** A call's: her reply is spoken as it streams. */
  readonly #call: CallHooks | null;
  readonly #late: LateTools | undefined;
  /** A call on a realtime model, which this turn only prepares. */
  readonly #realtime: boolean;
  #text = "";
  readonly #attachments: Attachment[] = [];
  #cutOff: CutOff | undefined;
  /** Her message is built: photos saved from now on go out on a later one. */
  #sealed = false;
  /** The voice her voice-style tool switched this voice message to. */
  #voice: string | undefined;
  /** Her voice message's audio, once spoken and saved. */
  #audio: Attachment | null = null;
  /** Why her voice message stayed text. */
  #unspoken: string | null = null;
  /** Her reply is or may be a voice message, or a call's. */
  readonly #mayBeVoice: boolean;

  /** `read` resolves once whoever reads `emit`'s outputs has handled them all. */
  constructor(
    request: TurnRequest | CallTurnRequest,
    deps: EngineDeps,
    signal: AbortSignal,
    emit: (output: AnyOutput) => void,
    read: () => Promise<void>,
    realtime = false,
  ) {
    this.#request = request;
    this.#deps = deps;
    this.#signal = signal;
    this.#emit = emit;
    this.#persona = request.persona;
    this.#id = deps.newId();
    this.#call = request.mode === "call" ? inOrder(request, read, signal) : null;
    this.#late = request.mode === "call" ? undefined : request.late;
    this.#realtime = realtime;
    this.#mayBeVoice = request.mode !== undefined && request.mode !== "text";
  }

  async run(): Promise<void> {
    const turn = this.#id;
    this.#emit({ type: "started", turn, persona: this.#persona });
    let failure: string | null = null;
    try {
      await this.#respond();
      const mode = await raceAbort(Promise.resolve(this.#request.mode), this.#signal);
      if (mode === "voice") await this.#speak();
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
    // A call keeps what was heard of her, which may stop short of what she wrote.
    const heard = this.#call === null ? null : await this.#call.heard();
    const text = heard === null ? this.#text : heard.text;
    // A reply cut off before any words is kept too, so the chat shows it; a call's isn't.
    if (
      text !== "" ||
      this.#attachments.length > 0 ||
      (heard === null && this.#cutOff !== undefined)
    ) {
      const interrupted =
        heard === null ? this.#signal.aborted || failure !== null : !heard.complete;
      const attachments =
        this.#audio === null ? this.#attachments : [this.#audio, ...this.#attachments];
      events.push({
        type: "message",
        id: this.#deps.newId(),
        speaker: { kind: "persona", id: this.#persona },
        text,
        ...(this.#audio === null ? {} : { modality: "voice" }),
        ...(heard === null ? {} : { modality: "call" }),
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
        ...(interrupted ? { interrupted: true } : {}),
        ...(this.#cutOff !== undefined ? { cutOff: this.#cutOff } : {}),
      });
    }
    if (failure !== null) {
      events.push({ type: "turn-failed", persona: this.#persona, turn, error: failure });
    } else if (this.#unspoken !== null) {
      events.push({
        type: "turn-failed",
        persona: this.#persona,
        turn,
        error: this.#unspoken,
        code: "voice-failed",
      });
    }
    this.#record(events);
    this.#emit({ type: "ended", turn });
  }

  #record(events: readonly ChatEventDraft[]): void {
    if (events.length > 0) this.#emit({ type: "events", events });
  }

  /** Her parts, her view with her kickoff and nudge, and her providers' recall. */
  async prepare(): Promise<{ parts: PersonaParts; conversation: TurnConversation }> {
    const group = this.#group();
    const parts = await this.#parts(group);
    return { parts, conversation: await this.#enriched(parts, group) };
  }

  async #respond(): Promise<void> {
    const group = this.#group();
    const parts = await this.#parts(group);
    const mind = this.#deps.createMind();
    const conversation = await this.#enriched(parts, group);
    await this.#converse(parts, mind, conversation, group);
  }

  #group(): Group | null {
    return groupOf(this.#request.chat, this.#persona, this.#request.viewer.uname ?? "");
  }

  async #parts(group: Group | null): Promise<PersonaParts> {
    const { chat, viewer } = this.#request;
    const others = group?.others ?? [];
    const options: PartsOptions = this.#realtime
      ? { others, realtime: true }
      : { others, voice: this.#mayBeVoice };
    const parts = await raceAbort(
      this.#deps.parts(this.#persona, viewer, chat, options),
      this.#signal,
    );
    if (this.#call === null && !this.#realtime) return parts;
    return { ...parts, systemInstruction: callInstruction(parts.systemInstruction, parts.tools) };
  }

  async #enriched(parts: PersonaParts, group: Group | null): Promise<TurnConversation> {
    const { chat, viewer, kickoff, nudge } = this.#request;
    const { messages, blocks } = turnView(chat, this.#persona, viewer.uname ?? "");
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
    if (nudge !== undefined) {
      conversation.setMessages([
        ...conversation.getMessages(),
        { role: "developer", content: nudge },
      ]);
      this.#record(conversation.takeRecorded());
    }
    await this.#enrich(parts, conversation, group);
    return conversation;
  }

  /**
   * Her voice role speaks what she wrote, cues and all, and the audio is saved for her message.
   * When that fails, her message stays text, and the failure is recorded after it.
   */
  async #speak(): Promise<void> {
    if (this.#text.trim() === "") return;
    const signal = this.#signal;
    const state = (s: "running" | "done" | "failed"): void =>
      this.#emit({ type: "tool", turn: this.#id, name: SPEAKING, state: s });
    state("running");
    try {
      const voice = this.#voice;
      const spoken = await raceAbort(
        this.#deps.speech.synthesize(this.#text, {
          ...(voice === undefined ? {} : { voice }),
          signal,
        }),
        signal,
      );
      const saved = await raceAbort(this.#deps.saveAttachment(spoken.bytes, spoken.mime), signal);
      this.#audio = timed(saved, spoken.durationMs);
      state("done");
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      this.#unspoken = errorText(error);
      logger.warning(`[chat] ${this.#persona}'s voice message goes as text: ${this.#unspoken}`);
      state("failed");
    }
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
        const text = provider.errorMessage(error);
        logger.error(`${label}: ${text}`);
        if (this.#call !== null) this.#emit({ type: "notice", turn: this.#id, text });
      }
    }
    this.#record(conversation.takeRecorded());
  }

  /** In a call, a mind request's `started` line, and what ends it once. */
  #mindRequest(): (error?: string) => void {
    if (this.#call === null) return () => {};
    const turn = this.#id;
    this.#emit({ type: "mind", turn, state: "started" });
    let open = true;
    return (error) => {
      if (!open) return;
      open = false;
      this.#emit({ type: "mind", turn, state: "ended", ...(error === undefined ? {} : { error }) });
    };
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
      const ended = this.#mindRequest();
      try {
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
      } catch (error) {
        ended(signal.aborted ? undefined : completionError(error));
        throw error;
      }
      let running: Promise<ToolResult | null | typeof RUNS_ON>[];
      try {
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
        // pipedog runs a round's calls in parallel too, and ends the mind's response once they
        // have started.
        running = calls.map((call) => this.#runTool(parts, call, conversation));
      } finally {
        ended();
      }
      const outcomes = await allSettled(running);
      const results = outcomes.filter((result) => result !== RUNS_ON);
      if (results.length < outcomes.length) {
        // pipedog asks the mind again only once every call of the round has settled: the async
        // one's result starts her next reply.
        this.#record(conversation.takeRecorded());
        return;
      }
      calls.forEach((call, i) => {
        conversation.append(...toolCallMessages({ callId: call.id, ...call }, results[i] ?? null));
      });
      // A call's text lands after its tool messages, as pipedog's assistant aggregator orders it.
      if (text !== "") conversation.append({ role: "assistant", content: text });
      this.#record(conversation.takeRecorded());
    }
  }

  /** A call names a tool that timed out cancelled; a chat, failed. */
  #toolLine(call: MindToolCall, runsOn: boolean, state: ToolState): void {
    const { name } = call;
    const turn = this.#id;
    if (this.#call !== null) {
      this.#emit({ type: "tool", turn, name, callId: call.id, async: runsOn, state });
    } else {
      this.#emit({ type: "tool", turn, name, state: state === "cancelled" ? "failed" : state });
    }
  }

  /**
   * The result the mind sees, null for a call that timed out, which a call's view cancels, or
   * RUNS_ON for a call's async tool, whose result comes through `onAsyncResult`.
   */
  async #runTool(
    parts: PersonaParts,
    call: MindToolCall,
    conversation: TurnConversation,
  ): Promise<ToolResult | null | typeof RUNS_ON> {
    const turnSignal = this.#signal;
    const hooks = this.#call;
    const tool = parts.tools.find((candidate) => candidate.schema.name === call.name);
    const runsOn = hooks !== null && tool !== undefined && isAsyncTool(tool);
    const state = (s: ToolState): void => this.#toolLine(call, runsOn, s);
    const settle = (result: ToolResult, s: "done" | "failed"): ToolResult => {
      this.#record([this.#toolResult(call, result)]);
      state(s);
      return result;
    };
    state("running");
    if (tool === undefined) {
      logger.warning(`[chat] ${this.#persona} called ${call.name}, which she doesn't have`);
      return settle(missingResult(call.name), "failed");
    }
    if (runsOn) {
      this.#record([{ ...this.#toolResult(call, {}), stage: "started" }]);
      this.#runOn(tool, call, conversation, hooks);
      return RUNS_ON;
    }
    // A tool that runs on past an interruption answers only to its timeout and `late.signal`.
    const late = tool.cancelOnInterruption ? undefined : this.#late;
    const cancel = late?.signal ?? turnSignal;
    const later: Attachment[] = [];
    const effects = (signal: AbortSignal): ToolEffects =>
      hooks?.effects ?? {
        switchVoice: async (voice) => {
          if (!this.#mayBeVoice) throw new Error("A text reply has no voice to switch");
          this.#voice = voice;
        },
        sendServerMessage: async (data) => {
          const saved = await saveSelfies(data, signal, this.#deps);
          (this.#sealed ? later : this.#attachments).push(...saved);
        },
      };
    const running = invoke(tool, call, conversation, effects, cancel);
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
      if (hooks !== null) state("cancelled");
      throw turnSignal.reason;
    }
    if (outcome.result === null) {
      state("cancelled");
      return null;
    }
    return settle(outcome.result, outcome.failed ? "failed" : "done");
  }

  /**
   * A call's async tool, run on past its round in her scopes: its result, or its cancellation at
   * its timeout or the call's end, goes to `onAsyncResult`.
   */
  #runOn(
    tool: LlmTool,
    call: MindToolCall,
    conversation: TurnConversation,
    hooks: CallHooks,
  ): void {
    const cancel = hooks.asyncSignal ?? new AbortController().signal;
    void invoke(tool, call, conversation, () => hooks.effects, cancel)
      .then(
        (outcome) => outcome.result,
        () => null,
      )
      .then((result) => {
        hooks.onAsyncResult([
          result === null
            ? { ...this.#toolResult(call, {}), stage: "cancelled" }
            : { ...this.#toolResult(call, result), stage: "final" },
        ]);
      });
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

  #toolResult(call: MindToolCall, result: ToolResult): ToolResultDraft {
    return { type: "tool-result", persona: this.#persona, turn: this.#id, callId: call.id, result };
  }
}
