import { connect } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  type Listener,
  listen,
  type RouteHandler,
  type RouteRequest,
  type RouteServer,
  type Routes,
  routeRequest,
} from "../src/routing.ts";
import { serveRoutes } from "./serve.ts";

const server: RouteServer = { requestIP: () => ({ address: "127.0.0.1", port: 1 }) };

/** A route that answers with its name, the method it saw and the params it was handed. */
function named(name: string): RouteHandler {
  return async (request) =>
    Response.json({ name, method: request.method, params: { ...request.params } });
}

function dispatch(routes: Routes) {
  const handle = routeRequest(routes, (request) =>
    Response.json({ name: "fallback", method: request.method }, { status: 299 }),
  );
  return async (path: string, method = "GET") => {
    const response = await handle(new Request(`http://localhost${path}`, { method }), server);
    return { status: response.status, ...(await response.json()) };
  };
}

describe("routeRequest", () => {
  test("an exact path beats a param path, which beats a wildcard", async () => {
    const route = dispatch({
      "/w/*": named("wildcard"),
      "/w/:k": named("param"),
      "/w/x": named("exact"),
    });
    expect((await route("/w/x")).name).toBe("exact");
    expect(await route("/w/q")).toMatchObject({ name: "param", params: { k: "q" } });
    expect(await route("/w/q/r")).toMatchObject({ name: "wildcard", params: {} });
  });

  test("among param paths the most literal segments win, then the earliest literal", async () => {
    const route = dispatch({
      "/:p/:q": named("/:p/:q"),
      "/:y/b": named("/:y/b"),
      "/a/:x": named("/a/:x"),
      "/:z/b/c": named("/:z/b/c"),
      "/a/b/:c": named("/a/b/:c"),
      "/a/:x/:y": named("/a/:x/:y"),
    });
    expect((await route("/a/z")).name).toBe("/a/:x");
    expect((await route("/z/b")).name).toBe("/:y/b");
    expect((await route("/a/b")).name).toBe("/a/:x");
    expect((await route("/z/z")).name).toBe("/:p/:q");
    expect((await route("/a/b/c")).name).toBe("/a/b/:c");
    expect((await route("/z/b/c")).name).toBe("/:z/b/c");
    expect((await route("/a/z/c")).name).toBe("/a/:x/:y");
  });

  test("the longest wildcard prefix wins, and a wildcard needs its slash", async () => {
    const route = dispatch({ "/w/*": named("w"), "/w/x/*": named("wx"), "/*": named("root") });
    expect((await route("/w/x/z")).name).toBe("wx");
    expect((await route("/w/x")).name).toBe("w");
    expect((await route("/w/")).name).toBe("w");
    expect((await route("/w")).name).toBe("root");
    expect((await route("/")).name).toBe("root");
    expect((await dispatch({ "/w/*": named("w") })("/w")).name).toBe("fallback");
  });

  test("a path matches as written: no trailing-slash or case folding, no empty param", async () => {
    const route = dispatch({ "/t/": named("slash"), "/a/b": named("ab"), "/s/:id": named("s") });
    expect((await route("/t/")).name).toBe("slash");
    expect((await route("/t")).name).toBe("fallback");
    expect((await route("/a/b/")).name).toBe("fallback");
    expect((await route("/A/B")).name).toBe("fallback");
    expect((await route("/s/")).name).toBe("fallback");
    expect((await route("/a/b?x=1")).name).toBe("ab");
    // The URL's own normalization applies first, as the handlers see it.
    expect((await route("/c/../a/b")).name).toBe("ab");
  });

  test("params arrive percent-decoded, as Bun gave them; one that won't decode stays as sent", async () => {
    const route = dispatch({ "/s/:id": { GET: named("s") } });
    expect((await route("/s/abc%2Epng")).params).toEqual({ id: "abc.png" });
    expect((await route("/s/a%20b%2Fc")).params).toEqual({ id: "a b/c" });
    expect((await route("/s/%E4%B8%AD")).params).toEqual({ id: "中" });
    expect((await route("/s/a+b")).params).toEqual({ id: "a+b" });
    expect((await route("/s/a%ZZ")).params).toEqual({ id: "a%ZZ" });
  });

  test("a method map answers its methods, runs GET for HEAD and leaves the rest to the fallback", async () => {
    const route = dispatch({
      "/m": { GET: named("get"), POST: named("post") },
      "/p": { POST: named("post") },
    });
    expect(await route("/m")).toMatchObject({ name: "get", method: "GET" });
    expect(await route("/m", "POST")).toMatchObject({ name: "post", method: "POST" });
    expect(await route("/m", "HEAD")).toMatchObject({ name: "get", method: "HEAD" });
    for (const method of ["PATCH", "PUT", "DELETE", "OPTIONS"]) {
      expect(await route("/m", method)).toMatchObject({ status: 299, name: "fallback", method });
    }
    expect(await route("/p", "HEAD")).toMatchObject({ status: 299, name: "fallback" });
    expect(await route("/p", "GET")).toMatchObject({ status: 299, name: "fallback" });
  });

  test("a function route takes every method, OPTIONS and HEAD included", async () => {
    const route = dispatch({ "/f": named("f") });
    for (const method of ["GET", "POST", "OPTIONS", "DELETE", "PATCH", "HEAD"]) {
      expect(await route("/f", method)).toMatchObject({ name: "f", method });
    }
  });

  test("an unmatched path goes to the fallback with the server", async () => {
    const seen: (RouteServer | undefined)[] = [];
    const handle = routeRequest({ "/a": named("a") }, (_request, given) => {
      seen.push(given);
      return new Response(null, { status: 404 });
    });
    expect((await handle(new Request("http://localhost/b"), server)).status).toBe(404);
    expect(seen).toEqual([server]);
  });

  test("a handler's throw reaches the caller", async () => {
    const handle = routeRequest(
      {
        "/boom": async () => {
          throw new Error("boom");
        },
      },
      () => new Response(null, { status: 404 }),
    );
    await expect(handle(new Request("http://localhost/boom"), server)).rejects.toThrow("boom");
  });
});

