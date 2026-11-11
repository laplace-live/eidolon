// The async-tool messages a persona's view holds, against the builders pipedog's call context used.
import { describe, expect, test } from "bun:test";
import * as pipedog from "@pipedog/core/processors/aggregators/async_tool_messages";
import {
  cancelledEnvelope,
  finalEnvelope,
  startedEnvelope,
  toolCallMessages,
} from "../../../chat/src/index.ts";

const CALL_IDS = ["call_42", "toolu_01AbC", '引号"和\\反斜杠', "line\nbreak\ttab"];
const RESULTS = [
  "COMPLETED",
  '{"ok": true, "count": 2}',
  '{"ok": false, "error": "生成失败：超时"}',
  '{"note": "emoji 😀, quote \\" and newline \\n", "ctrl": "\\u0001"}',
];

describe("async-tool envelopes are pipedog's, byte for byte", () => {
  test("started, as her view's tool placeholder", () => {
    for (const id of CALL_IDS) {
      const [, placeholder] = toolCallMessages(
        { callId: id, name: "take_selfie", arguments: {} },
        "started",
      );
      expect(placeholder).toEqual(pipedog.buildStartedMessage(id) as typeof placeholder);
      expect(startedEnvelope(id)).toBe(pipedog.buildStartedMessage(id).content as string);
    }
  });

  test("final", () => {
    for (const id of CALL_IDS) {
      for (const result of RESULTS) {
        expect(finalEnvelope(id, result)).toBe(
          pipedog.buildFinalResultMessage(id, result).content as string,
        );
      }
    }
  });

  test("cancelled", () => {
    for (const id of CALL_IDS) {
      expect(cancelledEnvelope(id)).toBe(pipedog.buildCancelledMessage(id).content as string);
    }
  });
});
