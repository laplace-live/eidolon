import "../../config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataHome } from "@eidolon/config";
import type { LlmTool, ToolEffects } from "@eidolon/core";
import { isSelfieConfigured, type ReferenceImage, SelfieStore } from "@eidolon/imagegen";
import {
  createSelfieTool,
  SELFIE_TOOL_NAME,
  type SelfieToolOptions,
  selfiePromptHint,
  selfieToolSchema,
} from "../src/index.ts";
import { SELFIE_HINT_FRIEND, SELFIE_SCHEMA_WIRE, SELFIE_SCHEMA_WIRE_FRIEND } from "./goldens.ts";
import {
  bytesOf,
  CancelledError,
  captureLogs,
  clearSelfieEnv,
  dataUrl,
  type FetchCall,
  fakeFetch,
  invoke,
  jsonResponse,
  logLines,
  removeTempDirs,
  restoreEnv,
  restoreLogs,
  setEnv,
  tempDir,
  tempTree,
  wire,
} from "./helpers.ts";

const B64 = "iVBORyBmYWtl";
const OUTFIT_DAY = dataUrl("image/png", bytesOf("day"));
const OUTFIT_NIGHT = dataUrl("image/png", bytesOf("night"));

let root: string;

beforeEach(() => {
  clearSelfieEnv();
  setEnv("OPENROUTER_API_KEY", "sk-test");
  root = tempTree({
    "outfits/day.png": bytesOf("day"),
    "outfits/night.png": bytesOf("night"),
    "friends/A.png": bytesOf("A"),
    "friends/B.png": bytesOf("B"),
  });
});
afterEach(() => {
  restoreEnv();
  restoreLogs();
});
afterAll(removeTempDirs);

function referencesSent(call: FetchCall | undefined): string[] {
  const references = (call?.payload.input_references ?? []) as ReferenceImage[];
  return references.map((reference) => reference.image_url.url);
}

function enabled(options: SelfieToolOptions = {}): LlmTool {
  const tool = createSelfieTool({ root, store: new SelfieStore(), ...options });
  if (!tool) throw new Error("take_selfie should be enabled");
  return tool;
}

function rendering(body: unknown = { data: [{ b64_json: B64 }], usage: { cost: 0.04 } }) {
  return fakeFetch(() => jsonResponse(200, body));
}

describe("selfieToolSchema", () => {
  test("serializes exactly as Python's schema does, with and without friends", () => {
    const schema = selfieToolSchema([]);
    expect(schema.name).toBe(SELFIE_TOOL_NAME);
    expect(schema.properties).toEqual({});
    expect(schema.required).toEqual([]);
    expect(wire(schema)).toBe(SELFIE_SCHEMA_WIRE);
    expect(wire(selfieToolSchema(["七海Nana7mi"]))).toBe(SELFIE_SCHEMA_WIRE_FRIEND);
  });
});

