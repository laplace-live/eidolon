import { expect, mock, test } from "bun:test";
import { linguiMacro } from "@/test/lingui-macro";

mock.module("@lingui/core/macro", linguiMacro);
const { toolState } = await import("./labels");

test("her task tools each say what she is doing while they run", () => {
  const tools = ["start_task", "steer_task", "stop_task", "check_task"];
  expect(tools.map((name) => toolState(name).message)).toEqual([
    "Starting a task…",
    "Passing it on to the task…",
    "Stopping the task…",
    "Checking on the task…",
  ]);
});

test("a tool with no words of its own reads as any tool", () => {
  expect(toolState("web_fetch").message).toBe("Using a tool…");
});
