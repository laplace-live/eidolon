import { describe, expect, test } from "bun:test";
import { CHAT_DISPLAYS } from "@eidolon/chat";
import { CHAT_COMMANDS, parseCommand } from "./commands";

describe("parseCommand", () => {
  test("the three displays and stop, each alone, run", () => {
    expect(CHAT_COMMANDS).toEqual([...CHAT_DISPLAYS, "stop"]);
    for (const command of CHAT_COMMANDS) {
      expect(parseCommand(`/${command}`)).toEqual({ kind: "command", command });
    }
  });

  test("a command runs in any case, after a full-width slash, and with space around it", () => {
    expect(parseCommand("/Focus")).toEqual({ kind: "command", command: "focus" });
    expect(parseCommand("/VERBOSE")).toEqual({ kind: "command", command: "verbose" });
    expect(parseCommand("／stop")).toEqual({ kind: "command", command: "stop" });
    expect(parseCommand("  /normal \n")).toEqual({ kind: "command", command: "normal" });
    expect(parseCommand("　/focus　")).toEqual({ kind: "command", command: "focus" });
  });

  test("a command with anything after it is refused, never sent as a line", () => {
    expect(parseCommand("/stop 2")).toEqual({ kind: "trailing", command: "stop" });
    expect(parseCommand("/focus please")).toEqual({ kind: "trailing", command: "focus" });
    expect(parseCommand("/focus\nhi")).toEqual({ kind: "trailing", command: "focus" });
    expect(parseCommand("／Verbose 一下")).toEqual({ kind: "trailing", command: "verbose" });
  });

  test("a bare slash word that names no command is refused, as typed", () => {
    expect(parseCommand("/vebose")).toEqual({ kind: "unknown", typed: "/vebose" });
    expect(parseCommand(" /Foo ")).toEqual({ kind: "unknown", typed: "/Foo" });
    expect(parseCommand("/stopnow")).toEqual({ kind: "unknown", typed: "/stopnow" });
    expect(parseCommand("／help")).toEqual({ kind: "unknown", typed: "／help" });
  });

  test("anything else is a line for her, a path or a slash before words included", () => {
    for (const draft of [
      "/usr/local/bin 里那个",
      "/ 你好",
      "//",
      "/1",
      "/",
      "/哈哈",
      "/hello world",
      "/stop.",
      "stop",
      "please /stop",
      "你好",
    ]) {
      expect(parseCommand(draft)).toEqual({ kind: "line" });
    }
  });
});
