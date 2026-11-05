// GET status: its shape on a fresh home, the background probes it reports from their last answer,
// the index read from build records alone, the yt-dlp states, the last failed call and restarts.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dataHome,
  installSettings,
  logger,
  PROJECT_ROOT,
  personaHomeDir,
  resetSettings,
} from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import manifest from "../../package.json" with { type: "json" };
import { reinstallSettings } from "../../src/local/restart.ts";
import type { LocalApp } from "../../src/local/router.ts";
import { statusRoutes } from "../../src/local/routes/status.ts";
import { buildStatus, PROBE_TTL_MS, type StatusDeps } from "../../src/local/status.ts";
import { ensureDataHome } from "../../src/local/write.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";

interface FakeApp extends LocalApp {
  calls: number;
  readonly stops: (() => Promise<void>)[];
}

function fakeApp(): FakeApp {
  const app: FakeApp = {
    calls: 0,
    stops: [],
    port: () => 7860,
    activeCalls: () => app.calls,
    restart: () => {},
    onStop: (hook) => {
      app.stops.push(hook);
    },
    memoryAdmin: (): MemoryAdmin | null => null,
  };
  return app;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A clock tests move, and a fetch that answers by URL prefix and counts what it was asked. */
function fakeDeps(replies: Record<string, () => Response>) {
  const asked: string[] = [];
  const deps: StatusDeps & { clock: number } = {
    clock: Date.now(),
    now: () => deps.clock,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const key = Object.keys(replies)
        .sort((a, b) => b.length - a.length)
        .find((prefix) => url.startsWith(prefix));
      if (key === undefined) throw new TypeError("fetch failed");
      return (replies[key] as () => Response)();
    }) as typeof fetch,
  };
  return { deps, asked };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(2);
  expect(done()).toBe(true);
}

let app: FakeApp;
let logs: CapturedLogs;
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

