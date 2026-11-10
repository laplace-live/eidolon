import { expect, mock, test } from "bun:test";
import { linguiMacro } from "@/test/lingui-macro";

mock.module("@lingui/core/macro", linguiMacro);
const { callLine } = await import("./call-line");

const started = { kind: "call", seq: 4, edge: "started", persona: "mio" } as const;
const line = (...args: Parameters<typeof callLine>) => callLine(...args).message;

test("a call's start names her, and how long it ran once it has ended", () => {
  expect(line({ ...started, durationMs: null }, "奶绿")).toBe("Call with 奶绿");
  expect(line({ ...started, durationMs: 192_000 }, "奶绿")).toBe("Call with 奶绿 · 3:12");
  expect(line({ ...started, durationMs: 5_400 }, "奶绿")).toBe("Call with 奶绿 · 0:05");
  expect(line({ ...started, durationMs: 4_500_000 }, "奶绿")).toBe("Call with 奶绿 · 1:15:00");
});

test("its end says only that it ended", () => {
  expect(line({ ...started, edge: "ended", durationMs: 192_000 }, "奶绿")).toBe("Call ended");
  expect(line({ ...started, edge: "ended", persona: null, durationMs: null }, "")).toBe(
    "Call ended",
  );
});

test("a group call's start says the whole group was on it", () => {
  const group = { ...started, group: true } as const;
  expect(line({ ...group, durationMs: null }, "奶绿")).toBe("Group call");
  expect(line({ ...group, durationMs: 192_000 }, "奶绿")).toBe("Group call · 3:12");
  expect(line({ ...group, edge: "ended", durationMs: 192_000 }, "奶绿")).toBe("Call ended");
});
