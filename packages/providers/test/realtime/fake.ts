// A realtime server played by Bun.serve, in OpenAI's dialect or xAI's: it greets each connection
// as its provider does and answers `session.update`; the test scripts the rest. Nothing here waits
// on a timer.
import type { Server, ServerWebSocket } from "bun";
import type { RealtimeEvent, RealtimeSession } from "../../src/realtime/index.ts";
import { type Selection, select } from "../../src/resolve.ts";

export const KEY = "secret-key-0123456789";

export type DialectId = "openai" | "xai";

export type ClientMessage = Readonly<Record<string, unknown>> & { readonly type: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Waiting<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((item: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

interface PeerData {
  readonly peer: RealtimePeer;
}

export class RealtimePeer {
  readonly url: URL;
  readonly headers: Headers;
  /** Every message the client sent, as it sent it. */
  readonly raw: string[] = [];
  readonly #messages = new Waiting<ClientMessage>();
  readonly #closed = Promise.withResolvers<void>();
  readonly #server: FakeRealtime;
  socket: ServerWebSocket<PeerData> | null = null;

  constructor(request: Request, server: FakeRealtime) {
    this.url = new URL(request.url);
    this.headers = request.headers;
    this.#server = server;
  }

  /** The client's next message, its event id checked and left out. */
  async next(): Promise<ClientMessage> {
    return this.#messages.next();
  }

  /** The client's next message of `type`, skipping the others. */
  async nextOf(type: string): Promise<ClientMessage> {
    for (;;) {
      const message = await this.next();
      if (message.type === type) return message;
    }
  }

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  send(...events: readonly unknown[]): void {
    for (const event of events) {
      this.socket?.send(typeof event === "string" ? event : JSON.stringify(event));
    }
  }

  close(code = 1000, reason = ""): void {
    this.socket?.close(code, reason);
  }

  received(data: string | Buffer): void {
    const text = typeof data === "string" ? data : data.toString();
    this.raw.push(text);
    const { event_id, ...message } = JSON.parse(text) as ClientMessage;
    if (typeof event_id !== "string" || !UUID.test(event_id)) {
      this.#messages.push({ type: "no-event-id", text });
      return;
    }
    if (message.type === "session.update" && this.#server.answers) {
      this.send({ type: "session.updated", event_id: "ev_up", session: message.session });
    }
    this.#messages.push(message as ClientMessage);
  }

  ended(): void {
    this.#closed.resolve();
  }
}

export class FakeRealtime {
  readonly dialect: DialectId;
  readonly #server: Server<PeerData>;
  readonly #arrivals = new Waiting<RealtimePeer>();
  /** Answer upgrades with this HTTP status instead of accepting them. */
  refuse: number | null = null;
  /** Whether `session.update` is answered with `session.updated`. */
  answers: boolean;

  constructor(dialect: DialectId, options: { readonly answers?: boolean } = {}) {
    this.dialect = dialect;
    this.answers = options.answers ?? true;
    this.#server = Bun.serve<PeerData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        if (this.refuse !== null) return new Response("refused", { status: this.refuse });
        const peer = new RealtimePeer(request, this);
        if (server.upgrade(request, { data: { peer } })) return undefined;
        return new Response("no upgrade", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          ws.data.peer.socket = ws;
          const says = serverEvents(dialect);
          ws.data.peer.send(says.sessionCreated());
          if (dialect === "xai") ws.data.peer.send(says.conversationCreated());
          this.#arrivals.push(ws.data.peer);
        },
        message: (ws, data) => ws.data.peer.received(data),
        close: (ws) => ws.data.peer.ended(),
      },
    });
  }

  /** The account's API base. */
  get base(): string {
    return `http://127.0.0.1:${this.#server.port}/v1`;
  }

  connection(): Promise<RealtimePeer> {
    return this.#arrivals.next();
  }

  stop(): void {
    this.#server.stop(true);
  }
}

function base64(samples: readonly number[]): string {
  return Buffer.from(new Int16Array(samples).buffer).toString("base64");
}

let serial = 0;
const eventId = () => `ev_${++serial}`;

export interface Usage {
  readonly input: number;
  readonly cached?: number;
  readonly output: number;
}

