// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/ai/test/validation.test.ts@ac78a60
//
// pi's cases on plain JSON schemas; a tool's schema here is its properties and required list.
import type { ToolSchema } from "@eidolon/core";
import { describe, expect, test } from "vitest";
import { validateToolArguments } from "../src/task/validate.ts";

function echo(value: Readonly<Record<string, unknown>>): ToolSchema {
  return { name: "echo", description: "Echo tool", properties: { value }, required: ["value"] };
}

describe("validateToolArguments", () => {
  test("coerces a loosely typed value towards its schema", () => {
    const passing: [Record<string, unknown>, unknown, unknown][] = [
      [{ type: "number" }, "42", 42],
      [{ type: "number" }, true, 1],
      [{ type: "number" }, null, 0],
      [{ type: "integer" }, "42", 42],
      [{ type: "boolean" }, "true", true],
      [{ type: "boolean" }, "false", false],
      [{ type: "boolean" }, 1, true],
      [{ type: "boolean" }, 0, false],
      [{ type: "string" }, null, "null"],
      [{ type: "string" }, true, "true"],
      [{ type: "null" }, "", null],
      [{ type: "null" }, 0, null],
      [{ type: "null" }, false, null],
      [{ type: ["number", "string"] }, "1", "1"],
      [{ type: ["boolean", "number"] }, "1", 1],
      [{ type: "boolean" }, "1", true],
      [{ type: "boolean" }, "0", false],
      [{ type: "null" }, "null", null],
      [{ type: "integer" }, "42.1", 42],
      [{ type: "array", items: { type: "number" } }, "7", [7]],
    ];
    for (const [schema, input, expected] of passing) {
      expect(validateToolArguments(echo(schema), { value: input })).toEqual({ value: expected });
    }
  });

  test("treats null as omission for an optional property that doesn't take null", () => {
    const schema: ToolSchema = {
      name: "echo",
      description: "Echo tool",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
        metadata: { type: "object", properties: { enabled: { type: "boolean" } } },
      },
      required: ["path", "metadata"],
    };
    expect(
      validateToolArguments(schema, {
        path: "file.txt",
        offset: null,
        nullable: null,
        metadata: { enabled: null },
      }),
    ).toEqual({ path: "file.txt", nullable: null, metadata: {} });
  });

  test("keeps a value that already matches one arm of a union", () => {
    expect(
      validateToolArguments(echo({ anyOf: [{ type: "number" }, { type: "null" }] }), {
        value: null,
      }),
    ).toEqual({ value: null });
    expect(
      validateToolArguments(echo({ oneOf: [{ type: "number" }, { type: "null" }] }), {
        value: null,
      }),
    ).toEqual({ value: null });
  });

  test("coerces towards a union's arms when the value matches none of them", () => {
    expect(
      validateToolArguments(echo({ anyOf: [{ type: "number" }, { type: "null" }] }), {
        value: "42",
      }),
    ).toEqual({ value: 42 });
  });

  test("takes null for a nullable array", () => {
    expect(
      validateToolArguments(echo({ type: ["array", "null"], items: { type: "string" } }), {
        value: null,
      }),
    ).toEqual({ value: null });
  });

  test("rejects what can't be coerced", () => {
    const failing: [Record<string, unknown>, unknown][] = [
      [{ type: "boolean" }, "yes"],
      [{ type: "number" }, "abc"],
      [{ type: "null" }, "nil"],
      [{ type: "integer" }, "4x"],
    ];
    for (const [schema, input] of failing) {
      expect(() => validateToolArguments(echo(schema), { value: input })).toThrow(
        "Validation failed",
      );
    }
  });

  test("lists each issue, then the arguments it received", () => {
    expect(() => validateToolArguments(echo({ type: "number" }), { value: "many" })).toThrow(
      'Validation failed for tool "echo":\n  - value: expected number, got string\n\n' +
        'Received arguments:\n{\n  "value": "many"\n}',
    );
  });

  test("reports a missing required property at the property", () => {
    expect(() => validateToolArguments(echo({ type: "string" }), {})).toThrow("  - value: missing");
  });

  test("reports a nested issue at its dotted path", () => {
    const schema: ToolSchema = {
      name: "edit",
      description: "Edit tool",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { oldText: { type: "string" }, newText: { type: "string" } },
            required: ["oldText", "newText"],
          },
        },
        mode: { type: "string", enum: ["replace", "append"] },
      },
      required: ["edits"],
    };
    expect(() =>
      validateToolArguments(schema, { edits: [{ oldText: "a" }], mode: "delete" }),
    ).toThrow('  - edits.0.newText: missing\n  - mode: expected one of ["replace","append"]');
  });

  test("repeats no more than 2,000 characters of the arguments it rejects", () => {
    const write: ToolSchema = {
      name: "write",
      description: "Write tool",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    };
    const content = "<div>".padEnd(150_000, "y");
    let message = "";
    try {
      validateToolArguments(write, { file_path: "index.html", content });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith(
      'Validation failed for tool "write":\n  - path: missing\n\nReceived arguments:\n' +
        '{\n  "file_path": "index.html",\n  "content": "<div>yyy',
    );
    expect(message).toEndWith("yyy\n... [truncated]");
    expect(message.length).toBeLessThan(2_200);
  });

  test("returns a copy of the arguments, also when nothing is coerced", () => {
    const args = { value: "x" };
    const validated = validateToolArguments(echo({ type: "string" }), args);
    expect(validated).toEqual({ value: "x" });
    expect(validated).not.toBe(args);
  });
});
