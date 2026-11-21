// Loopback stand-ins for every provider the desktop smokes reach, ported from
// apps/bot/scripts/local-smoke.ts's fake server to node:http: her mind's chat completions, streamed;
// the retrieval gate's and the director's decisions; embeddings; OpenAI's speech, transcriptions
// and realtime transcription sessions; OpenRouter's images, for a selfie; and the model listings.
// They answer one key, refuse every other request, and count what they answer by route.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { crc32, deflateSync } from "node:zlib";

export const GREETING = "晚上好呀，今天也来陪我聊天啦？";
/** A line whose answer streams REPLY's two parts, `replyHoldMs` apart. */
export const CHAT_MESSAGE = "今天过得怎么样？";
export const REPLY = ["还不错哦，", "刚刚在看猫猫视频。"] as const;
/** Her answer to a line that carries files or images. */
export const FILES_REPLY = "看到啦，故事也读完了。";
/** What the fake hearing hears: a voice message's upload, and a call's first segment. */
export const VOICE_TRANSCRIPT = "你听得到我说话吗？";
export const HEARD_REPLY = "听得到呀，声音很清楚。";
/** A line she answers with a take_selfie call, when the request offers it. */
export const SELFIE_REQUEST = "给我发张自拍吧";
/** What she says beside that call. */
export const SELFIE_SAID = "等我一下哦～";
/** Her answer to a tool's result. */
export const SELFIE_REPLY = "拍好啦，喜欢吗？";

const SELFIE_TOOL = "take_selfie";
const SELFIE_CALL_ID = "call_smoke_selfie";
/** Every model the listings name; each kind's listing filters them as its provider does. */
const MODELS = [
  "fake-chat",
  "fake-worker",
  "fake-embedding-small",
  "fake-embedding-large",
  "fake-transcribe",
  "fake-tts",
  "fake-image",
  "fake-decider",
] as const;
const OUTPUT_MODALITIES: Readonly<Record<string, readonly string[]>> = {
  image: ["fake-image"],
  decisions: ["fake-decider"],
  rerank: [],
};
const EMBEDDING_MODELS = ["fake-embedding-small", "fake-embedding-large"];
/** OpenAI's realtime transcription and speech, 16-bit mono PCM at 24 kHz. */
const PCM_RATE = 24_000;
const SPEECH_SECONDS = 1;
/** Far above what any provider call here sends; a voice message is a few kB. */
const BODY_LIMIT = 32 * 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The routes the fakes serve; any other answers 404. */
export const ROUTES = [
  "GET /v1/models",
  "GET /v1/embeddings/models",
  "POST /v1/chat/completions",
  "POST /v1/embeddings",
  "POST /v1/audio/speech",
  "POST /v1/audio/transcriptions",
  "POST /v1/images",
  "POST /alpha/decisions",
  "GET /v1/realtime",
] as const;
export type Route = (typeof ROUTES)[number];

interface Message {
  readonly role?: unknown;
  readonly content?: unknown;
}

/** One chat completion request, as the fakes read it. */
export interface ChatRequest {
  readonly model?: unknown;
  readonly stream?: unknown;
  readonly messages?: readonly Message[];
  readonly tools?: readonly { readonly function?: { readonly name?: unknown } }[];
}

/** One streamed reply: when it started, sent its first part and ended, and whether it ran out. */
export interface StreamRecord {
  readonly model: string;
  readonly texts: readonly string[];
  readonly startedAt: number;
  firstAt: number | null;
  endedAt: number | null;
  /** Its request went away before the stream ended: the turn was stopped. */
  cancelled: boolean;
}

/** One realtime transcription session, a call's hearing. */
export interface RealtimeSession {
  /** Audio appended to its buffer, in messages. */
  appended: number;
  /** Segments the call's voice detection committed. */
  commits: number;
  /** Transcripts sent, VOICE_TRANSCRIPT at the first commit and whatever say() sent. */
  readonly heard: string[];
  closed: boolean;
}

export interface FakesOptions {
  /** Between REPLY's two parts; 2000 ms by default. */
  readonly replyHoldMs?: number;
}

/** A hold on a kind of request, which release() lets go of, or the request's going away. */
class Hold {
  #gate: { readonly promise: Promise<void>; readonly release: () => void } | null = null;

