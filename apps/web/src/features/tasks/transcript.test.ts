import { describe, expect, test } from "vitest";
import type { TaskEntry } from "@/lib/api";
import {
  argumentHead,
  callOf,
  EMPTY_TRANSCRIPT,
  latestStep,
  reduceTranscript,
  type ToolRow,
  type TranscriptRow,
  toolLabel,
  toolState,
} from "./transcript";

const brief = {
  goal: "Write a TodoMVC",
  deliverable: "index.html",
  folder: "/tmp/todo",
  check: "Open it",
};

/** A transcript as transcript.jsonl holds it, numbered from 1. */
function entries(...bodies: readonly Record<string, unknown>[]): TaskEntry[] {
  return bodies.map((body, index) => ({ seq: index + 1, at: 1000 + index, ...body }) as TaskEntry);
}

const run = entries(
  { type: "brief", brief },
  {
    type: "assistant",
    text: "I'll look first.",
    calls: [
      { id: "c1", name: "ls", arguments: { path: "." } },
      { id: "c2", name: "write", arguments: { path: "index.html", content: "<!doctype html>" } },
    ],
    finishReason: "tool_calls",
  },
  { type: "tool-start", callId: "c1", name: "ls" },
  { type: "tool-start", callId: "c2", name: "write" },
  { type: "tool-result", callId: "c2", name: "write", content: "Wrote 15 bytes", isError: false },
  {
    type: "tool-result",
    callId: "c1",
    name: "ls",
    content: "EACCES",
    isError: true,
  },
  { type: "steer", text: "Use plain CSS" },
  {
    type: "compaction",
    summary: "## Goal\nTodoMVC",
    firstKeptSeq: 2,
    files: { read: [], written: [] },
    tokensBefore: 120_000,
  },
  { type: "pause", reason: "spend", detail: "Spent $1.02" },
  { type: "resume" },
  { type: "assistant", text: "Done: open index.html.", calls: [], finishReason: "stop" },
  { type: "end", outcome: { status: "succeeded", report: "Done: open index.html." } },
);

const kinds = (rows: readonly TranscriptRow[]) => rows.map((row) => row.kind);
const tools = (rows: readonly TranscriptRow[]) =>
  rows.filter((row): row is ToolRow => row.kind === "tool");

