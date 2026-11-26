// What runTask's tests stand in for: a mind that answers each request from a script, and an
// in-memory store, inbox and meter.
import { AnthropicClient, OpenAIChatClient } from "@eidolon/providers";
import { AnthropicMind } from "../src/mind/anthropic.ts";
import { OpenAIMind } from "../src/mind/openai.ts";
import {
  runTask,
  type TaskBrief,
  type TaskEntry,
  type TaskEntryDraft,
  type TaskEvent,
  type TaskInbox,
  type TaskMeter,
  type TaskOutcome,
  type TaskRequest,
  type TaskStore,
  type TaskTool,
  type TaskToolResult,
} from "../src/task.ts";
import type { Mind, MindChunk, MindRequest, MindToolCall } from "../src/types.ts";

export const BRIEF: TaskBrief = {
  goal: "Write a TodoMVC",
  deliverable: "index.html",
  folder: "/tmp/todo",
  check: "It opens",
};

export const SUMMARY_SYSTEM = "You summarize.";

export const DONE: MindChunk = { type: "done", finishReason: "stop" };

export function call(id: string, name: string, args: Record<string, unknown> = {}): MindToolCall {
  return { id, name, arguments: args };
}

/** A reply of `text`, with no calls. */
export function says(text: string): MindChunk[] {
  return [{ type: "text", text }, DONE];
}

/** A reply making `made`, after `text`. */
export function calls(made: readonly MindToolCall[], text = ""): MindChunk[] {
  return [
    ...(text === "" ? [] : [{ type: "text", text } as const]),
    { type: "tool-calls", calls: made },
    { type: "done", finishReason: "tool_calls" },
  ];
}

export type Script =
  | readonly MindChunk[]
  | Error
  | ((request: MindRequest) => AsyncIterable<MindChunk> | readonly MindChunk[]);

/**
 * Answers its nth task request with `scripts[n]`, and with a bare reply after them; a summary
 * request (system SUMMARY_SYSTEM) gets the next of `summaries`. `after` runs as each request ends.
 */
export class ScriptedMind implements Mind {
  readonly requests: MindRequest[] = [];
  readonly summaryRequests: MindRequest[] = [];
  readonly #scripts: readonly Script[];
  readonly #summaries: readonly Script[];
  readonly #after: ((request: MindRequest) => void) | undefined;

  constructor(
    scripts: readonly Script[],
    options: {
      readonly summaries?: readonly Script[];
      readonly after?: (request: MindRequest) => void;
    } = {},
  ) {
    this.#scripts = scripts;
    this.#summaries = options.summaries ?? [];
    this.#after = options.after;
  }

  async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
    const summary = request.system === SUMMARY_SYSTEM;
    const seen = summary ? this.summaryRequests : this.requests;
    seen.push(request);
    const script = (summary ? this.#summaries : this.#scripts)[seen.length - 1] ?? [DONE];
    if (script instanceof Error) throw script;
    if (typeof script === "function") yield* script(request);
    else yield* script;
    this.#after?.(request);
  }
}

export class MemoryStore implements TaskStore {
  readonly list: TaskEntry[] = [];

  constructor(...drafts: readonly TaskEntryDraft[]) {
    for (const draft of drafts) this.#add(draft);
  }

  #add(draft: TaskEntryDraft): TaskEntry {
    const entry = { ...draft, seq: this.list.length + 1, at: 1000 + this.list.length } as TaskEntry;
    this.list.push(entry);
    return entry;
  }

  async entries(): Promise<readonly TaskEntry[]> {
    return [...this.list];
  }

  async append(draft: TaskEntryDraft): Promise<TaskEntry> {
    return this.#add(draft);
  }

  types(): string[] {
    return this.list.map((entry) => entry.type);
  }

  of<T extends TaskEntry["type"]>(type: T): Extract<TaskEntry, { readonly type: T }>[] {
    return this.list.filter(
      (entry): entry is Extract<TaskEntry, { readonly type: T }> => entry.type === type,
    );
  }
}

export class MemoryInbox implements TaskInbox {
  readonly steering: string[] = [];
  readonly followUps: string[] = [];

  hasSteering(): boolean {
    return this.steering.length > 0;
  }

  takeSteering(all: boolean): readonly string[] {
    return this.steering.splice(0, all ? this.steering.length : 1);
  }

  takeFollowUps(all: boolean): readonly string[] {
    return this.followUps.splice(0, all ? this.followUps.length : 1);
  }
}

export class FakeMeter implements TaskMeter {
  spent = 0;
  input: number | null = null;
  uncounted: string | null = null;
  /** The requests the loop said came back whole. */
  ended = 0;

  spentUsd(): number {
    return this.spent;
  }

  lastInputTokens(): number | null {
    return this.input;
  }

  unpriced(): string | null {
    return this.uncounted;
  }

