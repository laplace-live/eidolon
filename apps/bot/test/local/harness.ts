// Fakes and a booted local server for the local tests: the real local code over fake packages, a
// fixture web build (tests never read apps/web/dist), and raw-socket requests for what fetch
// would normalize or refuse to send.
import "../../../../packages/config/test/isolated-guard.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllowedOffer } from "@eidolon/access";
import * as access from "@eidolon/access";
import {
  dataHome,
  installSettings,
  type LogLevel,
  resetSettings,
  setSettingDefaults,
} from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import {
  type BootIo,
  bootLocal,
  type LocalModules,
  type LocalServer,
} from "../../src/local/boot.ts";
import type { ListeningMessage } from "../../src/local/supervisor.ts";
import { type LocalToken, loadLocalToken, sessionCookieName } from "../../src/local/token.ts";
import { ANSWER } from "../fakes.ts";

export const INDEX_HTML = '<!doctype html><html lang="en"><title>Eidolon</title></html>';
export const APP_JS = "console.log('eidolon');";

/** A web build: index.html, a hashed asset, a root file, and (on request) links out of it. */
export function fixtureDist(options: { outside?: string } = {}): string {
  const dist = mkdtempSync(join(tmpdir(), "eidolon-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), INDEX_HTML);
  writeFileSync(join(dist, "assets", "app-3f1c0d4e.js"), APP_JS);
  writeFileSync(join(dist, "robots.txt"), "User-agent: *\n");
  if (options.outside !== undefined) {
    symlinkSync(options.outside, join(dist, "assets", "leak.txt"));
    symlinkSync(join(options.outside, ".."), join(dist, "outside"));
  }
  return dist;
}

export interface RecordedOffer {
  readonly admission: AllowedOffer;
}

export interface Fakes {
  readonly modules: LocalModules;
  readonly offers: RecordedOffer[];
  readonly admitted: string[];
  readonly levels: LogLevel[];
  memoryAdmin: MemoryAdmin | null;
}

/** The packages, faked where they would load models, open LanceDB or reach a network. */
export function fakeModules(): Fakes {
  const offers: RecordedOffer[] = [];
  const admitted: string[] = [];
  const levels: LogLevel[] = [];
  const fakes: Fakes = {
    offers,
    admitted,
    levels,
    memoryAdmin: null,
    modules: {
      access: {
        ...access,
        admitOffer: async (input) => {
          admitted.push(input.bodyText);
          return access.admitOffer(input, { quota: new access.SlidingWindowQuota(5, 3600) });
        },
        anonOfferQuota: () => ({ maxPerWindow: 5, windowSeconds: 3600 }),
      },
      imagegen: { selfieResponse: () => new Response(null, { status: 404 }) },
      memory: { memoryAdmin: () => fakes.memoryAdmin },
      retrieval: {
        warmTokenizer: () => {},
        resolveDbPath: () => "/fake/index",
        warmStreamCatalog: async () => {},
      },
      runtime: {
        configureLogging: ({ level }) => {
          levels.push(level);
        },
        warmAudioModels: async () => {},
        createSignallingServer: () => ({
          offer: async (admission) => {
            offers.push({ admission });
            return { status: 200, body: ANSWER };
          },
          patch: async () => ({ status: 200, body: { status: "success" } }),
          close: async () => {},
          activeSessions: 0,
        }),
      },
      turn: {
        iceServiceFromEnv: () => ({
          browserPayload: async () => ({ iceServers: [] }),
          serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }),
        }),
      },
      mcp: { createMcpHandler: async () => ({ handle: async () => new Response("mcp") }) },
    },
  };
  return fakes;
}

export interface FakeIo extends BootIo {
  readonly out: string[];
  readonly err: string[];
  readonly exits: number[];
  readonly opened: string[];
  readonly notified: ListeningMessage[];
  shutdown: (() => void) | null;
  now: number;
}

export function fakeIo(): FakeIo {
  const io: FakeIo = {
    out: [],
    err: [],
    exits: [],
    opened: [],
    notified: [],
    shutdown: null,
    now: 1_793_000_000,
    stdout: (text) => {
      io.out.push(text);
    },
    stderr: (text) => {
      io.err.push(text);
    },
    exit: (code) => {
      io.exits.push(code);
    },
    openBrowser: (url) => {
      io.opened.push(url);
    },
    onShutdown: (handler) => {
      io.shutdown = handler;
    },
    notify: (message) => {
      io.notified.push(message);
    },
    nowSeconds: () => io.now,
  };
  return io;
}

export interface Booted {
  readonly server: LocalServer;
  readonly fakes: Fakes;
  readonly io: FakeIo;
  readonly port: number;
  readonly base: string;
  readonly token: LocalToken;
  /** `Cookie: …` for a signed-in browser. */
  readonly cookie: string;
  readonly origin: string;
  stop(): Promise<void>;
}

/** Boots the local server on 127.0.0.1 at a free port, over a fixture build. */
export async function bootFixture(
  options: { argv?: string[]; dist?: string; fakes?: Fakes } = {},
): Promise<Booted> {
  const fakes = options.fakes ?? fakeModules();
  const io = fakeIo();
  const dist = options.dist ?? fixtureDist();
  const argv = options.argv ?? ["--host", "127.0.0.1", "--port", "0", "--no-open"];
  // What load-env.ts does in server.ts before the boot.
  installSettings();
  const server = await bootLocal(argv, fakes.modules, { dist, io });
  if (server === null) throw new Error(`boot exited: ${io.err.join("")}`);
  const port = server.bot.server.port as number;
  const token = loadLocalToken();
  const value = token.sessionCookie(port).split(";")[0] as string;
  return {
    server,
    fakes,
    io,
    port,
    base: `http://127.0.0.1:${port}`,
    token,
    cookie: value,
    origin: `http://127.0.0.1:${port}`,
    async stop() {
      await server.bot.stop();
      if (options.dist === undefined) rmSync(dist, { recursive: true, force: true });
    },
  };
}

/** Undoes what a boot leaves in the process: the per-persona defaults, settings, the data home. */
export function cleanUpBoot(): void {
  setSettingDefaults(null);
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Map<string, string>;
  readonly body: string;
}

/** One HTTP/1.1 exchange over a socket, sent byte for byte: `..`, odd Hosts, no Host at all. */
export function raw(port: number, head: string, body = ""): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const [statusLine, ...lines] = text.slice(0, split).split("\r\n");
      const headers = new Map<string, string>();
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      resolve({
        status: Number((statusLine ?? "").split(" ")[1]),
        headers,
        body: text.slice(split + 4),
      });
    });
    socket.write(`${head.replace(/\n/g, "\r\n")}\r\nConnection: close\r\n\r\n${body}`);
  });
}

export { sessionCookieName };
