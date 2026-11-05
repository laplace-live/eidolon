import { describe, expect, test } from "bun:test";
import { OpenAIClient, type OpenAIClientOptions } from "../src/index.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | null;
}

function client(
  reply: (call: Call) => Response | Promise<Response>,
  options: OpenAIClientOptions = {},
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const http = new OpenAIClient(
    { baseUrl: "https://example.test/v1", apiKey: "sk-test" },
    {
      fetch: (async (url: string, init: RequestInit) => {
        const call = {
          url,
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal ?? null,
        };
        calls.push(call);
        return reply(call);
      }) as unknown as typeof fetch,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...options,
    },
  );
  return { http, calls, sleeps };
}

describe("OpenAIClient", () => {
  test("default headers ride every request, beside the SDK's own", async () => {
    const { http, calls } = client(() => json({ ok: true }), {
      headers: { "HTTP-Referer": "https://laplace.live/ai", "X-Title": "LAPLACE Live!" },
    });
    expect(await http.post("chat/completions", { model: "m" })).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
    expect(calls[0]?.headers).toEqual({
      authorization: "Bearer sk-test",
      "content-type": "application/json",
      accept: "application/json",
      "http-referer": "https://laplace.live/ai",
      "x-title": "LAPLACE Live!",
    });
  });

  test("maxRetries sets how many times a retryable status is retried", async () => {
    const { http, calls, sleeps } = client(() => json({ error: "busy" }, 503), { maxRetries: 4 });
    await expect(http.post("chat/completions", {})).rejects.toThrow(
      "Error code: 503 - {'error': 'busy'}",
    );
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([500, 1000, 2000, 4000]);
  });

  test("an abort in flight rejects with the signal's reason and is not retried", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const { http, calls } = client(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
          controller.abort(reason);
        }),
      { signal: controller.signal },
    );
    await expect(http.post("chat/completions", {})).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });

  test("an abort during a retry wait rejects at once; then nothing is sent", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const { http, calls } = client(() => json({}, 503), {
      signal: controller.signal,
      sleep: () => {
        controller.abort(reason);
        return new Promise(() => {});
      },
    });
    await expect(http.post("chat/completions", {})).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
    await expect(http.post("chat/completions", {})).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });
});
