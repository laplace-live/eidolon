// BOOT_READ is complete over every setting and key, covers the whole Mem0 engine SharedEngine
// keeps, and arms each reader only once it can have read; POST restart asks the supervisor for a
// new server.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIALS, dataHome, installSettings, resetSettings, SETTINGS } from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import { buildMemoryConfig } from "../../../../packages/memory/src/config.ts";
import { BOOT_READ, LIVE_READ, RestartTracker } from "../../src/local/restart.ts";
import type { LocalApp } from "../../src/local/router.ts";
import { statusRoutes } from "../../src/local/routes/status.ts";

const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("BOOT_READ", () => {
  test("with LIVE_READ, names every setting and key exactly once", () => {
    const listed = [...Object.keys(BOOT_READ), ...LIVE_READ];
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.toSorted()).toEqual(
      [...SETTINGS.map((setting) => setting.env), ...CREDENTIALS].toSorted(),
    );
    for (const readers of Object.values(BOOT_READ)) expect(readers.length).toBeGreaterThan(0);
  });

  test("keeps every variable the first Mem0 engine is built from", () => {
    // SharedEngine keeps the first engine it opens, so each of these needs a restart once used.
    const engine = (env: Record<string, string>) => {
      for (const name of [...SETTINGS.map((s) => s.env), ...CREDENTIALS]) setEnv(name, env[name]);
      return JSON.stringify(buildMemoryConfig());
    };
    const memory = Object.entries(BOOT_READ)
      .filter(([, readers]) => readers.includes("memory"))
      .map(([name]) => name);
    // OpenRouter's key, and then OpenAI's settings, which mem0 falls back to without it.
    for (const base of [
      { MEM0_QDRANT_HOST: "127.0.0.1", OPENROUTER_API_KEY: "or" },
      { MEM0_QDRANT_HOST: "127.0.0.1", EMBED_API_KEY: "embed", OPENAI_API_KEY: "oa" },
    ] as Record<string, string>[]) {
      const before = engine(base);
      for (const setting of [...SETTINGS.map((s) => s.env), ...CREDENTIALS]) {
        const value = /PORT|DIM/.test(setting)
          ? "7"
          : setting.endsWith("_PATH")
            ? join(dataHome(), "elsewhere", "history.db")
            : "changed";
        if (engine({ ...base, [setting]: value }) !== before) {
          expect([setting, memory.includes(setting)]).toEqual([setting, true]);
        }
      }
    }
  });
});

describe("RestartTracker", () => {
  /** A tracker over a plain map, as the installed settings would read it. */
  function tracked(values: Record<string, string>) {
    const read = (name: string) => values[name] || undefined;
    return { values, tracker: new RestartTracker(read) };
  }

  test("a value read at boot needs a restart once it changes", () => {
    const { values, tracker } = tracked({ WEBRTC_STUN_URL: "stun:a" });
    expect(tracker.changes()).toEqual({ calls: [], mcp: [] });
    values.WEBRTC_STUN_URL = "stun:b";
    expect(tracker.changes()).toEqual({ calls: ["WEBRTC_STUN_URL"], mcp: [] });
    values.WEBRTC_STUN_URL = "stun:a";
    expect(tracker.changes()).toEqual({ calls: [], mcp: [] });
  });

  test("the wizard's first keys and Qdrant need no restart; later changes do", () => {
    const { values, tracker } = tracked({});
    values.OPENROUTER_API_KEY = "sk-first";
    values.SONIOX_API_KEY = "s";
    tracker.noteInstalled();
    values.MEM0_QDRANT_HOST = "127.0.0.1";
    values.MEM0_QDRANT_PORT = "6333";
    tracker.noteInstalled();
    expect(tracker.changes()).toEqual({ calls: [], mcp: [] });

    values.OPENROUTER_API_KEY = "sk-rotated";
    values.MEM0_QDRANT_PORT = "6334";
    values.FISH_MODEL = "s2-pro";
    tracker.noteInstalled();
    expect(tracker.changes().calls.toSorted()).toEqual(["MEM0_QDRANT_PORT", "OPENROUTER_API_KEY"]);
  });

  test("an embedding model saved while memory is off needs no restart", () => {
    const { values, tracker } = tracked({ OPENROUTER_API_KEY: "k" });
    values.EMBED_MODEL = "other/model";
    tracker.noteInstalled();
    // Retrieval reads the model per query; only the Mem0 engine keeps it, and memory is off.
    expect(tracker.changes()).toEqual({ calls: [], mcp: [] });
  });

  test("a persona switch leaves only the MCP server behind", () => {
    const { values, tracker } = tracked({ EIDOLON_PERSONA: "milky-green" });
    values.EIDOLON_PERSONA = "beta";
    expect(tracker.changes()).toEqual({ calls: [], mcp: ["EIDOLON_PERSONA"] });
  });

  test("the default persona chosen at boot and written back explicitly is no change", () => {
    resetSettings();
    installSettings();
    const tracker = new RestartTracker();
    mkdirSync(dataHome(), { recursive: true });
    writeFileSync(join(dataHome(), "settings.yaml"), "persona: milky-green\n");
    resetSettings();
    installSettings();
    expect(tracker.changes()).toEqual({ calls: [], mcp: [] });
  });
});

describe("POST restart", () => {
  function fakeApp(active: number) {
    const app = {
      restarts: 0,
      port: () => 7860,
      activeCalls: () => active,
      restart: () => {
        app.restarts++;
      },
      onStop: () => {},
      memoryAdmin: (): MemoryAdmin | null => null,
    } satisfies LocalApp & { restarts: number };
    return app;
  }

  function restartRoute(app: LocalApp) {
    const spec = statusRoutes(app).find((s) => s.route === "POST /api/local/restart");
    if (spec === undefined) throw new Error("no restart route");
    return spec;
  }

  const context = {
    url: new URL("http://127.0.0.1:7860/api/local/restart"),
    params: {},
    server: undefined as never,
    caller: "cookie" as const,
  };

  test("asks the supervisor for a new server", async () => {
    const app = fakeApp(0);
    const response = await restartRoute(app).handler(new Request(context.url), context);
    expect([response.status, await response.json(), app.restarts]).toEqual([200, { ok: true }, 1]);
  });

  test("refuses while a call is live, which a restart would end", async () => {
    const app = fakeApp(1);
    const response = await restartRoute(app).handler(new Request(context.url), context);
    expect([response.status, (await response.json()).error.code, app.restarts]).toEqual([
      409,
      "call-active",
      0,
    ]);
  });
});
