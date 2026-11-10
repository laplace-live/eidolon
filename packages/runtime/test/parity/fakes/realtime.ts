// A realtime voice server in OpenAI's dialect or xAI's, played by Bun.serve for the twin harness:
// it greets as its provider does, answers the client's events, plays a scripted response for each
// `response.create` (and for each turn its own VAD hears, which the scenario says when), and keeps
// every client event but the audio. Every event it sends passes pipedog's 0.10.0 parser, which
// rejects unknown types and missing fields.
// https://platform.openai.com/docs/api-reference/realtime-server-events
// https://docs.x.ai/docs/guides/voice/agent
import type { Server, ServerWebSocket } from "bun";

export type RealtimeDialect = "openai" | "xai";

/** One scripted response: each segment's transcript, spoken as a tone this long per character. */
export interface RealtimeReply {
  readonly segments: readonly string[];
  readonly msPerChar?: number;
}

/** A client event as it arrived, without its event id. */
export type ClientEvent = Readonly<Record<string, unknown>> & { readonly type: string };

interface Peer {
  readonly id: number;
}

const RATE = 24_000;
/** An audio delta's length; the server sends them faster than they play, as the real ones do. */
const CHUNK_MS = 100;
const CHUNK_GAP_MS = 40;
/** How long after the caller stops the server's VAD commits the turn and starts answering. */
const ANSWER_MS = 150;
/** How long after that the transcript of the turn comes. */
const TRANSCRIPT_MS = 150;

/** `ms` of a quiet tone, as base64 PCM. */
function tone(ms: number, offset: number): string {
  const samples = new Int16Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(3000 * Math.sin((2 * Math.PI * 440 * (offset + i)) / RATE));
  }
  return Buffer.from(samples.buffer).toString("base64");
}

interface Running {
  readonly id: string;
  cancelled: boolean;
  done: Promise<void>;
}

export class FakeRealtime {
  readonly dialect: RealtimeDialect;
  /** Every client event but `input_audio_buffer.append`, in order. */
  readonly received: ClientEvent[] = [];
  /** Bytes of the caller's audio appended. */
  audioBytes = 0;
  /** The handshake's path and authorization. */
  readonly connections: { readonly path: string; readonly authorization: string | null }[] = [];
  readonly #server: Server<Peer>;
  readonly #replies: RealtimeReply[];
  #socket: ServerWebSocket<Peer> | null = null;
  #active: Running | null = null;
  #responses = 0;
  #users = 0;
  #nextId = 0;
  #events = 0;

