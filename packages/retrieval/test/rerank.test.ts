import "../../config/test/isolated-guard.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, installSettings, resetSettings, withPersona } from "@eidolon/config";
import { setUsageSink, type UsageRecord } from "@eidolon/providers";
import { afterEach, describe, expect, test } from "vitest";
import { makeReranker } from "../src/index.ts";
import { captureLogs, isolateEnv, messages } from "./helpers.ts";

const records = captureLogs();
const env = isolateEnv();

const DEFAULT_MODEL = "cohere/rerank-4-fast";
const ok = (results: unknown) => Response.json({ results, meta: { billed_units: 1 } });

const ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "RERANK_API_KEY",
  "RERANK_BASE_URL",
  "RERANK_ENABLED",
  "RERANK_MODEL",
] as const;
const envBefore = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of envBefore) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("makeReranker", () => {
  test.each(["false", "0", "no", "off", " OFF "])("RERANK_ENABLED=%p switches it off", (value) => {
    process.env.RERANK_ENABLED = value;
    process.env.OPENROUTER_API_KEY = "k";
    expect(makeReranker()).toBeNull();
    expect(messages(records, "INFO")).toEqual([
      "RERANK_ENABLED is off — hybrid retrieval will use RRF fusion",
    ]);
  });

  test.each(["true", "", "maybe"])("RERANK_ENABLED=%p leaves it on", (value) => {
    process.env.RERANK_ENABLED = value;
    process.env.OPENROUTER_API_KEY = "k";
    expect(makeReranker()?.provider).toBe("openrouter");
  });

  test("no key means RRF", () => {
    expect(makeReranker()).toBeNull();
    expect(messages(records, "INFO")[0]).toStartWith("OPENROUTER_API_KEY is not set");
  });

  test("RERANK_API_KEY wins, and blank model and base URL take the defaults", async () => {
    process.env.RERANK_API_KEY = "rerank-key";
    process.env.OPENROUTER_API_KEY = "router-key";
    process.env.RERANK_MODEL = "";
    process.env.RERANK_BASE_URL = "";
    const reranker = makeReranker();
    expect(reranker?.model).toBe(DEFAULT_MODEL);
    expect(messages(records, "INFO")).toEqual([
      "Reranker enabled: model='cohere/rerank-4-fast' via https://openrouter.ai/api/v1",
    ]);
    const network = env
      .network()
      .mockImplementation((async () => ok([])) as unknown as typeof fetch);
    await reranker?.rerank("q", ["a"]);
    const [url, init] = network.mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(
      "Bearer rerank-key",
    );
  });

  test("spend at Cohere's own API goes into the ledger as Cohere's", async () => {
    process.env.RERANK_API_KEY = "co";
    process.env.RERANK_BASE_URL = "https://api.cohere.com/v2";
    process.env.RERANK_MODEL = "rerank-v4.0-fast";
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    try {
      env.network().mockImplementation((async () => ok([])) as unknown as typeof fetch);
      await makeReranker()?.rerank("q", ["a"]);
    } finally {
      setUsageSink(null);
    }
    expect(records.map(({ provider, model }) => [provider, model])).toEqual([
      ["cohere", "rerank-v4.0-fast"],
    ]);
  });

  test("a Cohere account reranks with Cohere's model on its own API", () => {
    process.env.RERANK_PROVIDER = "cohere";
    process.env.COHERE_API_KEY = "co";
    const reranker = makeReranker();
    expect([reranker?.provider, reranker?.model]).toEqual(["cohere", "rerank-v4.0-fast"]);
    expect(messages(records, "INFO")).toEqual([
      "Reranker enabled: model='rerank-v4.0-fast' via https://api.cohere.com/v2",
    ]);
  });

  test("each settings state builds and logs its reranker once", () => {
    process.env.OPENROUTER_API_KEY = "k";
    const a = makeReranker("model-a");
    const b = makeReranker("model-b");
    expect([a?.model, b?.model]).toEqual(["model-a", "model-b"]);
    process.env.RERANK_ENABLED = "off";
    expect(makeReranker("model-a")).toBeNull();
    expect(makeReranker("model-a")).toBeNull();
    delete process.env.RERANK_ENABLED;
    expect(makeReranker("model-a")).toBe(a);
    expect(makeReranker("model-b")).toBe(b);
    expect(messages(records, "INFO")).toEqual([
      "Reranker enabled: model='model-a' via https://openrouter.ai/api/v1",
      "Reranker enabled: model='model-b' via https://openrouter.ai/api/v1",
      "RERANK_ENABLED is off — hybrid retrieval will use RRF fusion",
    ]);
  });

  test("a new key or model builds a new reranker", () => {
    process.env.OPENROUTER_API_KEY = "k1";
    const first = makeReranker();
    process.env.OPENROUTER_API_KEY = "k2";
    const rekeyed = makeReranker();
    process.env.RERANK_MODEL = "cohere/rerank-v4.0-pro";
    const remodelled = makeReranker();
    expect(new Set([first, rekeyed, remodelled]).size).toBe(3);
    expect(remodelled?.model).toBe("cohere/rerank-v4.0-pro");
  });
});

describe("makeReranker per persona", () => {
  afterEach(() => {
    resetSettings();
    rmSync(dataHome(), { recursive: true, force: true });
  });

  function write(rel: string, text: string): void {
    const path = join(dataHome(), rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }

  function personas(): void {
    write(
      "personas/alice/persona.yaml",
      "identity:\n  name: Alice\nknowledge:\n  rerank:\n    model: alice/rerank\n",
    );
    write(
      "personas/bob/persona.yaml",
      "identity:\n  name: Bob\nknowledge:\n  rerank:\n    enabled: false\n",
    );
    process.env.OPENROUTER_API_KEY = "k";
    installSettings();
  }

  test("each persona gets her own reranker, or none", () => {
    personas();
    const alice = withPersona("alice", () => makeReranker());
    expect(alice?.model).toBe("alice/rerank");
    expect(withPersona("bob", () => makeReranker())).toBeNull();
    const installed = makeReranker();
    expect(installed?.model).toBe(DEFAULT_MODEL);
    expect(withPersona("alice", () => makeReranker())).toBe(alice);
    expect(makeReranker()).toBe(installed);
  });
});
