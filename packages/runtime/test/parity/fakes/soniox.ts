// Soniox's real-time socket, played by Bun.serve: the config each connection sends first, the
// caller's audio, and on every `finalize` the next scripted line as final tokens closed by `<fin>`.
// https://soniox.com/docs/stt/api-reference/websocket-api
import type { Server, ServerWebSocket } from "bun";

interface Peer {
  readonly id: number;
}

export interface SonioxConnection {
  readonly path: string;
  readonly authorization: string | null;
  /** What it sent first: the session's config, as text. */
  config: string | null;
  /** Bytes of audio it sent. */
  audioBytes: number;
  finalizes: number;
  keepalives: number;
}

export class FakeSoniox {
  readonly #server: Server<Peer>;
  readonly #sockets = new Map<number, ServerWebSocket<Peer>>();
  readonly connections: SonioxConnection[] = [];
  /** What each `finalize` is answered with, in order; an empty turn when it runs out. */
  readonly #lines: string[];
  #nextId = 0;

  constructor(lines: readonly string[] = []) {
    this.#lines = [...lines];
    this.#server = Bun.serve<Peer>({
      // 127.0.0.1 alone: bound to every address, the port could be shared with another listener.
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        const id = this.#nextId++;
        this.connections[id] = {
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          config: null,
          audioBytes: 0,
          finalizes: 0,
          keepalives: 0,
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

  /** The origin an account's API base names. */
  get base(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  /** Where pipedog's service dials when its `url` is set. */
  get url(): string {
    return `ws://127.0.0.1:${this.#server.port}/transcribe-websocket`;
  }

  /** Lines the next `finalize`s answer with. */
  say(...lines: string[]): void {
    this.#lines.push(...lines);
  }

  /** Drops every open socket, as a network blip does. */
  drop(): void {
    for (const socket of this.#sockets.values()) socket.close(1011, "dropped");
  }

  stop(): void {
    this.#server.stop(true);
  }

  #received(ws: ServerWebSocket<Peer>, data: string | Buffer): void {
    const connection = this.connections[ws.data.id] as SonioxConnection;
    if (typeof data !== "string") {
      connection.audioBytes += data.byteLength;
      return;
    }
    if (connection.config === null) {
      connection.config = data;
      return;
    }
    if (data === "") {
      ws.send(JSON.stringify({ tokens: [], finished: true }));
      return;
    }
    const message = JSON.parse(data) as { type?: string };
    if (message.type === "keepalive") {
      connection.keepalives++;
    } else if (message.type === "finalize") {
      connection.finalizes++;
      const line = this.#lines.shift();
      const tokens = line === undefined ? [] : [{ text: line, is_final: true }];
      ws.send(JSON.stringify({ tokens: [...tokens, { text: "<fin>", is_final: true }] }));
    }
  }
}
