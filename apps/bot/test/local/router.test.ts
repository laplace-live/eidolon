// The local router's 500: what a handler threw goes to the log under a short id, and the answer
// carries only its code, a fixed message and that id, never the exception's text or stack.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ErrorBody } from "../../src/local/api.ts";
import { createLocalRouter } from "../../src/local/router.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";

let logs: CapturedLogs;
let server: ReturnType<typeof Bun.serve>;
const thrown = new Error("could not open /Users/someone/.laplace/eidolon/credentials.json");

beforeAll(() => {
  logs = captureLogs();
  const router = createLocalRouter(
    [
      {
        route: "GET /api/local/status",
        handler: () => {
          throw thrown;
        },
      },
    ],
    () => "bearer",
  );
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/api/local/*": router },
    fetch: () => new Response(null, { status: 404 }),
  });
});

afterAll(async () => {
  await server.stop(true);
  logs.restore();
});

test("a handler that throws is a 500 with a fixed message, and an id that names its log line", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/local/status`);
  const text = await response.text();
  const { error } = JSON.parse(text) as ErrorBody;
  expect(response.status).toBe(500);
  expect(error).toEqual({
    code: "internal",
    message: "Eidolon hit an error; the terminal has the details",
    id: expect.stringMatching(/^[0-9a-f]{8}$/),
  });
  for (const leak of [thrown.message, "credentials.json", "router.test.ts", "    at "]) {
    expect([leak, text.includes(leak)]).toEqual([leak, false]);
  }
  const logged = logs.records.filter((record) => record.message.includes(`error ${error.id}`));
  expect(logged.map((record) => [record.level, record.message, record.error])).toEqual([
    ["ERROR", `GET /api/local/status failed (error ${error.id})`, thrown],
  ]);

  const again = (await (await fetch(response.url)).json()) as ErrorBody;
  expect(again.error.id).not.toBe(error.id);
});
