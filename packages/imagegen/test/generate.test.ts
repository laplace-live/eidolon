import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type GenerateOptions, generate, ImageGenError } from "../src/index.ts";
import {
  CancelledError,
  clearSelfieEnv,
  fakeFetch,
  hangingFetch,
  jsonResponse,
  restoreEnv,
} from "./helpers.ts";

// base64 of b"\x89PNG fake".
const B64 = "iVBORyBmYWtl";
const BYTES = Uint8Array.fromBase64(B64);

beforeEach(clearSelfieEnv);
afterEach(restoreEnv);

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

function answering(response: () => Response, options: Partial<GenerateOptions> = {}) {
  const { fetch, calls } = fakeFetch(response);
  return { calls, run: () => generate({ apiKey: "sk-or-test", prompt: "p", fetch, ...options }) };
}

describe("generate request", () => {
  test("posts Python's payload, headers and idle timeout", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, { data: [{ b64_json: B64 }], usage: { cost: 0.04 } }),
    );
    const result = await generate({
      apiKey: "sk-or-test",
      prompt: "p 七海",
      references: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
      fetch,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe(
      '{"model":"openai/gpt-image-2.5-flare","prompt":"p 七海","n":1,"input_references":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAA"}}]}',
    );
    expect(call?.init.headers).toEqual({
      "HTTP-Referer": "https://laplace.live/ai",
      "X-Title": "LAPLACE Live!",
      "X-OpenRouter-Title": "LAPLACE Live!",
      "X-OpenRouter-Categories": "roleplay",
      Authorization: "Bearer sk-or-test",
      "Content-Type": "application/json",
    });
    expect(call?.init.timeout).toBe(600_000);
    expect(result).toEqual({ images: [{ data: BYTES, mediaType: "image/png" }], costUsd: 0.04 });
  });

  test("omits empty references and auto settings, keeps the rest in order", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { data: [{ b64_json: B64 }] }));
    const base = { apiKey: "k", prompt: "p", fetch };
    await generate({
      ...base,
      references: [],
      aspectRatio: "3:4",
      quality: "high",
      n: 2,
      model: "m/x",
    });
    await generate({ ...base, references: null, aspectRatio: "auto", quality: "auto" });
    expect(calls.map((call) => call.init.body)).toEqual([
      '{"model":"m/x","prompt":"p","n":2,"aspect_ratio":"3:4","quality":"high"}',
      '{"model":"openai/gpt-image-2.5-flare","prompt":"p","n":1}',
    ]);
  });

  test("encodes the body as httpx's compact JSON", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { data: [{ b64_json: B64 }] }));
    await generate({
      apiKey: "k",
      prompt: '七海 —   \x01 "q" \\ /',
      references: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
      aspectRatio: "3:4",
      quality: "high",
      n: 2,
      model: "m",
      fetch,
    });
    expect(calls[0]?.init.body).toBe(
      '{"model":"m","prompt":"七海 —   \\u0001 \\"q\\" \\\\ /","n":2,"input_references":[{"type":"image_url","image_url":{"url":"https://x/y.png"}}],"aspect_ratio":"3:4","quality":"high"}',
    );
  });
});

