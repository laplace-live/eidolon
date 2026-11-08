import { describe, expect, test } from "bun:test";
import type { AccountEntry } from "@eidolon/config";
import { accountOf, listModels, type Sources } from "../src/index.ts";

function account(id: string, fields: Partial<AccountEntry> & { provider: string }) {
  const entry: AccountEntry = {
    id,
    name: null,
    apiKey: null,
    baseUrl: null,
    options: {},
    ...fields,
  };
  const sources: Sources = {
    read: () => undefined,
    env: () => undefined,
    accounts: new Map([[id, entry]]),
  };
  const found = accountOf(id, sources);
  if (found === undefined) throw new Error(`no account ${id}`);
  return found;
}

/** Answers every request with `body`, recording the URL and headers asked with. */
function answering(body: unknown, status = 200) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("listModels", () => {
  test("OpenRouter's listings answer without a key, sorted by id", async () => {
    const { fetch, seen } = answering({
      data: [
        { id: "z/model", name: "Z" },
        { id: "a/model", name: "a/model" },
      ],
    });
    const listing = await listModels(account("openrouter", { provider: "openrouter" }), "llm", {
      fetch,
    });
    expect(listing).toEqual({
      status: "ok",
      models: [{ id: "a/model" }, { id: "z/model", name: "Z" }],
    });
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    const embeddings = answering({ data: [] });
    await listModels(account("openrouter", { provider: "openrouter" }), "embedding", embeddings);
    expect(embeddings.seen[0]?.url).toBe("https://openrouter.ai/api/v1/embeddings/models");
  });

  test("OpenAI's one listing is split by what each id says it does, at the account's base", async () => {
    const { fetch, seen } = answering({
      data: [
        { id: "gpt-6-luna" },
        { id: "gpt-4o-mini-tts" },
        { id: "gpt-realtime-2.1" },
        { id: "text-embedding-3-large" },
        { id: "gpt-realtime-whisper" },
      ],
    });
    const work = account("openai-work", {
      provider: "openai",
      apiKey: "sk-w",
      baseUrl: "https://proxy.example/v1/",
    });
    const ids = async (category: Parameters<typeof listModels>[1]) => {
      const listing = await listModels(work, category, { fetch });
      return listing.status === "ok" ? listing.models.map((model) => model.id) : listing.status;
    };
    expect(await ids("llm")).toEqual(["gpt-6-luna"]);
    expect(await ids("tts")).toEqual(["gpt-4o-mini-tts"]);
    expect(await ids("realtime")).toEqual(["gpt-realtime-2.1", "gpt-realtime-whisper"]);
    expect(await ids("embedding")).toEqual(["text-embedding-3-large"]);
    expect(seen[0]?.url).toBe("https://proxy.example/v1/models");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-w");
  });

  test("Gemini's ids lose their models/ prefix; Soniox's split live from batch", async () => {
    const gemini = answering({
      data: [{ id: "models/gemini-3.1-flash" }, { id: "models/gemini-embedding-2" }],
    });
    const google = account("google", { provider: "google", apiKey: "g" });
    expect(await listModels(google, "llm", gemini)).toEqual({
      status: "ok",
      models: [{ id: "gemini-3.1-flash" }],
    });
    const soniox = answering({
      models: [
        { id: "stt-rt-v5", transcription_mode: "real_time" },
        { id: "stt-async-v5", transcription_mode: "async" },
      ],
    });
    const sx = account("soniox", { provider: "soniox", apiKey: "s" });
    const listed = await listModels(sx, "transcription", soniox);
    expect(listed.status === "ok" && listed.models.map((model) => model.id)).toEqual([
      "stt-async-v5",
    ]);
  });

  test("no listing, no key, or a refusal leaves the id to type", async () => {
    const fish = account("fish", { provider: "fish", apiKey: "f" });
    expect(await listModels(fish, "tts")).toEqual({ status: "unlisted" });
    const keyless = account("anthropic", { provider: "anthropic" });
    expect(await listModels(keyless, "llm")).toEqual({ status: "no-key" });
    const claude = account("anthropic", { provider: "anthropic", apiKey: "a" });
    const refused = answering({ error: { message: "invalid x-api-key" } }, 401);
    expect(await listModels(claude, "llm", refused)).toEqual({ status: "refused" });
    expect(refused.seen[0]?.headers.get("x-api-key")).toBe("a");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await listModels(claude, "llm", { fetch: down })).toEqual({
      status: "failed",
      message: "couldn't reach api.anthropic.com",
    });
    const broken = answering({ error: { message: "x".repeat(300) } }, 500);
    const failed = await listModels(claude, "llm", broken);
    expect(failed.status === "failed" && failed.message.length).toBe(160);
    const missing = answering({}, 404);
    const zhipu = account("zhipu", { provider: "zhipu", apiKey: "z" });
    expect(await listModels(zhipu, "llm", missing)).toEqual({ status: "unlisted" });
  });
});
