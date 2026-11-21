// Spike-only loopback fakes, copied and cut down from apps/bot/scripts/local-smoke.ts's fake server:
// an OpenAI/OpenRouter-compatible API (chat completions as SSE, models, embeddings, speech,
// transcriptions, realtime transcription sessions, OpenRouter's decisions) that answers one fake key,
// plus a "port blocker" that holds a port the way another program would, answering 404 to all.
// Every request is summarized to <state dir>/fakes.jsonl; nothing leaves loopback.
// usage: bun fakes.ts <state dir> [--block <port>]
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.argv[2];
if (!stateDir) throw new Error("usage: bun fakes.ts <state dir> [--block <port>]");
mkdirSync(stateDir, { recursive: true });
const blockAt = process.argv.indexOf("--block");
const blockPort = blockAt === -1 ? null : Number(process.argv[blockAt + 1]);
const key = `fake-key-${randomBytes(6).toString("hex")}`;
const LOG = join(stateDir, "fakes.jsonl");
let seq = 0;
function record(entry: Record<string, unknown>): void {
  appendFileSync(LOG, `${JSON.stringify({ seq: ++seq, at: Date.now(), ...entry })}\n`);
}

const GREETING = "晚上好呀，今天也来陪我聊天啦？";
const CHAT_MESSAGE = "今天过得怎么样？";
const REPLY = ["还不错哦，", "刚刚在看猫猫视频。"];
const REPLY_HOLD_MS = 2500;
const FILES_REPLY = "看到图片啦，是一张红色的小照片。";
const HEARD = "你听得到我说话吗？";
const HEARD_REPLY = "听得到呀，声音很清楚。";

