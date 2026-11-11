// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/test/test_async_tool_messages.test.ts@ce8f8bc
import { describe, expect, test } from "bun:test";
import {
  asyncToolCallId,
  cancelledEnvelope,
  finalEnvelope,
  startedEnvelope,
} from "../src/async_tool.ts";

const payload = (content: string) => JSON.parse(content) as Record<string, unknown>;

describe("the envelopes", () => {
  test("started: running, no result, in Python's json.dumps layout", () => {
    expect(startedEnvelope("call_42")).toBe(
      '{"type": "async_tool", "status": "running", "tool_call_id": "call_42", "description": ' +
        '"This tool is still running. You will be given its result later. Do not call it again ' +
        'and do not invent a result in the meantime."}',
    );
  });

  test("final: finished, carrying the encoded result as a string", () => {
    const content = finalEnvelope("call_7", '{"ok": true, "count": 1}');
    expect(content).toStartWith(
      '{"type": "async_tool", "status": "finished", "tool_call_id": "call_7", "description": ' +
        '"This is the final result for the asynchronous task',
    );
    expect(content).toEndWith(', "result": "{\\"ok\\": true, \\"count\\": 1}"}');
    expect(payload(content).result).toBe('{"ok": true, "count": 1}');
    expect(payload(finalEnvelope("call_1", "COMPLETED")).result).toBe("COMPLETED");
  });

  test("cancelled: finished, its result naming the call as what was cancelled", () => {
    const content = payload(cancelledEnvelope("call_5"));
    expect(content.type).toBe("async_tool");
    expect(content.status).toBe("finished");
    expect(content.tool_call_id).toBe("call_5");
    expect(content.result).toBe(
      "CANCELLED: this tool call was cancelled before it returned a result",
    );
    expect(String(content.description)).toContain("cancelled before it produced a result");
  });

  test("a non-ASCII result is not escaped a second time", () => {
    const result = '{"status": "आपका ऑर्डर कल पहुँचेगा", "note": "拍好了"}';
    const content = finalEnvelope("call_x", result);
    expect(content).toContain("आपका ऑर्डर कल पहुँचेगा");
    expect(content).toContain("拍好了");
    expect(content).not.toContain("\\u");
    expect(payload(content).result).toBe(result);
  });
});

describe("asyncToolCallId", () => {
  test("reads each envelope's call back", () => {
    expect(asyncToolCallId(startedEnvelope("abc"))).toBe("abc");
    expect(asyncToolCallId(finalEnvelope("abc", '"done"'))).toBe("abc");
    expect(asyncToolCallId(cancelledEnvelope("abc"))).toBe("abc");
  });

  test("is null for anything else", () => {
    for (const content of [
      "hello",
      "IN_PROGRESS",
      "{not json",
      "[1, 2, 3]",
      "null",
      JSON.stringify({ type: "something_else", tool_call_id: "x", status: "running" }),
      JSON.stringify({ type: "async_tool", status: "running" }),
      JSON.stringify({ type: "async_tool", tool_call_id: "x", status: "weird" }),
      JSON.stringify({ type: "async_tool", tool_call_id: 7, status: "running" }),
    ]) {
      expect(asyncToolCallId(content)).toBeNull();
    }
  });
});
