import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ProviderConfigError, ProviderHttpError, selectRequired } from "../../../src/index.ts";
import { speechSupport, transcribe } from "../../../src/speech/batch/index.ts";
import { transcribeTimeoutMs } from "../../../src/speech/batch/transcribe.ts";
import { FakeProvider, type Seen, sources } from "./fake.ts";

const fake = new FakeProvider();
beforeAll(() => fake.start());
afterAll(() => fake.stop());

const hearing = (vars: Readonly<Record<string, string>>) =>
  selectRequired("hearing", sources(vars));

const clip = {
  bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
  mime: "audio/webm;codecs=opus",
};
const noWait = async () => {};

/** Soniox deletes after it answers: what reached the fake once `count` requests have. */
async function requests(count: number): Promise<string[]> {
  for (let waited = 0; fake.seen.length < count && waited < 2000; waited += 5) await Bun.sleep(5);
  return fake.seen.map(({ method, url }) => `${method} ${new URL(url).pathname}`);
}

/** The upload's name, its type as sent (Bun's parse guesses one from the name), and its bytes. */
async function fileOf(seen: Seen | undefined): Promise<[string, string, number[]]> {
  const file = seen?.form?.get("file");
  if (!(file instanceof File)) throw new Error("no file in the upload");
  const raw = new TextDecoder().decode(seen?.bytes);
  const type = /name="file"; filename="[^"]*"\r\nContent-Type: ([^\r]+)/.exec(raw)?.[1] ?? "";
  return [file.name, type, [...new Uint8Array(await file.arrayBuffer())]];
}

