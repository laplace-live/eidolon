// The MCP endpoint's HTTP-level answers: transport security, method handling, the
// Accept/Content-Type gates, the body limit and envelope errors.
import { describe, expect, test } from "bun:test";
import { acceptsJson, isExactJsonContentType, parseAllowedHosts } from "../../src/mcp/http.ts";
import type { McpHandler } from "../../src/mcp/index.ts";
import { ACCEPT, buildHandler, isolateEnv, resultOf, rpc, withEnv } from "./helpers.ts";

isolateEnv();

const PING = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

function post(
  handler: McpHandler,
  headers: Record<string, string | null>,
  body: BodyInit | null = PING,
): Promise<Response> {
  const merged = new Headers({ "content-type": "application/json", accept: ACCEPT });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return handler.handle(
    new Request("http://localhost/mcp/", { method: "POST", headers: merged, body }),
    "testclient",
  );
}

function send(handler: McpHandler, method: string, headers: Record<string, string> = {}) {
  return handler.handle(
    new Request("http://localhost/mcp/", { method, headers: { accept: ACCEPT, ...headers } }),
    "testclient",
  );
}

const jsonRpcError = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });

describe("allowlist", () => {
  test("parseAllowedHosts trims, drops empties and derives https then http origins", () => {
    expect(parseAllowedHosts(" eidolon.example.com , ,localhost:* ")).toEqual({
      hosts: ["eidolon.example.com", "localhost:*"],
      origins: [
        "https://eidolon.example.com",
        "https://localhost:*",
        "http://eidolon.example.com",
        "http://localhost:*",
      ],
    });
    expect(parseAllowedHosts(undefined)).toBeNull();
    expect(parseAllowedHosts("   ")).toBeNull();
    // Non-blank but empty after the split keeps the check on, rejecting every Host.
    expect(parseAllowedHosts(",")).toEqual({ hosts: [], origins: [] });
  });

  test("Host and Origin follow Python's exact-or-port-wildcard rule", async () => {
    const handler = await withEnv(
      { EIDOLON_MCP_ALLOWED_HOSTS: " eidolon.example.com , ,localhost:* " },
      () => buildHandler(),
    );
    const status = async (headers: Record<string, string | null>) =>
      (await post(handler, headers)).status;
    expect(await status({ host: "eidolon.example.com" })).toBe(200);
    expect(await status({ host: "localhost:7860" })).toBe(200);
    expect(
      await status({ host: "eidolon.example.com", origin: "https://eidolon.example.com" }),
    ).toBe(200);
    expect(await status({ host: "localhost:7860", origin: "http://localhost:3000" })).toBe(200);
    for (const host of [
      "evil.example",
      "eidolon.example.com:443",
      "EIDOLON.example.com",
      "localhost",
    ]) {
      const response = await post(handler, { host });
      expect(response.status).toBe(421);
      expect(await response.text()).toBe("Invalid Host header");
    }
    const missing = await post(handler, {});
    expect(missing.status).toBe(421);
    const badOrigin = await post(handler, {
      host: "eidolon.example.com",
      origin: "https://evil.example",
    });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.text()).toBe("Invalid Origin header");
  });

  test("the Content-Type gate runs before the Host check", async () => {
    const handler = await withEnv({ EIDOLON_MCP_ALLOWED_HOSTS: "eidolon.example.com" }, () =>
      buildHandler(),
    );
    const response = await post(handler, { host: "evil.example", "content-type": "text/plain" });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid Content-Type header");
  });

  test("with the allowlist off, any Host passes", async () => {
    const handler = await buildHandler();
    expect(
      (await post(handler, { host: "evil.example", origin: "https://evil.example" })).status,
    ).toBe(200);
  });
});

describe("content type and accept", () => {
  test("a POST without a JSON Content-Type is 400 plain text", async () => {
    const handler = await buildHandler();
    for (const contentType of [null, "text/plain"]) {
      const response = await post(handler, { "content-type": contentType });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid Content-Type header");
    }
  });

  test("the second gate wants an exact application/json part", async () => {
    const handler = await buildHandler();
    for (const contentType of ["Application/JSON", "application/jsonx", "application/json-rpc"]) {
      const response = await post(handler, { "content-type": contentType });
      expect(response.status).toBe(415);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.text()).toBe(
        jsonRpcError(-32600, "Unsupported Media Type: Content-Type must be application/json"),
      );
    }
    for (const contentType of [
      "application/json; charset=utf-8",
      "application/json;",
      "application/json, text/plain",
      "application/jsonx, application/json",
    ]) {
      expect((await post(handler, { "content-type": contentType })).status).toBe(200);
    }
    expect(isExactJsonContentType(null)).toBe(false);
  });

  test("Accept needs only JSON, wildcards count, q is ignored", async () => {
    const handler = await buildHandler();
    for (const accept of [
      "application/json",
      "application/*",
      "*/*",
      "Application/JSON",
      "text/html, application/json;q=0.1",
    ]) {
      expect((await post(handler, { accept })).status).toBe(200);
    }
    for (const accept of [null, "", "text/html", "text/event-stream"]) {
      const response = await post(handler, { accept });
      expect(response.status).toBe(406);
      expect(await response.text()).toBe(
        jsonRpcError(-32600, "Not Acceptable: Client must accept application/json"),
      );
    }
    expect(acceptsJson(" application/json ; q=1")).toBe(true);
  });
});

