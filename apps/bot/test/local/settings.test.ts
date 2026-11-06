// /api/local/settings: every SETTINGS row layer by layer, writes into settings.yaml and the user's
// copy of persona.yaml (never the template), and the rules that keep a page from reading files or
// running binaries through a setting.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  activePersona,
  dataHome,
  envOptional,
  personaHomeDir,
  SETTINGS,
  templatesDir,
} from "@eidolon/config";
import type { SettingRow, SettingsResponse } from "../../src/local/api.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot, fakeModules } from "./harness.ts";

function hashTree(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const path = join(root, name);
    if (statSync(path).isFile()) {
      hashes.set(name, createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  }
  return hashes;
}

let templates: Map<string, string>;
beforeAll(() => {
  templates = hashTree(templatesDir());
});
afterAll(() => {
  expect(hashTree(templatesDir())).toEqual(templates);
});

let booted: Booted;
let logs: CapturedLogs;
let calls = 0;
const touched: string[] = [];

beforeEach(async () => {
  logs = captureLogs();
  calls = 0;
  const fakes = fakeModules();
  const runtime = fakes.modules.runtime;
  booted = await bootFixture({
    fakes: {
      ...fakes,
      modules: {
        ...fakes.modules,
        runtime: {
          ...runtime,
          createSignallingServer: (options) => ({
            ...runtime.createSignallingServer(options),
            get activeSessions() {
              return calls;
            },
          }),
        },
      },
    },
  });
});

afterEach(async () => {
  await booted.stop();
  logs.restore();
  for (const name of touched.splice(0)) delete process.env[name];
  cleanUpBoot();
});

function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${booted.base}/api/local${path}`, {
    method,
    headers: { Cookie: booted.cookie, Origin: booted.origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function settings(persona?: string): Promise<SettingsResponse> {
  const response = await api("GET", `/settings${persona ? `?persona=${persona}` : ""}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SettingsResponse;
}

function row(answer: SettingsResponse, path: string): SettingRow {
  const found = answer.settings.find((r) => r.path === path);
  if (found === undefined) throw new Error(`no row ${path}`);
  return found;
}

async function put(update: unknown): Promise<{ status: number; body: any }> {
  const response = await api("PUT", "/settings", update);
  return { status: response.status, body: await response.json() };
}

describe("GET settings", () => {
  test("lists every SETTINGS row with its file value, layer and flags", async () => {
    process.env.EMBED_MODEL = "from/env";
    touched.push("EMBED_MODEL");
    const answer = await settings();
    expect(answer.persona).toBe("milky-green");
    expect(answer.settings.map((r) => r.path)).toEqual(SETTINGS.map((r) => r.path));
    expect(row(answer, "identity.timezone")).toMatchObject({
      env: "PERSONA_TIMEZONE",
      scope: "persona",
      value: "Asia/Shanghai",
      source: "persona",
      envOverride: false,
    });
    expect(row(answer, "persona")).toMatchObject({ value: null, source: "default" });
    expect(row(answer, "embeddings.model")).toMatchObject({ value: null, envOverride: true });
    for (const path of ["access.realIpHeader", "mcp.allowedHosts", "network.turnUrl"]) {
      expect(row(answer, path).productionOnly).toBe(true);
    }
    for (const path of ["audio.opusBitrate.best", "providers.openrouter.appName"]) {
      expect(row(answer, path).productionOnly).toBe(true);
    }
    expect(row(answer, "local.viewerName").productionOnly).toBe(false);
    expect(row(answer, "providers.openrouter.apiBase").productionOnly).toBe(false);
    expect(answer.settings.filter((r) => r.readOnly).map((r) => r.path)).toEqual(["sources.ytDlp"]);
    expect(answer.restartRequired).toBe(false);
  });

  test("names a persona by id, and refuses one that isn't", async () => {
    expect((await api("GET", "/settings?persona=..%2Fx")).status).toBe(400);
    expect((await api("GET", "/settings?persona=nobody")).status).toBe(404);
  });
});

