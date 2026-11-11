// A fake provider for the batch speech tests: one local server that every provider's real URL is
// rerouted to, recording what each request carried, and a usage sink that keeps every report.
import type { AccountEntry } from "@eidolon/config";
import { resetSettings } from "@eidolon/config";
import type { Server } from "bun";
import { type Sources, setUsageSink, type UsageRecord } from "../../../src/index.ts";

export interface Seen {
  readonly method: string;
  /** The URL the client asked for, before it was rerouted here. */
  readonly url: string;
  readonly headers: Headers;
  readonly json: unknown;
  readonly form: FormData | null;
  readonly bytes: Uint8Array;
}

type Reply = (request: Seen, index: number) => Response | Promise<Response>;

// Variables a developer's shell may set, which would change the voice or language under test.
const AMBIENT = ["TTS_VOICE_ID", "FISH_VOICE_ID", "STT_LANGUAGE", "TRANSCRIBE_LANGUAGE"];

export class FakeProvider {
  readonly seen: Seen[] = [];
  readonly usage: UsageRecord[] = [];
  #reply: Reply = () => new Response("");
  #server: Server<undefined> | null = null;
  readonly #saved = new Map<string, string | undefined>();

  start(): void {
    resetSettings();
    for (const name of AMBIENT) {
      this.#saved.set(name, process.env[name]);
      delete process.env[name];
    }
    setUsageSink((record) => this.usage.push(record));
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const type = request.headers.get("content-type") ?? "";
        const bytes = new Uint8Array(await request.clone().arrayBuffer());
        const entry: Seen = {
          method: request.method,
          url: request.headers.get("x-fake-url") ?? request.url,
          headers: request.headers,
          json: type.startsWith("application/json")
            ? JSON.parse(new TextDecoder().decode(bytes))
            : null,
          form: type.startsWith("multipart/form-data") ? await request.formData() : null,
          bytes,
        };
        this.seen.push(entry);
        return this.#reply(entry, this.seen.length - 1);
      },
    });
  }

  stop(): void {
    this.#server?.stop(true);
    setUsageSink(null);
    for (const [name, value] of this.#saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  /** Answers each later request with `reply`, and forgets what came before. */
  answer(reply: Reply): void {
    this.seen.length = 0;
    this.usage.length = 0;
    this.#reply = reply;
  }

  /** A fetch that sends any URL here, keeping its path and query. */
  readonly fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    headers.set("x-fake-url", url.href);
    const port = this.#server?.port;
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers });
  }) as typeof fetch;
}

export function sources(
  values: Readonly<Record<string, string>>,
  accounts: readonly AccountEntry[] = [],
): Sources {
  const read = (name: string) => values[name] || undefined;
  return { read, env: read, accounts: new Map(accounts.map((entry) => [entry.id, entry])) };
}

/** Layer III frames of silence: MPEG-1 at 128 kbps and 44.1 kHz, 1152 samples each. */
export function mp3Frames(count: number): Uint8Array<ArrayBuffer> {
  const length = Math.floor((144 * 128_000) / 44_100);
  const out = new Uint8Array(length * count);
  for (let i = 0; i < count; i++) out.set([0xff, 0xfb, 0x90, 0x00], i * length);
  return out;
}

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