  requestEnded(): void {
    this.ended++;
  }
}

/** A tool taking an optional string `value`, unless `options.schema` says otherwise. */
export function tool(
  name: string,
  execute: TaskTool["execute"] = async (args) => ({ content: `${name}: ${String(args.value)}` }),
  options: Partial<Omit<TaskTool, "execute" | "schema">> & {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  } = {},
): TaskTool {
  const { properties = { value: { type: "string" } }, required = [], ...rest } = options;
  return {
    schema: { name, description: `The ${name} tool`, properties, required },
    replay: "safe",
    ...rest,
    execute,
  };
}

/** A promise and what settles it. */
export function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export interface Fakes<M extends Mind = ScriptedMind> {
  readonly mind: M;
  readonly store: MemoryStore;
  readonly inbox: MemoryInbox;
  readonly meter: FakeMeter;
}

/** A task on `mind`, with a store holding only its brief unless `overrides` brings one. */
export function taskRequest<M extends Mind = ScriptedMind>(
  mind: M,
  overrides: Partial<TaskRequest> = {},
): TaskRequest & Fakes<M> {
  return {
    id: "task-1",
    mind,
    system: "You do the work.",
    tools: [],
    store: new MemoryStore({ type: "brief", brief: BRIEF }),
    inbox: new MemoryInbox(),
    meter: new FakeMeter(),
    limits: { contextTokens: 0, spendPauseUsd: 0 },
    compaction: { system: SUMMARY_SYSTEM, instructions: "Summarize the task so far." },
    signal: new AbortController().signal,
    ...overrides,
  } as TaskRequest & Fakes<M>;
}

/** Every event the run yields, and its outcome. */
export async function drain(
  request: TaskRequest,
): Promise<{ readonly events: TaskEvent[]; readonly outcome: TaskOutcome }> {
  const events: TaskEvent[] = [];
  const run = runTask(request);
  for (;;) {
    const next = await run.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

/** Each tool message a request sent, as [call id, content]. */
export function toolMessages(request: MindRequest | undefined): [string, string][] {
  return (request?.messages ?? []).flatMap((message) => {
    const { role, tool_call_id: id, content } = message as Record<string, unknown>;
    return role === "tool" ? [[String(id), String(content)]] : [];
  });
}

/** Each user message a request sent. */
export function userLines(request: MindRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => {
    const { role, content } = message as Record<string, unknown>;
    return role === "user" ? [String(content)] : [];
  });
}

/** The results the store holds, as [call id, content]. */
export function storedResults(store: MemoryStore): [string, string][] {
  return store.of("tool-result").map((entry) => [entry.callId, entry.content]);
}

/** A tool result. */
export function result(content: string, more: Partial<TaskToolResult> = {}): TaskToolResult {
  return { content, ...more };
}

/**
 * A provider that streams its nth request `replies[n]` as server-sent events, `[DONE]` after
 * them when `done` says so, and the request bodies it was sent.
 */
function provider(
  replies: readonly (readonly Readonly<Record<string, unknown>>[])[],
  done: boolean,
): { readonly fetch: typeof fetch; readonly bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const answer = async (_url: unknown, init: RequestInit): Promise<Response> => {
    const events = replies[bodies.length] ?? [];
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const lines = [...events.map((event) => JSON.stringify(event)), ...(done ? ["[DONE]"] : [])];
    const body = lines.map((line) => `data: ${line}\n\n`).join("");
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  return { fetch: answer as unknown as typeof fetch, bodies };
}

/** The OpenAI-compatible mind on a fake OpenRouter streaming `replies`' chunks. */
export function openaiMind(replies: readonly (readonly Readonly<Record<string, unknown>>[])[]): {
  readonly mind: OpenAIMind;
  readonly bodies: Record<string, unknown>[];
} {
  const { fetch, bodies } = provider(replies, true);
  const client = new OpenAIChatClient({
    provider: "OpenRouter",
    baseUrl: "http://provider.invalid/api/v1",
    apiKey: "key",
    fetch,
  });
  const mind = new OpenAIMind({
    client,
    server: "http://provider.invalid/api/v1",
    model: "anthropic/claude-sonnet-5.5",
    extra: {},
    dialect: { wire: "openai" },
  });
  return { mind, bodies };
}

/** The Anthropic mind on a fake Messages API streaming `replies`' events. */
export function anthropicMind(replies: readonly (readonly Readonly<Record<string, unknown>>[])[]): {
  readonly mind: AnthropicMind;
  readonly bodies: Record<string, unknown>[];
} {
  const { fetch, bodies } = provider(replies, false);
  const client = new AnthropicClient({
    provider: "Anthropic",
    baseUrl: "http://provider.invalid/v1",
    apiKey: "key",
    fetch,
  });
  return { mind: new AnthropicMind({ client, model: "claude-sonnet-4-5", extra: {} }), bodies };
}
