import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PROOF_HEADER } from "../../../bot/src/local/api.ts";
import { ApiError, call, errorDetail, errorFrom, errorKey, stream, url } from "./api";
import { keepProof } from "./proof";

afterEach(() => {
  mock.restore();
});

function answer(response: Response) {
  return spyOn(globalThis, "fetch").mockResolvedValue(response);
}

describe("errorFrom", () => {
  test("reads the API's code and message", async () => {
    const error = await errorFrom(
      Response.json({ error: { code: "bad-json", message: "not valid JSON" } }, { status: 400 }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect([error.status, error.code, error.message]).toEqual([400, "bad-json", "not valid JSON"]);
  });

  test("a body that isn't the API's, such as a proxy's error page, is bad-response", async () => {
    const error = await errorFrom(new Response("<h1>Bad Gateway</h1>", { status: 502 }));
    expect([error.status, error.code, error.message]).toEqual([502, "bad-response", "HTTP 502"]);
  });

  test("a 5xx's id, which names the server's log line, joins its detail", async () => {
    const error = await errorFrom(
      Response.json(
        { error: { code: "internal", message: "Eidolon hit an error", id: "0a1b2c3d" } },
        { status: 500 },
      ),
    );
    expect([error.code, error.id]).toEqual(["internal", "0a1b2c3d"]);
    expect(errorDetail(error)).toBe("Eidolon hit an error (error 0a1b2c3d)");
    expect(errorDetail(new ApiError(404, "not-found", "No such route"))).toBe("No such route");
    expect(errorDetail(null)).toBeUndefined();
  });
});

test("errorKey names the locale string for a code, and a fallback for anything else", () => {
  expect(errorKey(new ApiError(409, "call-active", "a call is live"))).toBe("errors.call-active");
  expect(errorKey(new TypeError("x"))).toBe("errors.unknown");
});

describe("url", () => {
  test("encodes each segment, so a name can't add one", () => {
    expect(
      url("GET /api/local/personas/:id/references/:kind/:name", {
        params: { id: "milky-green", kind: "friends", name: "a/b c#?.png" },
      }),
    ).toBe("/api/local/personas/milky-green/references/friends/a%2Fb%20c%23%3F.png");
  });

  test("appends the query, leaving out what is unset", () => {
    expect(url("GET /api/local/settings", { query: { persona: "x&y" } })).toBe(
      "/api/local/settings?persona=x%26y",
    );
    expect(url("GET /api/local/voices/search", { query: { q: "奶绿", page: undefined } })).toBe(
      "/api/local/voices/search?q=%E5%A5%B6%E7%BB%BF",
    );
    expect(url("GET /api/local/status")).toBe("/api/local/status");
  });
});

describe("call", () => {
  test("sends JSON with the session cookie and parses the reply", async () => {
    const fetch = answer(Response.json({ text: "你好", source: "own" }));
    const reply = await call("PUT /api/local/personas/:id/prompt", {
      params: { id: "mine" },
      body: { text: "你好" },
    });
    expect(reply).toEqual({ text: "你好", source: "own" });
    const [to, init] = fetch.mock.calls[0] ?? [];
    expect(to).toBe("/api/local/personas/mine/prompt");
    expect(init).toMatchObject({
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"text":"你好"}',
    });
  });

  test("sends an upload as is, with its type", async () => {
    const fetch = answer(Response.json({ name: "day.png", source: "own", size: 2 }));
    const file = new Blob([Uint8Array.of(0x89, 0x50)], { type: "image/png" });
    await call("POST /api/local/personas/:id/references/:kind/:name", {
      params: { id: "mine", kind: "outfits", name: "day.png" },
      body: file,
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: file,
      headers: { "Content-Type": "image/png" },
    });
  });

  test("a failure carries the API's code", async () => {
    answer(
      Response.json({ error: { code: "unknown-job", message: "no such job" } }, { status: 404 }),
    );
    const failure = call("GET /api/local/jobs/:id", { params: { id: "x" } }).catch(
      (error: unknown) => error,
    );
    expect(await failure).toMatchObject({ status: 404, code: "unknown-job" });
  });

  test("no answer at all is unreachable", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await call("GET /api/local/status").catch((error: unknown) => error)).toMatchObject({
      status: 0,
      code: "unreachable",
    });
  });

  test("an abort stays an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    spyOn(globalThis, "fetch").mockRejectedValue(controller.signal.reason);
    const failure = await call("GET /api/local/status", { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(ApiError);
    expect((failure as Error).name).toBe("AbortError");
  });
});

describe("the session's proof", () => {
  test("goes with every call and stream, as the header the server reads", async () => {
    keepProof("proof-from-the-session");
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response("log"));
    await call("GET /api/local/status");
    await call("PUT /api/local/personas/:id/prompt", {
      params: { id: "mine" },
      body: { text: "x" },
    });
    await stream("GET /api/local/jobs/:id/log", { params: { id: "20261105T120000-ABCDEF" } });
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get(PROOF_HEADER)).toBe("proof-from-the-session");
    }
    expect(fetch.mock.calls).toHaveLength(3);
  });
});

test("stream hands over a raw route's body", async () => {
  const fetch = answer(new Response('{"type":"entry"}\n'));
  const body = await stream("GET /api/local/jobs/:id/events", {
    params: { id: "20261105T120000-ABCDEF" },
    query: { after: 120 },
  });
  expect(await new Response(body).text()).toBe('{"type":"entry"}\n');
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/local/jobs/20261105T120000-ABCDEF/events?after=120");
});

// Never run: the typecheck holds each call to its route's shape.
export function typeChecks() {
  void call("GET /api/local/status");
  // @ts-expect-error a route with a :name segment needs params
  void call("PUT /api/local/personas/:id/prompt", { body: { text: "x" } });
  // @ts-expect-error a route that takes a body needs one
  void call("POST /api/local/session");
  // @ts-expect-error the body has the route's shape
  void call("POST /api/local/session", { body: { token: "x" } });
  // @ts-expect-error a raw route is streamed or linked, not parsed
  void call("GET /api/local/jobs/:id/events", { params: { id: "x" } });
  // @ts-expect-error a JSON route isn't streamed
  void stream("GET /api/local/status");
  // @ts-expect-error not a route
  void call("GET /api/local/nope");
}
