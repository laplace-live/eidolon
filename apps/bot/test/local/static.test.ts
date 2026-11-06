// The built app is served from a map made at boot: no request path reaches the filesystem, so no
// spelling of `..` and no symlink leads out of the build. The fixture build is the test's own.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dataHome } from "@eidolon/config";
import { loadStaticSite, MissingDist, STATIC_HEADERS, WEB_DIST } from "../../src/local/static.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import {
  APP_JS,
  type Booted,
  bootFixture,
  cleanUpBoot,
  fixtureDist,
  INDEX_HTML,
  raw,
} from "./harness.ts";

const SENTINEL = "SENTINEL-credentials-never-served";

let booted: Booted;
let logs: CapturedLogs;
let outside: string;
let dist: string;

beforeAll(async () => {
  logs = captureLogs();
  outside = mkdtempSync(join(tmpdir(), "eidolon-outside-"));
  writeFileSync(join(outside, "secret.txt"), SENTINEL);
  dist = fixtureDist({ outside: join(outside, "secret.txt") });
  booted = await bootFixture({ dist });
  // What a traversal would be after: the data home's credentials, beside the build's parent.
  mkdirSync(dataHome(), { recursive: true });
  writeFileSync(join(dataHome(), "credentials.json"), `{"FISH_API_KEY": "${SENTINEL}"}`);
});

afterAll(async () => {
  await booted.stop();
  logs.restore();
  rmSync(dist, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  cleanUpBoot();
});

function get(path: string) {
  return raw(booted.port, `GET ${path} HTTP/1.1\nHost: 127.0.0.1:${booted.port}`);
}

describe("traversal", () => {
  test("no spelling of .. serves anything but the app's own index", async () => {
    const home = dataHome().replace(/^\//, "");
    const attempts = [
      "/..%2f..%2f..%2f..%2f..%2f.laplace%2feidolon%2fcredentials.json",
      `/..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f${home.replaceAll("/", "%2f")}%2fcredentials.json`,
      "/assets/..%2f..%2fpackage.json",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/%2e%2e%2findex.html",
      "/../",
      "/../../../../../../etc/passwd",
      "/assets/..%5c..%5cpackage.json",
      "/assets/%2e%2e%5cindex.html",
      "/%00",
      "/assets/leak.txt",
      "/outside/secret.txt",
    ];
    for (const path of attempts) {
      const response = await get(path);
      expect([path, response.status, response.body]).toEqual([path, 200, INDEX_HTML]);
      expect(response.body.includes(SENTINEL)).toBe(false);
    }
  });

  test("a symlink out of the build is not in the map at all", () => {
    const site = loadStaticSite(dist);
    expect(site.paths.toSorted()).toEqual([
      "/assets/app-3f1c0d4e.js",
      "/index.html",
      "/robots.txt",
    ]);
  });
});

describe("files", () => {
  test("an exact path is its file; any other is index.html", async () => {
    const asset = await get("/assets/app-3f1c0d4e.js");
    expect([asset.status, asset.body]).toEqual([200, APP_JS]);
    expect(asset.headers.get("content-type")).toBe("text/javascript;charset=utf-8");
    for (const path of ["/", "/setup", "/personas/milky-green/prompt", "/assets/missing.js"]) {
      const response = await get(path);
      expect([path, response.body]).toEqual([path, INDEX_HTML]);
    }
  });

  test("headers: CSP and the rest everywhere, assets immutable, the page no-cache", async () => {
    for (const path of ["/", "/index.html", "/setup", "/assets/app-3f1c0d4e.js", "/robots.txt"]) {
      const response = await get(path);
      for (const [name, value] of Object.entries(STATIC_HEADERS)) {
        expect([path, name, response.headers.get(name)]).toEqual([path, name, value]);
      }
      const cache = path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      expect([path, response.headers.get("cache-control")]).toEqual([path, cache]);
      expect(response.headers.get("access-control-allow-origin")).toBeUndefined();
    }
    expect(STATIC_HEADERS).toEqual({
      "content-security-policy":
        "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self' " +
        "'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: https:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
        "form-action 'self'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    });
  });

  test("a matching If-None-Match is a 304 with the same headers", async () => {
    const first = await get("/assets/app-3f1c0d4e.js");
    const etag = first.headers.get("etag") as string;
    const again = await raw(
      booted.port,
      `GET /assets/app-3f1c0d4e.js HTTP/1.1\nHost: 127.0.0.1:${booted.port}\nIf-None-Match: ${etag}`,
    );
    expect([again.status, again.body]).toEqual([304, ""]);
    expect(again.headers.get("x-frame-options")).toBe("DENY");
  });

  test("unknown /api and /mcp paths keep the bot's own answers", async () => {
    const api = await get("/api/nope");
    expect([api.status, api.body]).toEqual([404, '{"detail":"Not Found"}']);
    const mcp = await get("/mcp/deeper");
    expect([mcp.status, mcp.body]).toEqual([404, "Not Found"]);
    const offer = await get("/api/offer");
    expect([offer.status, offer.headers.get("allow")]).toEqual([405, "POST"]);
  });

  test("a POST outside the API is the bot's 404, not the page", async () => {
    const response = await raw(
      booted.port,
      `POST /setup HTTP/1.1\nHost: 127.0.0.1:${booted.port}\nContent-Length: 0`,
    );
    expect([response.status, response.body]).toEqual([404, '{"detail":"Not Found"}']);
  });
});

describe("the build", () => {
  test("is found next to the code, not the working directory", () => {
    expect(WEB_DIST).toBe(resolve(import.meta.dir, "../../../web/dist"));
  });

  test("a build without index.html is MissingDist", () => {
    const empty = mkdtempSync(join(tmpdir(), "eidolon-dist-"));
    try {
      expect(() => loadStaticSite(empty)).toThrow(MissingDist);
      expect(() => loadStaticSite(join(empty, "nope"))).toThrow(MissingDist);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
