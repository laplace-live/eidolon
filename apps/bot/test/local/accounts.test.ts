// /api/local/accounts: credentials.json's provider accounts and each provider's default, written
// with keys that never come back, guarded while a persona names one, checked and listed against
// the provider through a fake fetch.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, installSettings, resetSettings } from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import type { AccountsResponse, CheckResult, ModelsResponse } from "../../src/local/api.ts";
import type { LocalApp } from "../../src/local/router.ts";
import { accountsRoutes } from "../../src/local/routes/accounts.ts";

const app = {
  port: () => 7860,
  activeCalls: () => 0,
  restart: () => {},
  onStop: () => {},
  memoryAdmin: (): MemoryAdmin | null => null,
} satisfies LocalApp;

const touched: string[] = [];

function write(rel: string, text: string): void {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function credentials(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataHome(), "credentials.json"), "utf8"));
}

beforeEach(() => {
  resetSettings();
  installSettings();
});

afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

/** The routes over `fetchImpl`, called as the router would: by method and path, `:id` matched. */
function api(
  fetchImpl: typeof fetch = (async () => new Response("{}")) as unknown as typeof fetch,
) {
  const routes = accountsRoutes(app, { fetch: fetchImpl, now: () => Date.now() });
  return async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://127.0.0.1:7860/api/local${path}`);
    for (const spec of routes) {
      const [want, pattern] = spec.route.split(" ") as [string, string];
      const segments = pattern.split("/");
      const got = url.pathname.split("/");
      if (want !== method || segments.length !== got.length) continue;
      const params: Record<string, string> = {};
      const matched = segments.every((segment, i) => {
        if (!segment.startsWith(":")) return segment === got[i];
        params[segment.slice(1)] = decodeURIComponent(got[i] as string);
        return true;
      });
      if (!matched) continue;
      const request = new Request(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const response = await spec.handler(request, {
        url,
        params,
        server: undefined as never,
        caller: "bearer",
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    }
    throw new Error(`no route ${method} ${path}`);
  };
}

const ids = (body: AccountsResponse) => body.accounts.map((account) => account.id);

describe("GET accounts", () => {
  test("a fresh home shows the accounts her calls need, each without a key", async () => {
    const { body } = await api()("GET", "/accounts");
    expect(ids(body)).toEqual(["openrouter", "soniox", "fish"]);
    expect(
      (body as AccountsResponse).accounts.every((a) => a.needed && a.key.source === null),
    ).toBe(true);
  });

  test("the environment's key configures a provider's default account, and says so", async () => {
    setEnv("DEEPSEEK_API_KEY", "dk");
    installSettings();
    const { body } = await api()("GET", "/accounts");
    const deepseek = (body as AccountsResponse).accounts.find((a) => a.id === "deepseek");
    expect(deepseek).toMatchObject({ isDefault: true, saved: false, key: { source: "env" } });
  });
});

describe("adding and editing accounts", () => {
  test("the first of a provider is its default; the next, one more; no key comes back", async () => {
    const call = api();
    const first = await call("POST", "/accounts", { provider: "openai", apiKey: "sk-first" });
    expect([first.status, first.body.id, first.body.key]).toEqual([
      201,
      "openai",
      { value: null, source: "account" },
    ]);
    const second = await call("POST", "/accounts", {
      provider: "openai",
      name: "OpenAI (work)",
      apiKey: "sk-second",
      baseUrl: "https://proxy.example/v1/",
    });
    expect(second.body).toMatchObject({
      id: "openai-2",
      name: "OpenAI (work)",
      isDefault: false,
      baseUrl: { value: "https://proxy.example/v1", source: "account" },
    });
    const listed = await call("GET", "/accounts");
    expect(ids(listed.body)).toEqual(["openrouter", "openai", "openai-2", "soniox", "fish"]);
    for (const text of [first.text, second.text, listed.text]) {
      expect(text).not.toContain("sk-first");
      expect(text).not.toContain("sk-second");
    }
    expect(credentials().accounts).toEqual({
      openai: { provider: "openai", apiKey: "sk-first" },
      "openai-2": {
        provider: "openai",
        name: "OpenAI (work)",
        apiKey: "sk-second",
        baseUrl: "https://proxy.example/v1",
      },
    });
    expect(statSync(join(dataHome(), "credentials.json")).mode & 0o777).toBe(0o600);
  });

  test("a default account's key moves out of its old variable; null removes a value", async () => {
    write("credentials.json", JSON.stringify({ OPENROUTER_API_KEY: "or-old", FISH_API_KEY: "f" }));
    installSettings();
    const call = api();
    const edited = await call("PUT", "/accounts/openrouter", {
      apiKey: "or-new",
      baseUrl: "https://router.example/api/v1",
    });
    expect(edited.status).toBe(200);
    expect(credentials()).toEqual({
      FISH_API_KEY: "f",
      accounts: {
        openrouter: {
          provider: "openrouter",
          apiKey: "or-new",
          baseUrl: "https://router.example/api/v1",
        },
      },
    });
    const cleared = await call("PUT", "/accounts/openrouter", { baseUrl: null });
    expect(cleared.body.baseUrl).toEqual({
      value: "https://openrouter.ai/api/v1",
      source: "default",
    });
  });

  test("MiniMax's group id is a setting of its account", async () => {
    const call = api();
    const added = await call("POST", "/accounts", {
      provider: "minimax",
      apiKey: "mk",
      options: { groupId: "g-1" },
    });
    expect(added.body.options).toEqual({ groupId: { value: "g-1", source: "account" } });
    const refused = await call("POST", "/accounts", {
      provider: "minimax",
      options: { region: "cn" },
    });
    expect(refused.status).toBe(400);
  });

  test("what isn't an account, a provider or a value is refused", async () => {
    const call = api();
    expect((await call("PUT", "/accounts/ghost", { name: "x" })).body.error.code).toBe(
      "unknown-account",
    );
    expect((await call("POST", "/accounts", { provider: "nope" })).status).toBe(400);
    for (const body of [
      { provider: "openai", baseUrl: "ftp://example" },
      { provider: "openai", name: "x".repeat(81) },
      { provider: "openai", apiKey: "a\nb" },
    ]) {
      expect([body, (await call("POST", "/accounts", body)).status]).toEqual([body, 400]);
    }
  });
});

describe("removing an account", () => {
  test("refused while a persona names it, gone with its key once none does", async () => {
    const call = api();
    await call("POST", "/accounts", { provider: "deepseek", apiKey: "dk" });
    write("personas/milky-green/persona.yaml", "mind:\n  provider: deepseek\n");
    installSettings();
    const refused = await call("DELETE", "/accounts/deepseek");
    expect([refused.status, refused.body.error.code]).toEqual([409, "account-in-use"]);
    const listed = (await call("GET", "/accounts")).body as AccountsResponse;
    expect(listed.accounts.find((a) => a.id === "deepseek")?.uses).toEqual([
      { persona: "milky-green", role: "mind" },
    ]);
    write("personas/milky-green/persona.yaml", "mind:\n  provider: openrouter\n");
    installSettings();
    expect((await call("DELETE", "/accounts/deepseek")).status).toBe(200);
    expect(credentials().accounts).toBeUndefined();
  });
});

describe("checks and model listings", () => {
  test("a key typed for a new account is checked at its provider", async () => {
    const seen: string[] = [];
    const call = api((async (url: string, init: RequestInit) => {
      seen.push(`${url} ${new Headers(init.headers).get("authorization")}`);
      return Response.json({ data: [] });
    }) as unknown as typeof fetch);
    const checked = await call("POST", "/accounts/check", { provider: "deepseek", apiKey: "dk" });
    expect((checked.body as CheckResult).ok).toBe(true);
    expect(seen).toEqual(["https://api.deepseek.com/models Bearer dk"]);
    expect((await call("POST", "/accounts/check", { account: "ghost" })).status).toBe(404);
  });

  test("lists what the provider lists, from memory until the account changes", async () => {
    let asked = 0;
    const call = api((async () => {
      asked++;
      return Response.json({ data: [{ id: "b/model" }, { id: "a/model", name: "A" }] });
    }) as unknown as typeof fetch);
    const listed = await call("GET", "/accounts/openrouter/models?category=llm");
    expect(listed.body as ModelsResponse).toEqual({
      status: "ok",
      models: [{ id: "a/model", name: "A" }, { id: "b/model" }],
    });
    await call("GET", "/accounts/openrouter/models?category=llm");
    expect(asked).toBe(1);
    await call("PUT", "/accounts/openrouter", { name: "Router" });
    await call("GET", "/accounts/openrouter/models?category=llm");
    expect(asked).toBe(2);
    const fish = await call("GET", "/accounts/fish/models?category=tts");
    expect(fish.body).toEqual({ status: "unlisted", models: [] });
    expect((await call("GET", "/accounts/fish/models?category=nope")).status).toBe(400);
  });
});
