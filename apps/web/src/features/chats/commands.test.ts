import { describe, expect, test } from "bun:test";
import { CHAT_DISPLAYS } from "@eidolon/chat";
import { CHAT_COMMANDS, parseCommand, slashEntries } from "./commands";

const PDF = { name: "pdf", description: "Read and make PDFs" };
const DOCX = { name: "docx", description: "Read and make Word documents" };
const STOP = { name: "stop", description: "A skill named as a command" };

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

describe("a skill after a slash", () => {
  test("is a line for her, alone or with words after it, in any case", () => {
    for (const draft of ["/pdf", "/PDF", " ／pdf ", "/pdf 把报告做成 PDF"]) {
      expect(parseCommand(draft, [PDF])).toEqual({ kind: "line" });
    }
  });

  test("is refused alone where she can't be asked for it, and a command keeps its name", () => {
    expect(parseCommand("/pdf")).toEqual({ kind: "unknown", typed: "/pdf" });
    expect(parseCommand("/pdf", [DOCX])).toEqual({ kind: "unknown", typed: "/pdf" });
    expect(parseCommand("/stop", [STOP])).toEqual({ kind: "command", command: "stop" });
  });
});

describe("slashEntries", () => {
  test("offers the commands while the slash word is alone, then the skills", () => {
    expect(slashEntries([PDF], true)).toEqual([
      ...CHAT_COMMANDS.map((name) => ({ kind: "command" as const, name })),
      { kind: "skill", ...PDF },
    ]);
  });

  test("offers only the skills before what the draft already says", () => {
    expect(slashEntries([PDF], false)).toEqual([{ kind: "skill", ...PDF }]);
    expect(slashEntries([], false)).toEqual([]);
  });

  test("leaves out a skill named as a command, which would run instead", () => {
    expect(slashEntries([STOP, PDF], false)).toEqual([{ kind: "skill", ...PDF }]);
  });
});