describe("listen", () => {
  let listener: Listener | null = null;
  afterEach(async () => {
    await listener?.stop();
    listener = null;
  });

  test("serves on a free port, hands each route the peer, the params and the body", async () => {
    const peers: unknown[] = [];
    listener = await listen({
      hostname: "127.0.0.1",
      port: 0,
      handle: routeRequest(
        {
          "/echo/:name": {
            POST: async (request: RouteRequest, given) => {
              peers.push(given.requestIP(request));
              return Response.json({
                name: request.params.name,
                body: await request.text(),
                isRequest: request instanceof Request,
              });
            },
          },
        },
        () => new Response("fallback", { status: 404 }),
      ),
      onError: () => new Response("error", { status: 500 }),
    });
    expect(listener.hostname).toBe("127.0.0.1");
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.url).toBe(`http://127.0.0.1:${listener.port}/`);
    const response = await fetch(`http://127.0.0.1:${listener.port}/echo/%E4%B8%AD`, {
      method: "POST",
      body: "x".repeat(100_000),
    });
    expect(await response.json()).toEqual({
      name: "中",
      body: "x".repeat(100_000),
      isRequest: true,
    });
    expect(peers).toEqual([{ address: "127.0.0.1", port: expect.any(Number) }]);
    expect((peers[0] as { port: number }).port).not.toBe(listener.port);
    const missing = await fetch(`http://127.0.0.1:${listener.port}/elsewhere`);
    expect({ status: missing.status, body: await missing.text() }).toEqual({
      status: 404,
      body: "fallback",
    });
  });

  test("a HEAD runs GET's route and gets its headers without the body", async () => {
    listener = await listen({
      hostname: "127.0.0.1",
      port: 0,
      handle: routeRequest(
        {
          "/page": {
            GET: async (request) =>
              new Response(`seen ${request.method}`, { headers: { "x-route": "page" } }),
          },
        },
        () => new Response(null, { status: 404 }),
      ),
      onError: () => new Response(null, { status: 500 }),
    });
    const response = await fetch(`http://127.0.0.1:${listener.port}/page`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-route")).toBe("page");
    expect(await response.text()).toBe("");
  });

  test("a throw anywhere is answered by onError", async () => {
    const errors: unknown[] = [];
    listener = await listen({
      hostname: "127.0.0.1",
      port: 0,
      handle: async () => {
        throw new Error("boom");
      },
      onError: (error) => {
        errors.push(error);
        return new Response("handled", { status: 500 });
      },
    });
    const response = await fetch(`http://127.0.0.1:${listener.port}/`);
    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 500,
      body: "handled",
    });
    expect(errors).toEqual([new Error("boom")]);
  });

  test("a taken port refuses a second listener", async () => {
    listener = await listen({
      hostname: "127.0.0.1",
      port: 0,
      handle: async () => new Response("first"),
      onError: () => new Response(null, { status: 500 }),
    });
    await expect(
      listen({
        hostname: "127.0.0.1",
        port: listener.port,
        handle: async () => new Response("second"),
        onError: () => new Response(null, { status: 500 }),
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await (await fetch(`http://127.0.0.1:${listener.port}/`)).text()).toBe("first");
  });

  test("stop() closes the connections still open, and the port with them", async () => {
    let started = (): void => {};
    const streaming = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopping = await listen({
      hostname: "127.0.0.1",
      port: 0,
      handle: async () => {
        started();
        // A response that never ends: only stop() ends its connection.
        return new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1])) }));
      },
      onError: () => new Response(null, { status: 500 }),
    });
    const socket = connect(stopping.port, "127.0.0.1");
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.on("error", () => {});
    socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${stopping.port}\r\n\r\n`);
    await streaming;
    await stopping.stop();
    await closed;
    await expect(fetch(`http://127.0.0.1:${stopping.port}/`)).rejects.toThrow();
  });
});

test("serveRoutes stands up routes and a fallback, a bare 404 without one", async () => {
  const served = await serveRoutes({ "/a/:x": { GET: named("a") } });
  try {
    expect(await (await fetch(`${served.url}/a/1`)).json()).toEqual({
      name: "a",
      method: "GET",
      params: { x: "1" },
    });
    const missing = await fetch(`${served.url}/b`);
    expect({ status: missing.status, body: await missing.text() }).toEqual({
      status: 404,
      body: "",
    });
  } finally {
    await served.stop();
  }
});
