// BOOT_READ is complete over every setting and key and keeps no persona's setting for calls, and
// the tracker arms each reader only once it can have read; POST restart asks the supervisor for a
// new server.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIALS,
  dataHome,
  installSettings,
  resetSettings,
  SETTINGS,
  withPersona,
} from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import { makeReranker, resetRerankerCache } from "@eidolon/retrieval";
import { buildMemoryConfig } from "../../../../packages/memory/src/config.ts";
import { type MemoryEngine, SharedEngine } from "../../../../packages/memory/src/engine.ts";
import { BOOT_READ, LIVE_READ, RestartTracker } from "../../src/local/restart.ts";
import type { LocalApp } from "../../src/local/router.ts";
import { statusRoutes } from "../../src/local/routes/status.ts";

const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function write(rel: string, text: string): void {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  resetSettings();
  resetRerankerCache();
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("BOOT_READ", () => {
  test("with LIVE_READ, names every setting and key exactly once", () => {
    // `@<role>` names the account a reader keeps for a role, which is no variable.
    const listed = [...Object.keys(BOOT_READ), ...LIVE_READ].filter(
      (name) => !name.startsWith("@"),
    );
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.toSorted()).toEqual(
      [...SETTINGS.map((setting) => setting.env), ...CREDENTIALS].toSorted(),
    );
    for (const readers of Object.values(BOOT_READ)) expect(readers.length).toBeGreaterThan(0);
  });

  test("keeps no persona's setting for calls, which may run as any persona", () => {
    // Only the MCP server serves the persona installed at boot.
    const kept = SETTINGS.filter((setting) => setting.scope === "persona")
      .map((setting) => setting.env)
      .filter((name) => (BOOT_READ[name] ?? []).some((reader) => reader !== "mcp"));
    expect(kept).toEqual([]);
  });

  test("two personas get their own Mem0 engine and reranker, as LIVE_READ says", async () => {
    write(
      "personas/alice/persona.yaml",
      "memory:\n  model: alice/memory\nknowledge:\n  rerank:\n    model: alice/rerank\n",
    );
    write(
      "personas/bob/persona.yaml",
      "memory:\n  model: bob/memory\nknowledge:\n  rerank:\n    model: bob/rerank\n",
    );
    setEnv("MEM0_QDRANT_HOST", "127.0.0.1");
    setEnv("OPENROUTER_API_KEY", "or");
    installSettings();
    const engines = new SharedEngine(
      async (config) => ({ model: config.llm.model }) as unknown as MemoryEngine,
    );
    const open = (id: string) =>
      withPersona(id, async () => {
        const { engine } = await engines.get(buildMemoryConfig());
        await Bun.sleep(1);
        return { engine, reranker: makeReranker() };
      });
    const [alice, bob, again] = await Promise.all([open("alice"), open("bob"), open("alice")]);
    expect([alice.engine, bob.engine]).toEqual([
      { model: "alice/memory" },
      { model: "bob/memory" },
    ] as unknown as MemoryEngine[]);
    expect([alice.reranker?.modelName, bob.reranker?.modelName]).toEqual([
      "alice/rerank",
      "bob/rerank",
    ]);
    expect(again.engine).toBe(alice.engine);
    expect(again.reranker).toBe(alice.reranker);
  });
});

describe("RestartTracker", () => {
  /** A tracker over a plain map, as the installed settings would read it. */
  function tracked(values: Record<string, string>) {
    const read = (name: string) => values[name] || undefined;
    return { values, tracker: new RestartTracker(read) };
  }

  test("a value read at boot needs a restart once it changes, even once it is set back", () => {
    const { values, tracker } = tracked({ WEBRTC_STUN_URL: "stun:a" });
    expect(tracker.changes()).toEqual({ calls: [], mcp: [] });
    values.WEBRTC_STUN_URL = "stun:b";
    expect(tracker.changes()).toEqual({ calls: ["WEBRTC_STUN_URL"], mcp: [] });
    values.WEBRTC_STUN_URL = "stun:a";
    expect(tracker.changes()).toEqual({ calls: ["WEBRTC_STUN_URL"], mcp: [] });
  });

  test("a key changed and set back between two polls still needs one", () => {
    const { values, tracker } = tracked({});
    values.OPENROUTER_API_KEY = "sk-first";
    tracker.noteInstalled();
    // Saved, then a call builds retrieval's client with it, then the old key is saved back.
    values.OPENROUTER_API_KEY = "sk-second";
    tracker.noteInstalled();
    values.OPENROUTER_API_KEY = "sk-first";
    tracker.noteInstalled();
    expect(tracker.changes()).toEqual({ calls: ["OPENROUTER_API_KEY"], mcp: [] });
  });

  test("the wizard's first keys need no restart; a rotated embedding key does", () => {
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
    expect(tracker.changes().calls).toEqual(["OPENROUTER_API_KEY"]);
  });

  test("an account in credentials.json is kept as its variables are", () => {
    const save = (apiKey: string) => {
      const path = join(dataHome(), "credentials.json");
      mkdirSync(dataHome(), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ accounts: { openrouter: { provider: "openrouter", apiKey } } }),
      );
      resetSettings();
      installSettings();
    };
    save("sk-first");
    const tracker = new RestartTracker();
    expect(tracker.changes()).toEqual({ calls: [], mcp: [] });
    save("sk-rotated");
    tracker.noteInstalled();
    // Embeddings run on OpenRouter's account; memory and the reranker build theirs anew.
    expect(tracker.changes().calls).toEqual(["@embeddings"]);
  });

  test("what memory and the reranker are built from needs no restart", () => {
    const { values, tracker } = tracked({ OPENROUTER_API_KEY: "k", MEM0_QDRANT_HOST: "a" });
    for (const name of [
      "MEM0_QDRANT_HOST",
      "MEM0_QDRANT_COLLECTION",
      "MEM0_LLM_MODEL",
      "EMBED_MODEL",
      "EMBED_DIM",
      "RERANK_MODEL",
      "RERANK_API_KEY",
      "COHERE_API_KEY",
    ]) {
      values[name] = "changed";
    }
    tracker.noteInstalled();
    expect(tracker.changes()).toEqual({ calls: [], mcp: [] });
  });

  test("a persona switch leaves only the MCP server behind, until a restart", () => {
    const { values, tracker } = tracked({ EIDOLON_PERSONA: "milky-green" });
    values.EIDOLON_PERSONA = "beta";
    expect(tracker.changes()).toEqual({ calls: [], mcp: ["EIDOLON_PERSONA"] });
    values.EIDOLON_PERSONA = "milky-green";
    tracker.noteInstalled();
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