describe("generate errors", () => {
  test("a non-200 status carries OpenRouter's message, or the body as Python prints it", async () => {
    const rows: [number, string, string][] = [
      [402, '{"error":{"message":"Insufficient credits","code":402}}', "402: Insufficient credits"],
      [400, '{"error":{"code":400}}', "400: {'code': 400}"],
      [400, '{"error":"bad thing"}', "400: bad thing"],
      [500, '{"foo":1,"bar":null,"ok":true}', "500: {'foo': 1, 'bar': None, 'ok': True}"],
      [500, "", "500: "],
      [500, "  \n", "500: "],
      [502, "  <html>bad gateway</html>  ", "502: <html>bad gateway</html>"],
      [400, '"just a string"', "400: just a string"],
      [400, "null", "400: None"],
      [
        201,
        '{"data":[{"b64_json":"iVBORyBmYWtl"}]}',
        "201: {'data': [{'b64_json': 'iVBORyBmYWtl'}]}",
      ],
      [500, '{"error":{"message":"","code":1}}', "500: {'message': '', 'code': 1}"],
      [500, '{"error":{"message":0}}', "500: {'message': 0}"],
      [500, '{"error":0}', "500: {'error': 0}"],
      [500, '{"error":[]}', "500: {'error': []}"],
      [500, '{"error":{}}', "500: {}"],
      [500, '{"error":{"message":{"a":1}}}', "500: {'a': 1}"],
      [500, '{"error":{"message":["it\'s", "x"]}}', "500: [\"it's\", 'x']"],
      [500, '{"error":{"message":"你好"}}', "500: 你好"],
      [500, '{"e":"\\u0001\\u00a0\\u3000"}', "500: {'e': '\\x01\\xa0\\u3000'}"],
      [500, '{"e":1.5e-7}', "500: {'e': 1.5e-07}"],
      [500, '\uFEFF{"error":"bom"}', "500: bom"],
    ];
    for (const [status, body, message] of rows) {
      // Bytes, as off the socket: a Response built from a string skips the BOM-stripping decode.
      const { run } = answering(() => new Response(new TextEncoder().encode(body), { status }));
      const error = await failure(run());
      expect(error).toBeInstanceOf(ImageGenError);
      expect([status, body, (error as Error).message]).toEqual([status, body, message]);
    }
  });

  test("a transport failure is `request failed: <reason>`", async () => {
    const { run } = answering(() => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    });
    const error = await failure(run());
    expect(error).toBeInstanceOf(ImageGenError);
    expect((error as Error).message).toBe(
      "request failed: Unable to connect. Is the computer able to access the url?",
    );
  });

  test("a body that breaks off mid-read is a transport failure too", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        controller.error(new Error("socket reset"));
      },
    });
    const { run } = answering(() => new Response(stream, { status: 200 }));
    const error = await failure(run());
    expect(error).toBeInstanceOf(ImageGenError);
    expect((error as Error).message).toBe("request failed: socket reset");
  });

  test("an abort rejects with the signal's reason, unwrapped", async () => {
    const { fetch, started } = hangingFetch();
    const controller = new AbortController();
    const pending = failure(
      generate({ apiKey: "k", prompt: "p", fetch, signal: controller.signal }),
    );
    await started;
    const reason = new CancelledError("Task cancelled");
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });

  test("an abort during the body read rejects with the reason too", async () => {
    const controller = new AbortController();
    const reason = new CancelledError("Task cancelled");
    const { run } = answering(
      () => {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"data":'));
            controller.abort(reason);
            c.error(new Error("aborted"));
          },
        });
        return new Response(stream, { status: 200 });
      },
      { signal: controller.signal },
    );
    expect(await failure(run())).toBe(reason);
  });

  test("a 200 that isn't JSON throws SyntaxError, not ImageGenError", async () => {
    const { run } = answering(() => new Response("<html>", { status: 200 }));
    expect(await failure(run())).toBeInstanceOf(SyntaxError);
  });

  test("a response without an image row is an ImageGenError", async () => {
    const bodies: unknown[] = [
      { usage: { cost: 0.04 } },
      { data: [] },
      { data: null },
      { data: 0 },
      { data: "abc" },
      { data: { b64_json: B64 } },
      [{ b64_json: B64 }],
      JSON.stringify("x"),
      { data: ["junk", { url: "x" }, { b64_json: "" }, { b64_json: null }] },
    ];
    for (const body of bodies) {
      const { run } = answering(() => jsonResponse(200, body));
      const error = await failure(run());
      expect(error).toBeInstanceOf(ImageGenError);
      expect((error as Error).message).toBe("the response carried no image");
    }
  });

  test("a number or boolean `data` raises TypeError, as Python's iteration does", async () => {
    for (const [data, type] of [
      [5, "int"],
      [1.5, "float"],
      [true, "bool"],
    ] as const) {
      const { run } = answering(() => jsonResponse(200, { data }));
      const error = await failure(run());
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`'${type}' object is not iterable`);
    }
  });

  test("a b64_json that isn't a string raises TypeError", async () => {
    for (const b64 of [[1], true, 5]) {
      const { run } = answering(() => jsonResponse(200, { data: [{ b64_json: b64 }] }));
      expect(await failure(run())).toBeInstanceOf(TypeError);
    }
  });
});

describe("generate results", () => {
  test("keeps image rows in order with their media types", async () => {
    const { run } = answering(() =>
      jsonResponse(200, {
        data: [
          { b64_json: B64, media_type: "image/webp" },
          { b64_json: "" },
          "junk",
          { b64_json: B64, media_type: "" },
          { b64_json: B64, media_type: null },
          { b64_json: B64, media_type: "image/gif", url: "ignored" },
        ],
      }),
    );
    const result = await run();
    expect(result.images.map((image) => image.mediaType)).toEqual([
      "image/webp",
      "image/png",
      "image/png",
      "image/gif",
    ]);
    expect(result.images.every((image) => image.data.toString() === BYTES.toString())).toBe(true);
  });

  test("reads the cost as extract_cost_usd does", async () => {
    const cases: [unknown, number | null][] = [
      [{ cost: 0.04 }, 0.04],
      [{ cost: 0, cost_details: { upstream_inference_cost: 0.03 } }, 0.03],
      [{ cost: "0.05" }, 0.05],
      [{ cost: 0 }, 0],
      [[1], null],
      [undefined, null],
    ];
    for (const [usage, cost] of cases) {
      const { run } = answering(() => jsonResponse(200, { data: [{ b64_json: B64 }], usage }));
      expect((await run()).costUsd).toBe(cost);
    }
  });
});
