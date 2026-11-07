import { describe, expect, test } from "bun:test";
import { studioPath } from "@/lib/paths";
import type { Status } from "../../lib/api";
import { type Formats, formatsFor, type Item, readiness, verdict } from "./readiness";

const plain: Formats = {
  bytes: (bytes) => `${bytes}B`,
  date: (iso) => `@${iso}`,
  count: (count) => String(count),
};

const healthy: Status = {
  version: "1.0.0",
  restartRequired: false,
  mcpRestartRequired: false,
  keys: { SONIOX_API_KEY: true, OPENROUTER_API_KEY: true, FISH_API_KEY: true },
  persona: {
    id: "milky-green",
    name: "明前奶绿",
    shortName: "奶绿",
    voice: { id: "a".repeat(32), source: "persona", ok: true },
  },
  index: {
    tables: [
      {
        table: "stream_chunks",
        built: true,
        rows: 900,
        builtAt: "2026-11-01T00:00:00Z",
        model: "m",
        dim: 3072,
        stale: false,
      },
      {
        table: "persona_facts",
        built: true,
        rows: 40,
        builtAt: "2026-11-02T00:00:00Z",
        model: "m",
        dim: 3072,
        stale: false,
      },
    ],
    catalogBuiltAt: "2026-11-01T00:00:00Z",
  },
  selfieReferences: 2,
  memory: { configured: true, reachable: true },
  ytDlp: { state: "installed", tag: "2026.10.30" },
  ffmpeg: true,
  freeBytes: 200e9,
  lastSessionError: null,
  activeCalls: 0,
};

function item(status: Status, id: string): Item | undefined {
  return readiness(status, plain).find((entry) => entry.id === id);
}

test("a healthy install is all ok, in a fixed order, and only her voice offers a change", () => {
  const items = readiness(healthy, plain);
  expect(items.map((entry) => entry.id)).toEqual([
    "keys",
    "voice",
    "memory",
    "facts",
    "streams",
    "selfies",
    "ytdlp",
    "ffmpeg",
    "disk",
  ]);
  expect(items.every((entry) => entry.tone === "ok")).toBe(true);
  expect(items.filter((entry) => entry.fix !== undefined).map((entry) => entry.id)).toEqual([
    "voice",
  ]);
  expect(item(healthy, "voice")?.fix).toEqual({
    kind: "pick-voice",
    label: "home.fix.changeVoice",
  });
  expect(item(healthy, "streams")?.vars).toEqual({ rows: "900", date: "@2026-11-01T00:00:00Z" });
  expect(verdict(items)).toBe("ready");
});

test("a missing key names its provider and links to setup", () => {
  const status = {
    ...healthy,
    keys: { ...healthy.keys, FISH_API_KEY: false, SONIOX_API_KEY: false },
  };
  expect(item(status, "keys")).toEqual({
    id: "keys",
    tone: "error",
    text: "home.ready.keys.missing",
    vars: { names: "Soniox, Fish Audio" },
    fix: { kind: "link", to: "/setup", label: "home.fix.setup" },
  });
});

describe("the voice", () => {
  const voice = (patch: Partial<Status["persona"]["voice"]>): Status => ({
    ...healthy,
    persona: { ...healthy.persona, voice: { ...healthy.persona.voice, ...patch } },
  });

  test("unset or unknown to Fish blocks calls, and the fix is picking one in place", () => {
    const pick = { kind: "pick-voice", label: "home.fix.pickVoice" } as const;
    expect(item(voice({ id: null, source: "default", ok: null }), "voice")).toEqual({
      id: "voice",
      tone: "error",
      text: "home.ready.voice.none",
      fix: pick,
    });
    expect(item(voice({ ok: false }), "voice")).toMatchObject({
      tone: "error",
      text: "home.ready.voice.bad",
      fix: pick,
    });
  });

  test("unchecked offers the Fish check, and says whether she inherits it", () => {
    expect(item(voice({ ok: null }), "voice")).toMatchObject({
      text: "home.ready.voice.unchecked",
      fix: { kind: "check", provider: "fish" },
    });
    expect(item(voice({ source: "env", ok: null }), "voice")).toMatchObject({
      text: "home.ready.voice.uncheckedEnv",
      fix: { kind: "check", provider: "fish" },
    });
  });

  test("an inherited voice says so, and is changed in her studio's voice section", () => {
    const studio = { kind: "link", to: "/personas/milky-green/voice" } as const;
    expect(item(voice({ source: "env", ok: false }), "voice")).toMatchObject({
      tone: "error",
      text: "home.ready.voice.badEnv",
      vars: { id: "a".repeat(32) },
      fix: { ...studio, label: "home.fix.pickVoice" },
    });
    expect(item(voice({ source: "env", ok: true }), "voice")).toMatchObject({
      tone: "ok",
      text: "home.ready.voice.env",
      fix: { ...studio, label: "home.fix.changeVoice" },
    });
  });
});