describe("createSelfieTool", () => {
  test("is disabled without a key", () => {
    const records = captureLogs();
    setEnv("OPENROUTER_API_KEY", undefined);
    expect(createSelfieTool({ root })).toBeNull();
    setEnv("OPENROUTER_API_KEY", "");
    expect(createSelfieTool({ root })).toBeNull();
    expect(logLines(records)).toEqual([
      "INFO [selfie] Disabled: OPENROUTER_API_KEY is unset.",
      "INFO [selfie] Disabled: OPENROUTER_API_KEY is unset.",
    ]);
  });

  test("is disabled without any outfit", () => {
    const records = captureLogs();
    const empty = tempTree({ "friends/A.png": bytesOf("A") });
    expect(createSelfieTool({ root: empty })).toBeNull();
    expect(logLines(records)).toEqual([`INFO [selfie] Disabled: no reference images in ${empty}.`]);
  });

  test("is disabled, with a warning, when the outfit can't be encoded", () => {
    const records = captureLogs();
    setEnv("SELFIE_REFERENCE_IMAGES", " eidolon-missing.png , ,");
    expect(createSelfieTool({ root })).toBeNull();
    const notes = join(tempTree({ "notes.txt": "not an image" }), "notes.txt");
    setEnv("SELFIE_REFERENCE_IMAGES", notes);
    expect(createSelfieTool({ root })).toBeNull();
    expect(logLines(records)).toEqual([
      "WARNING [selfie] Disabled: eidolon-missing.png: no such file",
      `WARNING [selfie] Disabled: ${notes}: not a recognizable image type`,
    ]);
    // The cheap check never reads the type, so it still says yes here.
    expect(isSelfieConfigured({ root })).toBe(true);
  });

  test("is an asynchronous tool bounded by SELFIE_TIMEOUT_SECONDS", () => {
    const records = captureLogs();
    const tool = enabled();
    expect(tool.cancelOnInterruption).toBe(false);
    expect(tool.timeoutSecs).toBe(120);
    expect(tool.schema).toEqual(selfieToolSchema(["A", "B"]));
    expect(logLines(records)).toEqual([
      expect.stringMatching(
        /^INFO \[selfie\] Enabled\. Outfit for this hour: (day|night)\.png \(re-picked per render\)\.$/,
      ),
      "INFO [selfie] Friend references available: ['A', 'B']",
    ]);
  });

  test("reads the timeout as an int: 0 stays 0, a float falls back to 120", () => {
    const records = captureLogs();
    setEnv("SELFIE_TIMEOUT_SECONDS", "0");
    expect(enabled().timeoutSecs).toBe(0);
    setEnv("SELFIE_TIMEOUT_SECONDS", "90.5");
    records.length = 0;
    expect(enabled().timeoutSecs).toBe(120);
    expect(logLines(records)[0]).toMatch(
      /^WARNING SELFIE_TIMEOUT_SECONDS=.90\.5. is not a valid int; using default 120$/,
    );
  });

  test("names a URL outfit by its last path component", () => {
    const records = captureLogs();
    setEnv("SELFIE_REFERENCE_IMAGES", "https://example.com/a.png,https://example.com/b-night.png");
    enabled({ now: () => new Date() });
    expect(logLines(records)[0]).toMatch(/Outfit for this hour: (a|b-night)\.png/);
  });
});