/** What a server of `dialect` sends. */
export function serverEvents(dialect: DialectId) {
  const xai = dialect === "xai";
  return {
    sessionCreated: () => ({
      type: "session.created",
      event_id: eventId(),
      session: { id: "sess_1", object: "realtime.session" },
    }),
    conversationCreated: () => ({
      type: "conversation.created",
      event_id: eventId(),
      conversation: { id: "conv_1", object: "realtime.conversation" },
    }),
    sessionUpdated: () => ({ type: "session.updated", event_id: eventId(), session: {} }),
    speechStarted: (item: string) => ({
      type: "input_audio_buffer.speech_started",
      event_id: eventId(),
      audio_start_ms: 120,
      item_id: item,
    }),
    speechStopped: (item: string) => ({
      type: "input_audio_buffer.speech_stopped",
      event_id: eventId(),
      audio_end_ms: 900,
      item_id: item,
    }),
    /** What the user has said so far, piece by piece: OpenAI's deltas, xAI's whole text. */
    heard: (item: string, pieces: readonly string[]) =>
      pieces.map((_, at) =>
        xai
          ? {
              type: "conversation.item.input_audio_transcription.updated",
              event_id: eventId(),
              item_id: item,
              transcript: ` ${pieces.slice(0, at + 1).join("")} `,
            }
          : {
              type: "conversation.item.input_audio_transcription.delta",
              event_id: eventId(),
              item_id: item,
              content_index: 0,
              delta: pieces[at],
            },
      ),
    heardAll: (item: string, transcript: string) => ({
      type: "conversation.item.input_audio_transcription.completed",
      event_id: eventId(),
      item_id: item,
      content_index: 0,
      transcript,
    }),
    responseCreated: (id: string) => ({
      type: "response.created",
      event_id: eventId(),
      response: { id, object: "realtime.response", status: "in_progress", output: [] },
    }),
    audio: (response: string, item: string, samples: readonly number[], content = 0) => ({
      type: "response.output_audio.delta",
      event_id: eventId(),
      response_id: response,
      item_id: item,
      output_index: 0,
      content_index: content,
      delta: base64(samples),
    }),
    spoken: (response: string, item: string, delta: string) => ({
      type: "response.output_audio_transcript.delta",
      event_id: eventId(),
      response_id: response,
      item_id: item,
      output_index: 0,
      content_index: 0,
      delta,
    }),
    /** A function call's item, announced as xAI announces it: twice. */
    call: (response: string, item: string, callId: string, name: string) => {
      const announced = {
        id: item,
        type: "function_call",
        status: "in_progress",
        call_id: callId,
        name,
        arguments: "",
      };
      const added = { type: "conversation.item.added", event_id: eventId(), item: announced };
      return xai
        ? [
            {
              type: "response.output_item.added",
              event_id: eventId(),
              response_id: response,
              output_index: 0,
              item: announced,
            },
            added,
          ]
        : [added];
    },
    args: (response: string, item: string, callId: string, name: string, args: string) => ({
      type: "response.function_call_arguments.done",
      event_id: eventId(),
      response_id: response,
      item_id: item,
      output_index: 0,
      call_id: callId,
      ...(xai ? { name } : {}),
      arguments: args,
    }),
    done: (
      id: string,
      options: {
        readonly status?: string;
        readonly details?: unknown;
        readonly usage?: Usage | null;
      } = {},
    ) => {
      const { usage = null } = options;
      const reported =
        usage === null
          ? null
          : xai
            ? {
                total_tokens: usage.input + usage.output,
                input_tokens: usage.input,
                output_tokens: usage.output,
              }
            : {
                total_tokens: usage.input + usage.output,
                input_tokens: usage.input,
                output_tokens: usage.output,
                input_token_details: {
                  cached_tokens: usage.cached ?? 0,
                  text_tokens: usage.input,
                  audio_tokens: 0,
                },
                output_token_details: { text_tokens: 0, audio_tokens: usage.output },
              };
      return {
        type: "response.done",
        event_id: eventId(),
        response: {
          id,
          object: "realtime.response",
          status: options.status ?? "completed",
          status_details: options.details ?? null,
          output: [],
          ...(reported !== null && !xai ? { usage: reported } : {}),
        },
        ...(reported !== null && xai ? { usage: reported } : {}),
      };
    },
    error: (code: string | null, message: string) => ({
      type: "error",
      event_id: "ev_err",
      error: { type: "invalid_request_error", code, message, param: null, event_id: null },
    }),
  };
}

/** The realtime role filled by an account of `provider` whose API base is `base`. */
export function realtimeAt(provider: DialectId, base: string, model?: string): Selection {
  const id = `${provider}-fake`;
  const values: Record<string, string> = {
    REALTIME_PROVIDER: id,
    ...(model === undefined ? {} : { REALTIME_MODEL: model }),
  };
  const entry = { id, provider, name: null, apiKey: KEY, baseUrl: base, options: {} };
  return select("realtime", {
    read: (name) => values[name],
    env: (name) => values[name],
    accounts: new Map([[id, entry]]),
  }) as Selection;
}

/** The realtime role filled by `provider`'s own account. */
export function defaultRealtime(provider: DialectId): Selection {
  const keyName = provider === "openai" ? "OPENAI_API_KEY" : "XAI_API_KEY";
  const values: Record<string, string> = { REALTIME_PROVIDER: provider, [keyName]: KEY };
  return select("realtime", (name) => values[name]) as Selection;
}

/** Everything `session` emits, as it emits it. */
export function watch(session: RealtimeSession): {
  readonly seen: RealtimeEvent[];
  until(match: (event: RealtimeEvent) => boolean): Promise<RealtimeEvent>;
  readonly ended: Promise<void>;
} {
  const seen: RealtimeEvent[] = [];
  const waiters: {
    match: (event: RealtimeEvent) => boolean;
    resolve: (event: RealtimeEvent) => void;
  }[] = [];
  const ended = (async () => {
    for await (const event of session.events) {
      seen.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.match(event)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  })();
  return {
    seen,
    ended,
    until(match) {
      const found = seen.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}
