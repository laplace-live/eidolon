import { describe, expect, test, vi } from "vitest";
import { linguiMacro } from "@/test/lingui-macro";
import { WEB_MODES } from "./choice";

vi.doMock("@lingui/core/macro", linguiMacro);
const {
  MCP_HINT_TEXT,
  PAUSE_REASONS,
  PROFILE_LABELS,
  pathGrant,
  STATUS_LABELS,
  TODO_STATUS_LABELS,
  visibleCommand,
  WEB_MODE_LABELS,
  webModeHelp,
} = await import("./labels");
const { t } = linguiMacro();

const english = (labels: Readonly<Record<string, { readonly message?: string }>>) =>
  Object.fromEntries(Object.entries(labels).map(([code, label]) => [code, label.message]));

test("each status has its name, the ones the owner waits on said as such", () => {
  expect(english(STATUS_LABELS)).toEqual({
    "awaiting-approval": "Awaiting Approval",
    running: "Running",
    paused: "Paused",
    interrupted: "Interrupted",
    succeeded: "Done",
    failed: "Failed",
    cancelled: "Stopped",
  });
  // Shared with the jobs' "Done", which a context keeps apart.
  expect(STATUS_LABELS.succeeded).toMatchObject({ context: "task status" });
});

test("the web access choices, Ask for Each Site first, each with what it means", () => {
  expect(WEB_MODES.map((mode) => WEB_MODE_LABELS[mode].message)).toEqual([
    "Ask for Each Site",
    "Any Site",
    "No Web",
  ]);
  for (const search of [false, true]) {
    for (const mode of WEB_MODES) expect(webModeHelp(mode, search).message).toMatch(/\.$/);
  }
});

test("with web search on, the help says a task searches unasked, and No Web stops that too", () => {
  const help = (mode: (typeof WEB_MODES)[number], search: boolean) =>
    webModeHelp(mode, search).message ?? "";
  // Results bring any site's excerpts in, which no site question covers.
  expect(help("ask", true)).toContain("search the web without asking");
  expect(help("any", true)).toContain("search the web");
  expect(help("off", true)).toContain("can't search or fetch");
  for (const mode of WEB_MODES) expect(help(mode, false)).not.toContain("search");
  // Under No Web an Always grant for an MCP tool doesn't apply: every call asks.
  for (const search of [false, true]) {
    expect(help("off", search)).toContain("each call to an MCP server asks you first");
  }
});

test("each kind she gives a task has its name, apart from other words like it", () => {
  expect(english(PROFILE_LABELS)).toEqual({
    quick: "Quick",
    coding: "Coding",
    research: "Research",
  });
  for (const label of Object.values(PROFILE_LABELS)) {
    expect(label).toMatchObject({ context: "task kind" });
  }
});

test("an MCP server's hint is a sentence of its claim", () => {
  expect(english(MCP_HINT_TEXT)).toEqual({
    "read-only": "The server says this tool only reads.",
    destructive: "The server says this tool can change or delete things.",
  });
});

