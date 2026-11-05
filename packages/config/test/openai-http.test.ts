import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

  test("the retry wait gets the client's signal, or none", async () => {
    const controller = new AbortController();
    for (const signal of [controller.signal, undefined]) {
      const given: (AbortSignal | undefined)[] = [];
      const replies = [json({}, 503), json({ ok: true })];
      const { http } = client(() => replies.shift() as Response, {
        signal,
        sleep: async (_ms, sleepSignal) => {
          given.push(sleepSignal);
        },
      });
      expect(await http.post("chat/completions", {})).toEqual({ ok: true });
      expect(given).toEqual([signal]);
    }
  });

  test("without a signal, the default retry wait still sleeps its full delay", async () => {
    const replies = [
      new Response("{}", { status: 503, headers: { "retry-after-ms": "60" } }),
      json({ ok: true }),
    ];
    const http = new OpenAIClient(
      { baseUrl: "https://example.test/v1", apiKey: "sk-test" },
      { fetch: (async () => replies.shift()) as unknown as typeof fetch },
    );
    const started = performance.now();
    expect(await http.post("chat/completions", {})).toEqual({ ok: true });
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });

  test("a cancel during the default retry wait clears its timer, so the process exits at once", async () => {
    const module = join(import.meta.dir, "../src/openai-http.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { OpenAIClient } = await import(${JSON.stringify(module)});
         const controller = new AbortController();
         const http = new OpenAIClient({ baseUrl: "https://example.test/v1", apiKey: "k" }, {
           signal: controller.signal,
           fetch: async () => {
             setTimeout(() => controller.abort(new Error("cancelled")), 20);
             return new Response("{}", { status: 503, headers: { "retry-after": "30" } });
           },
         });
         await http.post("chat/completions", {}).catch((error) => console.log(error.message));`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    try {
      const started = performance.now();
      expect(await child.exited).toBe(0);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(await new Response(child.stdout).text()).toBe("cancelled\n");
    } finally {
      child.kill("SIGKILL");
    }
  }, 40_000);
});
