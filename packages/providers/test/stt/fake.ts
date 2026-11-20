// A provider's WebSocket played by ws's server, and the helpers the recognizer tests share. Nothing
// here waits on a timer, so a test may fake the clock.
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import type { WebSocket } from "ws";
import { type Selection, select } from "../../src/index.ts";
import type { SttEvent, SttStream } from "../../src/stt/index.ts";
import type { WsData } from "../../src/ws.ts";
import { type Handshake, type Listening, messageOf, serveWs } from "../ws-server.ts";

export const KEY = "secret-key-0123456789";

/** Keeps log lines off the console while a test runs; `restore()` puts them back. */
export function captureLogs(): { readonly lines: string[]; restore(): void } {
  const lines: string[] = [];
  logger.setSink((record: LogRecord) => lines.push(`${record.level} ${record.message}`));
  return { lines, restore: () => logger.setSink(consoleSink) };
}

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

export class Peer {
  readonly url: URL;
  readonly headers: Headers;
  readonly #messages = new Waiting<WsData>();
  readonly #closed = Promise.withResolvers<void>();
  readonly socket: WebSocket;

  constructor(socket: WebSocket, handshake: Handshake) {
    this.socket = socket;
    this.url = handshake.url;
    this.headers = handshake.headers;
  }

  /** The next message the client sent. */
  next(): Promise<WsData> {
    return this.#messages.next();
  }

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  close(code = 1000, reason = ""): void {
    this.socket.close(code, reason);
  }

  received(data: WsData): void {
    this.#messages.push(data);
  }

  ended(): void {
    this.#closed.resolve();
  }
}

export class FakeServer {
  #server: Listening | null = null;
  readonly #peers: Peer[] = [];
  readonly #arrivals = new Waiting<Peer>();
  /** Answer upgrades with this HTTP status instead of accepting them. */
  refuse: number | null = null;
  /** Called once each connection is open. */
  onOpen: ((peer: Peer) => void) | null = null;

  static async start(): Promise<FakeServer> {
    const fake = new FakeServer();
    fake.#server = await serveWs({
      handshake: () =>
        fake.refuse === null ? undefined : new Response("refused", { status: fake.refuse }),
      open: (socket, handshake) => {
        const peer = new Peer(socket, handshake);
        socket.on("message", (data, isBinary) => peer.received(messageOf(data, isBinary)));
        socket.on("close", () => peer.ended());
        fake.#peers.push(peer);
        fake.#arrivals.push(peer);
        fake.onOpen?.(peer);
      },
    });
    return fake;
  }

  /** The HTTP origin, as an account's API base names it. */
  get base(): string {
    return `http://127.0.0.1:${this.#server?.port}`;
  }

  get connections(): number {
    return this.#peers.length;
  }

  /** The next connection to open. */
  connection(): Promise<Peer> {
    return this.#arrivals.next();
  }

  stop(): Promise<void> {
    return this.#server?.stop() ?? Promise.resolve();
  }
}

/** The hearing role filled by an account of `provider` whose API base is `base`. */
export function selectionAt(
  provider: string,
  base: string,
  env: Readonly<Record<string, string>> = {},
): Selection {
  const id = `${provider}-fake`;
  const values: Record<string, string> = { STT_PROVIDER: id, ...env };
  const entry = { id, provider, name: null, apiKey: KEY, baseUrl: base, options: {} };
  return select("hearing", {
    read: (name) => values[name],
    env: (name) => values[name],
    accounts: new Map([[id, entry]]),
  }) as Selection;
}

/** The hearing role filled by `provider`'s own account. */
export function defaultSelection(provider: string, keyName: string): Selection {
  const values: Record<string, string> = { STT_PROVIDER: provider, [keyName]: KEY };
  return select("hearing", (name) => values[name]) as Selection;
}

export const live = (): AbortSignal => new AbortController().signal;

/** One event loop turn, which I/O completes in; never a timer. */
export const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let turns = 0; turns < 100_000; turns++) {
    if (condition()) return;
    await turn();
  }
  throw new Error("the condition never held");
}

/** Everything `stream` emits, as it emits it. */
export function watch(stream: SttStream): {
  readonly seen: SttEvent[];
  until(match: (event: SttEvent) => boolean): Promise<SttEvent>;
  readonly ended: Promise<void>;
} {
  const seen: SttEvent[] = [];
  const waiters: { match: (event: SttEvent) => boolean; resolve: (event: SttEvent) => void }[] = [];
  const ended = (async () => {
    for await (const event of stream.events) {
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

export const errors = (seen: readonly SttEvent[]) => seen.filter((event) => event.type === "error");

/** The samples a binary audio frame carries. */
export function samples(data: WsData): number[] {
  const bytes = data as Uint8Array;
  return [...new Int16Array(bytes.slice().buffer)];
}
