import "./isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountEntries,
  activePersona,
  dataHome,
  envEntries,
  envOptional,
  envOverride,
  envRaw,
  installSettings,
  loadSettings,
  PROJECT_ROOT,
  personaFolders,
  personaPath,
  resetSettings,
  SETTINGS,
  setSettingDefaults,
  settingsGeneration,
  withPersona,
} from "../src/index.ts";

const touched = new Set<string>();
function setEnv(name: string, value: string | undefined): void {
  touched.add(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.clear();
  setSettingDefaults(null);
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function twoPersonas(): void {
  write(
    "personas/alice/persona.yaml",
    "identity:\n  name: Alice\nmind:\n  model: alice/chat\nknowledge:\n  index: alice-index\n",
  );
  write(
    "personas/bob/persona.yaml",
    "identity:\n  name: Bob\nmind:\n  model: bob/chat\nknowledge:\n  index: /srv/bob-index\n" +
      "memory:\n  agentId: bob-memories\n",
  );
  // What the local app derives for every persona.
  setSettingDefaults((persona) => ({ MEM0_AGENT_ID: persona.id }));
  setEnv("LLM_MODEL", "env/chat");
  installSettings();
}

/** What a turn reads. */
function reads() {
  return {
    id: activePersona().id,
    name: activePersona().identity.name,
    model: envOptional("LLM_MODEL"),
    agent: envOptional("MEM0_AGENT_ID"),
    index: envOptional("LANCEDB_PATH"),
  };
}

const ALICE = {
  id: "alice",
  name: "Alice",
  model: "alice/chat",
  agent: "alice",
  index: join(dataHome(), "personas", "alice", "alice-index"),
};
const BOB = {
  id: "bob",
  name: "Bob",
  model: "bob/chat",
  agent: "bob-memories",
  index: "/srv/bob-index",
};
const GREEN = {
  id: "milky-green",
  name: "明前奶绿",
  model: "env/chat",
  agent: "milky-green",
  index: undefined,
};

describe("withPersona", () => {
  test("resolves her own settings, identity and derived defaults", () => {
    twoPersonas();
    expect(withPersona("alice", reads)).toEqual(ALICE);
    expect(withPersona("bob", reads)).toEqual(BOB);
    expect(reads()).toEqual(GREEN);
  });

  test("an inner scope wins until it returns", () => {
    twoPersonas();
    const seen = withPersona("alice", () => [reads(), withPersona("bob", reads), reads()]);
    expect(seen).toEqual([ALICE, BOB, ALICE]);
  });

  test("two scopes interleaved across awaits each keep their own persona", async () => {
    twoPersonas();
    const aliceTurn = Promise.withResolvers<void>();
    const bobTurn = Promise.withResolvers<void>();
    const alice = withPersona("alice", async () => {
      const before = reads();
      bobTurn.resolve();
      await aliceTurn.promise;
      await Bun.sleep(1);
      return [before, reads()];
    });
    const bob = withPersona("bob", async () => {
      await bobTurn.promise;
      const before = reads();
      aliceTurn.resolve();
      await Bun.sleep(1);
      return [before, reads()];
    });
    const between = reads();
    expect(await Promise.all([alice, bob])).toEqual([
      [ALICE, ALICE],
      [BOB, BOB],
    ]);
    expect(between).toEqual(GREEN);
    expect(reads()).toEqual(GREEN);
  });

  test("outside a scope, every reader is unchanged", async () => {
    twoPersonas();
    write("credentials.json", '{"accounts": {"work": {"provider": "openai"}}}');
    installSettings();
    const snapshot = () => ({
      entries: envEntries(),
      persona: activePersona(),
      accounts: [...accountEntries()],
      prompt: personaPath("prompt.md"),
    });
    const before = snapshot();
    withPersona("alice", reads);
    await withPersona("bob", async () => {
      await Bun.sleep(1);
      return reads();
    });
    const after = snapshot();
    expect(after).toEqual(before);
    expect(after.persona).toBe(before.persona);
    expect(before.prompt).toBe(join(PROJECT_ROOT, "personas", "milky-green", "prompt.md"));
  });

  test("the installed persona's scope is exactly what is installed", () => {
    twoPersonas();
    const outside = activePersona();
    expect(withPersona(outside.id, activePersona)).toBe(outside);
  });

  test("resolves what installing her would, the environment's voices and models included", () => {
    for (const [name, value] of [
      ["TTS_VOICE_ID", "env-voice"],
      ["FISH_VOICE_ID_GENTLE", "env-gentle"],
      ["TTS_VOICE_ID_CALM", "env-calm"],
      ["MEM0_LLM_MODEL", "env/memory"],
      ["REFINE_MODEL", "env/refiner"],
      ["EMBED_MODEL", "env/embed"],
    ] as const) {
      setEnv(name, value);
    }
    write(
      "settings.yaml",
      "embeddings:\n  model: file/embed\nmemory:\n  qdrant:\n    port: 7000\n",
    );
    write("credentials.json", '{"accounts": {"work": {"provider": "anthropic"}}}');
    write(
      "personas/alice/persona.yaml",
      "voice:\n  voiceId: alice-voice\n  styles:\n    lively: alice-lively\n" +
        "mind:\n  provider: work\nrefine:\n  model: alice/refiner\n",
    );
    write("personas/bob/persona.yaml", "voice:\n  styles:\n    calm: bob-calm\n");
    setSettingDefaults((persona) => ({ MEM0_AGENT_ID: persona.id, TTS_MODEL: "s1" }));
    installSettings();
    // The install's choice of persona, an app setting no scope changes, is how this test installs.
    const kept = (name: string) => name !== "EIDOLON_PERSONA";
    const names = [
      ...SETTINGS.map((s) => s.env).filter(kept),
      ...["FISH_VOICE_ID", "FISH_VOICE_ID_GENTLE", "TTS_VOICE_ID_CALM", "TTS_VOICE_ID_LIVELY"],
    ];
    const snapshot = () => ({
      entries: envEntries().filter(([name]) => kept(name)),
      raw: names.map((name) => [name, envRaw(name)]),
      override: names.map((name) => [name, envOverride(name)]),
      persona: activePersona(),
      accounts: [...accountEntries()],
    });
    const ids = ["milky-green", "alice", "bob"];
    const scoped = ids.map((id) => withPersona(id, snapshot));
    expect(scoped[1]?.raw).toContainEqual(["FISH_VOICE_ID_GENTLE", undefined]);
    expect(scoped[1]?.raw).toContainEqual(["MEM0_LLM_MODEL", undefined]);
    expect(scoped[1]?.raw).toContainEqual(["MEM0_AGENT_ID", "alice"]);
    expect(scoped[2]?.raw).toContainEqual(["FISH_VOICE_ID_GENTLE", "env-gentle"]);
    expect(scoped[2]?.raw).toContainEqual(["TTS_VOICE_ID_CALM", "bob-calm"]);
    ids.forEach((id, i) => {
      setEnv("EIDOLON_PERSONA", id);
      installSettings();
      expect(snapshot(), id).toEqual(scoped[i] as ReturnType<typeof snapshot>);
    });
  });

  test("personaPath and personaFolders resolve in her folders", () => {
    twoPersonas();
    mkdirSync(join(dataHome(), "personas", "alice", "references"), { recursive: true });
    const own = join(dataHome(), "personas", "alice");
    expect(withPersona("alice", () => personaPath("prompt.md"))).toBe(join(own, "prompt.md"));
    expect(withPersona("alice", () => personaFolders("references"))).toEqual([
      join(own, "references"),
    ]);
    expect(personaFolders("references")).toEqual([
      join(PROJECT_ROOT, "personas", "milky-green", "references"),
    ]);
  });
});

describe("the scopes' settings", () => {
  test("are read once, until the settings or their defaults change", () => {
    twoPersonas();
    const first = withPersona("alice", activePersona);
    expect(withPersona("alice", activePersona)).toBe(first);
    write("personas/alice/persona.yaml", "identity:\n  name: Alice 2\nmind:\n  model: alice/v2\n");
    expect(withPersona("alice", reads).model).toBe("alice/chat");
    installSettings();
    expect(withPersona("alice", reads)).toMatchObject({ name: "Alice 2", model: "alice/v2" });
    setSettingDefaults((persona) => ({ MEM0_AGENT_ID: `${persona.id}-memories` }));
    expect(withPersona("alice", reads).agent).toBe("alice-memories");
    resetSettings();
    expect(withPersona("alice", activePersona)).not.toBe(first);
  });

  test("settingsGeneration moves whenever they are dropped, and only then", () => {
    twoPersonas();
    const seen = [settingsGeneration()];
    withPersona("alice", activePersona);
    expect(settingsGeneration()).toBe(seen[0] as number);
    installSettings();
    seen.push(settingsGeneration());
    setSettingDefaults(null);
    seen.push(settingsGeneration());
    resetSettings();
    seen.push(settingsGeneration());
    expect(new Set(seen).size).toBe(4);
  });
});

test("loadSettings reads the persona it is given without installing her", () => {
  twoPersonas();
  const alice = loadSettings("alice");
  expect(alice.persona.identity.name).toBe("Alice");
  expect(alice.values.get("LLM_MODEL")).toBe("alice/chat");
  expect(alice.values.get("LANCEDB_PATH")).toBe(
    join(dataHome(), "personas", "alice", "alice-index"),
  );
  expect(reads()).toEqual(GREEN);
});