describe("reduceTranscript", () => {
  test("lays a transcript out row by row, each call under the reply that made it", () => {
    const view = reduceTranscript(EMPTY_TRANSCRIPT, run);
    expect(kinds(view.rows)).toEqual([
      "brief",
      "text",
      "tool",
      "tool",
      "steer",
      "compaction",
      "pause",
      "resume",
      "text",
      "end",
    ]);
    const [ls, write] = tools(view.rows);
    expect([ls?.name, ls?.head, ls?.result?.isError]).toEqual(["ls", ".", true]);
    expect([write?.name, write?.head, write?.result?.content]).toEqual([
      "write",
      "index.html",
      "Wrote 15 bytes",
    ]);
    expect(view.rows.at(-1)).toMatchObject({
      kind: "end",
      outcome: { status: "succeeded" },
    });
  });

  test("gives the same view whether the entries come at once or in batches", () => {
    const whole = reduceTranscript(EMPTY_TRANSCRIPT, run);
    const cuts = [0, 2, 3, 5, 9, run.length];
    let batched = EMPTY_TRANSCRIPT;
    for (let i = 1; i < cuts.length; i++) {
      batched = reduceTranscript(batched, run.slice(cuts[i - 1], cuts[i]));
    }
    expect(batched.rows).toEqual(whole.rows);
  });

  test("leaves the view it was given as it was", () => {
    const before = reduceTranscript(EMPTY_TRANSCRIPT, run.slice(0, 3));
    const rows = [...before.rows];
    const tool = tools(before.rows)[0];
    reduceTranscript(before, run.slice(3));
    expect(before.rows).toEqual(rows);
    expect(tools(before.rows)[0]).toBe(tool);
    expect(tool?.result).toBeNull();
  });

  test("a call is waiting until it starts, then running until its result, or stopped", () => {
    const waiting = reduceTranscript(EMPTY_TRANSCRIPT, run.slice(0, 2));
    const started = reduceTranscript(waiting, run.slice(2, 3));
    const ended = reduceTranscript(started, run.slice(3, 6));
    const [ls] = tools(waiting.rows);
    const [lsStarted] = tools(started.rows);
    const [lsEnded, write] = tools(ended.rows);
    expect(ls && toolState(ls, true)).toBe("waiting");
    expect(lsStarted && toolState(lsStarted, true)).toBe("running");
    // The task stopped running with the call under way: it never got a result.
    expect(lsStarted && toolState(lsStarted, false)).toBe("stopped");
    expect(lsEnded && toolState(lsEnded, true)).toBe("error");
    expect(write && toolState(write, false)).toBe("done");
  });

  test("a call whose arguments couldn't be read never ran, and shows what was sent", () => {
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries(
        { type: "brief", brief },
        {
          type: "assistant",
          text: "",
          calls: [{ id: "c1", name: "write", arguments: {}, unparsed: '{"path": "a.ht' }],
          finishReason: "length",
        },
        {
          type: "tool-result",
          callId: "c1",
          name: "write",
          content: "Re-issue the tool call with complete arguments",
          isError: true,
        },
      ),
    );
    // A reply with no text adds no text row.
    expect(kinds(view.rows)).toEqual(["brief", "tool"]);
    const [call] = tools(view.rows);
    expect(call?.unparsed).toBe('{"path": "a.ht');
    expect(call?.head).toBe('{"path": "a.ht');
    expect(call && toolState(call, false)).toBe("error");
  });

  test("a reply cut off or stopped by its provider is marked", () => {
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries(
        { type: "assistant", text: "Half a", calls: [], finishReason: "max_tokens" },
        { type: "assistant", text: "No.", calls: [], finishReason: "content_filter" },
        { type: "assistant", text: "Yes.", calls: [], finishReason: "end_turn" },
        { type: "assistant", text: "Old.", calls: [] },
      ),
    );
    expect(view.rows.map((row) => (row.kind === "text" ? row.finish : null))).toEqual([
      "cut-off",
      "stopped",
      null,
      null,
    ]);
  });

  test("a result goes to the latest call with its id, as a provider may reuse one", () => {
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries(
        { type: "assistant", text: "", calls: [{ id: "x", name: "ls", arguments: { path: "a" } }] },
        { type: "tool-result", callId: "x", name: "ls", content: "first", isError: false },
        { type: "assistant", text: "", calls: [{ id: "x", name: "ls", arguments: { path: "b" } }] },
        { type: "tool-start", callId: "x", name: "ls" },
        { type: "tool-result", callId: "x", name: "ls", content: "second", isError: false },
      ),
    );
    expect(tools(view.rows).map((row) => [row.head, row.result?.content])).toEqual([
      ["a", "first"],
      ["b", "second"],
    ]);
    expect(new Set(view.rows.map((row) => row.key)).size).toBe(view.rows.length);
  });

  test("a result no call named still shows, as a row of its own", () => {
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries({
        type: "tool-result",
        callId: "z",
        name: "grep",
        content: "1 match",
        isError: false,
      }),
    );
    const [row] = tools(view.rows);
    expect([row?.name, row?.head, row?.result?.content]).toEqual(["grep", "", "1 match"]);
  });

  test("an edit's result carries its diff, and a refused path what it asked for", () => {
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries(
        {
          type: "assistant",
          text: "",
          calls: [
            { id: "e", name: "edit", arguments: { path: "a.ts", edits: [] } },
            { id: "r", name: "read", arguments: { path: "/etc/hosts" } },
          ],
        },
        {
          type: "tool-result",
          callId: "e",
          name: "edit",
          content: "Replaced 1 block",
          isError: false,
          details: { diff: "-1 old\n+1 new", patch: "@@", firstChangedLine: 1 },
        },
        {
          type: "tool-result",
          callId: "r",
          name: "read",
          content: "Refused: /etc/hosts",
          isError: true,
          refused: { path: "/etc/hosts", access: "read" },
        },
      ),
    );
    const [edit, read] = tools(view.rows);
    expect(edit?.result?.diff).toBe("-1 old\n+1 new");
    expect(read?.result?.diff).toBeNull();
    expect(read?.result?.refused).toEqual({ path: "/etc/hosts", access: "read" });
  });
});