test("the verdict: an error blocks calls, a warning wants a look, information is fine", () => {
  expect(verdict([{ tone: "ok" }, { tone: "info" }])).toBe("ready");
  expect(verdict([{ tone: "info" }, { tone: "warn" }])).toBe("attention");
  expect(verdict([{ tone: "warn" }, { tone: "error" }, { tone: "ok" }])).toBe("blocked");
  const noKeys = { ...healthy, keys: { ...healthy.keys, FISH_API_KEY: false } };
  expect(verdict(readiness(noKeys, plain))).toBe("blocked");
  expect(verdict(readiness({ ...healthy, freeBytes: 2e9 }, plain))).toBe("attention");
});

test("memory off links to the wizard's memory step; down or unchecked offers a check", () => {
  const memory = (state: Status["memory"]) => item({ ...healthy, memory: state }, "memory");
  expect(memory({ configured: false, reachable: null })?.fix).toEqual({
    kind: "link",
    to: "/setup?step=memory",
    label: "home.fix.memory",
  });
  expect(memory({ configured: true, reachable: false })).toMatchObject({
    tone: "warn",
    fix: { kind: "check", provider: "qdrant" },
  });
  expect(memory({ configured: true, reachable: null })?.tone).toBe("info");
});

test("index tables: never built, stale, and a missing broadcast overview link to the studio", () => {
  const [streams, facts] = healthy.index.tables as [
    Status["index"]["tables"][number],
    Status["index"]["tables"][number],
  ];
  const tables = (patch: Partial<Status["index"]>) => ({
    ...healthy,
    index: { ...healthy.index, ...patch },
  });
  expect(item(tables({ tables: [] }), "facts")).toMatchObject({
    tone: "info",
    text: "home.ready.facts.none",
    fix: { to: "/personas/milky-green/knowledge" },
  });
  expect(item(tables({ tables: [{ ...streams, stale: true }, facts] }), "streams")).toMatchObject({
    tone: "warn",
    fix: { to: "/personas/milky-green/videos", label: "home.fix.reingest" },
  });
  const unbuilt = { ...facts, built: false, rows: null, builtAt: null };
  expect(item(tables({ tables: [streams, unbuilt] }), "facts")?.text).toBe("home.ready.facts.none");
  const python = { ...facts, rows: null, builtAt: null, model: null, dim: null };
  expect(item(tables({ tables: [streams, python] }), "facts")).toEqual({
    id: "facts",
    tone: "ok",
    text: "home.ready.facts.built",
  });
  expect(item(tables({ catalogBuiltAt: null }), "streams")).toMatchObject({
    tone: "info",
    text: "home.ready.streams.noCatalog",
  });
});

test("tools, disk, the last error, a live call and a pending restart", () => {
  const status: Status = {
    ...healthy,
    restartRequired: true,
    activeCalls: 1,
    selfieReferences: 0,
    ytDlp: { state: "unavailable", reason: "GitHub unreachable" },
    ffmpeg: false,
    freeBytes: 2e9,
    lastSessionError: { message: "TTS 402", at: "2026-11-05T10:00:00Z" },
  };
  const items = readiness(status, plain);
  expect(items.slice(0, 2).map((entry) => entry.id)).toEqual(["restart", "call"]);
  const byId = Object.fromEntries(items.map((entry) => [entry.id, entry]));
  expect(byId.restart?.fix).toEqual({ kind: "restart" });
  expect(byId.selfies?.fix).toMatchObject({ to: "/personas/milky-green/references" });
  expect(byId.ytdlp).toMatchObject({ tone: "warn", detail: "GitHub unreachable" });
  expect(byId.ytdlp?.fix).toBeUndefined();
  expect(byId.ffmpeg?.tone).toBe("info");
  expect(byId.disk).toMatchObject({ tone: "warn", vars: { free: "2000000000B" } });
  expect(byId.lastError).toMatchObject({
    detail: "TTS 402",
    vars: { when: "@2026-11-05T10:00:00Z" },
  });
  expect(item({ ...healthy, freeBytes: null }, "disk")).toBeUndefined();
});

test("a restart only the MCP server needs is information, not a warning", () => {
  expect(item({ ...healthy, mcpRestartRequired: true }, "restart")).toEqual({
    id: "restart",
    tone: "info",
    text: "home.ready.mcpRestart",
    fix: { kind: "restart" },
  });
  const both = { ...healthy, restartRequired: true, mcpRestartRequired: true };
  expect(item(both, "restart")?.text).toBe("home.ready.restart");
});

test("studio paths encode the id, and formats follow the language", () => {
  expect(studioPath("a b", "voice")).toBe("/personas/a%20b/voice");
  const zh = formatsFor("zh-CN");
  expect(formatsFor("en").bytes(12.34e9)).toBe("12.3 GB");
  expect(zh.count(12345)).toBe("12,345");
  expect(zh.date("not a date")).toBe("not a date");
});
