import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pyJsonDumps } from "@eidolon/config";
import {
  parseRecallRequest,
  RECALL_PERIODS,
  RECALL_STREAMS_SCHEMA,
  RECALL_TOOL_NAME,
  RecallRequestError,
} from "../src/index.ts";

interface RequestCase {
  args: Record<string, unknown>;
  ok?: Record<string, unknown>;
  error?: string;
}

// Each `args` with what validating it yields: the request, or the error text pydantic 2.13 gives.
// JSON.parse rounds integers past 2^53 before any code sees them, so a repr of one can't match.
const cases = (
  JSON.parse(
    readFileSync(new URL("./fixtures/recall_requests.json", import.meta.url), "utf8"),
  ) as RequestCase[]
).filter((c) =>
  Object.values(c.args).every(
    (v) => typeof v !== "number" || Math.abs(v) <= Number.MAX_SAFE_INTEGER,
  ),
);

// The tool's schema as sent on the wire, and the kwargs it is registered with.
const python = JSON.parse(
  readFileSync(new URL("./fixtures/recall_schema.json", import.meta.url), "utf8"),
) as { schema: Record<string, unknown>; register_kwargs: Record<string, unknown> };

function label(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

describe("parseRecallRequest matches pydantic", () => {
  test("the oracle covers both outcomes", () => {
    expect(cases.filter((c) => c.ok).length).toBeGreaterThan(50);
    expect(cases.filter((c) => c.error).length).toBeGreaterThan(100);
  });

  for (const [index, c] of cases.entries()) {
    test(`#${index} ${label(c.args)}`, () => {
      if (c.ok !== undefined) {
        expect(parseRecallRequest(c.args)).toEqual(c.ok as never);
        return;
      }
      let thrown: unknown;
      try {
        parseRecallRequest(c.args);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RecallRequestError);
      expect((thrown as Error).message).toBe(c.error as string);
    });
  }

  test("a non-object is a model_type error", () => {
    expect(() => parseRecallRequest(null)).toThrow(
      "1 validation error for RecallRequest\n" +
        "  Input should be a valid dictionary or instance of RecallRequest " +
        "[type=model_type, input_value=None, input_type=NoneType]\n" +
        "    For further information visit https://errors.pydantic.dev/2.13/v/model_type",
    );
  });

  test("undefined counts as an absent key", () => {
    expect(
      parseRecallRequest({ query: "q", mode: "details", period: "all", days: undefined }).days,
    ).toBe(7);
  });
});

describe("RECALL_STREAMS_SCHEMA", () => {
  test("is Python's function schema, byte for byte", () => {
    const { name, description, properties, required } = RECALL_STREAMS_SCHEMA;
    const wire = { name, description, parameters: { type: "object", properties, required } };
    expect(pyJsonDumps(wire, { ensureAscii: false })).toBe(
      pyJsonDumps(python.schema, { ensureAscii: false }),
    );
    expect(python.register_kwargs).toEqual({ cancel_on_interruption: true });
  });

  test("names the tool and its periods", () => {
    expect(RECALL_TOOL_NAME).toBe("recall_streams");
    expect(RECALL_STREAMS_SCHEMA.name).toBe(RECALL_TOOL_NAME);
    expect((RECALL_STREAMS_SCHEMA.properties.period as { enum: string[] }).enum).toEqual([
      ...RECALL_PERIODS,
    ]);
  });
});
