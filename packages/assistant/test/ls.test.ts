// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/tools.test.ts@ac78a60
//
// pi's ls cases in a task's folder, where a limit is a whole number; then the task's own:
// refusals, errors, aborts and arguments.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskToolResult } from "@eidolon/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLsTool, type LsDetails } from "../src/tools/ls.ts";
import type { AssistantTool } from "../src/types.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

let testDir: string;
let lsTool: AssistantTool;

function ls(args: Record<string, unknown>, signal?: AbortSignal): Promise<TaskToolResult> {
  return lsTool.execute(args, toolContext(signal));
}

beforeEach(async () => {
  testDir = await tempFolder();
  lsTool = createLsTool(folderGuard(testDir));
});

afterEach(removeTempFolders);

describe("ls tool", () => {
  it("should list dotfiles and directories", async () => {
    writeFileSync(join(testDir, ".hidden-file"), "secret");
    mkdirSync(join(testDir, ".hidden-dir"));

    const result = await ls({ path: testDir });

    expect(result.content).toContain(".hidden-file");
    expect(result.content).toContain(".hidden-dir/");
  });

  it("should treat limits below 1 as 1", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(testDir, name), name);

    for (const limit of [0, -5]) {
      const result = await ls({ path: testDir, limit });
      expect(result.content).toBe("a.txt\n\n[1 entries limit reached. Use limit=2 for more]");
      expect(result.details).toEqual({ entryLimitReached: 1 });
    }
  });

  it("should report the entry limit only when more entries exist", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(testDir, name), name);

    const result = await ls({ path: testDir, limit: 3 });
    expect(result.content).toBe("a.txt\nb.txt\nc.txt");
    expect(result.details).toBeUndefined();
  });

  it("ls uses the task's folder when no path is given", async () => {
    writeFileSync(join(testDir, "ctx-cwd-ls.txt"), "list me");

    const result = await ls({});

    expect(result.content).toContain("ctx-cwd-ls.txt");
  });
});

describe("ls in a task's folder", () => {
  it("sorts without regard to case, a directory's link marked as a directory", async () => {
    writeFileSync(join(testDir, "B.txt"), "");
    writeFileSync(join(testDir, "a.txt"), "");
    mkdirSync(join(testDir, "c"));
    symlinkSync(join(testDir, "c"), join(testDir, "d-link"));
    symlinkSync(join(testDir, "missing"), join(testDir, "dangling"));

    expect(await ls({ path: "." })).toEqual({ content: "a.txt\nB.txt\nc/\nd-link/" });
  });

  it("says when a folder is empty", async () => {
    mkdirSync(join(testDir, "empty"));

    expect(await ls({ path: "empty" })).toEqual({ content: "(empty directory)" });
  });

  it("caps the listing at 50KB", async () => {
    const names = Array.from(
      { length: 300 },
      (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(196)}`,
    );
    for (const name of names) writeFileSync(join(testDir, name), "");

    const result = await ls({});

    expect(result.content).toMatch(/\n\n\[50\.0KB limit reached\]$/);
    const details = result.details as LsDetails;
    expect(details.entryLimitReached).toBeUndefined();
    expect(details.truncation?.totalLines).toBe(300);
    expect(details.truncation?.outputLines).toBe(256);
  });

  it("refuses a folder outside the task's, naming it for an approval", async () => {
    const outside = await tempFolder();

    const result = await ls({ path: outside });

    expect(result.isError).toBe(true);
    expect(result.refused).toEqual({ path: outside, access: "read" });
    expect(result.content).toContain(outside);
  });

  it("refuses a denied folder with nothing to ask for", async () => {
    const secret = join(testDir, "secret");
    mkdirSync(secret);
    const tool = createLsTool(folderGuard(testDir, [secret]));

    const result = await tool.execute({ path: "secret" }, toolContext());

    expect(result.isError).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result.content).toContain(secret);
  });

  it("fails on a missing path or a file", async () => {
    writeFileSync(join(testDir, "file.txt"), "");

    expect(await ls({ path: "missing" })).toEqual({
      content: `Path not found: ${join(testDir, "missing")}`,
      isError: true,
    });
    expect(await ls({ path: "file.txt" })).toEqual({
      content: `Not a directory: ${join(testDir, "file.txt")}`,
      isError: true,
    });
  });

  it("answers bad arguments as pi's validation does, and reads null as left out", async () => {
    writeFileSync(join(testDir, "a.txt"), "");
    writeFileSync(join(testDir, "b.txt"), "");

    for (const [args, problem] of [
      [{ path: 3 }, "  - path: expected string, got integer"],
      [{ limit: "ten" }, "  - limit: expected integer, got string"],
      [{ limit: 1.5 }, "  - limit: expected integer, got number"],
    ] as const) {
      const result = await ls(args);
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith(`Validation failed for tool "ls":\n${problem}\n`);
    }
    expect(await ls({ path: null, limit: null })).toEqual({ content: "a.txt\nb.txt" });
    expect((await ls({ limit: "1" })).details).toEqual({ entryLimitReached: 1 });
  });

  it("stops at once when the task is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const guard = folderGuard(testDir);

    const result = await createLsTool(guard).execute({}, toolContext(controller.signal));

    expect(result).toEqual({ content: "Operation aborted", isError: true });
    expect(guard.resolved).toEqual([]);
  });

  it("describes itself as pi does", () => {
    expect(lsTool.schema.name).toBe("ls");
    expect(lsTool.replay).toBe("safe");
    expect(lsTool.snippet).toBe("List directory contents");
    expect(lsTool.guidelines).toEqual([]);
  });
});