describe("visibleCommand", () => {
  const shown = (command: string) =>
    visibleCommand(command)
      .map((part) => (part.escaped ? `[${part.text}]` : part.text))
      .join("");

  test("spells out bidi controls, zero-width marks, ESC and CR, so what runs is what shows", () => {
    // Trojan Source: U+202E turns the rest of the line around on screen, never in bash.
    expect(shown("echo safe\u202E;rm -rf ~\u202C")).toBe(
      "echo safe[\\u{202E}];rm -rf ~[\\u{202C}]",
    );
    expect(shown("rm -rf /tmp/a\u200Bb")).toBe("rm -rf /tmp/a[\\u{200B}]b");
    expect(shown("rm -rf /tmp/a\u034Fb")).toBe("rm -rf /tmp/a[\\u{034F}]b");
    expect(shown("printf '\u001B[2Kok'")).toBe("printf '[\\u{001B}][2Kok'");
    expect(shown("make\r\n")).toBe("make[\\u{000D}]\n");
  });

  test("leaves CJK, emoji, tabs and newlines as they are", () => {
    const plain = "echo '你好，世界' \u{1F642}\n\tls -la\n";
    expect(visibleCommand(plain)).toEqual([{ at: 0, text: plain, escaped: false }]);
    expect(visibleCommand("")).toEqual([]);
  });

  test("spells out the other invisible characters, each in full", () => {
    const hidden = [
      0x00, 0x07, 0x0b, 0x1f, 0x7f, 0x85, 0x9f, 0xad, 0x34f, 0x61c, 0x200e, 0x200f, 0x2028, 0x2029,
      0x202a, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff, 0xe0001, 0xe007f,
    ];
    for (const code of hidden) {
      const parts = visibleCommand(`a${String.fromCodePoint(code)}b`);
      expect([code, parts.map((part) => part.escaped)]).toEqual([code, [false, true, false]]);
      expect(parts[1]?.text).toBe(`\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}`);
    }
    // Their neighbours show as they are.
    for (const code of [
      0x20, 0x7e, 0xa0, 0xae, 0x34e, 0x350, 0x200a, 0x2030, 0x2065, 0x206a, 0xe0080,
    ]) {
      expect([code, visibleCommand(`a${String.fromCodePoint(code)}b`).length]).toEqual([code, 1]);
    }
  });

  test("each part's offset is where it starts in the command, an astral escape included", () => {
    expect(visibleCommand("a\u{E0041}b")).toEqual([
      { at: 0, text: "a", escaped: false },
      { at: 1, text: "\\u{E0041}", escaped: true },
      { at: 3, text: "b", escaped: false },
    ]);
    const command = "\u202Eab\u200Bc";
    expect(visibleCommand(command).map((part) => part.at)).toEqual([0, 1, 3, 4]);
    for (const part of visibleCommand(command)) {
      if (!part.escaped) expect(command.slice(part.at, part.at + part.text.length)).toBe(part.text);
    }
  });
});

test("a path's question names what an Allow grants, and with which access: its folder, or the file", () => {
  const said = (pending: Parameters<typeof pathGrant>[0]) => {
    const { line, allow, always } = pathGrant(pending);
    return [t(line), t(allow), always && t(always)];
  };
  // The file needn't exist: an Allow still grants all of its folder.
  const pdf = {
    path: "/Users/me/Documents/tax-2025.pdf",
    access: "read",
    folder: "/Users/me/Documents",
  } as const;
  expect(said(pdf)).toEqual([
    "Waiting for your OK to read everything in /Users/me/Documents",
    "Allow Once lets this task read everything in /Users/me/Documents until it ends; Deny tells it it can't.",
    // A read is this task's alone: assistant.folders would let every task write there.
    null,
  ]);
  const [line, allow, always] = said({ ...pdf, access: "write" });
  expect([line, allow]).toEqual([
    "Waiting for your OK to read and write everything in /Users/me/Documents",
    "Allow Once lets this task read and write everything in /Users/me/Documents until it ends; Deny tells it it can't.",
  ]);
  // assistant.folders are read-write grants for every run, and a task in one starts without an OK.
  expect(always).toContain("adds /Users/me/Documents to Assistant Mode's folders");
  expect(always).toContain("every task may read and write in it");
  expect(always).toContain("without asking");
  // Home can't be granted, so a file right in it is granted alone, and Always adds nothing.
  expect(said({ path: "/Users/me/.zshrc", access: "write" })).toEqual([
    "Waiting for your OK to read and write /Users/me/.zshrc",
    "Allow Once lets this task read and write /Users/me/.zshrc alone until it ends; Deny tells it it can't.",
    null,
  ]);
  expect(said({ path: "/Users/me/.zshrc", access: "read" }).slice(0, 2)).toEqual([
    "Waiting for your OK to read /Users/me/.zshrc",
    "Allow Once lets this task read /Users/me/.zshrc alone until it ends; Deny tells it it can't.",
  ]);
});

test("a plan's steps and a pause's reason have words of their own", () => {
  expect(Object.keys(TODO_STATUS_LABELS)).toEqual(["pending", "in_progress", "done"]);
  for (const reason of Object.values(PAUSE_REASONS)) expect(reason.message).toMatch(/\.$/);
});