describe("transcribe", () => {
  test("OpenAI uploads the clip to its batch model, in the spoken language", async () => {
    fake.answer(() =>
      Response.json({
        text: " 你好呀 ",
        usage: { type: "tokens", input_tokens: 40, output_tokens: 5 },
      }),
    );
    const selection = hearing({ STT_PROVIDER: "openai", OPENAI_API_KEY: "ok" });
    const heard = await transcribe(selection, { ...clip, durationMs: 2500 }, { fetch: fake.fetch });
    expect(heard).toEqual({ text: "你好呀", durationMs: 2500 });
    const [request] = fake.seen;
    expect(request?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(request?.headers.get("authorization")).toBe("Bearer ok");
    expect(request?.form?.get("model")).toBe("gpt-4o-transcribe");
    expect(request?.form?.get("language")).toBe("zh");
    expect(request?.form?.get("response_format")).toBe("json");
    expect(await fileOf(request)).toEqual(["voice.webm", "audio/webm", [...clip.bytes]]);
    expect(fake.usage).toHaveLength(1);
    expect(fake.usage[0]).toMatchObject({
      role: "hearing",
      category: "stt",
      provider: "openai",
      model: "gpt-4o-transcribe",
      units: { inputTokens: 40, outputTokens: 5, audioSeconds: 2.5 },
    });
  });

  test("OpenAI's whisper reports the seconds it heard; a named model is kept", async () => {
    fake.answer(() => Response.json({ text: "hi", usage: { type: "duration", seconds: 3.2 } }));
    const selection = hearing({
      STT_PROVIDER: "openai",
      STT_MODEL: "whisper-1",
      OPENAI_API_KEY: "ok",
    });
    const heard = await transcribe(
      selection,
      { bytes: clip.bytes, mime: "audio/mp4" },
      { language: null, fetch: fake.fetch },
    );
    expect(heard).toEqual({ text: "hi", durationMs: 3200 });
    expect(fake.seen[0]?.form?.get("model")).toBe("whisper-1");
    expect(fake.seen[0]?.form?.has("language")).toBe(false);
    expect((await fileOf(fake.seen[0]))[0]).toBe("voice.m4a");
    expect(fake.usage[0]?.units).toEqual({ audioSeconds: 3.2 });
  });

  test("Deepgram takes the raw bytes, and reports the length and its price", async () => {
    fake.answer(() =>
      Response.json({
        metadata: { duration: 4.5 },
        results: { channels: [{ alternatives: [{ transcript: "早上好", confidence: 0.9 }] }] },
      }),
    );
    process.env.TRANSCRIBE_LANGUAGE = "ja";
    try {
      const selection = hearing({ STT_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "dk" });
      expect(await transcribe(selection, clip, { fetch: fake.fetch })).toEqual({
        text: "早上好",
        durationMs: 4500,
      });
    } finally {
      delete process.env.TRANSCRIBE_LANGUAGE;
    }
    const [request] = fake.seen;
    expect(request?.url).toBe(
      "https://api.deepgram.com/v1/listen?model=nova-3-general&punctuate=true&language=ja",
    );
    expect(request?.headers.get("authorization")).toBe("Token dk");
    expect(request?.headers.get("content-type")).toBe("audio/webm");
    expect([...(request?.bytes ?? [])]).toEqual([...clip.bytes]);
    expect(fake.usage[0]).toMatchObject({
      provider: "deepgram",
      model: "nova-3-general",
      units: { audioSeconds: 4.5 },
      costUsd: (4.5 / 3600) * 0.462,
      costSource: "estimated",
    });
  });

  test("Deepgram detects the language when the setting says none", async () => {
    fake.answer(() => Response.json({ results: { channels: [] } }));
    process.env.STT_LANGUAGE = "none";
    try {
      const selection = hearing({ STT_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "dk" });
      expect(await transcribe(selection, clip, { fetch: fake.fetch })).toEqual({
        text: "",
        durationMs: null,
      });
    } finally {
      delete process.env.STT_LANGUAGE;
    }
    expect(new URL(fake.seen[0]?.url ?? "").searchParams.get("detect_language")).toBe("true");
    expect(fake.usage[0]?.units).toEqual({});
  });

  test("ElevenLabs hears with the realtime model's batch twin, without event tags", async () => {
    fake.answer(() => Response.json({ text: "你好", language_code: "zho" }));
    const selection = hearing({ STT_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "xk" });
    const heard = await transcribe(selection, { ...clip, durationMs: 1000 }, { fetch: fake.fetch });
    expect(heard).toEqual({ text: "你好", durationMs: 1000 });
    const [request] = fake.seen;
    expect(request?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(request?.headers.get("xi-api-key")).toBe("xk");
    expect(request?.form?.get("model_id")).toBe("scribe_v2");
    expect(request?.form?.get("language_code")).toBe("zh");
    expect(request?.form?.get("tag_audio_events")).toBe("false");
    expect(fake.usage[0]).toMatchObject({ model: "scribe_v2", units: { audioSeconds: 1 } });
  });

  test("Soniox uploads, transcribes with the async twin, polls, fetches, then deletes both", async () => {
    let polls = 0;
    fake.answer(({ method, url }) => {
      const path = new URL(url).pathname;
      if (method === "POST" && path === "/v1/files") return Response.json({ id: "f1" });
      if (method === "POST" && path === "/v1/transcriptions") {
        return Response.json({ id: "t1", status: "queued" });
      }
      if (method === "GET" && path === "/v1/transcriptions/t1") {
        polls++;
        return Response.json(
          polls < 2
            ? { id: "t1", status: "processing" }
            : { id: "t1", status: "completed", audio_duration_ms: 3600 },
        );
      }
      if (method === "GET" && path === "/v1/transcriptions/t1/transcript") {
        return Response.json({ id: "t1", text: "你好啊", tokens: [] });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    });
    const waits: number[] = [];
    process.env.STT_LANGUAGE = "zh";
    try {
      const selection = hearing({ SONIOX_API_KEY: "sk" });
      const heard = await transcribe(selection, clip, {
        fetch: fake.fetch,
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      expect(heard).toEqual({ text: "你好啊", durationMs: 3600 });
    } finally {
      delete process.env.STT_LANGUAGE;
    }
    expect(await requests(7)).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      "GET /v1/transcriptions/t1",
      "GET /v1/transcriptions/t1",
      "GET /v1/transcriptions/t1/transcript",
      "DELETE /v1/transcriptions/t1",
      "DELETE /v1/files/f1",
    ]);
    expect(fake.seen[0]?.url).toBe("https://api.soniox.com/v1/files");
    expect(waits).toEqual([500, 500]);
    expect(fake.seen.every((seen) => seen.headers.get("authorization") === "Bearer sk")).toBe(true);
    expect(await fileOf(fake.seen[0])).toEqual(["voice.webm", "audio/webm", [...clip.bytes]]);
    expect(fake.seen[1]?.json).toEqual({
      model: "stt-async-v5",
      file_id: "f1",
      language_hints: ["zh"],
    });
    expect(fake.usage[0]).toMatchObject({
      role: "hearing",
      provider: "soniox",
      model: "stt-async-v5",
      units: { audioSeconds: 3.6 },
      costUsd: (3.6 / 3600) * 0.1,
      costSource: "estimated",
    });
  });

  test("Soniox detects the language itself: only STT_LANGUAGE becomes a hint", async () => {
    fake.answer(({ method, url }) => {
      const path = new URL(url).pathname;
      if (path === "/v1/files") return Response.json({ id: "f2" });
      if (method === "POST") return Response.json({ id: "t2", status: "completed" });
      if (method === "GET") return Response.json({ text: "" });
      return new Response(null, { status: 204 });
    });
    process.env.TRANSCRIBE_LANGUAGE = "ja";
    try {
      const heard = await transcribe(hearing({ SONIOX_API_KEY: "sk" }), clip, {
        fetch: fake.fetch,
        sleep: noWait,
      });
      expect(heard).toEqual({ text: "", durationMs: null });
    } finally {
      delete process.env.TRANSCRIBE_LANGUAGE;
    }
    await requests(5);
    expect(fake.seen[1]?.json).toEqual({ model: "stt-async-v5", file_id: "f2" });
  });

  test("a Soniox job that fails is an error, and its file and job are still deleted", async () => {
    fake.answer(({ method, url }) => {
      const path = new URL(url).pathname;
      if (path === "/v1/files") return Response.json({ id: "f3" });
      if (method === "POST") {
        return Response.json({
          id: "t3",
          status: "error",
          error_type: "audio_decode_error",
          error_message: "can't decode",
        });
      }
      if (path === "/v1/files/f3") return Response.json({ message: "gone" }, { status: 404 });
      return new Response(null, { status: 204 });
    });
    const failed = transcribe(hearing({ SONIOX_API_KEY: "sk" }), clip, {
      fetch: fake.fetch,
      sleep: noWait,
    });
    await expect(failed).rejects.toThrow("Soniox answered 200: audio_decode_error: can't decode");
    expect(await requests(4)).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      "DELETE /v1/transcriptions/t3",
      "DELETE /v1/files/f3",
    ]);
    expect(fake.usage).toEqual([]);
  });

  test("a Soniox job in a status it doesn't know is an error, not polled forever", async () => {
    fake.answer(({ method, url }) => {
      const path = new URL(url).pathname;
      if (path === "/v1/files") return Response.json({ id: "f9" });
      if (method === "POST") return Response.json({ id: "t9", status: "queued" });
      if (method === "GET") return Response.json({ id: "t9" });
      return new Response(null, { status: 204 });
    });
    const failed = transcribe(hearing({ SONIOX_API_KEY: "sk" }), clip, {
      fetch: fake.fetch,
      sleep: noWait,
    });
    await expect(failed).rejects.toThrow("Soniox answered 200: a transcription in status null");
    expect(await requests(5)).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      "GET /v1/transcriptions/t9",
      "DELETE /v1/transcriptions/t9",
      "DELETE /v1/files/f9",
    ]);
  });

  test("a Soniox delete that never answers still leaves the other its own time", async () => {
    fake.answer(({ method, url }) => {
      const path = new URL(url).pathname;
      if (path === "/v1/files") return Response.json({ id: "f5" });
      if (method === "POST") return Response.json({ id: "t5", status: "completed" });
      if (method === "GET") return Response.json({ text: "嗯" });
      if (path === "/v1/transcriptions/t5") return new Promise<Response>(() => {});
      return new Response(null, { status: 204 });
    });
    const heard = await transcribe(hearing({ SONIOX_API_KEY: "sk" }), clip, {
      fetch: fake.fetch,
      sleep: noWait,
      cleanupMs: 50,
    });
    expect(heard.text).toBe("嗯");
    expect(await requests(5)).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      "GET /v1/transcriptions/t5/transcript",
      "DELETE /v1/transcriptions/t5",
      "DELETE /v1/files/f5",
    ]);
  });

  test("an abort mid-poll still deletes the upload", async () => {
    const controller = new AbortController();
    fake.answer(({ method, url }) => {
      const path = new URL(url).pathname;
      if (path === "/v1/files") return Response.json({ id: "f4" });
      if (method === "POST") return Response.json({ id: "t4", status: "queued" });
      return new Response(null, { status: 204 });
    });
    const failed = transcribe(hearing({ SONIOX_API_KEY: "sk" }), clip, {
      fetch: fake.fetch,
      signal: controller.signal,
      sleep: async () => {
        controller.abort(new Error("stopped"));
        throw new Error("stopped");
      },
    });
    await expect(failed).rejects.toThrow("stopped");
    expect(await requests(4)).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      "DELETE /v1/transcriptions/t4",
      "DELETE /v1/files/f4",
    ]);
  });

  test("a provider that never answers fails within the time limit, and nothing is used", async () => {
    fake.answer(() => new Promise<Response>(() => {}));
    const pending = transcribe(hearing({ STT_PROVIDER: "openai", OPENAI_API_KEY: "ok" }), clip, {
      fetch: fake.fetch,
      signal: new AbortController().signal,
      timeoutMs: 50,
    });
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).message).toBe("OpenAI didn't answer within 0.05 s");
    expect(fake.usage).toEqual([]);
  });

  test("a Soniox job that never finishes fails within the limit, and both are still deleted", async () => {
    fake.answer(({ method, url }) => {
      const path = new URL(url).pathname;
      if (path === "/v1/files") return Response.json({ id: "f6" });
      if (method === "POST") return Response.json({ id: "t6", status: "queued" });
      if (method === "GET") return new Promise<Response>(() => {});
      return new Response(null, { status: 204 });
    });
    const pending = transcribe(hearing({ SONIOX_API_KEY: "sk" }), clip, {
      fetch: fake.fetch,
      sleep: noWait,
      timeoutMs: 50,
    });
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).message).toBe("Soniox didn't answer within 0.05 s");
    expect(await requests(5)).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      "GET /v1/transcriptions/t6",
      "DELETE /v1/transcriptions/t6",
      "DELETE /v1/files/f6",
    ]);
  });

  test("the time limit is 30 s and a second for every two of the clip's, at most 90 s", () => {
    expect(transcribeTimeoutMs(10_000)).toBe(35_000);
    expect(transcribeTimeoutMs(4321)).toBe(33_000);
    expect(transcribeTimeoutMs(120_000)).toBe(90_000);
    expect(transcribeTimeoutMs(undefined)).toBe(90_000);
  });

  test("an error status becomes ProviderHttpError, and nothing is reported as used", async () => {
    fake.answer(() =>
      Response.json({ error: { message: "Invalid file format" } }, { status: 400 }),
    );
    const failed = transcribe(hearing({ STT_PROVIDER: "openai", OPENAI_API_KEY: "ok" }), clip, {
      fetch: fake.fetch,
    });
    await expect(failed).rejects.toThrow("OpenAI answered 400: Invalid file format");
    expect(await failed.catch((e: unknown) => e)).toBeInstanceOf(ProviderHttpError);
    expect(fake.usage).toEqual([]);
  });

  test("refuses before any request without a key, or with a voice role", async () => {
    fake.answer(() => Response.json({}));
    const noKey = transcribe(hearing({}), clip, { fetch: fake.fetch });
    await expect(noKey).rejects.toThrow(
      "Soniox needs an API key: set SONIOX_API_KEY in credentials.json or the environment",
    );
    expect(await noKey.catch((e: unknown) => e)).toBeInstanceOf(ProviderConfigError);
    const voice = selectRequired("voice", sources({ FISH_API_KEY: "fk" }));
    await expect(transcribe(voice, clip, { fetch: fake.fetch })).rejects.toThrow(
      "Fish Audio has no batch speech recognition",
    );
    expect(fake.seen).toEqual([]);
  });
});

describe("speechSupport", () => {
  test("every STT in the catalog transcribes", () => {
    for (const provider of ["soniox", "openai", "elevenlabs", "deepgram"]) {
      expect([provider, speechSupport(hearing({ STT_PROVIDER: provider }))]).toEqual([
        provider,
        { synthesize: false, transcribe: true },
      ]);
    }
  });
});
