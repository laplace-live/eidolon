import { EmbeddingUsage, setUsageSink, type UsageRecord } from "@eidolon/providers";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_EMBED_MODEL,
  defaultEmbeddingModel,
  embedTexts,
  embedTextsWithUsage,
} from "../src/index.ts";
import { isolateEnv } from "./helpers.ts";

const env = isolateEnv();

const vectors = (...rows: number[][]) => ({
  data: rows.map((embedding, index) => ({ embedding, index, object: "embedding" })),
  model: "m",
  object: "list",
  usage: { prompt_tokens: 7, total_tokens: 7 },
});

describe("default model from env", () => {
  test("without a key, every call throws and nothing is cached", async () => {
    const message =
      "OpenRouter needs an API key: set OPENROUTER_API_KEY in credentials.json or the environment, or EMBED_API_KEY for embeddings alone";
    expect(() => defaultEmbeddingModel()).toThrow(message);
    await expect(embedTexts(["a"])).rejects.toThrow(message);
    process.env.OPENROUTER_API_KEY = "k";
    expect(defaultEmbeddingModel()).toMatchObject({
      provider: "openrouter",
      model: DEFAULT_EMBED_MODEL,
    });
  });

  test("empty input never builds the model", async () => {
    expect(await embedTextsWithUsage([])).toEqual([[], new EmbeddingUsage()]);
  });

  test("blank EMBED_* values fall back to the defaults; EMBED_API_KEY wins", async () => {
    process.env.EMBED_API_KEY = "embed-key";
    process.env.OPENROUTER_API_KEY = "router-key";
    process.env.EMBED_MODEL = "";
    process.env.EMBED_BASE_URL = "";
    process.env.EMBED_DIM = "";
    const network = env
      .network()
      .mockImplementation((async () => Response.json(vectors([9]))) as unknown as typeof fetch);
    expect(await embedTexts(["q"])).toEqual([[9]]);
    const [url, init] = network.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer embed-key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: DEFAULT_EMBED_MODEL,
      dimensions: 3072,
    });
  });

  test("the account is kept from the first call; the model is the settings' each time", async () => {
    process.env.OPENROUTER_API_KEY = "first-key";
    const network = env
      .network()
      .mockImplementation((async () => Response.json(vectors([9]))) as unknown as typeof fetch);
    await embedTexts(["q"]);
    process.env.OPENROUTER_API_KEY = "second-key";
    process.env.EMBED_MODEL = "openai/text-embedding-3-large";
    await embedTexts(["q"], { model: "openai/text-embedding-3-small" });
    await embedTexts(["q"]);
    const sent = network.mock.calls.map(([, init]) => [
      ((init as RequestInit).headers as Record<string, string>).Authorization,
      JSON.parse(String((init as RequestInit).body)).model,
    ]);
    expect(sent).toEqual([
      ["Bearer first-key", DEFAULT_EMBED_MODEL],
      ["Bearer first-key", "openai/text-embedding-3-small"],
      ["Bearer first-key", "openai/text-embedding-3-large"],
    ]);
  });

  test("spend at another provider's API, through EMBED_BASE_URL, is that provider's", async () => {
    process.env.EMBED_API_KEY = "sk-openai";
    process.env.EMBED_BASE_URL = "https://api.openai.com/v1";
    process.env.EMBED_MODEL = "text-embedding-3-large";
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    try {
      env
        .network()
        .mockImplementation((async () => Response.json(vectors([9]))) as unknown as typeof fetch);
      await embedTexts(["q"]);
    } finally {
      setUsageSink(null);
    }
    expect(records.map(({ provider, model }) => [provider, model])).toEqual([
      ["openai", "text-embedding-3-large"],
    ]);
  });
});