describe("take_selfie", () => {
  const cases: [Record<string, unknown>, number, RegExp][] = [
    [{}, 1, /Exactly one person is in the picture/],
    [{ with_friends: ["A", "Stranger"] }, 2, /Also in frame: A\. Exactly 2 people/],
    [{ with_friends: "A" }, 1, /Exactly one person is in the picture/],
    [{ with_friends: ["A", "A"] }, 3, /Also in frame: A, A\. Exactly 3 people/],
    [{ with_friends: null }, 1, /Exactly one person is in the picture/],
    [{ with_friends: ["B", "A"] }, 3, /Also in frame: B, A\. Exactly 3 people/],
  ];

  test("each probed call sends the references and prompt Python sends", async () => {
    captureLogs();
    for (const [args, references, prompt] of cases) {
      const { fetch, calls } = rendering();
      const store = new SelfieStore();
      const { events, result } = await invoke(enabled({ fetch, store }), args);
      expect(result).toEqual({ ok: true, count: 1 });
      expect(referencesSent(calls[0])).toHaveLength(references);
      expect(String(calls[0]?.payload.prompt)).toMatch(prompt);
      const [push, done] = events;
      expect(push?.slice(0, 2)).toEqual(["push", "RTVIServerMessageFrame"]);
      expect(done).toEqual(["result", { ok: true, count: 1 }]);
      const message = push?.[2] as { type: string; urls: string[] };
      expect(Object.keys(message)).toEqual(["type", "urls"]);
      expect(message.type).toBe("selfie");
      expect(message.urls).toHaveLength(1);
      expect(store.lookup(message.urls[0]?.split("/").at(-1) as string)).not.toBeNull();
    }
  });

  test("sends friends after the outfit, in the order named", async () => {
    captureLogs();
    const { fetch, calls } = rendering();
    await invoke(enabled({ fetch, now: () => new Date("2026-11-03T04:00:00Z") }), {
      with_friends: ["B", "A"],
    });
    expect(referencesSent(calls[0])).toEqual([
      OUTFIT_DAY,
      dataUrl("image/png", bytesOf("B")),
      dataUrl("image/png", bytesOf("A")),
    ]);
  });

  test("warns about names it can't draw and logs the group", async () => {
    const records = captureLogs();
    const tool = enabled({ fetch: rendering().fetch });
    records.length = 0;
    await invoke(tool, { with_friends: ["A", "Stranger", 7] });
    expect(logLines(records)).toEqual([
      "WARNING [selfie] LLM named unknown friends ['Stranger', '7']; known: ['A', 'B']",
      "INFO [selfie] Group selfie with ['A']",
      "INFO [selfie] Generated 1 image(s), cost $0.0400",
    ]);
  });

  test("renders with the bot's settings", async () => {
    captureLogs();
    const first = rendering();
    await invoke(enabled({ fetch: first.fetch }), {});
    const payload = first.calls[0]?.payload ?? {};
    expect(Object.keys(payload)).toEqual([
      "model",
      "prompt",
      "n",
      "input_references",
      "aspect_ratio",
    ]);
    expect([payload.model, payload.n, payload.aspect_ratio]).toEqual([
      "openai/gpt-image-2.5-flare",
      1,
      "3:4",
    ]);
    expect(first.calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer sk-test" });

    setEnv("SELFIE_MODEL", "m/x");
    setEnv("SELFIE_ASPECT_RATIO", "auto");
    setEnv("SELFIE_QUALITY", "high");
    const second = rendering();
    await invoke(enabled({ fetch: second.fetch }), {});
    const overridden = second.calls[0]?.payload ?? {};
    expect(Object.keys(overridden)).toEqual([
      "model",
      "prompt",
      "n",
      "input_references",
      "quality",
    ]);
    expect([overridden.model, overridden.quality]).toEqual(["m/x", "high"]);
  });

  test("publishes for SELFIE_TTL_SECONDS", async () => {
    captureLogs();
    setEnv("SELFIE_TTL_SECONDS", "0");
    const store = new SelfieStore();
    const { events } = await invoke(enabled({ fetch: rendering().fetch, store }), {});
    const message = events[0]?.[2] as { urls: string[] };
    const url = message.urls[0] as string;
    expect(store.lookup(url.split("/").at(-1) as string)).toBeNull();
  });

  test("reads the clock once per call, so the light and the outfit agree", async () => {
    captureLogs();
    const { fetch, calls } = rendering();
    // Creation at noon, then calls at 20:59:59.999 and 21:00 in Shanghai. Reading twice within
    // the first call could pair dusk light with the night outfit.
    const instants = ["2026-11-03T04:00:00Z", "2026-11-03T12:59:59.999Z", "2026-11-03T13:00:00Z"];
    const now = () => new Date(instants.shift() as string);
    const tool = enabled({ fetch, now });
    await invoke(tool, {});
    expect(instants).toHaveLength(1);
    expect(String(calls[0]?.payload.prompt)).toContain("Time: it is dusk, about 20:59 local time.");
    expect(referencesSent(calls[0])).toEqual([OUTFIT_DAY]);
    await invoke(tool, {});
    expect(String(calls[1]?.payload.prompt)).toContain(
      "Time: it is night, about 21:00 local time.",
    );
    expect(referencesSent(calls[1])).toEqual([OUTFIT_NIGHT]);
  });

  test("a failed render reports the error and sends no picture", async () => {
    const records = captureLogs();
    const { fetch } = fakeFetch(() =>
      jsonResponse(402, { error: { message: "Insufficient credits", code: 402 } }),
    );
    const tool = enabled({ fetch });
    records.length = 0;
    const { events } = await invoke(tool, {});
    expect(events).toEqual([
      ["result", { ok: false, error: "Selfie generation failed: 402: Insufficient credits" }],
    ]);
    expect(logLines(records)).toEqual([
      "WARNING [selfie] Selfie generation failed: 402: Insufficient credits",
    ]);
  });

  test("a friend whose file can't be loaded drops every friend for a solo shot", async () => {
    const records = captureLogs();
    // A friends/ directory found relative to the working directory but named with a leading ~,
    // which loadReference expands to the home directory, where nothing exists.
    const work = tempDir();
    const missingHome = `eidolon-${crypto.randomUUID()}`;
    tempTree(
      { [`~/${missingHome}/friends/A.png`]: bytesOf("A"), "outfit.png": bytesOf("o") },
      work,
    );
    setEnv("SELFIE_REFERENCE_IMAGES", join(work, "outfit.png"));
    const cwd = process.cwd();
    process.chdir(work);
    try {
      const { fetch, calls } = rendering();
      const tool = enabled({ root: `~/${missingHome}`, fetch });
      const { result } = await invoke(tool, { with_friends: ["A"] });
      expect(result).toEqual({ ok: true, count: 1 });
      expect(referencesSent(calls[0])).toEqual([dataUrl("image/png", bytesOf("o"))]);
      expect(String(calls[0]?.payload.prompt)).toContain("Exactly one person is in the picture");
      expect(logLines(records)).toContain(
        `WARNING [selfie] ${join(homedir(), missingHome, "friends", "A.png")}: no such file`,
      );
    } finally {
      process.chdir(cwd);
    }
  });

  test("an abort rejects with the signal's reason and sends nothing", async () => {
    captureLogs();
    let started = () => {};
    const fetched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hanging = ((_input: string | URL | Request, init: BunFetchRequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        started();
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    const sent: unknown[] = [];
    const effects: ToolEffects = {
      switchVoice: async () => {},
      sendServerMessage: async (data) => {
        sent.push(data);
      },
    };
    const controller = new AbortController();
    const context = { getMessages: () => [], setMessages: () => {}, setHiddenTools: () => {} };
    const pending = enabled({ fetch: hanging }).run(
      { arguments: {}, context, signal: controller.signal },
      effects,
    );
    await fetched;
    const reason = new CancelledError("Task cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(sent).toEqual([]);
  });

  test("an unexpected response propagates instead of becoming a result", async () => {
    captureLogs();
    const { fetch } = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(invoke(enabled({ fetch }), {})).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("selfiePromptHint", () => {
  // The template ships outfits only; the friend lives in the user's data home.
  const personas = () => join(dataHome(), "personas");
  afterEach(() => rmSync(personas(), { recursive: true, force: true }));
  function privateFriend(): void {
    const dir = join(personas(), "milky-green", "references", "friends");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "七海Nana7mi.png"), bytesOf("nana"));
  }

  test("names the user's friend exactly as Python named the bundled one", () => {
    privateFriend();
    expect(selfiePromptHint()).toBe(SELFIE_HINT_FRIEND);
  });

  test("is the first line alone without friends", () => {
    const bare = tempTree({ "outfits/day.png": bytesOf("day") });
    expect(selfiePromptHint({ root: bare })).toBe(SELFIE_HINT_FRIEND.split("\n")[0] as string);
  });

  test("is empty when selfies aren't configured", () => {
    setEnv("OPENROUTER_API_KEY", undefined);
    expect(selfiePromptHint()).toBe("");
    setEnv("OPENROUTER_API_KEY", "sk-test");
    expect(selfiePromptHint({ root: tempDir() })).toBe("");
  });
});
