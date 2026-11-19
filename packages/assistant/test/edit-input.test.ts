// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/edit-tool-legacy-input.test.ts@ac78a60
//
// The task loop runs prepareArguments before validating, as pi does, and execute runs it again, so
// a call made without the loop is prepared too.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEditTool, prepareEditArguments } from "../src/tools/edit.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

afterEach(removeTempFolders);

describe("edit tool prepareArguments", () => {
  it("keeps legacy fields out of the public schema", async () => {
    const tool = createEditTool(folderGuard(await tempFolder()));
    expect(tool.schema.properties).not.toHaveProperty("oldText");
    expect(tool.schema.properties).not.toHaveProperty("newText");
  });

  it("folds top-level oldText/newText into edits", () => {
    const prepared = prepareEditArguments({
      path: "file.txt",
      oldText: "before",
      newText: "after",
    });
    expect(prepared).toEqual({
      path: "file.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });
  });

  it("appends legacy replacement to existing edits", () => {
    const prepared = prepareEditArguments({
      path: "file.txt",
      edits: [{ oldText: "a", newText: "b" }],
      oldText: "c",
      newText: "d",
    });
    expect(prepared).toEqual({
      path: "file.txt",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    });
  });

  it("passes through valid input unchanged", () => {
    const input = { path: "file.txt", edits: [{ oldText: "a", newText: "b" }] };
    expect(prepareEditArguments(input)).toBe(input);
  });

  it("passes through non-object input unchanged", () => {
    expect(prepareEditArguments(null)).toBe(null);
    expect(prepareEditArguments(undefined)).toBe(undefined);
    expect(prepareEditArguments("garbage")).toBe("garbage");
  });

  it("is the tool's prepareArguments, which the task loop runs before validating", async () => {
    const tool = createEditTool(folderGuard(await tempFolder()));
    const legacy = { path: "file.txt", oldText: "before", newText: "after" };
    const stringified = { path: "file.txt", edits: '[{"oldText":"a","newText":"b"}]' };
    expect(tool.prepareArguments?.(legacy)).toEqual({
      path: "file.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect(tool.prepareArguments?.(stringified)).toEqual({
      path: "file.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });
  });

  it("leaves the arguments it was given as they were", () => {
    const input = { path: "file.txt", edits: '[{"oldText":"a","newText":"b"}]' };
    prepareEditArguments(input);
    expect(input).toEqual({ path: "file.txt", edits: '[{"oldText":"a","newText":"b"}]' });
  });

  it("prepared args execute correctly", async () => {
    const dir = await tempFolder();
    const filePath = join(dir, "legacy.txt");
    writeFileSync(filePath, "before\n", "utf8");

    const result = await createEditTool(folderGuard(dir)).execute(
      { path: "legacy.txt", oldText: "before", newText: "after" },
      toolContext(),
    );

    expect(result.content).toBe("Successfully replaced 1 block(s) in legacy.txt.");
    expect(readFileSync(filePath, "utf8")).toBe("after\n");
  });
});

describe("edit tool stringified edits", () => {
  it("parses edits from a JSON string", () => {
    const prepared = prepareEditArguments({
      path: "file.txt",
      edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
    });
    expect(prepared).toEqual({ path: "file.txt", edits: [{ oldText: "a", newText: "b" }] });
  });

  it("leaves edits alone when the string is not valid JSON", () => {
    const prepared = prepareEditArguments({ path: "file.txt", edits: "not json" });
    expect(prepared).toEqual({ path: "file.txt", edits: "not json" });
  });
});
