// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/tools.test.ts@ac78a60
//
// pi's read cases in a task's folder, where an image is a note rather than an attachment and a
// failure a result rather than a rejection; then the task's own: refusals, files and arguments.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TaskToolResult } from "@eidolon/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/tools/read.ts";
import type { AssistantTool } from "../src/types.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

function createTinyBmp1x1Red24bpp(): Buffer {
  const buffer = Buffer.alloc(58);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(1, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(0, 30);
  buffer.writeUInt32LE(4, 34);
  buffer[56] = 0xff;
  return buffer;
}

let testDir: string;
let readTool: AssistantTool;

function read(args: Record<string, unknown>, signal?: AbortSignal): Promise<TaskToolResult> {
  return readTool.execute(args, toolContext(signal));
}

beforeEach(async () => {
  testDir = await tempFolder();
  readTool = createReadTool(folderGuard(testDir));
});

afterEach(removeTempFolders);

describe("read tool", () => {
  it("should read file contents that fit within limits", async () => {
    const testFile = join(testDir, "test.txt");
    const content = "Hello, world!\nLine 2\nLine 3";
    writeFileSync(testFile, content);

    const result = await read({ path: testFile });

    expect(result.content).toBe(content);
    // No truncation message since file fits within limits
    expect(result.content).not.toContain("Use offset=");
    expect(result.details).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  it("should handle non-existent files", async () => {
    const result = await read({ path: join(testDir, "nonexistent.txt") });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/ENOENT|not found/i);
  });

  it("should truncate files exceeding line limit", async () => {
    const testFile = join(testDir, "large.txt");
    const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(testFile, lines.join("\n"));

    const output = (await read({ path: testFile })).content;

    expect(output).toContain("Line 1");
    expect(output).toContain("Line 2000");
    expect(output).not.toContain("Line 2001");
    expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
  });

  it("should truncate when byte limit exceeded", async () => {
    const testFile = join(testDir, "large-bytes.txt");
    // Create file that exceeds 50KB byte limit but has fewer than 2000 lines
    const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
    writeFileSync(testFile, lines.join("\n"));

    const output = (await read({ path: testFile })).content;

    expect(output).toContain("Line 1:");
    // Should show byte limit message
    expect(output).toMatch(
      /\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/,
    );
  });

  it("should handle offset parameter", async () => {
    const testFile = join(testDir, "offset-test.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(testFile, lines.join("\n"));

    const output = (await read({ path: testFile, offset: 51 })).content;

    expect(output).not.toContain("Line 50");
    expect(output).toContain("Line 51");
    expect(output).toContain("Line 100");
    // No truncation message since file fits within limits
    expect(output).not.toContain("Use offset=");
  });

  it("should handle limit parameter", async () => {
    const testFile = join(testDir, "limit-test.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(testFile, lines.join("\n"));

    const output = (await read({ path: testFile, limit: 10 })).content;

    expect(output).toContain("Line 1");
    expect(output).toContain("Line 10");
    expect(output).not.toContain("Line 11");
    expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
  });

  it("should handle offset + limit together", async () => {
    const testFile = join(testDir, "offset-limit-test.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(testFile, lines.join("\n"));

    const output = (await read({ path: testFile, offset: 41, limit: 20 })).content;

    expect(output).not.toContain("Line 40");
    expect(output).toContain("Line 41");
    expect(output).toContain("Line 60");
    expect(output).not.toContain("Line 61");
    expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
  });

  it("should show error when offset is beyond file length", async () => {
    const testFile = join(testDir, "short.txt");
    writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

    const result = await read({ path: testFile, offset: 100 });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Offset 100 is beyond end of file \(3 lines total\)/);
  });

  it("should include truncation details when truncated", async () => {
    const testFile = join(testDir, "large-file.txt");
    const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(testFile, lines.join("\n"));

    const result = await read({ path: testFile });
    const details = result.details as { truncation?: Record<string, unknown> } | undefined;

    expect(details?.truncation).toBeDefined();
    expect(details?.truncation?.truncated).toBe(true);
    expect(details?.truncation?.truncatedBy).toBe("lines");
    expect(details?.truncation?.totalLines).toBe(2500);
    expect(details?.truncation?.outputLines).toBe(2000);
    // The shown text is the result's content; details don't carry it twice.
    expect(details?.truncation).not.toHaveProperty("content");
  });

  it("should detect image MIME type from file magic (not extension)", async () => {
    const testFile = join(testDir, "image.txt");
    writeFileSync(testFile, Buffer.from(PNG_1X1, "base64"));

    const result = await read({ path: testFile });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      `${testFile} is an image (image/png) of 70B. read shows text only, so its contents aren't shown.`,
    );
  });

  it("should note BMP files as images", async () => {
    const testFile = join(testDir, "image.bmp");
    writeFileSync(testFile, createTinyBmp1x1Red24bpp());

    const result = await read({ path: testFile });

    expect(result.content).toContain("is an image (image/bmp) of 58B.");
  });

  it("should treat files with image extension but non-image content as text", async () => {
    const testFile = join(testDir, "not-an-image.png");
    writeFileSync(testFile, "definitely not a png");

    const result = await read({ path: testFile });

    expect(result.content).toBe("definitely not a png");
  });

  it("reads a relative path in the task's folder", async () => {
    writeFileSync(join(testDir, "ctx-cwd-read.txt"), "hello from ctx.cwd");

    const result = await read({ path: "ctx-cwd-read.txt" });

    expect(result.content).toContain("hello from ctx.cwd");
  });
});

describe("read tool in a task", () => {
  it("names the file it read", async () => {
    mkdirSync(join(testDir, "notes"));
    writeFileSync(join(testDir, "notes", "a.txt"), "a\n");

    const result = await read({ path: "notes/a.txt" });

    expect(result.files).toEqual({ read: [join(testDir, "notes", "a.txt")] });
  });

  it("names no file when the read fails", async () => {
    const result = await read({ path: "missing.txt" });

    expect(result.isError).toBe(true);
    expect(result.files).toBeUndefined();
  });

  it("refuses a path outside the task's folders, and asks for access", async () => {
    const outside = await tempFolder();
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret\n");

    for (const path of [secret, `../${basename(outside)}/secret.txt`]) {
      expect(await read({ path })).toEqual({
        content: `${secret} is outside the folders this task may read. If the task needs it, ask for access rather than working around it.`,
        isError: true,
        refused: { path: secret, access: "read" },
      });
    }
  });

  it("refuses a denied path with nothing to ask for", async () => {
    const keys = join(testDir, "keys");
    mkdirSync(keys);
    writeFileSync(join(keys, "id"), "private\n");
    readTool = createReadTool(folderGuard(testDir, [keys]));

    expect(await read({ path: "keys/id" })).toEqual({
      content: `No task may read ${join(keys, "id")}, whatever access it is given.`,
      isError: true,
    });
  });

  it("notes a binary file instead of showing its bytes", async () => {
    writeFileSync(join(testDir, "data.bin"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x14]));

    const result = await read({ path: "data.bin" });

    expect(result).toEqual({
      content:
        "data.bin is a binary file of 6B. read shows text only, so its contents aren't shown.",
      files: { read: [join(testDir, "data.bin")] },
    });
  });

  it("reads UTF-16 by its byte order mark, and text that isn't UTF-8 as GB18030, saying so", async () => {
    const utf16 = Buffer.from("\u{feff}name\tscore\n小红\t200", "utf16le");
    writeFileSync(join(testDir, "export.txt"), utf16);
    // 你好，世界 as GBK, as a Chinese Windows saves text.
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]);
    writeFileSync(join(testDir, "notes.txt"), gbk);

    expect(await read({ path: "export.txt" })).toEqual({
      content: "name\tscore\n小红\t200\n\n[export.txt is UTF-16LE text.]",
      files: { read: [join(testDir, "export.txt")] },
    });
    expect(await read({ path: "notes.txt" })).toEqual({
      content: "你好，世界\n\n[notes.txt isn't UTF-8: this is it read as GB18030.]",
      files: { read: [join(testDir, "notes.txt")] },
    });
  });

  it("reads UTF-8 with a stray byte, or Latin-1, as UTF-8 with a replacement character", async () => {
    // A Windows-1252 apostrophe pasted into UTF-8 notes, and a Windows-1252 CSV.
    const notes = ["# 直播笔记\n今天的歌单：晴天、稻香\nIt", "s done\n明天直播唱歌\n"];
    writeFileSync(
      join(testDir, "notes.md"),
      Buffer.concat([
        Buffer.from(notes[0] as string),
        Buffer.from([0x92]),
        Buffer.from(notes[1] as string),
      ]),
    );
    writeFileSync(
      join(testDir, "kunden.csv"),
      Buffer.from("Name;Stadt\nM\xfcller;M\xfcnchen\n", "latin1"),
    );

    expect((await read({ path: "notes.md" })).content).toBe(notes.join("\ufffd"));
    expect((await read({ path: "kunden.csv" })).content).toBe(
      "Name;Stadt\nM\ufffdller;M\ufffdnchen\n",
    );
  });

  it("points a directory at ls", async () => {
    mkdirSync(join(testDir, "src"));

    expect(await read({ path: "src" })).toEqual({
      content: "src is a directory. Use ls to list it.",
      isError: true,
    });
  });

  it("reads an empty file as nothing", async () => {
    writeFileSync(join(testDir, "empty.txt"), "");

    expect((await read({ path: "empty.txt" })).content).toBe("");
  });

  it("shows the head of a first line over the byte limit, and says how to read on", async () => {
    writeFileSync(join(testDir, "wide.txt"), `${"z".repeat(60 * 1024)}\nsecond`);
    // 中 is three bytes: the head stops at the last whole one.
    writeFileSync(join(testDir, "export.json"), "中".repeat(20 * 1024));

    const result = await read({ path: "wide.txt" });

    expect(result.content).toBe(
      `${"z".repeat(50 * 1024)}\n\n[Showing the first 50.0KB of line 1, which is 60.0KB. Use grep to see the text around a match further along it. Use offset=2 to continue.]`,
    );
    expect(await read({ path: "wide.txt", offset: 2 })).toMatchObject({ content: "second" });
    expect((await read({ path: "export.json" })).content).toBe(
      `${"中".repeat(17_066)}\n\n[Showing the first 50.0KB of line 1, which is 60.0KB. Use grep to see the text around a match further along it.]`,
    );
  });

  it("reads on from the offset its note gives", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(join(testDir, "long.txt"), lines.join("\n"));

    const first = await read({ path: "long.txt" });
    const next = Number(/Use offset=(\d+)/.exec(first.content)?.[1]);
    const rest = await read({ path: "long.txt", offset: next });

    expect(next).toBe(2001);
    expect(rest.content).toBe(lines.slice(2000).join("\n"));
  });

  it("takes an offset and a limit sent as strings", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(join(testDir, "strings.txt"), lines.join("\n"));

    expect(await read({ path: "strings.txt", offset: "41", limit: "20" })).toEqual(
      await read({ path: "strings.txt", offset: 41, limit: 20 }),
    );
  });

  it("rejects arguments it can't use, naming each", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{}, "  - path: missing"],
      [{ path: 42 }, "  - path: expected string, got integer"],
      [{ path: "" }, "  - path: must not be empty"],
      [{ path: "a.txt", offset: "abc" }, "  - offset: expected integer, got string"],
      [{ path: "a.txt", offset: 2.5 }, "  - offset: expected integer, got number"],
      [{ path: "a.txt", limit: -1 }, "  - limit: must be 0 or more"],
    ];
    for (const [args, problem] of cases) {
      const result = await read(args);
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith(`Validation failed for tool "read":\n${problem}\n`);
      expect(result.content).toEndWith(`Received arguments:\n${JSON.stringify(args, null, 2)}`);
    }
  });

  it("answers an abort before it starts without touching the file", async () => {
    const guard = folderGuard(testDir);
    readTool = createReadTool(guard);
    const controller = new AbortController();
    controller.abort();

    expect(await read({ path: "a.txt" }, controller.signal)).toEqual({
      content: "Operation aborted",
      isError: true,
    });
    expect(guard.resolved).toEqual([]);
  });

  it("describes itself as pi's read does", () => {
    expect(readTool.schema.name).toBe("read");
    expect(readTool.schema.required).toEqual(["path"]);
    expect(Object.keys(readTool.schema.properties)).toEqual(["path", "offset", "limit"]);
    expect(readTool.replay).toBe("safe");
    expect(readTool.executionMode).toBeUndefined();
    expect(readTool.snippet).toBe("Read file contents");
    expect(readTool.guidelines).toEqual(["Use read to examine files instead of cat or sed."]);
  });
});