  constructor(dialect: RealtimeDialect, replies: readonly RealtimeReply[] = []) {
    this.dialect = dialect;
    this.#replies = [...replies];
    this.#server = Bun.serve<Peer>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        const id = this.#nextId++;
        const url = new URL(request.url);
        this.connections.push({
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get("authorization"),
        });
        if (server.upgrade(request, { data: { id } })) return undefined;
        return new Response("no upgrade", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          this.#socket = ws;
          this.#send({
            type: "session.created",
            session: { id: "sess_twin", object: "realtime.session" },
          });
          if (dialect === "xai") {
            this.#send({
              type: "conversation.created",
              conversation: { id: "conv_twin", object: "realtime.conversation" },
            });
          }
        },
        message: (_ws, data) => this.#received(data),
        close: () => {
          this.#socket = null;
        },
      },
    });
  }

  /** The API base an account names: the socket is `<base>/realtime`. */
  get base(): string {
    return `http://127.0.0.1:${this.#server.port}/v1`;
  }

  /** The client events of `type`. */
  of(type: string): ClientEvent[] {
    return this.received.filter((event) => event.type === type);
  }

  /**
   * The caller says `text`, as the server's VAD and transcription report it: speech starts (OpenAI's
   * server cancels a running response then), stops after `speakMs`, and the server answers with
   * the next scripted response while the transcript is still coming.
   */
  async userSays(text: string, o: { readonly speakMs?: number } = {}): Promise<void> {
    const item = `item_user_${++this.#users}`;
    this.#send({ type: "input_audio_buffer.speech_started", audio_start_ms: 100, item_id: item });
    const active = this.#active;
    if (this.dialect === "openai" && active !== null) {
      active.cancelled = true;
      await active.done;
    }
    await Bun.sleep(o.speakMs ?? 400);
    this.#send({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 900, item_id: item });
    await Bun.sleep(ANSWER_MS);
    this.#send({ type: "input_audio_buffer.committed", previous_item_id: null, item_id: item });
    this.#send({
      type: "conversation.item.added",
      previous_item_id: null,
      item: {
        id: item,
        object: "realtime.item",
        type: "message",
        status: "completed",
        role: "user",
        content: [{ type: "input_audio", transcript: null }],
      },
    });
    const answer = this.#respond();
    await Bun.sleep(TRANSCRIPT_MS);
    this.#transcribe(item, text);
    await answer;
  }

  /** A fatal server error. */
  fail(message: string): void {
    this.#send({
      event_id: "event_fatal",
      type: "error",
      error: { type: "server_error", code: "server_error", message, param: null, event_id: null },
    });
  }

  /** Resolves once no response is playing. */
  async idle(): Promise<void> {
    while (this.#active !== null) await this.#active.done;
  }

  stop(): void {
    this.#server.stop(true);
  }

  #send(event: Readonly<Record<string, unknown>>): void {
    this.#socket?.send(JSON.stringify({ event_id: `event_${++this.#events}`, ...event }));
  }

  #transcribe(item: string, text: string): void {
    const pieces = [...text];
    const half = Math.max(1, Math.floor(pieces.length / 2));
    if (this.dialect === "openai") {
      for (const delta of [pieces.slice(0, half).join(""), pieces.slice(half).join("")]) {
        if (delta === "") continue;
        this.#send({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: item,
          content_index: 0,
          delta,
        });
      }
    } else {
      this.#send({
        type: "conversation.item.input_audio_transcription.updated",
        item_id: item,
        transcript: pieces.slice(0, half).join(""),
      });
    }
    this.#send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: item,
      content_index: 0,
      transcript: text,
    });
  }

  #received(data: string | Buffer): void {
    const { event_id: _, ...event } = JSON.parse(String(data)) as ClientEvent;
    if (event.type === "input_audio_buffer.append") {
      this.audioBytes += Buffer.from(String(event.audio ?? ""), "base64").length;
      return;
    }
    this.received.push(event as ClientEvent);
    switch (event.type) {
      case "session.update":
        this.#send({ type: "session.updated", session: event.session ?? {} });
        return;
      case "conversation.item.create": {
        const item = (event.item ?? {}) as Record<string, unknown>;
        this.#send({
          type: "conversation.item.added",
          previous_item_id: null,
          item: {
            ...item,
            id: item.id ?? `item_client_${this.received.length}`,
            status: "completed",
          },
        });
        return;
      }
      case "conversation.item.delete":
        this.#send({ type: "conversation.item.deleted", item_id: event.item_id });
        return;
      case "conversation.item.truncate":
        this.#send({
          type: "conversation.item.truncated",
          item_id: event.item_id,
          content_index: event.content_index,
          audio_end_ms: event.audio_end_ms,
        });
        return;
      case "response.create":
        if (this.#active !== null) {
          this.#refuse(
            "conversation_already_has_active_response",
            "Conversation already has an active response",
          );
          return;
        }
        void this.#respond();
        return;
      case "response.cancel":
        if (this.#active === null) {
          this.#refuse(
            "response_cancel_not_active",
            "Cancellation failed: no active response found",
          );
          return;
        }
        this.#active.cancelled = true;
        return;
    }
  }

  #refuse(code: string, message: string): void {
    this.#send({
      type: "error",
      error: { type: "invalid_request_error", code, message, param: null, event_id: null },
    });
  }

  /** Plays the next scripted response, or a short one when the script has run out. */
  #respond(): Promise<void> {
    const reply = this.#replies.shift() ?? { segments: ["好的。"] };
    const id = `resp_${++this.#responses}`;
    const running: Running = { id, cancelled: false, done: Promise.resolve() };
    this.#active = running;
    running.done = this.#play(running, reply);
    return running.done;
  }

  async #play(running: Running, reply: RealtimeReply): Promise<void> {
    const { id } = running;
    const itemId = `item_${id}`;
    const item = {
      id: itemId,
      object: "realtime.item",
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    this.#send({
      type: "response.created",
      response: {
        id,
        object: "realtime.response",
        status: "in_progress",
        status_details: null,
        output: [],
      },
    });
    this.#send({ type: "response.output_item.added", response_id: id, output_index: 0, item });
    this.#send({ type: "conversation.item.added", previous_item_id: null, item });
    let offset = 0;
    const msPerChar = reply.msPerChar ?? 60;
    for (const segment of reply.segments) {
      if (running.cancelled) break;
      this.#send({
        type: "response.output_audio_transcript.delta",
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: segment,
      });
      for (let left = [...segment].length * msPerChar; left > 0; left -= CHUNK_MS) {
        await Bun.sleep(CHUNK_GAP_MS);
        if (running.cancelled) break;
        const ms = Math.min(CHUNK_MS, left);
        this.#send({
          type: "response.output_audio.delta",
          response_id: id,
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: tone(ms, offset),
        });
        offset += Math.round((RATE * ms) / 1000);
      }
    }
    const usage = { total_tokens: 130, input_tokens: 100, output_tokens: 30 };
    this.#send({
      type: "response.done",
      response: {
        id,
        object: "realtime.response",
        status: running.cancelled ? "cancelled" : "completed",
        status_details: null,
        output: [{ ...item, status: running.cancelled ? "incomplete" : "completed" }],
        ...(this.dialect === "openai"
          ? {
              usage: {
                ...usage,
                input_token_details: { cached_tokens: 0, text_tokens: 100, audio_tokens: 0 },
                output_token_details: { text_tokens: 10, audio_tokens: 20 },
              },
            }
          : {}),
      },
      ...(this.dialect === "xai" ? { usage } : {}),
    });
    if (this.#active === running) this.#active = null;
  }
}
