// A speech provider stand-in on ws's server, and selections that reach it through an account of its
// own, as a non-default account reaches a proxy.
import { setTimeout as delay } from "node:timers/promises";
import type { WebSocket } from "ws";
import { type Selection, select } from "../../src/index.ts";
import type { UtteranceAudio } from "../../src/speech/stream/index.ts";
import type { KeyedSelection } from "../../src/speech/stream/shared.ts";
import { messageOf, serveWs } from "../ws-server.ts";

export const KEY = "sk-test-secret-0123456789";

export interface Peer {
  /** Path and query of the handshake. */
  readonly path: string;
  readonly headers: Headers;
  readonly received: (string | Uint8Array)[];
  readonly socket: WebSocket;
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
  stop(): Promise<void>;
}

export interface FakeOptions {
  /** Answers a plain HTTP request. */
  readonly http?: (request: HttpRequest) => Response | Promise<Response>;
  /** Refuses the handshake with this status. */
  readonly refuse?: number;
  readonly onMessage?: (peer: Peer, data: string | Uint8Array) => void;
}

export async function fakeServer(options: FakeOptions = {}): Promise<Fake> {
  const peers: Peer[] = [];
  const requests: HttpRequest[] = [];
  const server = await serveWs({
    handshake: () =>
      options.refuse === undefined
        ? undefined
        : new Response(`refused ${KEY}`, { status: options.refuse }),
    open(socket, { url, headers }) {
      const peer: Peer = {
        path: `${url.pathname}${url.search}`,
        headers,
        received: [],
        socket,
        closed: null,
      };
      socket.on("message", (message, isBinary) => {
        const data = messageOf(message, isBinary);
        peer.received.push(data);
        options.onMessage?.(peer, data);
      });
      socket.on("close", (code, reason) => {
        peer.closed = { code, reason: reason.toString() };
      });
      peers.push(peer);
    },
    async fetch(request) {
      const url = new URL(request.url);
      const entry = {
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        body: await request.text(),
      };
      requests.push(entry);
      return options.http?.(entry) ?? new Response("no handler", { status: 500 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    peers,
    requests,
    stop: () => server.stop(),
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
    await delay(5);
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
  FISH_SPEECH_API_KEY: undefined,
  FISH_SPEECH_BASE_URL: undefined,
  STT_LANGUAGE: undefined,
  TRANSCRIBE_LANGUAGE: undefined,
  MINIMAX_API_KEY: undefined,
  MINIMAX_GROUP_ID: undefined,
  MINIMAX_BASE_URL: undefined,
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_COMPATIBLE_API_KEY: undefined,
  OPENAI_COMPATIBLE_BASE_URL: undefined,
  OPENAI_COMPATIBLE_STT_PROTOCOL: undefined,
  ELEVENLABS_API_KEY: undefined,
  CARTESIA_API_KEY: undefined,
  SONIOX_API_KEY: undefined,
};