function fakeVector(text: string, dimensions: number): number[] {
  const seed = createHash("sha256").update(text).digest();
  const vector = Array.from({ length: dimensions }, (_, i) => Math.sin(((seed[i % 32] as number) + 1) * (i + 1)));
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

function completionStream(texts: readonly string[], holdMs: number): Response {
  const encoder = new TextEncoder();
  const data = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  const chunk = (delta: object, finish: string | null) =>
    data({ id: "chatcmpl-spike", object: "chat.completion.chunk", created: 0, model: "fake-chat", choices: [{ index: 0, delta, finish_reason: finish }] });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const [i, content] of texts.entries()) {
          if (i > 0) await Bun.sleep(holdMs);
          controller.enqueue(chunk(i === 0 ? { role: "assistant", content } : { content }, null));
          record({ kind: "sse-chunk", index: i, text: content });
        }
        controller.enqueue(chunk({}, "stop"));
        controller.enqueue(data({ id: "chatcmpl-spike", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        // The turn was stopped, which cancels the stream.
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** 16-bit mono PCM at `rate`: a 440 Hz tone at -12 dBFS, so the page can tell her voice arrived. */
function tonePcm(seconds: number, rate: number): Uint8Array {
  const samples = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8192);
  return new Uint8Array(samples.buffer);
}

/** Silent MPEG-1 Layer III frames, mono, 44.1 kHz at 128 kbps (local-smoke's fake voice message). */
function silentMp3(seconds: number): Uint8Array {
  const frame = 417;
  const frames = Math.ceil((seconds * 44_100) / 1152);
  const bytes = new Uint8Array(frames * frame);
  for (let i = 0; i < frames; i++) bytes.set([0xff, 0xfb, 0x90, 0xc4], i * frame);
  return bytes;
}

type Message = { role?: unknown; content?: unknown };
function summarize(content: unknown): unknown {
  if (typeof content === "string") return content.length > 160 ? `${content.slice(0, 160)}…` : content;
  if (Array.isArray(content)) {
    return content.map((part: Record<string, unknown>) => {
      if (part.type === "image_url") {
        const url = String((part.image_url as { url?: unknown })?.url ?? "");
        const [head, data] = url.split(";base64,");
        return { type: "image_url", head, base64Chars: data?.length ?? 0 };
      }
      return { type: part.type, text: typeof part.text === "string" ? part.text.slice(0, 160) : undefined };
    });
  }
  return typeof content;
}

let imageCount = 0;
function saveImages(content: unknown): string[] {
  const saved: string[] = [];
  if (!Array.isArray(content)) return saved;
  for (const part of content as Record<string, unknown>[]) {
    if (part.type !== "image_url") continue;
    const url = String((part.image_url as { url?: unknown })?.url ?? "");
    const [head, data] = url.split(";base64,");
    const ext = head === "data:image/jpeg" ? "jpg" : head === "data:image/webp" ? "webp" : head === "data:image/png" ? "png" : "bin";
    const file = join(stateDir, `mind-image-${++imageCount}.${ext}`);
    writeFileSync(file, Buffer.from(data ?? "", "base64"));
    saved.push(file);
  }
  return saved;
}

const ROUTES = new Set([
  "POST /v1/embeddings",
  "GET /v1/models",
  "POST /v1/chat/completions",
  "POST /v1/audio/speech",
  "POST /v1/audio/transcriptions",
  "POST /alpha/decisions",
  "GET /v1/realtime",
]);

interface Session {
  appended: number;
  commits: number;
  said: number;
}

const server = Bun.serve<{ session: Session }>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route)) {
      record({ kind: "unknown-route", route });
      return new Response(null, { status: 404 });
    }
    if (request.headers.get("authorization") !== `Bearer ${key}`) {
      record({ kind: "refused", route });
      return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
    }
    if (route === "POST /v1/chat/completions") {
      const body = (await request.json()) as { model?: unknown; stream?: unknown; messages?: Message[]; tools?: unknown[] };
      const last = body.messages?.at(-1);
      const images = saveImages(last?.content);
      record({
        kind: "chat",
        model: body.model,
        stream: body.stream,
        roles: (body.messages ?? []).map((m) => m.role),
        tools: (body.tools ?? []).length,
        last: { role: last?.role, content: summarize(last?.content) },
        images,
      });
      const asked = last?.role === "user" ? last.content : undefined;
      const heard = (body.messages ?? []).some((m) => m.role === "user" && String(m.content).includes(HEARD));
      if (asked === CHAT_MESSAGE) return completionStream(REPLY, REPLY_HOLD_MS);
      if (Array.isArray(asked)) return completionStream([FILES_REPLY], 0);
      if (heard && typeof asked === "string" && asked.includes(HEARD)) return completionStream([HEARD_REPLY], 0);
      return completionStream([GREETING], 0);
    }
    if (route === "POST /alpha/decisions") {
      const body = (await request.json()) as { questions?: Record<string, unknown> };
      record({ kind: "decisions", questions: Object.keys(body.questions ?? {}) });
      return Response.json({
        model: "fake-decider",
        answers: Object.fromEntries(Object.keys(body.questions ?? {}).map((k) => [k, { type: "noul", noul: 0 }])),
        usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
      });
    }
    if (route === "POST /v1/audio/speech") {
      const body = (await request.json()) as { model?: unknown; input?: unknown; voice?: unknown; response_format?: unknown };
      record({ kind: "speech", model: body.model, voice: body.voice, format: body.response_format, input: body.input });
      if (body.response_format === "pcm") {
        return new Response(tonePcm(1.5, 24_000), { headers: { "content-type": "audio/pcm" } });
      }
      return new Response(silentMp3(1), { headers: { "content-type": "audio/mpeg" } });
    }
    if (route === "GET /v1/realtime") {
      record({ kind: "realtime-open", search: url.search });
      return server.upgrade(request, { data: { session: { appended: 0, commits: 0, said: 0 } } })
        ? undefined
        : new Response(null, { status: 400 });
    }
    if (route === "POST /v1/audio/transcriptions") {
      const form = await request.formData();
      const file = form.get("file");
      record({ kind: "transcription", bytes: file instanceof File ? file.size : 0 });
      return Response.json({ text: HEARD, usage: { type: "tokens", input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
    }
    if (route === "GET /v1/models") {
      record({ kind: "models" });
      return Response.json({ object: "list", data: [{ id: "fake-chat", object: "model", owned_by: "spike" }] });
    }
    const body = (await request.json()) as { input?: unknown; dimensions?: unknown; model?: unknown };
    const inputs = (Array.isArray(body.input) ? body.input : [body.input]).map(String);
    const dimensions = typeof body.dimensions === "number" ? body.dimensions : 3072;
    record({ kind: "embeddings", model: body.model, inputs: inputs.length, dimensions });
    return Response.json({
      object: "list",
      model: "fake",
      data: inputs.map((text, index) => ({ object: "embedding", index, embedding: fakeVector(text, dimensions) })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "session.created" }));
    },
    message(ws, message) {
      const event = JSON.parse(String(message)) as { type?: unknown };
      const session = ws.data.session;
      if (event.type === "session.update") {
        record({ kind: "realtime-session-update" });
        ws.send(JSON.stringify({ type: "session.updated" }));
      } else if (event.type === "input_audio_buffer.append") {
        session.appended++;
        if (session.appended % 250 === 1) record({ kind: "realtime-append", appended: session.appended });
      } else if (event.type === "input_audio_buffer.commit") {
        session.commits++;
        record({ kind: "realtime-commit", commits: session.commits, appended: session.appended });
        if (session.said === 0) {
          session.said++;
          const item_id = `item_said_${session.said}`;
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id, transcript: HEARD }));
          record({ kind: "realtime-said", transcript: HEARD });
        }
      } else {
        record({ kind: "realtime-event", type: event.type });
      }
    },
    close(ws) {
      record({ kind: "realtime-close", appended: ws.data.session.appended, commits: ws.data.session.commits });
    },
  },
});

let blocker: ReturnType<typeof Bun.serve> | null = null;
if (blockPort !== null) {
  blocker = Bun.serve({
    hostname: "127.0.0.1",
    port: blockPort,
    fetch(request) {
      record({ kind: "blocker-hit", route: `${request.method} ${new URL(request.url).pathname}` });
      return new Response("not eidolon", { status: 404 });
    },
  });
}

const base = `http://127.0.0.1:${server.port}/v1`;
writeFileSync(
  join(stateDir, "fakes.json"),
  JSON.stringify({ pid: process.pid, base, key, blockPort: blocker?.port ?? null }, null, 1),
);
record({ kind: "started", base, blockPort: blocker?.port ?? null });
console.log(`fakes on ${base}${blocker ? `, blocking ${blocker.port}` : ""}`);
process.on("SIGTERM", () => {
  server.stop(true);
  blocker?.stop(true);
  process.exit(0);
});
