// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/agent/src/agent-loop.ts@ac78a60 and packages/agent/src/agent.ts@ac78a60
//
// A task's run: pi-agent-core's turns on a Mind, with every step stored before it is shown, so a run
// stopped anywhere resumes from its transcript.
import { abortableSleep, errorText, raceAbort } from "@eidolon/config";
import { withUsageScope } from "@eidolon/providers";
import { canonical } from "../canonical.ts";
import type {
  TaskEntry,
  TaskEntryDraft,
  TaskEvent,
  TaskOutcome,
  TaskPauseReason,
  TaskRequest,
  TaskTool,
  TaskToolContext,
  TaskToolResult,
} from "../task.ts";
import type { MindRequest, MindToolCall } from "../types.ts";
import {
  argumentsHead,
  type ContextMessage,
  contextMessages,
  cutOff,
  endedReply,
  estimateTokens,
  filesBefore,
  firstKept,
  messageTokens,
  summaryPrompt,
  taskContext,
  unfinished,
} from "./context.ts";
import { isContextOverflow, isTransient } from "./errors.ts";
import { echoed, validateToolArguments } from "./validate.ts";

/** The waits before each retry of a request that failed for a transient reason. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000];

/** pi's reserveTokens: room left in the context for the reply, a quarter of a smaller window. */
const RESERVE_TOKENS = 16_384;
/** pi's keepRecentTokens. */
const KEEP_TOKENS = 20_000;
const MASK_AFTER_TOKENS = 40_000;
/** Turns making the same calls before the task pauses as stalled. */
const STALL_TURNS = 3;
/** How often a run waiting on its background work looks at it and at its inbox. */
const WAIT_MS = 1000;

const INTERRUPTED =
  "Interrupted by a restart before its result was recorded; check the files before trying again.";
/** OpenClaw's result for a sequential call steering skipped. */
const SKIPPED = "Skipped to process an incoming message.";

type EntryOf<T extends TaskEntry["type"]> = Extract<TaskEntry, { readonly type: T }>;

interface Reply {
  readonly text: string;
  readonly calls: readonly MindToolCall[];
  readonly finishReason: string | null;
}

/** A call a batch answers: on resume, one a restart caught running reruns or is reported. */
interface Pending {
  readonly call: MindToolCall;
  readonly as: "new" | "rerun" | "interrupted";
}

interface Settled {
  readonly call: MindToolCall;
  readonly result: TaskToolResult;
}

interface Batch {
  /** In call order. */
  readonly settled: readonly Settled[];
  /** The gate's reason, when it paused the batch; its call and the ones after it didn't run. */
  readonly paused?: string;
}

interface Turn {
  readonly assistant: EntryOf<"assistant">;
  readonly batch: Batch | null;
}

type Prepared =
  | {
      readonly kind: "run";
      readonly call: MindToolCall;
      readonly tool: TaskTool;
      readonly args: Record<string, unknown>;
    }
  | { readonly kind: "result"; readonly result: TaskToolResult }
  | { readonly kind: "pause"; readonly detail: string };

const paused = (reason: TaskPauseReason, detail: string): TaskOutcome => ({
  status: "paused",
  reason,
  detail,
});

/** pi's terminate: a batch whose every result asks for it ends the run as a reply with no calls. */
const terminates = (batch: Batch): boolean =>
  batch.paused === undefined &&
  batch.settled.length > 0 &&
  batch.settled.every(({ result }) => result.terminate === true);

/** A call's arguments as a stall compares and names them; for one that couldn't be read, its text. */
function argumentsOf(call: MindToolCall): string {
  return call.unparsed ?? canonical(call.arguments);
}

/** A turn's calls, in a form two turns making the same calls share. */
function signatureOf(calls: readonly MindToolCall[]): string {
  return calls
    .map((call) => `${call.name} ${argumentsOf(call)}`)
    .sort()
    .join("\n");
}

/** The context's size past which it is compacted. */
function compactAbove(contextTokens: number): number {
  return contextTokens - Math.min(RESERVE_TOKENS, Math.floor(contextTokens / 4));
}

/** The compaction's kept part shrinks with a small context, or it would compact on every turn. */
function keepTokens(contextTokens: number): number {
  return Math.min(KEEP_TOKENS, Math.floor(compactAbove(contextTokens) / 2));
}