describe("methods", () => {
  test("GET is 405, Allow: POST", async () => {
    const handler = await buildHandler();
    const response = await send(handler, "GET");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.text()).toBe(jsonRpcError(-32600, "Method Not Allowed"));
  });

  test("DELETE is 405 without session termination", async () => {
    const handler = await buildHandler();
    const response = await send(handler, "DELETE");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      jsonRpcError(-32600, "Method Not Allowed: Session termination not supported"),
    );
  });

  test("every other method is 405 with Python's Allow", async () => {
    const handler = await buildHandler();
    for (const method of ["PUT", "PATCH", "HEAD", "OPTIONS"]) {
      const response = await send(handler, method);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST, DELETE");
      if (method !== "HEAD") {
        expect(await response.text()).toBe(jsonRpcError(-32600, "Method Not Allowed"));
      }
    }
  });
});

describe("body", () => {
  test("over 4 MiB is 413, declared or streamed", async () => {
    const handler = await buildHandler();
    const declared = await handler.handle(
      new Request("http://localhost/mcp/", {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": String(4 * 1024 * 1024 + 1) },
      }),
      "testclient",
    );
    expect(declared.status).toBe(413);
    expect(await declared.text()).toBe("Request body too large");
    const chunks = [new Uint8Array(3 * 1024 * 1024), new Uint8Array(1024 * 1024 + 1)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const streamed = await post(handler, {}, stream);
    expect(streamed.status).toBe(413);
    expect(await streamed.text()).toBe("Request body too large");
    expect(
      (await post(handler, {}, `${PING}${" ".repeat(4 * 1024 * 1024 - PING.length)}`)).status,
    ).toBe(200);
  });

  test("unparseable bodies are 400 -32700", async () => {
    const handler = await buildHandler();
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(PING)]);
    const badUtf8 = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"ping","x":"?"}');
    badUtf8[badUtf8.length - 3] = 0xff;
    for (const body of ["{not json", "", bom, badUtf8]) {
      const response = await post(handler, {}, body);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(jsonRpcError(-32700, "Parse error: Invalid JSON"));
    }
  });

  test("a JSON body that is not an object, a batch included, gets pydantic's union error", async () => {
    const handler = await buildHandler();
    const union = (shown: string) =>
      [
        "Validation error: 4 validation errors for union[JSONRPCRequest,JSONRPCNotification,JSONRPCResponse,JSONRPCError]",
        ...["JSONRPCRequest", "JSONRPCNotification", "JSONRPCResponse", "JSONRPCError"].map(
          (model) =>
            `${model}\n  Input should be a valid dictionary or instance of ${model} [type=model_type, ${shown}]\n    For further information visit https://errors.pydantic.dev/2.13/v/model_type`,
        ),
      ].join("\n");
    const cases: [string, string][] = [
      [`[${PING}]`, "input_value=[{'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}], input_type=list"],
      [
        `[${PING},{"jsonrpc":"2.0","method":"notifications/initialized"}]`,
        "input_value=[{'jsonrpc': '2.0', 'id':...fications/initialized'}], input_type=list",
      ],
      ["[]", "input_value=[], input_type=list"],
      ['"hello"', "input_value='hello', input_type=str"],
      ["5", "input_value=5, input_type=int"],
      ["null", "input_value=None, input_type=NoneType"],
      ["true", "input_value=True, input_type=bool"],
    ];
    for (const [body, shown] of cases) {
      const response = await post(handler, {}, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32602, message: union(shown) },
      });
    }
  });
});

describe("protocol headers", () => {
  test("a client Mcp-Session-Id is ignored and none is issued", async () => {
    const handler = await buildHandler();
    const response = await rpc(handler, "tools/list", {}, { headers: { "mcp-session-id": "abc" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect((await resultOf(response)).tools).toHaveLength(2);
  });

  test("a handshake version in MCP-Protocol-Version passes; an unknown one is the SDK's 400", async () => {
    const handler = await buildHandler();
    for (const version of ["2025-06-18", "2025-03-26", "2024-11-05", "2025-11-25"]) {
      const response = await rpc(handler, "ping", undefined, {
        headers: { "mcp-protocol-version": version },
      });
      expect(response.status).toBe(200);
    }
    const unknown = await rpc(handler, "ping", undefined, {
      headers: { "mcp-protocol-version": "2026-07-28" },
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.message).toStartWith(
      "Bad Request: Unsupported protocol version: 2026-07-28",
    );
  });
});
