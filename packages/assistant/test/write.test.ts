// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/tools.test.ts@ac78a60
//
// pi's write cases in a task's folder; then the task's own: refusals, files, aborts and arguments.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TaskToolResult } from "@eidolon/engine";
import { createWriteTool } from "../src/tools/write.ts";
import type { AssistantTool } from "../src/types.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

let testDir: string;
let writeTool: AssistantTool;

function write(args: Record<string, unknown>, signal?: AbortSignal): Promise<TaskToolResult> {
  return writeTool.execute(args, toolContext(signal));
}

beforeEach(async () => {
  testDir = await tempFolder();
  writeTool = createWriteTool(folderGuard(testDir));
});

afterEach(removeTempFolders);

describe("write tool", () => {
  it("should write file contents", async () => {
    const testFile = join(testDir, "write-test.txt");
    const content = "Test content";

    const result = await write({ path: testFile, content });

    expect(result.content).toBe(`Successfully wrote to ${testFile}`);
    expect(result.details).toBeUndefined();
    expect(readFileSync(testFile, "utf-8")).toBe(content);
  });

  it("should create parent directories", async () => {
    const testFile = join(testDir, "nested", "dir", "test.txt");
    const content = "Nested content";

    const result = await write({ path: testFile, content });

    expect(result.content).toContain("Successfully wrote");
    expect(readFileSync(testFile, "utf-8")).toBe(content);
  });

  it("writes a relative path in the task's folder", async () => {
    await write({ path: "ctx-cwd-write.txt", content: "written via ctx.cwd" });

    expect(readFileSync(join(testDir, "ctx-cwd-write.txt"), "utf-8")).toBe("written via ctx.cwd");
  });
});

describe("write tool in a task", () => {
  it("names the file it wrote", async () => {
    const result = await write({ path: "out/index.html", content: "<!doctype html>\n" });

    expect(result).toEqual({
      content: "Successfully wrote to out/index.html",
      files: { written: [join(testDir, "out", "index.html")] },
    });
  });

  it("overwrites a file whole, and writes empty content", async () => {
    writeFileSync(join(testDir, "a.txt"), "old\nlines\n");

    await write({ path: "a.txt", content: "new\n" });
    expect(readFileSync(join(testDir, "a.txt"), "utf-8")).toBe("new\n");

    await write({ path: "a.txt", content: "" });
    expect(readFileSync(join(testDir, "a.txt"), "utf-8")).toBe("");
  });

  it("writes line endings and a byte order mark as given", async () => {
    await write({ path: "crlf.txt", content: "\u{feff}a\r\nb\n" });

    expect(readFileSync(join(testDir, "crlf.txt")).equals(Buffer.from("\u{feff}a\r\nb\n"))).toBe(
      true,
    );
  });

  it("refuses a path outside the task's folders, and makes nothing there", async () => {
    const outside = await tempFolder();
    const target = join(outside, "new", "dir", "file.txt");

    for (const path of [target, `../${basename(outside)}/new/dir/file.txt`]) {
      expect(await write({ path, content: "x" })).toEqual({
        content: `${target} is outside the folders this task may write. If the task needs it, ask for access rather than working around it.`,
        isError: true,
        refused: { path: target, access: "write" },
      });
    }
    expect(existsSync(join(outside, "new"))).toBe(false);
  });

  it("refuses a denied path with nothing to ask for", async () => {
    const keys = join(testDir, ".ssh");
    writeTool = createWriteTool(folderGuard(testDir, [keys]));

    expect(await write({ path: ".ssh/config", content: "Host *\n" })).toEqual({
      content: `No task may write ${join(keys, "config")}, whatever access it is given.`,
      isError: true,
    });
    expect(existsSync(keys)).toBe(false);
  });

  it("writes nothing once aborted", async () => {
    const guard = folderGuard(testDir);
    writeTool = createWriteTool(guard);
    const controller = new AbortController();
    controller.abort();

    expect(await write({ path: "a.txt", content: "x" }, controller.signal)).toEqual({
      content: "Operation aborted",
      isError: true,
    });
    expect(existsSync(join(testDir, "a.txt"))).toBe(false);
    expect(guard.resolved).toEqual([]);
  });

  it("reports a failure as a result", async () => {
    writeFileSync(join(testDir, "file"), "a file, not a folder\n");

    const result = await write({ path: "file/inside.txt", content: "x" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/EEXIST|ENOTDIR/);
    expect(result.files).toBeUndefined();
  });

  it("rejects arguments it can't use, naming each", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ path: "a.txt" }, "  - content: missing"],
      [{ path: "a.txt", content: { name: "x" } }, "  - content: expected string, got object"],
      [{ content: "x" }, "  - path: missing"],
      [{ path: null, content: "x" }, "  - path: expected string, got null"],
    ];
    for (const [args, problem] of cases) {
      const result = await write(args);
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith(`Validation failed for tool "write":\n${problem}\n`);
    }
    expect(existsSync(join(testDir, "a.txt"))).toBe(false);
  });

  it("echoes no more than the start of a long call's arguments", async () => {
    const result = await write({ file_path: "a.txt", content: "x".repeat(100_000) });

    expect(result.content).toStartWith('Validation failed for tool "write":\n  - path: missing\n');
    expect(result.content).toEndWith("\n... [truncated]");
    expect(result.content.length).toBeLessThan(2200);
  });

  it("describes itself as pi's write does", () => {
    expect(writeTool.schema.name).toBe("write");
    expect(writeTool.schema.required).toEqual(["path", "content"]);
    expect(writeTool.replay).toBe("safe");
    expect(writeTool.executionMode).toBeUndefined();
    expect(writeTool.snippet).toBe("Create or overwrite files");
    expect(writeTool.guidelines).toEqual(["Use write only for new files or complete rewrites."]);
  });
});
