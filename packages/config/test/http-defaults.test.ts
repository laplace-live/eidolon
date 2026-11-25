import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { installHttpDefaults, patientDispatcher } from "../src/index.ts";
import { serveFetch } from "./http.ts";

const PROXY_VARIABLES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"];
const saved = new Map<string, string | undefined>();

function setProxyEnv(values: Record<string, string>): void {
  for (const name of [...PROXY_VARIABLES, "no_proxy", "NO_PROXY"]) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    delete process.env[name];
  }
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

/** A forward proxy that answers every request itself, noting the target it was asked for. */
async function fakeProxy(): Promise<{ url: string; targets: string[]; server: Server }> {
  const targets: string[] = [];
  const server = createServer((request, response) => {
    targets.push(request.url ?? "");
    response.end("via proxy");
  });
  // A tunnel: the proxy plays the far end too, and answers the request sent through it.
  server.on("connect", (request, socket) => {
    targets.push(`CONNECT ${request.url}`);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 9\r\nconnection: close\r\n\r\nvia proxy");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, targets, server };
}

describe("installHttpDefaults", () => {
  test("fetch then goes through HTTP_PROXY", async () => {
    const proxy = await fakeProxy();
    try {
      setProxyEnv({ HTTP_PROXY: proxy.url });
      installHttpDefaults();
      const response = await fetch("http://eidolon.invalid/hello");
      expect(await response.text()).toBe("via proxy");
      expect(proxy.targets).toHaveLength(1);
      expect(proxy.targets[0]).toMatch(/eidolon\.invalid(:80)?/);
    } finally {
      setProxyEnv({});
      installHttpDefaults();
      proxy.server.close();
    }
  });

  test("with no proxy set, fetch reaches the server itself", async () => {
    setProxyEnv({});
    installHttpDefaults();
    const served = await serveFetch((request) => new Response(new URL(request.url).pathname));
    try {
      expect(await (await fetch(`${served.url}/direct`)).text()).toBe("/direct");
    } finally {
      await served.stop();
    }
  });
});

test("patientDispatcher carries one request as fetch's dispatcher", async () => {
  setProxyEnv({});
  const served = await serveFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response("late");
  });
  try {
    const init: RequestInit & { dispatcher: unknown } = { dispatcher: patientDispatcher(1_000) };
    expect(await (await fetch(served.url, init)).text()).toBe("late");
  } finally {
    await served.stop();
  }
});
