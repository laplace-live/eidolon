// A speech provider stand-in on Bun.serve, and selections that reach it through an account of its
// own, as a non-default account reaches a proxy.
import type { Server, ServerWebSocket } from "bun";
import { type Selection, select } from "../../src/index.ts";
import type { UtteranceAudio } from "../../src/speech/stream/index.ts";
import type { KeyedSelection } from "../../src/speech/stream/shared.ts";

export const KEY = "sk-test-secret-0123456789";

export interface Peer {
  /** Path and query of the handshake. */
  readonly path: string;
  readonly headers: Headers;
  readonly received: (string | Uint8Array)[];
  readonly socket: ServerWebSocket<{ peer: Peer }>;
  closed: { code: number; reason: string } | null;
}

export interface HttpRequest {
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
}

export interface Fake {
  readonly base: string;
  readonly peers: Peer[];
  readonly requests: HttpRequest[];
  stop(): void;
}

export interface FakeOptions {
  /** Answers a plain HTTP request. */
  readonly http?: (request: HttpRequest) => Response | Promise<Response>;
  /** Refuses the handshake with this status. */
  readonly refuse?: number;
  readonly onMessage?: (peer: Peer, data: string | Uint8Array) => void;
}

export function fakeServer(options: FakeOptions = {}): Fake {
  const peers: Peer[] = [];
  const requests: HttpRequest[] = [];
  const server: Server<{ peer: Peer }> = Bun.serve<{ peer: Peer }>({
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      if (request.headers.get("upgrade") === "websocket") {
        if (options.refuse !== undefined) {
          return new Response(`refused ${KEY}`, { status: options.refuse });
        }
        const peer = {
          path,
          headers: request.headers,
          received: [],
          closed: null,
        } as unknown as Peer;
        if (srv.upgrade(request, { data: { peer } })) return undefined;
        return new Response("no upgrade", { status: 400 });
      }
      const entry = { path, headers: request.headers, body: await request.text() };
      requests.push(entry);
      return options.http?.(entry) ?? new Response("no handler", { status: 500 });
    },
    websocket: {
      open(ws) {
        (ws.data.peer as { socket: unknown }).socket = ws;
        peers.push(ws.data.peer);
      },
      message(ws, message) {
        const data = typeof message === "string" ? message : new Uint8Array(message);
        ws.data.peer.received.push(data);
        options.onMessage?.(ws.data.peer, data);
      },
      close(ws, code, reason) {
        ws.data.peer.closed = { code, reason };
      },
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    peers,
    requests,
    stop: () => server.stop(true),
  };
}

/** The voice role filled by an account of `provider` whose API base is `base`. */
export function selectionAt(
  provider: string,
  base: string,
  variables: Readonly<Record<string, string>> = {},
  options: Readonly<Record<string, string>> = {},
): KeyedSelection {
  const id = `test-${provider}`;
  const env: Record<string, string> = { TTS_PROVIDER: id, ...variables };
  const read = (name: string) => env[name];
  const accounts = new Map([
    [id, { id, provider, name: null, apiKey: KEY, baseUrl: base, options }],
  ]);
  const selection = select("voice", { read, env: read, accounts }) as Selection;
  return selection as KeyedSelection;
}

/** Waits for `check` to pass, polling. */
export async function until<T>(check: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** Everything an utterance's audio yields, to its end. */
export async function collect(audio: AsyncIterable<UtteranceAudio>): Promise<UtteranceAudio[]> {
  const out: UtteranceAudio[] = [];
  for await (const item of audio) out.push(item);
  return out;
}

/** The events with each pcm's samples spelled out, for comparing. */
export function plain(events: readonly UtteranceAudio[]): unknown[] {
  return events.map((event) =>
    event.kind === "pcm" ? { kind: "pcm", seg: event.seg, pcm: [...event.pcm] } : event,
  );
}

/** Little-endian bytes of `samples`. */
export function bytesOf(samples: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Int16Array.from(samples).buffer);
}

/** The `index`th peer, once it has sent something. */
export function heardFrom(fake: Fake, index: number): Peer | undefined {
  const peer = fake.peers[index];
  return peer !== undefined && peer.received.length > 0 ? peer : undefined;
}

/** Saves the variables, sets them (undefined unsets), and returns the restore. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.keys(vars).map((name) => [name, process.env[name]] as const);
  const apply = (entries: readonly (readonly [string, string | undefined])[]) => {
    for (const [name, value] of entries) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(Object.entries(vars));
  return () => apply(saved);
}

/** The variables the voice role reads, cleared, so a developer's own never leak in. */
export const CLEAN_ENV: Record<string, string | undefined> = {
  TTS_PROVIDER: undefined,
  TTS_MODEL: undefined,
  TTS_VOICE_ID: undefined,
  FISH_VOICE_ID: undefined,
  FISH_MODEL: undefined,
  FISH_API_KEY: undefined,
  STT_LANGUAGE: undefined,
  TRANSCRIBE_LANGUAGE: undefined,
  MINIMAX_API_KEY: undefined,
  MINIMAX_GROUP_ID: undefined,
  MINIMAX_BASE_URL: undefined,
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  ELEVENLABS_API_KEY: undefined,
  CARTESIA_API_KEY: undefined,
  SONIOX_API_KEY: undefined,
};