/** The events a running task has produced and its reader hasn't taken yet. */
class Events implements AsyncIterable<TaskEvent> {
  readonly #queue: TaskEvent[] = [];
  #closed = false;
  #wake: (() => void) | null = null;

  readonly push = (event: TaskEvent): void => {
    if (this.#closed) return;
    this.#queue.push(event);
    this.#wake?.();
  };

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TaskEvent> {
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

class TaskRun {
  readonly #request: TaskRequest;
  readonly #emit: (event: TaskEvent) => void;
  /** The reader stopped reading: the run stops, storing nothing more, for a later run to resume. */
  readonly #left: AbortSignal;
  readonly #signal: AbortSignal;
  readonly #entries: TaskEntry[] = [];
  readonly #schemaTokens: number;
  #writes: Promise<unknown> = Promise.resolve();
  /** The run has stored its last entry, or its reader left. */
  #closed = false;
  /** Assistant entries so far: the number of the turn that made the latest. */
  #turns = 0;
  /** Each turn's calls this run, for stalls. */
  readonly #signatures: string[] = [];
  #spendLimit = Number.POSITIVE_INFINITY;
  /** The last request's input as its provider counted it, and as estimated. */
  #counted: { readonly reported: number; readonly estimated: number } | null = null;

  constructor(request: TaskRequest, emit: (event: TaskEvent) => void, left: AbortSignal) {
    this.#request = request;
    this.#emit = emit;
    this.#left = left;
    this.#signal = AbortSignal.any([request.signal, left]);
    this.#schemaTokens = estimateTokens(JSON.stringify(request.tools.map((tool) => tool.schema)));
    left.addEventListener(
      "abort",
      () => {
        this.#closed = true;
      },
      { once: true },
    );
  }

  async run(): Promise<TaskOutcome> {
    this.#emit({ type: "run", state: "start" });
    let outcome: TaskOutcome;
    try {
      outcome = await this.#run();
    } catch (error) {
      if (!this.#signal.aborted) throw error;
      if (this.#left.aborted) return { status: "cancelled" };
      outcome = { status: "cancelled" };
    }
    await this.#append(
      outcome.status === "paused"
        ? { type: "pause", reason: outcome.reason, detail: outcome.detail }
        : { type: "end", outcome },
      true,
    );
    this.#emit({ type: "run", state: "end" });
    return outcome;
  }

  async #run(): Promise<TaskOutcome> {
    const stored = await this.#request.store.entries();
    if (stored.length === 0) throw new Error(`Task ${this.#request.id} has no brief`);
    this.#entries.push(...stored);
    this.#turns = stored.filter((entry) => entry.type === "assistant").length;
    const step = this.#request.limits.spendPauseUsd;
    if (step > 0) {
      this.#spendLimit = (Math.floor(this.#request.meter.spentUsd() / step) + 1) * step;
    }
    if (stored.length === 1) return await this.#loop(null);
    await this.#append({ type: "resume" });
    const last = this.#entries.findLast(
      (entry): entry is EntryOf<"assistant"> => entry.type === "assistant",
    );
    const pending = last === undefined ? [] : this.#pending(last);
    if (last !== undefined && pending.length > 0) {
      return await this.#loop({ assistant: last, pending });
    }
    // pi's continue() from an assistant tail: a request now would answer her own reply, so only
    // queued lines and the background's ends carry the run on, unless that reply can't be the
    // report.
    const tail = taskContext(this.#entries).blocks.at(-1);
    if (
      tail?.kind === "assistant" &&
      tail.entry.calls.length === 0 &&
      unfinished(tail.entry.finishReason) === null &&
      !this.#request.inbox.hasSteering() &&
      (await this.#takeFollowUps()) === 0 &&
      !(await this.#waitBackground())
    ) {
      return { status: "succeeded", report: tail.entry.text };
    }
    return await this.#loop(null);
  }

  /** `assistant`'s calls with no result yet, and how each is answered. */
  #pending(assistant: EntryOf<"assistant">): Pending[] {
    const after = this.#entries.filter((entry) => entry.seq > assistant.seq);
    const answered = new Set(after.flatMap((e) => (e.type === "tool-result" ? [e.callId] : [])));
    const started = new Set(after.flatMap((e) => (e.type === "tool-start" ? [e.callId] : [])));
    return assistant.calls
      .filter((call) => !answered.has(call.id))
      .map((call): Pending => {
        if (!started.has(call.id)) return { call, as: "new" };
        return { call, as: this.#tool(call.name)?.replay === "safe" ? "rerun" : "interrupted" };
      });
  }

  async #loop(
    resumed: {
      readonly assistant: EntryOf<"assistant">;
      readonly pending: readonly Pending[];
    } | null,
  ): Promise<TaskOutcome> {
    for (let first = true; ; first = false) {
      const turn = first && resumed !== null ? await this.#rerun(resumed) : await this.#turn();
      if ("status" in turn) return turn;
      const stop = this.#guard(turn);
      if (stop !== null) return stop;
      if (turn.batch !== null && !terminates(turn.batch)) continue;
      if (this.#request.inbox.hasSteering()) continue;
      if ((await this.#takeFollowUps()) > 0) continue;
      const why = turn.batch === null ? unfinished(turn.assistant.finishReason) : null;
      if (why !== null) return { status: "failed", error: why.error };
      if (await this.#waitBackground()) continue;
      return { status: "succeeded", report: turn.assistant.text };
    }
  }

  /**
   * While the tools' background work runs, a run that would end waits for it, sending no request:
   * true once one of its ends, a steering line or a follow-up gives the worker more to do, false
   * once nothing runs.
   */
  async #waitBackground(): Promise<boolean> {
    const background = this.#request.background;
    if (background === undefined) return false;
    for (;;) {
      // Asked first: work that ends after this is either taken now or waited for.
      const running = background.running();
      if ((await this.#takeNotices()) > 0) return true;
      if (!running) return false;
      // runTask's reader stops it only at an event (its generator's return() waits behind next()).
      this.#emit({ type: "wait" });
      await (this.#request.sleep ?? abortableSleep)(WAIT_MS, this.#signal);
      this.#signal.throwIfAborted();
      if (this.#request.inbox.hasSteering()) return true;
      if ((await this.#takeFollowUps()) > 0) return true;
    }
  }

  /** Stores each line the background gives about work that ended since, as a notice. */
  async #takeNotices(): Promise<number> {
    const background = this.#request.background;
    if (background === undefined) return 0;
    this.#signal.throwIfAborted();
    const lines = background.takeEnded();
    for (const text of lines) await this.#append({ type: "notice", text });
    return lines.length;
  }

  async #turn(): Promise<Turn | TaskOutcome> {
    this.#signal.throwIfAborted();
    const held = this.#held();
    if (held !== null) return held;
    const all = this.#request.steeringMode !== "one-at-a-time";
    for (const text of this.#request.inbox.takeSteering(all)) {
      await this.#append({ type: "steer", text });
    }
    await this.#takeNotices();
    const turn = ++this.#turns;
    this.#emit({ type: "turn", state: "start", turn });
    try {
      let reply: Reply | TaskOutcome;
      try {
        reply = await this.#ask();
      } catch (error) {
        if (this.#signal.aborted) throw error;
        return { status: "failed", error: errorText(error) };
      }
      if ("status" in reply) return reply;
      const assistant = await this.#append({
        type: "assistant",
        text: reply.text,
        calls: reply.calls,
        finishReason: reply.finishReason,
      });
      const pending = reply.calls.map((call): Pending => ({ call, as: "new" }));
      return { assistant, batch: await this.#answer(assistant, pending) };
    } finally {
      this.#emit({ type: "turn", state: "end", turn });
    }
  }

  /** Runs `pending`, or tells the model to make them again when the output limit cut them off. */
  async #answer(
    assistant: EntryOf<"assistant">,
    pending: readonly Pending[],
  ): Promise<Batch | null> {
    if (pending.length === 0) return null;
    if (cutOff(assistant.finishReason)) return await this.#failTruncated(pending);
    return await this.#runBatch(assistant, pending);
  }

  /** The turn a restart cut short: its calls with no result, and no request. */
  async #rerun({
    assistant,
    pending,
  }: {
    readonly assistant: EntryOf<"assistant">;
    readonly pending: readonly Pending[];
  }): Promise<Turn> {
    const turn = this.#turns;
    this.#emit({ type: "turn", state: "start", turn });
    try {
      return { assistant, batch: await this.#answer(assistant, pending) };
    } finally {
      this.#emit({ type: "turn", state: "end", turn });
    }
  }

  /**
   * The pause the meter calls for before another request, while spend pauses are on: its spend
   * reached the next multiple of the pause, or a request it couldn't count went before.
   */
  #held(): TaskOutcome | null {
    const step = this.#request.limits.spendPauseUsd;
    if (step <= 0) return null;
    const every = `every $${step.toFixed(2)}`;
    const spent = this.#request.meter.spentUsd();
    if (spent >= this.#spendLimit) {
      return paused("spend", `Spent $${spent.toFixed(2)}; it pauses at ${every}.`);
    }
    const why = this.#request.meter.unpriced();
    if (why === null) return null;
    return paused("unpriced", `${why}, so its spend can't count toward the pause at ${every}.`);
  }

  /** The pause a finished batch calls for: the gate's, a refused path's, or a stall's. */
  #guard({ assistant, batch }: Turn): TaskOutcome | null {
    if (batch === null) {
      this.#signatures.push("");
      return null;
    }
    if (batch.paused !== undefined) return paused("approval", batch.paused);
    if (this.#request.pauseOnRefused) {
      const refused = batch.settled.flatMap(({ result }) =>
        result.refused ? [result.refused] : [],
      );
      if (refused.length > 0) {
        const asked = refused.map(({ path, access }) => `${access} access to ${path}`);
        return paused("approval", asked.join("\n"));
      }
    }
    if (terminates(batch)) return null;
    const signature = signatureOf(assistant.calls);
    this.#signatures.push(signature);
    const recent = this.#signatures.slice(-STALL_TURNS);
    if (recent.length === STALL_TURNS && recent.every((each) => each === signature)) {
      const named = assistant.calls
        .map((call) => `${call.name} ${argumentsHead(argumentsOf(call))}`)
        .sort();
      return paused("stall", `The same calls ${STALL_TURNS} turns running:\n${named.join("\n")}`);
    }
    return null;
  }

  async #takeFollowUps(): Promise<number> {
    this.#signal.throwIfAborted();
    const all = this.#request.followUpMode !== "one-at-a-time";
    const lines = this.#request.inbox.takeFollowUps(all);
    for (const text of lines) await this.#append({ type: "follow-up", text });
    return lines.length;
  }

  /** The context's size: the provider's count for the last request, and an estimate since. */
  #view(): {
    readonly messages: ContextMessage[];
    readonly tokens: number;
    readonly sized: number;
  } {
    const maskAfter = this.#request.limits.maskAfterTokens ?? MASK_AFTER_TOKENS;
    const messages = contextMessages(taskContext(this.#entries), maskAfter, this.#request.tools);
    const tokens =
      estimateTokens(this.#request.system) +
      this.#schemaTokens +
      messages.reduce((sum, message) => sum + messageTokens(message), 0);
    const counted = this.#counted;
    const sized = counted === null ? tokens : counted.reported + tokens - counted.estimated;
    return { messages, tokens, sized };
  }

  /** The turn's request, compacted first when the context calls for it; a summary may pause it. */
  async #ask(): Promise<Reply | TaskOutcome> {
    if (this.#view().sized > compactAbove(this.#request.limits.contextTokens)) {
      if (await this.#compact()) {
        const held = this.#held();
        if (held !== null) return held;
      }
    }
    let compacted = false;
    for (;;) {
      const view = this.#view();
      try {
        const reply = await this.#send(
          this.#request.system,
          view.messages,
          this.#request.tools.map((tool) => tool.schema),
          true,
        );
        const reported = this.#request.meter.lastInputTokens();
        this.#counted = reported === null ? null : { reported, estimated: view.tokens };
        return reply;
      } catch (error) {
        if (this.#signal.aborted || compacted || !isContextOverflow(error)) throw error;
        compacted = true;
        if (!(await this.#compact())) throw error;
        const held = this.#held();
        if (held !== null) return held;
      }
    }
  }

  /** One request, sent again after each transient failure. `live`: the task's own, with events. */
  async #send(
    system: string,
    messages: readonly ContextMessage[],
    tools: MindRequest["tools"],
    live: boolean,
  ): Promise<Reply> {
    const report = (event: TaskEvent): void => {
      if (live) this.#emit(event);
    };
    for (let retries = 0; ; retries++) {
      report({ type: "request", state: "start" });
      try {
        const reply = await this.#stream({ system, messages, tools, signal: this.#signal }, live);
        report({ type: "request", state: "end" });
        return reply;
      } catch (error) {
        if (this.#signal.aborted) {
          report({ type: "request", state: "end" });
          throw this.#signal.reason;
        }
        const retryInMs =
          isContextOverflow(error) || !isTransient(error) ? undefined : RETRY_DELAYS_MS[retries];
        const text = errorText(error);
        report(
          retryInMs === undefined
            ? { type: "request", state: "end", error: text }
            : { type: "request", state: "end", error: text, retryInMs },
        );
        if (retryInMs === undefined) throw error;
        await (this.#request.sleep ?? abortableSleep)(retryInMs, this.#signal);
        this.#signal.throwIfAborted();
      }
    }
  }

  async #stream(request: MindRequest, live: boolean): Promise<Reply> {
    let text = "";
    const calls: MindToolCall[] = [];
    let finishReason: string | null = null;
    for await (const chunk of this.#request.mind.stream(request)) {
      this.#signal.throwIfAborted();
      if (chunk.type === "text") {
        text += chunk.text;
        if (live && chunk.text !== "") this.#emit({ type: "delta", text: chunk.text });
      } else if (chunk.type === "tool-calls") {
        calls.push(...chunk.calls);
      } else {
        finishReason = chunk.finishReason;
      }
    }
    this.#signal.throwIfAborted();
    // pi's "Stream ended without finish_reason": a failed attempt, which a retry may get past.
    if (!endedReply(finishReason)) {
      throw new Error(
        finishReason === null
          ? "The model's reply ended with no finish reason"
          : `The model's reply ended with finish reason ${JSON.stringify(finishReason)}`,
      );
    }
    // Only a whole reply: a cut stream seldom carries its usage, and its retry may.
    this.#request.meter.requestEnded();
    return { text, calls, finishReason };
  }

  /**
   * Summarizes what came before the newest blocks, through the task's mind with no tools, and
   * stores it. False when the newest blocks are all there is.
   */
  async #compact(): Promise<boolean> {
    const tokensBefore = this.#view().sized;
    const context = taskContext(this.#entries);
    const first = firstKept(context.blocks, keepTokens(this.#request.limits.contextTokens));
    const kept = context.blocks[first];
    if (first === 0 || kept === undefined) return false;
    const files = filesBefore(this.#entries, kept.seq);
    const { system, instructions } = this.#request.compaction;
    const older = context.blocks.slice(0, first);
    const prompt = summaryPrompt(older, context.compaction?.summary ?? null, files, instructions);
    const reply = await this.#send(system, [{ role: "user", content: prompt }], [], false);
    const why = unfinished(reply.finishReason);
    if (why !== null) throw new Error(`Compaction failed. ${why.error}`);
    const summary = reply.text.trim();
    if (summary === "") throw new Error("Compaction returned no summary");
    await this.#append({
      type: "compaction",
      summary,
      firstKeptSeq: kept.seq,
      files,
      tokensBefore,
    });
    this.#counted = null;
    return true;
  }

  #tool(name: string): TaskTool | undefined {
    return this.#request.tools.find((tool) => tool.schema.name === name);
  }

  /** pi: the calls of a reply the output limit cut off may hold cut arguments, so none runs. */
  async #failTruncated(pending: readonly Pending[]): Promise<Batch> {
    const settled: Settled[] = [];
    for (const { call } of pending) {
      this.#toolStart(call);
      const content =
        `Tool call "${call.name}" was not executed: the response hit the output token limit, ` +
        "so its arguments may be truncated. Re-issue the tool call with complete arguments.";
      settled.push(await this.#settle(call, { content, isError: true }));
    }
    return { settled };
  }

  /** In parallel, unless a call's tool runs alone (pi's executionMode). */
  #runBatch(assistant: EntryOf<"assistant">, pending: readonly Pending[]): Promise<Batch> {
    const sequential = pending.some(
      ({ call }) => this.#tool(call.name)?.executionMode === "sequential",
    );
    return sequential ? this.#runSequential(assistant, pending) : this.#runParallel(pending);
  }

  /**
   * One call at a time. Once one of the reply's calls has started, a waiting steering line skips
   * the rest (OpenClaw's queue steering).
   */
  async #runSequential(
    assistant: EntryOf<"assistant">,
    pending: readonly Pending[],
  ): Promise<Batch> {
    const settled: Settled[] = [];
    let started = this.#entries.some(
      (entry) => entry.type === "tool-start" && entry.seq > assistant.seq,
    );
    const steered = (): boolean => started && this.#request.inbox.hasSteering();
    for (const [at, item] of pending.entries()) {
      if (steered()) {
        settled.push(...(await this.#skip(pending.slice(at), false)));
        break;
      }
      const prepared = await this.#prepare(item);
      if (prepared.kind === "pause") return { settled, paused: prepared.detail };
      if (prepared.kind === "result") {
        settled.push(await this.#settle(item.call, prepared.result));
        continue;
      }
      if (steered()) {
        settled.push(...(await this.#skip(pending.slice(at), true)));
        break;
      }
      started = true;
      settled.push(await this.#execute(prepared));
    }
    return { settled };
  }

  /** pi's parallel batch: each call through the gate in order, then the allowed ones together. */
  async #runParallel(pending: readonly Pending[]): Promise<Batch> {
    const settled = new Map<string, Settled>();
    const runs: Extract<Prepared, { kind: "run" }>[] = [];
    let pausedBy: string | undefined;
    for (const item of pending) {
      const prepared = await this.#prepare(item);
      if (prepared.kind === "pause") {
        pausedBy = prepared.detail;
        break;
      }
      if (prepared.kind === "result") {
        settled.set(item.call.id, await this.#settle(item.call, prepared.result));
      } else {
        runs.push(prepared);
      }
    }
    if (pausedBy === undefined) {
      const outcomes = await Promise.allSettled(runs.map((run) => this.#execute(run)));
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
        settled.set(outcome.value.call.id, outcome.value);
      }
    }
    const ordered = pending.flatMap(({ call }) => {
      const each = settled.get(call.id);
      return each === undefined ? [] : [each];
    });
    return pausedBy === undefined ? { settled: ordered } : { settled: ordered, paused: pausedBy };
  }

  /** Answers each of `items` without running it; `announced`: the first's start is shown. */
  async #skip(items: readonly Pending[], announced: boolean): Promise<Settled[]> {
    const settled: Settled[] = [];
    for (const [at, { call, as }] of items.entries()) {
      if (at > 0 || !announced) this.#toolStart(call);
      const result: TaskToolResult =
        as === "new"
          ? {
              content: SKIPPED,
              isError: true,
              details: { status: "skipped", deniedReason: "steering" },
            }
          : { content: INTERRUPTED, isError: true };
      settled.push(await this.#settle(call, result));
    }
    return settled;
  }

  /** pi's prepareToolCall: the call's tool, its arguments validated, and the gate's word on it. */
  async #prepare({ call, as }: Pending): Promise<Prepared> {
    this.#signal.throwIfAborted();
    this.#toolStart(call);
    if (as === "interrupted")
      return { kind: "result", result: { content: INTERRUPTED, isError: true } };
    if (call.unparsed !== undefined) {
      const content =
        `Tool call "${call.name}" wasn't run: its arguments aren't a JSON object.\n\n` +
        `Received arguments:\n${echoed(call.unparsed)}`;
      return { kind: "result", result: { content, isError: true } };
    }
    const tool = this.#tool(call.name);
    if (tool === undefined) {
      return { kind: "result", result: { content: `Tool ${call.name} not found`, isError: true } };
    }
    try {
      const args = validateToolArguments(
        tool.schema,
        tool.prepareArguments?.(call.arguments) ?? call.arguments,
      );
      // A rerun was let through before the restart.
      const gate = as === "new" ? this.#request.gate : undefined;
      const decision =
        gate === undefined
          ? null
          : await raceAbort(gate({ ...call, arguments: args }), this.#signal);
      if (decision !== null && "pause" in decision)
        return { kind: "pause", detail: decision.pause };
      if (decision !== null) {
        const content = decision.block || "Tool execution was blocked";
        const result: TaskToolResult = decision.terminate
          ? { content, isError: true, terminate: true }
          : { content, isError: true };
        return { kind: "result", result };
      }
      return { kind: "run", call, tool, args };
    } catch (error) {
      if (this.#signal.aborted) throw this.#signal.reason;
      return { kind: "result", result: { content: errorText(error), isError: true } };
    }
  }

  /** Stores the intent to run `call`, runs it, and stores its result. */
  async #execute({ call, tool, args }: Extract<Prepared, { kind: "run" }>): Promise<Settled> {
    await this.#append({ type: "tool-start", callId: call.id, name: call.name });
    this.#signal.throwIfAborted();
    let open = true;
    const context: TaskToolContext = {
      signal: this.#signal,
      onUpdate: (text) => {
        if (open)
          this.#emit({ type: "tool", state: "update", callId: call.id, name: call.name, text });
      },
      steered: () => this.#request.inbox.hasSteering(),
    };
    let result: TaskToolResult;
    try {
      result = await raceAbort(tool.execute(args, context), this.#signal);
    } catch (error) {
      if (this.#signal.aborted) throw this.#signal.reason;
      result = { content: errorText(error), isError: true };
    } finally {
      open = false;
    }
    return await this.#settle(call, await this.#after({ ...call, arguments: args }, result));
  }

  /** pi's afterToolCall: it may replace the content, details or isError, or set terminate. */
  async #after(call: MindToolCall, result: TaskToolResult): Promise<TaskToolResult> {
    const hook = this.#request.afterToolCall;
    if (hook === undefined) return result;
    try {
      const override = await raceAbort(hook(call, result), this.#signal);
      if (override === undefined) return result;
      return {
        ...result,
        content: override.content ?? result.content,
        details: override.details ?? result.details,
        isError: override.isError ?? result.isError,
        terminate: override.terminate ?? result.terminate,
      };
    } catch (error) {
      if (this.#signal.aborted) throw this.#signal.reason;
      return { content: errorText(error), isError: true };
    }
  }

  async #settle(call: MindToolCall, result: TaskToolResult): Promise<Settled> {
    const isError = result.isError === true;
    await this.#append({
      type: "tool-result",
      callId: call.id,
      name: call.name,
      content: result.content,
      isError,
      ...(result.details === undefined ? {} : { details: result.details }),
      ...(result.files === undefined ? {} : { files: result.files }),
      ...(result.refused === undefined ? {} : { refused: result.refused }),
    });
    this.#emit({ type: "tool", state: "end", callId: call.id, name: call.name, isError });
    return { call, result };
  }

  #toolStart(call: MindToolCall): void {
    this.#emit({ type: "tool", state: "start", callId: call.id, name: call.name });
  }

  /**
   * Stores `draft`, one write at a time in call order, then shows it. `last`: nothing is stored
   * after it, so a tool still running when the run ends never adds its result.
   */
  async #append<D extends TaskEntryDraft>(draft: D, last = false): Promise<D & TaskEntry> {
    if (this.#closed) throw this.#signal.reason ?? new Error("The task's run has ended");
    if (last) this.#closed = true;
    const write = this.#writes.then(() => this.#request.store.append(draft));
    this.#writes = write.catch(() => {});
    const entry = (await write) as D & TaskEntry;
    this.#entries.push(entry);
    this.#emit({ type: "entry", entry });
    return entry;
  }
}

/**
 * Runs task `request.id` from its store: a store holding only its brief starts, any other resumes.
 * It starts on the first read and ends with the outcome, stored first; a cancel through
 * `request.signal` stores `cancelled`, and a reader that stops reading stops it storing nothing,
 * for a later run to resume. Its requests are billed as source "task", session `request.id`.
 */
export async function* runTask(request: TaskRequest): AsyncGenerator<TaskEvent, TaskOutcome> {
  const events = new Events();
  const left = new AbortController();
  const run = new TaskRun(request, events.push, left.signal);
  // A promise rather than this generator's body, which runs in whatever context reads it next.
  const outcome = withUsageScope({ source: "task", session: request.id }, () => run.run());
  void outcome.then(
    () => events.close(),
    () => events.close(),
  );
  let drained = false;
  try {
    yield* events;
    drained = true;
  } finally {
    if (!drained) left.abort();
  }
  return await outcome;
}
