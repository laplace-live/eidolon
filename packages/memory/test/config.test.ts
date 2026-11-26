import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataHome, installSettings, resetSettings } from "@eidolon/config";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildMemoryConfig,
  type EmbedderSettings,
  memorySearchSettingsFromEnv,
  requireLlmKey,
} from "../src/config.ts";
import { isMemoryConfigured } from "../src/index.ts";
import { clearMemoryEnv, resetEnv, setEnv, tempPath } from "./support.ts";

beforeEach(() => {
  clearMemoryEnv();
  const dbPath = tempPath("h.db");
  setEnv({
    MEM0_ENABLED: "true",
    OPENROUTER_API_KEY: "sk-or",
    MEM0_HISTORY_DB_PATH: dbPath,
  });
});
afterEach(resetEnv);

/** The embeddings role's account, model and key, and the dimension sent. */
function embedder({ selection, dims }: EmbedderSettings) {
  const { provider, model, apiKey, baseUrl } = selection;
  return { provider: provider.id, model, apiKey, baseUrl, dims };
}

describe("enablement", () => {
  test("unset or empty is on", () => {
    setEnv({ MEM0_ENABLED: undefined, MEM0_QDRANT_HOST: undefined });
    expect(isMemoryConfigured()).toBe(true);
    setEnv({ MEM0_ENABLED: "" });
    expect(isMemoryConfigured()).toBe(true);
    setEnv({ MEM0_ENABLED: " \t　" });
    expect(isMemoryConfigured()).toBe(true);
  });

  test("MEM0_ENABLED turns memory on and off explicitly, overriding legacy MEM0_QDRANT_HOST", () => {
    setEnv({ MEM0_ENABLED: "1", MEM0_QDRANT_HOST: undefined });
    expect(isMemoryConfigured()).toBe(true);
    setEnv({ MEM0_ENABLED: "false", MEM0_QDRANT_HOST: "qdrant" });
    expect(isMemoryConfigured()).toBe(false);
  });

  test("falls back to legacy MEM0_QDRANT_HOST when MEM0_ENABLED is unset, beating settings.yaml", () => {
    const home = dirname(tempPath("home-legacy"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.yaml"), "memory:\n  enabled: false\n");
    setEnv({ EIDOLON_HOME: home, MEM0_ENABLED: undefined, MEM0_QDRANT_HOST: "\u0085qdrant\n" });
    resetSettings();
    installSettings();
    try {
      expect(isMemoryConfigured()).toBe(true);
      setEnv({ MEM0_QDRANT_HOST: " \t　" });
      expect(isMemoryConfigured()).toBe(false);
    } finally {
      resetSettings();
    }
  });
});

describe("buildMemoryConfig", () => {
  test("defaults vector store beside history.db", () => {
    const home = dirname(tempPath("home"));
    setEnv({ EIDOLON_HOME: home, MEM0_HISTORY_DB_PATH: undefined, MEM0_DIR: undefined });
    const config = buildMemoryConfig();
    expect(config.store).toEqual({
      dir: join(dataHome(), "mem0", "vectors"),
      vectorSize: 3072,
      embedModel: "openrouter:google/gemini-embedding-2-preview",
    });
    expect(embedder(config.embedder)).toEqual({
      provider: "openrouter",
      model: "google/gemini-embedding-2-preview",
      apiKey: "sk-or",
      baseUrl: "https://openrouter.ai/api/v1",
      dims: 3072,
    });
    expect(config.llm).toEqual({
      provider: "openrouter",
      model: "~google/gemini-flash-latest",
      apiKey: "sk-or",
      baseUrl: "https://openrouter.ai/api/v1",
      keyMissing: null,
    });
    expect(config.historyDbPath).toBe(join(dataHome(), "mem0", "history.db"));
  });

  test("follows MEM0_HISTORY_DB_PATH when MEM0_DIR is unset, and honours MEM0_DIR when set", () => {
    const dbPath = join(dirname(tempPath("x")), "mounted", "mem0", "history.db");
    setEnv({ MEM0_HISTORY_DB_PATH: dbPath, MEM0_DIR: undefined });
    expect(buildMemoryConfig().store.dir).toBe(join(dirname(dbPath), "vectors"));
    expect(existsSync(join(dirname(dbPath), "vectors"))).toBe(true);

    const customDir = join(dirname(tempPath("y")), "custom-vectors");
    setEnv({ MEM0_DIR: customDir });
    expect(buildMemoryConfig().store.dir).toBe(customDir);
    expect(existsSync(customDir)).toBe(true);
  });

  test("the LLM model falls back MEM0_LLM_MODEL → OPENROUTER_MODEL → default, empty counting as unset", () => {
    setEnv({ MEM0_LLM_MODEL: "", OPENROUTER_MODEL: "x/persona" });
    expect(buildMemoryConfig().llm.model).toBe("x/persona");
    setEnv({ MEM0_LLM_MODEL: "x/extractor" });
    expect(buildMemoryConfig().llm.model).toBe("x/extractor");
  });

  test("EMBED_API_KEY beats OPENROUTER_API_KEY for embeddings only", () => {
    setEnv({
      EMBED_API_KEY: "sk-embed",
      EMBED_BASE_URL: "https://embed.example/v1",
      EMBED_MODEL: "m",
      EMBED_DIM: "8",
    });
    const config = buildMemoryConfig();
    expect(embedder(config.embedder)).toEqual({
      provider: "openrouter",
      model: "m",
      apiKey: "sk-embed",
      baseUrl: "https://embed.example/v1",
      dims: 8,
    });
    expect(config.store.vectorSize).toBe(8);
    expect(config.store.embedModel).toBe("openrouter:m");
    expect(config.llm.apiKey).toBe("sk-or");
  });

  test("no embedding key names the key to set", () => {
    setEnv({ OPENROUTER_API_KEY: "", EMBED_API_KEY: "" });
    expect(() => buildMemoryConfig()).toThrow(
      "OpenRouter needs an API key: set OPENROUTER_API_KEY in credentials.json or the environment, or EMBED_API_KEY for embeddings alone",
    );
  });

  test("creates the history DB's parent directory", () => {
    const path = join(dirname(tempPath("x")), "nested", "deeper", "history.db");
    setEnv({ MEM0_HISTORY_DB_PATH: path });
    expect(buildMemoryConfig().historyDbPath).toBe(path);
    expect(existsSync(dirname(path))).toBe(true);
  });

  test("refuses to build when memory is disabled", () => {
    setEnv({ MEM0_ENABLED: "false" });
    expect(() => buildMemoryConfig()).toThrow("MEM0_ENABLED is off");
  });
});

describe("extraction LLM routing", () => {
  test("the persona's chat provider, OPENROUTER_API_BASE overriding OpenRouter's base", () => {
    setEnv({ OPENROUTER_API_BASE: "https://proxy.example/v1", OPENAI_API_KEY: "sk-oa" });
    expect(buildMemoryConfig().llm).toMatchObject({
      provider: "openrouter",
      apiKey: "sk-or",
      baseUrl: "https://proxy.example/v1",
    });
  });

  test("a provider of its own, with that provider's key and base", () => {
    setEnv({ MEM0_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-oa" });
    expect(buildMemoryConfig().llm).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
      apiKey: "sk-oa",
      baseUrl: "https://api.openai.com/v1",
    });
    setEnv({ OPENAI_BASE_URL: "https://compat.example/v1" });
    expect(buildMemoryConfig().llm.baseUrl).toBe("https://compat.example/v1");
  });

  test("a provider that takes no key opens the extraction client without one", () => {
    setEnv({ MEM0_LLM_PROVIDER: "ollama", EMBED_API_KEY: "sk-embed" });
    const { llm } = buildMemoryConfig();
    expect(llm.provider).toBe("ollama");
    expect(requireLlmKey(llm)).toBe("");
  });

  test("no key fails where the extraction client would be built, naming the key", () => {
    setEnv({ OPENROUTER_API_KEY: "", EMBED_API_KEY: "sk-embed" });
    const { llm } = buildMemoryConfig();
    expect(llm.apiKey).toBeNull();
    expect(() => requireLlmKey(llm)).toThrow(
      "OpenRouter needs an API key: set OPENROUTER_API_KEY in credentials.json or the environment",
    );
  });
});

describe("search settings", () => {
  test("defaults 10 / 0.3", () => {
    expect(memorySearchSettingsFromEnv()).toEqual({ searchLimit: 10, searchThreshold: 0.3 });
  });

  test.each([
    ["1", "0", 1, 0],
    ["1000000", "1", 1000000, 1],
    ["", "", 10, 0.3],
  ])("accepts limit=%p threshold=%p", (limit, threshold, l, t) => {
    setEnv({ MEM0_SEARCH_LIMIT: limit, MEM0_SEARCH_THRESHOLD: threshold });
    expect(memorySearchSettingsFromEnv()).toEqual({ searchLimit: l, searchThreshold: t });
  });

  // pydantic's text, as probed from Pipecat's InputParams.
  test.each([
    [
      "0",
      "0.3",
      "1 validation error for InputParams\nsearch_limit\n  Input should be greater than or equal to 1 [type=greater_than_equal, input_value=0, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/greater_than_equal",
    ],
    [
      "10",
      "nan",
      "1 validation error for InputParams\nsearch_threshold\n  Input should be less than or equal to 1 [type=less_than_equal, input_value=nan, input_type=float]\n    For further information visit https://errors.pydantic.dev/2.13/v/less_than_equal",
    ],
    [
      "10",
      "inf",
      "1 validation error for InputParams\nsearch_threshold\n  Input should be less than or equal to 1 [type=less_than_equal, input_value=inf, input_type=float]\n    For further information visit https://errors.pydantic.dev/2.13/v/less_than_equal",
    ],
    [
      "10",
      "1.5",
      "1 validation error for InputParams\nsearch_threshold\n  Input should be less than or equal to 1 [type=less_than_equal, input_value=1.5, input_type=float]\n    For further information visit https://errors.pydantic.dev/2.13/v/less_than_equal",
    ],
    [
      "10",
      "-0.1",
      "1 validation error for InputParams\nsearch_threshold\n  Input should be greater than or equal to 0 [type=greater_than_equal, input_value=-0.1, input_type=float]\n    For further information visit https://errors.pydantic.dev/2.13/v/greater_than_equal",
    ],
    [
      "-5",
      "-inf",
      "2 validation errors for InputParams\nsearch_limit\n  Input should be greater than or equal to 1 [type=greater_than_equal, input_value=-5, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/greater_than_equal\nsearch_threshold\n  Input should be greater than or equal to 0 [type=greater_than_equal, input_value=-inf, input_type=float]\n    For further information visit https://errors.pydantic.dev/2.13/v/greater_than_equal",
    ],
  ])("rejects limit=%p threshold=%p", (limit, threshold, message) => {
    setEnv({ MEM0_SEARCH_LIMIT: limit, MEM0_SEARCH_THRESHOLD: threshold });
    expect(() => memorySearchSettingsFromEnv()).toThrow(new RangeError(message));
  });
});
