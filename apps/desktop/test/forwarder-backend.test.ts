// The probe and the forwarder against the real local server, booted in this process over fake
// packages and a fixture web build: its session route signs the probe, and its guard refuses the
// page's Host, Origin and fetch metadata unless the forwarder drops them.
import "../../../packages/config/test/isolated-guard.ts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type CapturedLogs, captureLogs } from "../../bot/test/fakes.ts";
import { type Booted, bootFixture, cleanUpBoot, raw } from "../../bot/test/local/harness.ts";
import { BearerToken, probe } from "../src/main/attach.ts";
import type { BackendState } from "../src/main/controller.ts";
import { createForwarder, type Forwarder } from "../src/main/forwarder.ts";

let booted: Booted;
let forwarder: Forwarder;
let logs: CapturedLogs;

beforeAll(async () => {
  logs = captureLogs();
  booted = await bootFixture();
  const state: BackendState = {
    phase: "ready",
    origin: booted.base,
    token: new BearerToken(booted.token.secret),
    owned: false,
  };
  forwarder = createForwarder({
    backend: {
      state,
      subscribe: () => () => {},
      refused: () => {},
      restarted: () => {},
      disconnected: () => {},
    },
    waitingPage: () => "",
  });
});

afterAll(async () => {
  await forwarder.destroy();
  await booted.stop();
  cleanUpBoot();
  logs.restore();
});

/** What the page's fetch hands protocol.handle: its own Host, Origin, fetch metadata and cookie. */
const PAGE = {
  host: "app",
  origin: "eidolon-app://app",
  "sec-fetch-site": "cross-site",
};

function app(path: string, init: RequestInit = {}): Request {
  const request = new Request(`eidolon-app://app${path}`, init);
  Object.defineProperty(request, "initiatorOrigin", { value: "eidolon-app://app" });
  return request;
}

test("the probe proves the server holding the token, and no other", async () => {
  expect(await probe(booted.base, new BearerToken(booted.token.secret))).toBe(true);
  expect(await probe(booted.base, new BearerToken("x".repeat(43)))).toBe(false);
});

test("the guard refuses what the page sends as it is", async () => {
  const bearer = `Bearer ${booted.token.secret}`;
  const host = await raw(
    booted.port,
    `GET /api/local/status HTTP/1.1\nHost: app\nAuthorization: ${bearer}`,
  );
  const statuses = [host.status];
  const asSent: Record<string, string>[] = [
    { origin: "eidolon-app://app" },
    { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of asSent) {
    const response = await fetch(`${booted.base}/api/local/status`, {
      headers: { ...headers, authorization: bearer },
    });
    statuses.push(response.status);
  }
  expect(statuses).toEqual([421, 403, 403]);
});

test("forwarded, a GET and a POST pass it on the Bearer alone", async () => {
  const status = await forwarder.handle(
    app("/api/local/status", {
      headers: { ...PAGE, cookie: booted.cookie, accept: "application/json" },
    }),
  );
  expect(status.status).toBe(200);
  expect(await status.json()).toHaveProperty("activeCalls", 0);
  const post = await forwarder.handle(
    app("/api/local/session", {
      method: "POST",
      headers: { ...PAGE, "content-type": "text/plain" },
      body: JSON.stringify({ code: "1793000000.not-a-code" }),
    }),
  );
  expect([post.status, ((await post.json()) as { error: { code: string } }).error.code]).toEqual([
    401,
    "unauthorized",
  ]);
});

test("the session cookie a link code earns never reaches the page", async () => {
  const code = booted.token.linkCode(booted.io.now);
  const direct = await fetch(`${booted.base}/api/local/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(direct.headers.get("set-cookie")).toContain("eidolon_session_");
  const forwarded = await forwarder.handle(
    app("/api/local/session", {
      method: "POST",
      headers: { ...PAGE, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );
  expect(forwarded.status).toBe(200);
  expect(forwarded.headers.has("set-cookie")).toBe(false);
});

test("main's own load of the page gets the web build", async () => {
  const response = await forwarder.handle(
    new Request("eidolon-app://app/", { headers: { accept: "text/html" } }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<title>Eidolon</title>");
});