  /** Holds every request that waits from now on; the returned function lets them go. */
  start(): () => void {
    this.#gate?.release();
    let release = (): void => {};
    const promise = new Promise<void>((done) => {
      release = done;
    });
    const gate = { promise, release };
    this.#gate = gate;
    return () => {
      if (this.#gate === gate) this.#gate = null;
      gate.release();
    };
  }

  /** Resolves once the hold is released, or at once when none is on. */
  wait(gone: Promise<void>): Promise<void> {
    return this.#gate === null ? Promise.resolve() : Promise.race([this.#gate.promise, gone]);
  }

  release(): void {
    this.#gate?.release();
    this.#gate = null;
  }
}

/** A unit vector derived from the text, so equal texts embed equally. */
function fakeVector(text: string, dimensions: number): number[] {
  const seed = createHash("sha256").update(text).digest();
  const vector = Array.from({ length: dimensions }, (_, i) =>
    Math.sin((seed[i % 32] + 1) * (i + 1)),
  );
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

/** `seconds` of silent MPEG-1 Layer III frames, mono, 44.1 kHz at 128 kbps: a voice message. */
function silentMp3(seconds: number): Buffer {
  // 144 × 128000 / 44100, unpadded; all-zero side info decodes as silence.
  const frame = 417;
  const frames = Math.ceil((seconds * 44_100) / 1152);
  const bytes = Buffer.alloc(frames * frame);
  for (let i = 0; i < frames; i++) bytes.set([0xff, 0xfb, 0x90, 0xc4], i * frame);
  return bytes;
}

/** A 440 Hz tone at -20 dBFS, so a page can tell her voice arrived on a call. */
function tonePcm(seconds: number): Buffer {
  const samples = Math.round(seconds * PCM_RATE);
  const bytes = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    bytes.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / PCM_RATE) * 3277), i * 2);
  }
  return bytes;
}

/** A solid PNG, the selfie the image model draws. */
function png(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const part = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    part("IHDR", header),
    part("IDAT", deflateSync(pixels)),
    part("IEND", Buffer.alloc(0)),
  ]);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parse(body: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function textOf(content: unknown): string {
  return typeof content === "string" ? content : "";
}

function offers(request: ChatRequest, name: string): boolean {
  return (request.tools ?? []).some((tool) => tool.function?.name === name);
}

/** What her mind says to `request`: a tool call for a selfie asked for, else lines of text. */
function answerTo(request: ChatRequest): {
  readonly texts: readonly string[];
  readonly call: boolean;
} {
  const last = request.messages?.at(-1);
  if (last?.role === "tool") return { texts: [SELFIE_REPLY], call: false };
  if (last?.role !== "user") return { texts: [GREETING], call: false };
  if (Array.isArray(last.content)) return { texts: [FILES_REPLY], call: false };
  const asked = textOf(last.content);
  if (asked.includes(SELFIE_REQUEST) && offers(request, SELFIE_TOOL)) {
    return { texts: [SELFIE_SAID], call: true };
  }
  if (asked === CHAT_MESSAGE) return { texts: REPLY, call: false };
  if (asked.includes(VOICE_TRANSCRIPT)) return { texts: [HEARD_REPLY], call: false };
  return { texts: [GREETING], call: false };
}

const UNPRICED = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function chunk(model: string, delta: object, finish: string | null): string {
  const choice = { index: 0, delta, finish_reason: finish };
  const value = {
    id: "chatcmpl-desktop-smoke",
    object: "chat.completion.chunk",
    created: 0,
    model,
  };
  return `data: ${JSON.stringify({ ...value, choices: [choice] })}\n\n`;
}

/** The frames of one WebSocket message from the server: unmasked, unfragmented. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)]);
  return Buffer.concat([head, payload]);
}

function bigLength(length: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(length));
  return bytes;
}

/**
 * A realtime session over an upgraded socket, as OpenAI's transcription API answers: created, then
 * updated on each session.update; a transcript at its first commit, and whatever say() sends.
 */
class RealtimeSocket {
  readonly session: RealtimeSession = { appended: 0, commits: 0, heard: [], closed: false };
  readonly #socket: Socket;
  #buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #items = 0;

  constructor(socket: Socket, head: Buffer) {
    this.#socket = socket;
    socket.on("data", (data: Buffer) => this.#read(data));
    socket.on("close", () => {
      this.session.closed = true;
    });
    socket.on("error", () => {});
    this.#send({ type: "session.created" });
    if (head.length > 0) this.#read(head);
  }

  say(text: string): void {
    this.#items++;
    this.session.heard.push(text);
    this.#send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: `item_smoke_${this.#items}`,
      transcript: text,
    });
  }

  close(): void {
    if (this.session.closed) return;
    this.#socket.end(frame(0x8, Buffer.from([0x03, 0xe8])));
    this.#socket.destroySoon();
  }

  #send(event: object): void {
    if (!this.session.closed) this.#socket.write(frame(0x1, Buffer.from(JSON.stringify(event))));
  }

  #read(data: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const end = offset + (masked ? 4 : 0) + length;
      if (this.#buffer.length < end) return;
      const payload = Buffer.from(this.#buffer.subarray(end - length, end));
      if (masked) {
        const mask = this.#buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }
      this.#buffer = this.#buffer.subarray(end);
      this.#frame(first & 0x80, first & 0x0f, payload);
    }
  }

  #frame(fin: number, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.#socket.write(frame(0xa, payload));
      return;
    }
    if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) return;
    this.#fragments.push(payload);
    if (fin === 0) return;
    const message = Buffer.concat(this.#fragments).toString("utf8");
    this.#fragments = [];
    this.#event(parse(Buffer.from(message)));
  }

  #event(event: Record<string, unknown>): void {
    if (event.type === "session.update") this.#send({ type: "session.updated" });
    else if (event.type === "input_audio_buffer.append") this.session.appended++;
    else if (event.type === "input_audio_buffer.commit") {
      this.session.commits++;
      if (this.session.commits === 1) this.say(VOICE_TRANSCRIPT);
    }
  }
}

