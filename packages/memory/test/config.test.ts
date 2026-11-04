import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataHome } from "@eidolon/config";
import {
  buildMemoryConfig,
  EMBED_KEY_MISSING,
  memorySearchSettingsFromEnv,
  qdrantHost,
  requireLlmKey,
} from "../src/config.ts";
import { isMemoryConfigured } from "../src/index.ts";
import { clearMemoryEnv, resetEnv, setEnv, tempPath } from "./support.ts";

beforeEach(() => {
  clearMemoryEnv();
  setEnv({
    MEM0_QDRANT_HOST: "qdrant",
    OPENROUTER_API_KEY: "sk-or",
    MEM0_HISTORY_DB_PATH: tempPath("h.db"),
  });
});
afterEach(resetEnv);

describe("enablement", () => {
  test("a whitespace-only host leaves memory off", () => {
    setEnv({ MEM0_QDRANT_HOST: " \t　" });
    expect(qdrantHost()).toBe("");
    expect(isMemoryConfigured()).toBe(false);
  });

  test("the host is stripped with Python's whitespace set", () => {
    setEnv({ MEM0_QDRANT_HOST: "\u0085qdrant\n" });
    expect(qdrantHost()).toBe("qdrant");
    expect(isMemoryConfigured()).toBe(true);
  });

  test("unset or empty is off", () => {
    setEnv({ MEM0_QDRANT_HOST: "" });
    expect(isMemoryConfigured()).toBe(false);
    setEnv({ MEM0_QDRANT_HOST: undefined });
    expect(isMemoryConfigured()).toBe(false);
  });
});

describe("buildMemoryConfig", () => {
  test("defaults", () => {
    setEnv({ MEM0_HISTORY_DB_PATH: undefined });
    const config = buildMemoryConfig();
    expect(config.qdrant).toEqual({
      host: "qdrant",
      port: 6333,
      collection: "eidolon_memories",
      vectorSize: 3072,
    });
    expect(config.embedder).toEqual({
      model: "google/gemini-embedding-2-preview",
      apiKey: "sk-or",
      baseUrl: "https://openrouter.ai/api/v1",
      dims: 3072,
    });
    expect(config.llm).toEqual({
      model: "~google/gemini-flash-latest",
      apiKey: "sk-or",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(config.historyDbPath).toBe(join(dataHome(), "mem0", "history.db"));
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
    expect(config.embedder).toEqual({
      model: "m",
      apiKey: "sk-embed",
      baseUrl: "https://embed.example/v1",
      dims: 8,
    });
    expect(config.qdrant.vectorSize).toBe(8);
    expect(config.llm.apiKey).toBe("sk-or");
  });

  test("no embedding key is mem0_local's error, verbatim", () => {
    setEnv({ OPENROUTER_API_KEY: "", EMBED_API_KEY: "" });
    expect(() => buildMemoryConfig()).toThrow(EMBED_KEY_MISSING);
    expect(EMBED_KEY_MISSING).toBe(
      "Self-hosted Mem0 needs an embedding API key. Set OPENROUTER_API_KEY (reused from the LLM config) or EMBED_API_KEY for a different provider.",
    );
  });

  test("creates the history DB's parent directory", () => {
    const path = join(dirname(tempPath("x")), "nested", "deeper", "history.db");
    setEnv({ MEM0_HISTORY_DB_PATH: path });
    expect(buildMemoryConfig().historyDbPath).toBe(path);
    expect(existsSync(dirname(path))).toBe(true);
  });

  test("port and collection", () => {
    setEnv({ MEM0_QDRANT_PORT: "16333", MEM0_QDRANT_COLLECTION: " spaced " });
    expect(buildMemoryConfig().qdrant).toMatchObject({ port: 16333, collection: " spaced " });
  });

  test("a non-positive port is refused rather than dialled on port 80", () => {
    setEnv({ MEM0_QDRANT_PORT: "0" });
    expect(() => buildMemoryConfig()).toThrow("MEM0_QDRANT_PORT=0 is not a Qdrant server port");
  });

  test("refuses to build without a host", () => {
    setEnv({ MEM0_QDRANT_HOST: "  " });
    expect(() => buildMemoryConfig()).toThrow("MEM0_QDRANT_HOST is unset");
  });
});

describe("extraction LLM routing", () => {
  test("OpenRouter whenever OPENROUTER_API_KEY is set, OPENROUTER_API_BASE overriding the base", () => {
    setEnv({ OPENROUTER_API_BASE: "https://proxy.example/v1", OPENAI_API_KEY: "sk-oa" });
    expect(buildMemoryConfig().llm).toMatchObject({
      apiKey: "sk-or",
      baseUrl: "https://proxy.example/v1",
    });
  });

  test("otherwise OpenAI's key and base", () => {
    setEnv({ OPENROUTER_API_KEY: "", EMBED_API_KEY: "sk-embed", OPENAI_API_KEY: "sk-oa" });
    expect(buildMemoryConfig().llm).toMatchObject({
      apiKey: "sk-oa",
      baseUrl: "https://api.openai.com/v1",
    });
    setEnv({ OPENAI_BASE_URL: "https://compat.example/v1" });
    expect(buildMemoryConfig().llm.baseUrl).toBe("https://compat.example/v1");
  });

  test("no key at all fails where the OpenAI client would be built", () => {
    setEnv({ OPENROUTER_API_KEY: "", EMBED_API_KEY: "sk-embed" });
    const { llm } = buildMemoryConfig();
    expect(llm.apiKey).toBeNull();
    expect(() => requireLlmKey(llm)).toThrow(
      "The api_key client option must be set either by passing api_key to the client or by setting the OPENAI_API_KEY environment variable",
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