describe("commands, MCP tools and the runtime's notices", () => {
  test("a notice is a line of its own, apart from what she or the owner told it", () => {
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries(
        { type: "steer", text: "The owner allowed read access to /x." },
        {
          type: "notice",
          text: "[Command 3 ended with code 0 after 47 s. bash_output with id 3 shows its output.]",
        },
      ),
    );
    expect(view.rows).toEqual([
      { kind: "steer", key: "1", at: 1000, text: "The owner allowed read access to /x." },
      {
        kind: "notice",
        key: "2",
        at: 1001,
        text: "[Command 3 ended with code 0 after 47 s. bash_output with id 3 shows its output.]",
      },
    ]);
  });

  test("a bash call's row gains its command's id once its result gives one, which bash_output and bash_kill name", () => {
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries(
        {
          type: "assistant",
          text: "",
          calls: [{ id: "b", name: "bash", arguments: { command: "npm run dev", wait: false } }],
        },
        { type: "tool-start", callId: "b", name: "bash" },
        {
          type: "tool-result",
          callId: "b",
          name: "bash",
          content: "Command 3 is still running after 10 s, so it moved to the background.",
          isError: false,
          details: { id: 3, background: true },
        },
        {
          type: "assistant",
          text: "",
          calls: [
            { id: "o", name: "bash_output", arguments: { id: 3, offset: 10, limit: 50 } },
            { id: "k", name: "bash_kill", arguments: { id: 3 } },
          ],
        },
      ),
    );
    expect(tools(view.rows).map((row) => [row.label, row.head])).toEqual([
      ["bash", "#3 · npm run dev"],
      ["bash_output", "#3"],
      ["bash_kill", "#3"],
    ]);
  });

  test("an MCP tool reads as its server and tool, by its name, then by its result's own names", () => {
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries(
        {
          type: "assistant",
          text: "",
          calls: [
            { id: "m", name: "mcp__github__create_issue", arguments: { title: "Bug" } },
            { id: "n", name: "mcp__my_fs__read_text_file", arguments: { path: "/a" } },
          ],
        },
        {
          type: "tool-result",
          callId: "n",
          name: "mcp__my_fs__read_text_file",
          content: "text",
          isError: false,
          details: { server: "my-fs", tool: "read.text.file", isError: false },
        },
      ),
    );
    expect(tools(view.rows).map((row) => [row.name, row.label, row.head])).toEqual([
      ["mcp__github__create_issue", "github · create_issue", "Bug"],
      ["mcp__my_fs__read_text_file", "my-fs · read.text.file", "/a"],
    ]);
    // Only an MCP tool's name is read so, whatever another tool's details hold.
    expect(toolLabel("read", { server: "x", tool: "y" })).toBe("read");
  });

  test("a skill's row names the skill, then the file of it it reads", () => {
    const head = (args: Record<string, unknown>) =>
      argumentHead({ id: "s", name: "skill", arguments: args });
    expect(head({ name: "house-style" })).toBe("house-style");
    expect(head({ name: "house-style", path: "references/forms.md" })).toBe(
      "house-style · references/forms.md",
    );
  });

  test("a call's arguments are kept whole, and found by its id, the latest call's when ids repeat", () => {
    const content = "x".repeat(3000);
    const view = reduceTranscript(
      EMPTY_TRANSCRIPT,
      entries(
        { type: "assistant", text: "", calls: [{ id: "c", name: "ls", arguments: { path: "a" } }] },
        {
          type: "assistant",
          text: "",
          calls: [{ id: "c", name: "mcp__fs__write", arguments: { content, path: "~/.zshrc" } }],
        },
      ),
    );
    expect(callOf(view, "c")?.arguments).toEqual({ content, path: "~/.zshrc" });
    expect(callOf(view, "nope")).toBeNull();
  });
});

describe("latestStep", () => {
  test("is the newest tool call, running or not", () => {
    expect(latestStep(EMPTY_TRANSCRIPT)).toBeNull();
    expect(latestStep(reduceTranscript(EMPTY_TRANSCRIPT, run.slice(0, 1)))).toBeNull();
    const asked = reduceTranscript(EMPTY_TRANSCRIPT, run.slice(0, 2));
    expect(latestStep(asked)).toMatchObject({ name: "write", head: "index.html", result: null });
    // Text after it doesn't hide it.
    const all = reduceTranscript(EMPTY_TRANSCRIPT, run);
    expect(latestStep(all)).toMatchObject({ name: "write", result: { content: "Wrote 15 bytes" } });
  });
});

describe("argumentHead", () => {
  const head = (name: string, args: Record<string, unknown>, unparsed?: string) =>
    argumentHead({ id: "c", name, arguments: args, unparsed });

  test("names a call's target: its path, link or pattern", () => {
    expect(head("read", { path: "src/a.ts", offset: 10 })).toBe("src/a.ts");
    expect(head("web_fetch", { url: "https://example.com/" })).toBe("https://example.com/");
    expect(head("grep", { pattern: "TODO", path: "src", glob: "*.ts" })).toBe("TODO · src · *.ts");
  });

  test("falls back to the first text, then to the arguments as JSON", () => {
    expect(head("todo", { items: [{ text: "Plan", status: "done" }, { text: "Build" }] })).toBe(
      "Plan · Build",
    );
    expect(head("mystery", { note: "  two\n lines " })).toBe("two lines");
    expect(head("mystery", { n: 3 })).toBe('{"n":3}');
    expect(head("mystery", {})).toBe("");
  });

  test("keeps to one line of a readable length", () => {
    const long = head("write", { path: `${"a".repeat(300)}.txt` });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
    expect(head("write", { path: "a\nb" })).toBe("a b");
  });
});
