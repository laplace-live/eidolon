// Fish Audio's live socket, played by Bun.serve: `start` opens a session, each `flush` answers the
// text sent since the last one with a tone as long as the text, and `stop` ends the session with
// `finish` once that audio is out. https://docs.fish.audio/api-reference/endpoint/websocket/tts-live
import type { Server, ServerWebSocket } from "bun";
import { packMsg, unpackMsg } from "../../../../providers/src/speech/stream/msgpack.ts";

interface Peer {
  readonly id: number;
}

export interface FishSession {
  readonly path: string;
  readonly authorization: string | null;
  readonly model: string | null;
  /** The raw `start` message, and its request decoded. */
  start: Uint8Array | null;
  request: Readonly<Record<string, unknown>> | null;
  /** Each flushed text, in order. */
  readonly flushed: string[];
  stopped: boolean;
}

/** Milliseconds of audio per character spoken, at least one 20 ms frame per flush. */
const MS_PER_CHARACTER = 100;
const FRAME_MS = 20;

export interface FishOptions {
  /** How long a flush waits before its first audio, as Fish's time to first byte. */
  readonly firstAudioMs?: number;
  /** Flushes after this many send no audio, and stall: no-audio failures. */
  readonly silentAfter?: number;
}

export class FakeFish {
  readonly #server: Server<Peer>;
  readonly #sockets = new Map<number, ServerWebSocket<Peer>>();
  readonly sessions: FishSession[] = [];
  readonly #options: FishOptions;
  readonly #pending = new Map<number, string>();
  /** Per session, the audio it has yet to send before `finish`. */
  readonly #sending = new Map<number, Promise<void>>();
  #flushes = 0;
  #nextId = 0;

  constructor(options: FishOptions = {}) {
    this.#options = options;
    this.#server = Bun.serve<Peer>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        const id = this.#nextId++;
        this.sessions[id] = {
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          model: request.headers.get("model"),
          start: null,
          request: null,
          flushed: [],
          stopped: false,
        };
        if (server.upgrade(request, { data: { id } })) return undefined;
        return new Response("no upgrade", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          this.#sockets.set(ws.data.id, ws);
        },
        message: (ws, data) => this.#received(ws, data),
        close: (ws) => {
          this.#sockets.delete(ws.data.id);
        },
      },
    });
  }

  get base(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  /** Where pipedog's service dials once its `_baseUrl` is set. */
  get url(): string {
    return `ws://127.0.0.1:${this.#server.port}/v1/tts/live`;
  }

  /** Every flushed text, across sessions, in order. */
  get spoken(): string[] {
    return this.sessions.flatMap((session) => session.flushed);
  }

  stop(): void {
    this.#server.stop(true);
  }

  #received(ws: ServerWebSocket<Peer>, data: string | Buffer): void {
    if (typeof data === "string") return;
    const id = ws.data.id;
    const session = this.sessions[id] as FishSession;
    const bytes = new Uint8Array(data);
    const message = unpackMsg(bytes) as { event?: string; text?: string; request?: unknown };
    switch (message.event) {
      case "start":
        session.start = bytes;
        session.request = message.request as Record<string, unknown>;
        return;
      case "text":
        this.#pending.set(id, (this.#pending.get(id) ?? "") + (message.text ?? ""));
        return;
      case "flush": {
        const text = this.#pending.get(id) ?? "";
        this.#pending.delete(id);
        if (text === "") return;
        session.flushed.push(text);
        const silent =
          this.#options.silentAfter !== undefined && this.#flushes >= this.#options.silentAfter;
        this.#flushes++;
        if (silent) return;
        const rate = Number(session.request?.sample_rate ?? 44100);
        this.#queue(id, () => this.#speak(ws, text, rate));
        return;
      }
      case "stop":
        session.stopped = true;
        this.#queue(id, async () => {
          if (ws.readyState === 1) ws.send(packMsg({ event: "finish", reason: "stop" }));
          ws.close();
        });
        return;
    }
  }

  #queue(id: number, work: () => Promise<void>): void {
    const next = (this.#sending.get(id) ?? Promise.resolve()).then(work);
    this.#sending.set(id, next);
  }

  /** A tone `text`'s length long, in 20 ms frames, as fast as the socket takes them. */
  async #speak(ws: ServerWebSocket<Peer>, text: string, rate: number): Promise<void> {
    await Bun.sleep(this.#options.firstAudioMs ?? 30);
    const frames = Math.max(1, Math.round(([...text].length * MS_PER_CHARACTER) / FRAME_MS));
    const samples = Math.round((rate * FRAME_MS) / 1000);
    for (let frame = 0; frame < frames; frame++) {
      if (ws.readyState !== 1) return;
      const pcm = new Int16Array(samples);
      for (let i = 0; i < samples; i++) {
        const n = frame * samples + i;
        pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 330 * n) / rate));
      }
      ws.send(packMsg({ event: "audio", audio: new Uint8Array(pcm.buffer) }));
    }
  }
}