function write(rel: string, text: string): string {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

beforeEach(() => {
  logs = captureLogs();
  // As the boot does.
  ensureDataHome();
  installSettings();
  app = fakeApp();
});

afterEach(async () => {
  for (const hook of app.stops.splice(0)) await hook();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  logs.restore();
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("GET status", () => {
  test("on a fresh home: no keys, the demo persona, nothing built, memory off", () => {
    const { deps, asked } = fakeDeps({});
    statusRoutes(app, deps);
    const status = buildStatus(app, deps);
    expect(status).toMatchObject({
      version: manifest.version,
      restartRequired: false,
      mcpRestartRequired: false,
      keys: { SONIOX_API_KEY: false, OPENROUTER_API_KEY: false, FISH_API_KEY: false },
      persona: {
        id: "milky-green",
        name: "明前奶绿",
        shortName: "奶绿",
        voice: { id: null, source: "default", ok: null },
      },
      index: {
        tables: [
          { table: "stream_chunks", built: false, rows: null, stale: false },
          { table: "persona_facts", built: false, rows: null, stale: false },
        ],
        catalogBuiltAt: null,
      },
      selfieReferences: 2,
      memory: { configured: false, reachable: null },
      lastSessionError: null,
      activeCalls: 0,
    });
    expect(typeof status.ffmpeg).toBe("boolean");
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(asked).toEqual([]);
  });

  test("reports keys and the voice as the bot reads them, and where the voice comes from", () => {
    setEnv("SONIOX_API_KEY", "s");
    write(
      "personas/milky-green/persona.yaml",
      "voice:\n  voiceId: 0123456789abcdef0123456789abcdef\n",
    );
    reinstallSettings(app);
    const { deps } = fakeDeps({});
    const status = buildStatus(app, deps);
    expect(status.keys).toEqual({
      SONIOX_API_KEY: true,
      OPENROUTER_API_KEY: false,
      FISH_API_KEY: false,
    });
    expect(status.persona.voice).toEqual({
      id: "0123456789abcdef0123456789abcdef",
      source: "persona",
      ok: null,
    });
    setEnv("FISH_VOICE_ID", "fedcba9876543210fedcba9876543210");
    expect(buildStatus(app, deps).persona.voice.source).toBe("env");
  });

  test("probes Qdrant in the background, once per TTL, and reports the last answer", async () => {
    setEnv("MEM0_QDRANT_HOST", "127.0.0.1");
    const { deps, asked } = fakeDeps({
      "http://127.0.0.1:6333/collections": () => json(200, { result: {} }),
      "http://127.0.0.1:6333/": () =>
        json(200, { title: "qdrant - vector search engine", version: "1.19.1" }),
    });
    expect(buildStatus(app, deps).memory).toEqual({ configured: true, reachable: null });
    await until(() => buildStatus(app, deps).memory.reachable === true);
    const probes = asked.length;
    buildStatus(app, deps);
    expect(asked.length).toBe(probes);
    deps.clock += PROBE_TTL_MS;
    buildStatus(app, deps);
    expect(asked.length).toBeGreaterThan(probes);
  });

  test("checks the voice with the key in the background, never during a call", async () => {
    setEnv("FISH_API_KEY", "fk");
    setEnv("FISH_VOICE_ID", "0123456789abcdef0123456789abcdef");
    const { deps, asked } = fakeDeps({
      "https://api.fish.audio/model/0123456789abcdef0123456789abcdef": () => json(404, {}),
    });
    app.calls = 1;
    buildStatus(app, deps);
    await Bun.sleep(5);
    expect(asked).toEqual([]);
    app.calls = 0;
    expect(buildStatus(app, deps).persona.voice.ok).toBeNull();
    await until(() => buildStatus(app, deps).persona.voice.ok === false);
    expect(asked).toEqual(["https://api.fish.audio/model/0123456789abcdef0123456789abcdef"]);
  });

  test("reads the index from its build records and the catalog's head, opening no table", () => {
    const index = join(personaHomeDir("milky-green"), "index");
    mkdirSync(join(index, "stream_chunks.lance"), { recursive: true });
    mkdirSync(join(index, "persona_facts.lance"), { recursive: true });
    write(
      "personas/milky-green/index/stream_chunks.meta.json",
      JSON.stringify({
        embedModel: "google/gemini-embedding-2-preview",
        embedDim: 3072,
        rows: 1234,
        builtAt: "2026-11-01T00:00:00.000Z",
        sources: [],
      }),
    );
    write(
      "personas/milky-green/index/stream_catalog.json",
      `{"schema_version": 1, "built_at": "2026-11-02T03:04:05.000006+00:00", "broadcasts": []}`,
    );
    const { deps } = fakeDeps({});
    const { index: status } = buildStatus(app, deps);
    expect(status.catalogBuiltAt).toBe("2026-11-02T03:04:05.000006+00:00");
    expect(status.tables).toEqual([
      {
        table: "stream_chunks",
        built: true,
        rows: 1234,
        builtAt: "2026-11-01T00:00:00.000Z",
        model: "google/gemini-embedding-2-preview",
        dim: 3072,
        stale: false,
      },
      // Built by the Python tools: no record to judge it by.
      {
        table: "persona_facts",
        built: true,
        rows: null,
        builtAt: null,
        model: null,
        dim: null,
        stale: false,
      },
    ]);
    setEnv("EMBED_DIM", "1024");
    expect(buildStatus(app, deps).index.tables[0]?.stale).toBe(true);
  });

  test("counts the selfie references the bot picks among", () => {
    const { deps } = fakeDeps({});
    expect(buildStatus(app, deps).selfieReferences).toBe(2);
    write("personas/milky-green/references/outfits/summer.png", "png");
    expect(buildStatus(app, deps).selfieReferences).toBe(3);
    setEnv("SELFIE_REFERENCE_IMAGES", "a.png, b.png, c.png, d.png");
    expect(buildStatus(app, deps).selfieReferences).toBe(4);
  });
});

describe("yt-dlp", () => {
  test("installs on first download, then shows the managed copy's tag", () => {
    const { deps } = fakeDeps({});
    expect(buildStatus(app, deps).ytDlp).toEqual({ state: "installs-on-first-download" });
    write("bin/yt-dlp", "#!/bin/sh\n");
    write("bin/yt-dlp.stamp.json", JSON.stringify({ tag: "2026.10.30", asset: "yt-dlp_macos" }));
    const fresh = fakeApp();
    expect(buildStatus(fresh, deps).ytDlp).toEqual({ state: "installed", tag: "2026.10.30" });
  });

  test("a configured yt-dlp that isn't there is unavailable; one that is, its version", async () => {
    setEnv("YT_DLP_PATH", join(dataHome(), "nowhere", "yt-dlp"));
    const { deps } = fakeDeps({});
    const missing = buildStatus(app, deps).ytDlp;
    expect(missing.state).toBe("unavailable");

    const script = write("tools/yt-dlp", "#!/bin/sh\necho 2026.11.01\n");
    chmodSync(script, 0o755);
    setEnv("YT_DLP_PATH", script);
    const own = fakeApp();
    expect(buildStatus(own, deps).ytDlp).toEqual({ state: "installed", tag: "" });
    deps.clock += 60_000;
    await until(() => {
      deps.clock += 60_000;
      const ytDlp = buildStatus(own, deps).ytDlp;
      return ytDlp.state === "installed" && ytDlp.tag === "2026.11.01";
    });
  });
});

describe("the last failed call", () => {
  test("comes from the runtime's own log line, until the server stops", async () => {
    const { deps } = fakeDeps({});
    statusRoutes(app, deps);
    logger.error("Bot session failed: Soniox connect failed: 401");
    logger.error("Something else failed");
    const failed = buildStatus(app, deps).lastSessionError;
    expect(failed?.message).toBe("Soniox connect failed: 401");
    expect(Number.isNaN(Date.parse(failed?.at ?? ""))).toBe(false);
  });

  test("the runtime still logs a failed session with that prefix", () => {
    const source = readFileSync(
      join(PROJECT_ROOT, "packages/runtime/src/session/session.ts"),
      "utf8",
    );
    expect(source).toContain("logger.error(`Bot session failed: ${");
  });
});

describe("restart flags", () => {
  test("a value read at boot flags calls; a persona switch flags only the MCP server", () => {
    const { deps } = fakeDeps({});
    statusRoutes(app, deps);
    mkdirSync(join(dataHome(), "personas", "beta"), { recursive: true });
    write("settings.yaml", "persona: beta\n");
    reinstallSettings(app);
    expect(buildStatus(app, deps)).toMatchObject({
      restartRequired: false,
      mcpRestartRequired: true,
    });
    setEnv("WEBRTC_STUN_URL", "stun:example.com");
    expect(buildStatus(app, deps).restartRequired).toBe(true);
  });
});
