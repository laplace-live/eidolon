// startBotServer without the local extension, as main.ts and the Docker image run it, answers every
// path the local app adds exactly as it did before the app existed.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANONYMOUS } from "@eidolon/access";
import { dataHome } from "@eidolon/config";
import type { BotDeps, BotServer } from "../../src/server.ts";
import { startBotServer } from "../../src/server.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { fakeModules } from "./harness.ts";

const ORIGIN = "https://laplace.live";

let bot: BotServer | null = null;
let logs: CapturedLogs;
let fakes: ReturnType<typeof fakeModules>;

beforeEach(async () => {
  logs = captureLogs();
  fakes = fakeModules();
  const deps: BotDeps = fakes.modules;
  bot = await startBotServer({ host: "127.0.0.1", port: 0, verbose: 0 }, deps);
});

afterEach(async () => {
  await bot?.stop();
  bot = null;
  logs.restore();
  delete process.env.EIDOLON_LOCAL_VIEWER_NAME;
  rmSync(dataHome(), { recursive: true, force: true });
});

function url(path: string): string {
  return `http://127.0.0.1:${bot?.server.port}${path}`;
}

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(url(path), { redirect: "manual", ...init });
  return { response, body: await response.text() };
}

describe("the production surface", () => {
  test("/ is the demo path's empty 404, with the CORS echo", async () => {
    const { response, body } = await call("/", { headers: { Origin: ORIGIN } });
    expect(response.status).toBe(404);
    expect(body).toBe("");
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  test("the app's paths are FastAPI's JSON 404, with the CORS echo", async () => {
    for (const path of ["/index.html", "/setup", "/assets/x.js", "/api/local/status"]) {
      const { response, body } = await call(path, { headers: { Origin: ORIGIN } });
      expect([path, response.status, body]).toEqual([path, 404, '{"detail":"Not Found"}']);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    }
  });

  test("a preflight to /api/local/session is today's allow-all 200", async () => {
    const { response, body } = await call("/api/local/session", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(response.status).toBe(200);
    expect(body).toBe("OK");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  test("POST /api/offer without a cookie still goes through the anonymous guard", async () => {
    const offer = '{"sdp":"v=0\\r\\n","type":"offer"}';
    const { response } = await call("/api/offer", {
      method: "POST",
      body: offer,
      headers: { "Content-Type": "application/json", Cookie: "eidolon_session_7860=x" },
    });
    expect(response.status).toBe(200);
    expect(fakes.admitted).toEqual([offer]);
    expect(
      fakes.offers.map(({ admission }) => [admission.user, admission.quota?.remaining]),
    ).toEqual([[ANONYMOUS, 4]]);
  });

  test("an offer naming a chat and a persona is still an unbound call to the active persona", async () => {
    const offer = JSON.stringify({
      sdp: "v=0\r\n",
      type: "offer",
      requestData: { chatId: "0190f2a4-1c3b-7d4e-8f5a-6b7c8d9e0f1a", persona: "someone-else" },
    });
    const { response } = await call("/api/offer", {
      method: "POST",
      body: offer,
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(fakes.offers.map(({ binding }) => binding)).toEqual([undefined]);
    expect(existsSync(join(dataHome(), "chats"))).toBe(false);
  });

  test("a local name and a local token change nothing: offers stay anonymous, memories 401", async () => {
    process.env.EIDOLON_LOCAL_VIEWER_NAME = "小明";
    mkdirSync(dataHome(), { recursive: true });
    writeFileSync(join(dataHome(), "local-token"), `${"a".repeat(43)}\n`, { mode: 0o600 });
    const bearer = { Authorization: `Bearer ${"a".repeat(43)}` };
    await call("/api/offer", {
      method: "POST",
      body: '{"sdp":"v","type":"offer"}',
      headers: bearer,
    });
    expect(fakes.offers.map(({ admission }) => admission.user)).toEqual([ANONYMOUS]);
    const memories = await call("/api/memories", { headers: bearer });
    expect([memories.response.status, memories.body]).toEqual([
      401,
      '{"error":"需要登录后才能查看记忆"}',
    ]);
  });

  test("HEAD on a GET route is still the bot's 405", async () => {
    const { response } = await call("/api/ice-servers", { method: "HEAD" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  test("boots at DEBUG and logs no local line", () => {
    expect(fakes.levels).toEqual(["DEBUG"]);
    expect(logs.lines().some((line) => line.includes("local"))).toBe(false);
  });
});