export interface Fakes {
  /** The API base every account takes: `http://127.0.0.1:<port>/v1`. */
  readonly url: string;
  /** The one key they answer. */
  readonly key: string;
  /** Between REPLY's two parts, in ms; a smoke may change it between turns. */
  replyHoldMs: number;
  /** How many requests `route` answered, with the key. */
  count(route: Route): number;
  /** Every route answered so far, with its count. */
  counts(): Readonly<Record<string, number>>;
  /** Requests without the key, by route: none reached a fake. */
  readonly refused: readonly string[];
  /** Requests to routes the fakes don't serve. */
  readonly unknown: readonly string[];
  /** Every Authorization header any request carried, the key's own included. */
  readonly authorizations: ReadonlySet<string>;
  /** The chat completion requests, in order. */
  readonly chats: readonly ChatRequest[];
  /** Each streamed reply. */
  readonly streams: readonly StreamRecord[];
  /** Each realtime transcription session a call opened. */
  readonly realtime: readonly RealtimeSession[];
  /**
   * From now on, each streamed reply waits after its first part until the returned function is
   * called, or its request goes away (the turn stopped), which a stream record then says.
   */
  holdReplies(): () => void;
  /** From now on, each embeddings request waits until the returned function is called. */
  holdEmbeddings(): () => void;
  /** Every open realtime session hears `text`; how many did. */
  say(text: string): number;
  stop(): Promise<void>;
}

