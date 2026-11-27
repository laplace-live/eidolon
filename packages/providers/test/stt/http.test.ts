import { afterEach, expect, test } from "vitest";
import { select, setUsageSink, type UsageRecord } from "../../src/index.ts";
import { openHttpWhisperStt } from "../../src/stt/http.ts";
import { STT_STREAMS } from "../../src/stt/index.ts";
import { serveWs } from "../ws-server.ts";
import { live, watch } from "./fake.ts";

let stopServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  setUsageSink(null);
  await stopServer?.();
  stopServer = null;
});

function compatibleSelection(base: string, sttProtocol?: string) {
  const id = "custom-stt";
  const env: Record<string, string> = { STT_PROVIDER: id };
  const options: Record<string, string> = sttProtocol === undefined ? {} : { sttProtocol };
  const accounts = new Map([
    [
      id,
      {
        id,
        provider: "openai-compatible",
        name: null,
        apiKey: null,
        baseUrl: base,
        options,
      },
    ],
  ]);
  return select("hearing", {
    read: (name) => env[name],
    env: (name) => env[name],
    accounts,
  })!;
}

test("HTTP Whisper STT latches pre-roll on speechStarted, posts WAV on finalize, and skips empty turns", async () => {
  const requests: {
    url: string;
    auth: string | null;
    model: FormDataEntryValue | null;
    bytes: number;
  }[] = [];
  const server = await serveWs({
    open() {},
    async fetch(request) {
      const form = await request.formData();
      const file = form.get("file") as File;
      requests.push({
        url: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        model: form.get("model"),
        bytes: (await file.arrayBuffer()).byteLength,
      });
      return Response.json({ text: "  你好世界  " });
    },
  });
  stopServer = () => server.stop();

  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));

  const stream = await STT_STREAMS["openai-compatible"]!(
    compatibleSelection(`http://127.0.0.1:${server.port}/v1/`),
    "zh",
    live(),
  );
  expect([stream.inputRate, stream.acknowledgesFinalize]).toEqual([16000, true]);
  const events = watch(stream);

  // Finalize while quiet emits finalized without posting.
  stream.finalize();
  await events.until((e) => e.type === "finalized");
  expect(requests).toHaveLength(0);

  // Feed 600 ms before speechStarted (capped to 500 ms pre-roll) + 200 ms speech -> 700 ms WAV.
  stream.send(new Int16Array(9600));
  stream.speechStarted?.();
  stream.send(new Int16Array(3200));
  stream.finalize();

  const finalEvent = await events.until((e) => e.type === "final");
  expect(finalEvent).toEqual({ type: "final", text: "你好世界", finalized: true });
  expect(requests).toHaveLength(1);
  // 0.7 s at 16 kHz mono s16le = 22400 PCM bytes + 44-byte WAV header.
  expect(requests[0]).toEqual({
    url: "/v1/audio/transcriptions",
    auth: null,
    model: "whisper-1",
    bytes: 44 + 11200 * 2,
  });
  expect(records).toMatchObject([
    {
      role: "hearing",
      provider: "openai-compatible",
      model: "whisper-1",
      units: { audioSeconds: 0.7 },
    },
  ]);

  await stream.close();
});

test("HTTP Whisper STT surfaces upstream errors and acknowledges finalize", async () => {
  const server = await serveWs({
    open() {},
    fetch: () => new Response("server down", { status: 503 }),
  });
  stopServer = () => server.stop();

  const stream = await STT_STREAMS["openai-compatible"]!(
    compatibleSelection(`http://127.0.0.1:${server.port}/v1`),
    null,
    live(),
  );
  const events = watch(stream);
  stream.speechStarted?.();
  stream.send(new Int16Array(3200));
  stream.finalize();

  await events.until((e) => e.type === "finalized");
  expect(events.seen).toEqual([
    { type: "error", message: "OpenAI-compatible STT error (503): server down", fatal: false },
    { type: "finalized" },
  ]);
  await stream.close();
});

test("openai-compatible uses Realtime WebSocket when sttProtocol is realtime", async () => {
  let wsPath = "";
  const server = await serveWs({
    open(_socket, { url }) {
      wsPath = `${url.pathname}${url.search}`;
    },
  });
  stopServer = () => server.stop();

  const stream = await STT_STREAMS["openai-compatible"]!(
    compatibleSelection(`http://127.0.0.1:${server.port}/v1`, "realtime"),
    "zh",
    live(),
  );
  expect(stream.inputRate).toBe(24000);
  expect(wsPath).toBe("/v1/realtime?intent=transcription");
  await stream.close();
});

test("HTTP Whisper STT closes events on signal abort and times out stalled requests", async () => {
  let count = 0;
  const server = await serveWs({
    open() {},
    async fetch() {
      count += 1;
      if (count === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return Response.json({ text: "恢复了" });
    },
  });
  stopServer = () => server.stop();

  const controller = new AbortController();
  const stream = await openHttpWhisperStt(
    compatibleSelection(`http://127.0.0.1:${server.port}/v1`),
    null,
    controller.signal,
    { timeoutMs: 40 },
  );
  const events = watch(stream);

  stream.speechStarted?.();
  stream.send(new Int16Array(3200));
  stream.finalize();
  await events.until((e) => e.type === "finalized");
  expect(events.seen).toEqual([
    { type: "error", message: "OpenAI-compatible STT timed out after 0.04 s", fatal: false },
    { type: "finalized" },
  ]);

  stream.speechStarted?.();
  stream.send(new Int16Array(3200));
  stream.finalize();
  await events.until((e) => e.type === "final");
  expect(events.seen.at(-1)).toEqual({ type: "final", text: "恢复了", finalized: true });

  // Aborting caller signal ends the event stream without requiring explicit close().
  const done = (async () => {
    for await (const _ of stream.events) {
      // drain until closed
    }
  })();
  controller.abort();
  await done;
});
