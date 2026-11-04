import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { pyJsonDumps } from "@eidolon/config";
import { ADDITIVE_EXTRACTION_PROMPT, AGENT_CONTEXT_SUFFIX } from "../src/extraction-prompt.ts";
import { generateAdditiveExtractionPrompt, type StoredMessage } from "../src/prompts.ts";
import { pyJsonLoads } from "../src/py-json.ts";
import { buildSessionScope, scopeFilters } from "../src/scope.ts";
import {
  extractJson,
  md5Hex,
  parseExtraction,
  parseMessages,
  removeCodeBlocks,
} from "../src/text.ts";
import fixtures from "./fixtures/text.json";
import { captureLogs } from "./support.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("extraction prompts", () => {
  test("system prompts are mem0's bytes", () => {
    expect(sha256(ADDITIVE_EXTRACTION_PROMPT)).toBe(
      "ad19187a37813ef77ee156e714c0650e6ec749e0264bdc07d499bc9b24115155",
    );
    expect(sha256(AGENT_CONTEXT_SUFFIX)).toBe(
      "04d709c8ef32bb65ea74c5a91ca99d283d76bea2ee1b25059cb94956c96230ad",
    );
    expect(Buffer.byteLength(ADDITIVE_EXTRACTION_PROMPT)).toBe(33831);
  });

  const row = (role: unknown, content: unknown): StoredMessage => ({
    role,
    content,
    name: null,
    created_at: "x",
  });

  test("golden user prompt with history and existing memories", () => {
    const prompt = generateAdditiveExtractionPrompt({
      existingMemories: [
        { id: "0", text: '用户喜欢"猫"' },
        { id: "1", text: "User likes tea" },
      ],
      newMessages: "user: 我养了一只猫\nassistant: 好可爱\n",
      lastKMessages: [row("user", "早上好")],
      currentDate: "2026-11-03",
    });
    expect(prompt).toBe(fixtures.prompt_golden_1);
  });

  test("golden user prompt with nothing to go on", () => {
    const prompt = generateAdditiveExtractionPrompt({
      existingMemories: [],
      newMessages: "user: hi\n",
      lastKMessages: [],
      currentDate: "2026-11-03",
    });
    expect(prompt).toBe(fixtures.prompt_golden_2);
  });

  test("history truncates by code point and skips empty rows; memories serialize as json.dumps", () => {
    const prompt = generateAdditiveExtractionPrompt({
      existingMemories: [
        { id: "0", text: "a\nb \t\\\x01é😀" },
        { id: "1", text: null },
        { id: "2", text: 5 },
      ],
      newMessages: "user: x\n",
      lastKMessages: [
        row("user", "猫".repeat(301)),
        row("assistant", "😀".repeat(301)),
        row("user", "猫".repeat(300)),
        row("", "skip"),
        row("user", ""),
        row("user", null),
      ],
      currentDate: "2026-11-03",
    });
    expect(prompt).toBe(fixtures.prompt_truncation);
  });
});

describe("text helpers", () => {
  test("parse_messages keeps system/user/assistant lines with content", () => {
    const messages = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "嗨\n你好" },
      { role: "tool", content: "x" },
      { role: "assistant", tool_calls: [{ id: "1" }] },
      { role: "system", content: "sys" },
    ];
    expect(parseMessages(messages)).toBe(fixtures.parse_messages);
  });

  for (const [input, expected] of fixtures.remove_code_blocks as [unknown, string][]) {
    test(`remove_code_blocks ${JSON.stringify(input)}`, () => {
      expect(removeCodeBlocks(input)).toBe(expected);
    });
  }

  test("remove_code_blocks raises as str.join does on a non-string text part", () => {
    expect(() => removeCodeBlocks([{ text: null }])).toThrow(
      "sequence item 0: expected str instance, NoneType found",
    );
  });

  for (const [input, expected] of fixtures.extract_json as [string, string][]) {
    test(`extract_json ${JSON.stringify(input)}`, () => {
      expect(extractJson(input)).toBe(expected);
    });
  }

  test("md5 of UTF-8", () => {
    expect(md5Hex("用户对海鲜过敏")).toBe("4d68311fc61acf9f9c131e5faf45a276");
  });
});

describe("json.loads(strict=False)", () => {
  for (const [input, ok, expected] of fixtures.json_loads as [string, boolean, string][]) {
    test(JSON.stringify(input), () => {
      if (!ok) {
        expect(() => pyJsonLoads(input)).toThrow(expected);
        return;
      }
      const value = pyJsonLoads(input);
      // JS has one number type, so 1500.0 and 10**22 can't round-trip Python's spelling.
      if (input.includes("1.5e3")) expect(value).toEqual({ a: 1500, b: 0, c: 1e22 });
      else expect(pyJsonDumps(value, { ensureAscii: true })).toBe(expected);
    });
  }

  test("errors are JSONDecodeError with code-point positions", () => {
    let error: Error | undefined;
    try {
      pyJsonLoads('{"猫": 1,\n "b": }');
    } catch (e) {
      error = e as Error;
    }
    expect(error?.name).toBe("JSONDecodeError");
    expect(error?.message).toBe("Expecting value: line 2 column 7 (char 15)");
  });

  test("a __proto__ key stays an own property", () => {
    const value = pyJsonLoads('{"__proto__": {"text": "x"}}') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  test("a BOM is refused", () => {
    expect(() => pyJsonLoads("﻿{}")).toThrow(
      "Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)",
    );
  });
});

describe("parseExtraction", () => {
  test("a raw newline inside a string parses", () => {
    expect(parseExtraction('{"memory": [{"text": "a\nb"}]}')).toEqual([{ text: "a\nb" }]);
  });

  test("falls back to the outermost braces", () => {
    expect(parseExtraction('Sure! {"memory": [{"text": "x"}]} done')).toEqual([{ text: "x" }]);
  });

  test("a top-level array is logged and yields []", () => {
    const logs = captureLogs();
    expect(parseExtraction("[1]")).toEqual([]);
    logs.stop();
    expect(logs.at("ERROR")).toEqual([
      ["ERROR", "Error parsing extraction response: 'list' object has no attribute 'get'"],
    ]);
  });

  test("a missing or null memory key is passed through for the caller to judge", () => {
    expect(parseExtraction('{"facts": ["x"]}')).toEqual([]);
    expect(parseExtraction('{"memory": null}')).toBeNull();
  });
});

describe("scope", () => {
  for (const [value, ok, expected] of fixtures.validate_entity_id as [
    unknown,
    boolean,
    string | null,
  ][]) {
    if (typeof value !== "string") continue;
    test(`validate ${JSON.stringify(value)}`, () => {
      if (ok) expect(scopeFilters({ userId: value })).toEqual({ user_id: expected as string });
      else expect(() => scopeFilters({ userId: value })).toThrow(expected as string);
    });
  }

  test("null ids are absent and keys keep mem0's order", () => {
    expect(scopeFilters({ userId: null })).toEqual({});
    expect(Object.keys(scopeFilters({ runId: "r", agentId: "a", userId: "u" }))).toEqual([
      "user_id",
      "agent_id",
      "run_id",
    ]);
  });

  for (const [filters, expected] of fixtures.session_scope as [Record<string, string>, string][]) {
    test(`session scope ${JSON.stringify(filters)}`, () => {
      expect(buildSessionScope(filters)).toBe(expected);
    });
  }
});