/** Starts the fakes on 127.0.0.1, on a free port. */
export async function startFakes({ replyHoldMs = 2000 }: FakesOptions = {}): Promise<Fakes> {
  const key = `desktop-smoke-${randomBytes(12).toString("hex")}`;
  const answered = new Map<string, number>();
  const refused: string[] = [];
  const unknown: string[] = [];
  const authorizations = new Set<string>();
  const chats: ChatRequest[] = [];
  const streams: StreamRecord[] = [];
  const sockets = new Set<RealtimeSocket>();
  const replies = new Hold();
  const embeddings = new Hold();
  const known = new Set<string>(ROUTES);

  /** Resolves when the request's connection goes away before its answer ended. */
  const goneOf = (response: ServerResponse): Promise<void> =>
    new Promise((done) => {
      response.on("close", () => done());
    });

  const route = (request: IncomingMessage): string =>
    `${request.method} ${new URL(request.url ?? "/", "http://fakes").pathname}`;

  /** Whether `request` carries the key; else it is recorded and refused. */
  const admitted = (request: IncomingMessage, name: string): boolean => {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) authorizations.add(authorization);
    if (authorization === `Bearer ${key}`) {
      answered.set(name, (answered.get(name) ?? 0) + 1);
      return true;
    }
    refused.push(name);
    return false;
  };

  const knobs = { replyHoldMs };
  let url = "";

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const fakes: Fakes = {
    get url() {
      return url;
    },
    key,
    get replyHoldMs() {
      return knobs.replyHoldMs;
    },
    set replyHoldMs(ms: number) {
      knobs.replyHoldMs = ms;
    },
    count: (name) => answered.get(name) ?? 0,
    counts: () => Object.fromEntries(answered),
    refused,
    unknown,
    authorizations,
    chats,
    streams,
    get realtime() {
      return [...sockets].map((socket) => socket.session);
    },
    holdReplies: () => replies.start(),
    holdEmbeddings: () => embeddings.start(),
    say(text) {
      const open = [...sockets].filter((socket) => !socket.session.closed);
      for (const socket of open) socket.say(text);
      return open.length;
    },
    stop: async () => {
      replies.release();
      embeddings.release();
      for (const socket of sockets) socket.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };

  async function stream(response: ServerResponse, request: ChatRequest): Promise<void> {
    const model = typeof request.model === "string" ? request.model : "fake-chat";
    const { texts, call } = answerTo(request);
    const record: StreamRecord = {
      model,
      texts,
      startedAt: Date.now(),
      firstAt: null,
      endedAt: null,
      cancelled: false,
    };
    streams.push(record);
    const gone = goneOf(response);
    let open = true;
    void gone.then(() => {
      open = false;
      if (record.endedAt === null) record.cancelled = true;
    });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const [i, content] of texts.entries()) {
      if (i > 0) {
        await Promise.race([new Promise((done) => setTimeout(done, knobs.replyHoldMs)), gone]);
      }
      if (!open) return;
      const delta = i === 0 ? { role: "assistant", content } : { content };
      response.write(chunk(model, delta, null));
      if (i === 0) {
        record.firstAt = Date.now();
        await replies.wait(gone);
      }
    }
    if (!open) return;
    if (call) {
      const toolCall = {
        index: 0,
        id: SELFIE_CALL_ID,
        type: "function",
        function: { name: SELFIE_TOOL, arguments: "{}" },
      };
      response.write(chunk(model, { tool_calls: [toolCall] }, null));
    }
    response.write(chunk(model, {}, call ? "tool_calls" : "stop"));
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl-desktop-smoke", choices: [], usage: UNPRICED })}\n\n`,
    );
    record.endedAt = Date.now();
    response.end("data: [DONE]\n\n");
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const name = route(request);
    if (!known.has(name) || name === "GET /v1/realtime") {
      unknown.push(name);
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    if (!admitted(request, name)) {
      json(response, 401, { error: { message: "Invalid API key" } });
      return;
    }
    const sent = parse(body);
    switch (name as Route) {
      case "GET /v1/models": {
        const modality = new URL(request.url ?? "/", "http://fakes").searchParams.get(
          "output_modalities",
        );
        const ids = modality === null ? MODELS : (OUTPUT_MODALITIES[modality] ?? []);
        json(response, 200, {
          object: "list",
          data: ids.map((id) => ({ id, object: "model", owned_by: "desktop-smoke" })),
        });
        return;
      }
      case "GET /v1/embeddings/models":
        json(response, 200, { data: EMBEDDING_MODELS.map((id) => ({ id, object: "model" })) });
        return;
      case "POST /v1/chat/completions": {
        const chat = sent as ChatRequest;
        chats.push(chat);
        if (chat.stream === true) {
          await stream(response, chat);
          return;
        }
        const { texts } = answerTo(chat);
        json(response, 200, {
          id: "chatcmpl-desktop-smoke",
          object: "chat.completion",
          created: 0,
          model: typeof chat.model === "string" ? chat.model : "fake-chat",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: texts.join("") },
              finish_reason: "stop",
            },
          ],
          usage: UNPRICED,
        });
        return;
      }
      case "POST /v1/embeddings": {
        await embeddings.wait(goneOf(response));
        if (response.destroyed) return;
        const inputs = (Array.isArray(sent.input) ? sent.input : [sent.input]).map(String);
        const dimensions = typeof sent.dimensions === "number" ? sent.dimensions : 3072;
        json(response, 200, {
          object: "list",
          model: "fake-embedding-large",
          data: inputs.map((text, index) => ({
            object: "embedding",
            index,
            embedding: fakeVector(text, dimensions),
          })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });
        return;
      }
      case "POST /v1/audio/speech": {
        const pcm = sent.response_format === "pcm";
        response.writeHead(200, { "content-type": pcm ? "audio/pcm" : "audio/mpeg" });
        response.end(pcm ? tonePcm(SPEECH_SECONDS) : silentMp3(SPEECH_SECONDS));
        return;
      }
      case "POST /v1/audio/transcriptions":
        // As gpt-4o-transcribe answers: usage in tokens, so the clip's length is the recorder's.
        json(response, 200, {
          text: VOICE_TRANSCRIPT,
          usage: { type: "tokens", input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        });
        return;
      case "POST /v1/images":
        json(response, 200, {
          data: [
            { b64_json: png(64, 64, [240, 180, 200]).toString("base64"), media_type: "image/png" },
          ],
          usage: { cost: 0 },
        });
        return;
      case "POST /alpha/decisions": {
        const questions = sent.questions;
        const keys =
          typeof questions === "object" && questions !== null ? Object.keys(questions) : [];
        json(response, 200, {
          model: "fake-decider",
          answers: Object.fromEntries(
            keys.map((question) => [question, { type: "noul", noul: 0 }]),
          ),
          usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
        });
        return;
      }
    }
  }

  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => {});
    const name = route(request);
    const accept = request.headers["sec-websocket-key"];
    if (name !== "GET /v1/realtime" || typeof accept !== "string") {
      unknown.push(name);
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!admitted(request, name)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const digest = createHash("sha1").update(`${accept}${WEBSOCKET_GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`,
    );
    sockets.add(new RealtimeSocket(socket, head));
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port: 0 }, () => done());
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return fakes;
}