describe("PUT settings", () => {
  test("round trips through settings.yaml, and null removes a key", async () => {
    const saved = await put({
      scope: "app",
      values: {
        "local.viewerName": " 小明 ",
        "embeddings.dim": 1024,
        "access.allowedOrigins": ["https://a.example", " https://b.example "],
      },
    });
    expect(saved.status).toBe(200);
    expect(row(saved.body, "local.viewerName")).toMatchObject({ value: "小明", source: "app" });
    expect(row(saved.body, "embeddings.dim")).toMatchObject({ value: 1024, source: "app" });
    expect(row(saved.body, "access.allowedOrigins").value).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(Bun.YAML.parse(readFileSync(join(dataHome(), "settings.yaml"), "utf8"))).toEqual({
      local: { viewerName: "小明" },
      embeddings: { dim: 1024 },
      access: { allowedOrigins: ["https://a.example", "https://b.example"] },
    });
    // Installed again: what the next call reads.
    expect(envOptional("EIDOLON_LOCAL_VIEWER_NAME")).toBe("小明");

    const removed = await put({ scope: "app", values: { "local.viewerName": null } });
    expect(row(removed.body, "local.viewerName")).toMatchObject({ value: null, source: "default" });
    expect(Bun.YAML.parse(readFileSync(join(dataHome(), "settings.yaml"), "utf8"))).toEqual({
      embeddings: { dim: 1024 },
      access: { allowedOrigins: ["https://a.example", "https://b.example"] },
    });
    expect(envOptional("EIDOLON_LOCAL_VIEWER_NAME")).toBeUndefined();
  });

  test("a persona's first write copies her template's persona.yaml to the data home", async () => {
    const saved = await put({
      scope: "persona",
      persona: "milky-green",
      values: { "voice.model": "s2-pro", "knowledge.rerank.enabled": false, "voice.voiceId": "" },
    });
    expect(saved.status).toBe(200);
    expect(row(saved.body, "voice.model")).toMatchObject({ value: "s2-pro", source: "persona" });
    const own = Bun.YAML.parse(
      readFileSync(join(personaHomeDir("milky-green"), "persona.yaml"), "utf8"),
    ) as Record<string, any>;
    expect(own.identity.name).toBe("明前奶绿");
    expect(own.knowledge.facts.subject).toBe("明前奶[绿黑]");
    expect(own.voice).toEqual({ model: "s2-pro" });
    expect(own.knowledge.rerank).toEqual({ enabled: false });
    expect(envOptional("FISH_MODEL")).toBe("s2-pro");
  });

  test("an empty update writes nothing", async () => {
    const saved = await put({ scope: "persona", persona: "milky-green", values: {} });
    expect(saved.status).toBe(200);
    expect(existsSync(join(personaHomeDir("milky-green"), "persona.yaml"))).toBe(false);
  });

  test("a persona's paths stay relative and inside her folder", async () => {
    for (const values of [
      { prompt: "/etc/passwd" },
      { prompt: "~/.ssh/id_ed25519" },
      { prompt: "../../credentials.json" },
      { prompt: "..\\..\\credentials.json" },
      { "knowledge.index": "." },
      { "selfie.references": ["~/x.png"] },
      { "selfie.references": ["outfits/a.png", "/etc/hosts"] },
    ]) {
      const refused = await put({ scope: "persona", persona: "milky-green", values });
      expect([JSON.stringify(values), refused.status, refused.body.error?.code]).toEqual([
        JSON.stringify(values),
        400,
        "invalid-path",
      ]);
    }
    expect(existsSync(join(personaHomeDir("milky-green"), "persona.yaml"))).toBe(false);
    const fine = await put({
      scope: "persona",
      persona: "milky-green",
      values: {
        prompt: "prompt-v2.md",
        "selfie.references": ["outfits/day.png", "https://example.com/day.png"],
      },
    });
    expect(fine.status).toBe(200);
    expect(row(fine.body, "prompt").value).toBe("prompt-v2.md");
  });

  test("sources.ytDlp is never written through the API", async () => {
    for (const value of ["/tmp/evil", null]) {
      const refused = await put({ scope: "app", values: { "sources.ytDlp": value } });
      expect([refused.status, refused.body.error.code]).toEqual([400, "read-only-setting"]);
    }
    expect(existsSync(join(dataHome(), "settings.yaml"))).toBe(false);
  });

  test("values are checked by kind", async () => {
    for (const values of [
      { "embeddings.dim": "1024" },
      { "embeddings.dim": 10.5 },
      { "memory.qdrant.host": 5 },
      { "memory.qdrant.host": "a\nb" },
      { "access.allowedOrigins": ["a,b"] },
      { "access.allowedOrigins": [1] },
    ]) {
      const refused = await put({ scope: "app", values });
      expect([refused.status, refused.body.error.code]).toEqual([400, "invalid-setting"]);
    }
    const flag = await put({
      scope: "persona",
      persona: "milky-green",
      values: { "knowledge.rerank.enabled": "true" },
    });
    expect([flag.status, flag.body.error.code]).toEqual([400, "invalid-setting"]);
    const float = await put({
      scope: "persona",
      persona: "milky-green",
      values: { "memory.searchThreshold": 0.25 },
    });
    expect(float.status).toBe(200);
  });

  test("the time zone is an IANA zone, as the identity editor requires", async () => {
    const timezone = (zone: string) =>
      put({ scope: "persona", persona: "milky-green", values: { "identity.timezone": zone } });
    const refused = await timezone("Asia/Shangai");
    expect([refused.status, refused.body.error.code]).toEqual([400, "invalid-setting"]);
    expect(existsSync(join(personaHomeDir("milky-green"), "persona.yaml"))).toBe(false);
    expect((await timezone("Asia/Tokyo")).status).toBe(200);
    expect(row(await settings("milky-green"), "identity.timezone").value).toBe("Asia/Tokyo");
  });

  test("a value names a setting of its scope, and a persona one its persona", async () => {
    const wrongScope = await put({ scope: "app", values: { "voice.model": "s2-pro" } });
    expect([wrongScope.status, wrongScope.body.error.code]).toEqual([400, "unknown-setting"]);
    const unknown = await put({ scope: "app", values: { "nope.nothing": 1 } });
    expect(unknown.body.error.code).toBe("unknown-setting");
    expect(JSON.stringify(unknown.body)).not.toContain("nope.nothing");
    const noPersona = await put({ scope: "persona", values: { "voice.model": "s2-pro" } });
    expect([noPersona.status, noPersona.body.error.code]).toEqual([400, "bad-request"]);
    const badId = await put({ scope: "persona", persona: "../x", values: {} });
    expect([badId.status, badId.body.error.code]).toEqual([400, "invalid-persona-id"]);
    const missing = await put({ scope: "persona", persona: "nobody", values: {} });
    expect([missing.status, missing.body.error.code]).toEqual([404, "unknown-persona"]);
    expect((await put({ scope: "nope", values: {} })).status).toBe(400);
  });

  test("`persona` switches as PUT personas/active does", async () => {
    const unknown = await put({ scope: "app", values: { persona: "beta" } });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, "unknown-persona"]);
    mkdirSync(join(dataHome(), "personas", "beta"), { recursive: true });
    calls = 1;
    const busy = await put({ scope: "app", values: { persona: "beta" } });
    expect([busy.status, busy.body.error.code]).toEqual([409, "call-active"]);
    calls = 0;
    const switched = await put({ scope: "app", values: { persona: "beta" } });
    expect([switched.status, switched.body.persona]).toEqual([200, "beta"]);
    expect(activePersona().id).toBe("beta");
  });

  test("the answer says when a value waits for a restart", async () => {
    // Memory was off at boot, so its first host needs none.
    const host = await put({ scope: "app", values: { "memory.qdrant.host": "127.0.0.1" } });
    expect(host.body.restartRequired).toBe(false);
    const port = await put({ scope: "app", values: { "memory.qdrant.port": 6334 } });
    expect(port.body.restartRequired).toBe(true);
  });

  test("a value read at boot needs a restart; one read per call doesn't", async () => {
    const perCall = await put({ scope: "app", values: { "local.viewerName": "小明" } });
    expect(perCall.body.restartRequired).toBe(false);
    const atBoot = await put({ scope: "app", values: { "network.stunUrl": "stun:example.com" } });
    expect(atBoot.body.restartRequired).toBe(true);
  });
});
