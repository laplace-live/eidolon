// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/read-streaming.test.ts@ac78a60
//
// The reference is pi's whole-file read from before it streamed, with this tool's head and note for
// a line over the byte limit. The 200 MB line is checked for its output only: no heap cap here would
// fail a read that stored it.
import { appendFileSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskToolResult } from "@eidolon/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadTool, type ReadText, readLines } from "../src/tools/read.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../src/tools/truncate.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

// A copy of the module, so a test can spy on what the tool calls: its own exports can't be.
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<object>()) }));

// The read tool's text path before it streamed (#9654), kept as the reference the new path must
// match.
function referenceRead(
  textContent: string,
  offset: number | undefined,
  limit: number | undefined,
): ReadText {
  const allLines = textContent.split("\n");
  const totalFileLines = allLines.length;
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
  }
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }
  const { content, ...truncation } = truncateHead(selectedContent);
  if (truncation.firstLineExceedsLimit) {
    const firstLine = Buffer.from(allLines[startLine] as string, "utf-8");
    let end = DEFAULT_MAX_BYTES;
    while (((firstLine[end] as number) & 0xc0) === 0x80) end--;
    const head = firstLine.subarray(0, end).toString("utf-8");
    const next =
      startLineDisplay < totalFileLines ? ` Use offset=${startLineDisplay + 1} to continue.` : "";
    return {
      text: `${head}\n\n[Showing the first ${formatSize(DEFAULT_MAX_BYTES)} of line ${startLineDisplay}, which is ${formatSize(firstLine.length)}. Use grep to see the text around a match further along it.${next}]`,
      truncation,
    };
  }
  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    const notice =
      truncation.truncatedBy === "lines"
        ? `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
        : `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    return { text: `${content}\n\n${notice}`, truncation };
  }
  if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    return {
      text: `${content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`,
    };
  }
  return { text: content };
}

type ReadOutcome = ReadText | { error: string };

function referenceOutcome(
  text: string,
  offset: number | undefined,
  limit: number | undefined,
): ReadOutcome {
  try {
    return referenceRead(text, offset, limit);
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Splits bytes into chunks of `size`, so characters and lines split at chunk ends. */
async function* chunked(bytes: Buffer, size: number): AsyncIterable<Uint8Array> {
  for (let position = 0; position < bytes.length; position += size) {
    yield bytes.subarray(position, position + size);
  }
}

async function streamedOutcome(
  chunks: AsyncIterable<Uint8Array>,
  offset: number | undefined,
  limit: number | undefined,
): Promise<ReadOutcome> {
  try {
    return await readLines(chunks, offset, limit);
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** A tool result as an outcome, to compare with the reference. */
function toolOutcome(result: TaskToolResult): ReadOutcome {
  if (result.isError) return { error: result.content };
  const details = result.details as { truncation?: ReadText["truncation"] } | undefined;
  return details
    ? { text: result.content, truncation: details.truncation }
    : { text: result.content };
}

function lines(count: number, make: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => make(i)).join("\n");
}

const FIFTY_KB_OF_LINES = `${lines(512, () => "y".repeat(99))}y`;

// Inputs around the boundaries the notices and truncation depend on.
const TEXT_CASES: Record<string, string> = {
  empty: "",
  "no trailing newline": "alpha\nbeta\ngamma",
  "trailing newline": "alpha\nbeta\n",
  CRLF: "alpha\r\nbeta\r\n\r\ngamma\r\n",
  "multi-byte characters and UTF-8 byte order mark":
    "\u{feff}\u{e9}\u{20ac}\u{1f600}\n\u{f1}\u{10348}\u{5b57}\n\u{1f600}\u{1f600}\u{1f600}",
  "2001 lines": lines(2001, (i) => `line ${i}`),
  // truncateHead drops a trailing empty line: the empty line at the line cap must not end the
  // stored lines.
  "2001 lines, an empty line and more": `${lines(2001, (i) => `line ${i}`)}\n\nmore`,
  "first line over 50KB": `${"\u{e9}".repeat(DEFAULT_MAX_BYTES / 2 + 1)}\nsecond`,
  "line over 50KB after short lines": `a\nb\n${"z".repeat(60 * 1024)}\nc`,
  // 50KB + 1 byte: truncated, yet every line fits, so truncateHead reports truncatedBy "lines".
  "exactly 50KB and a trailing newline": `${FIFTY_KB_OF_LINES}\n`,
  "exactly 50KB, an empty line and more": `${FIFTY_KB_OF_LINES}\n\nmore`,
  "multi-byte characters over 50KB": lines(700, (i) => `${i} ${"\u{20ac}\u{1f600}".repeat(13)}`),
};

describe("read tool streaming", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await tempFolder();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempFolders();
  });

  function readTool() {
    return createReadTool(folderGuard(tempDir));
  }

  it("gives the same output as the whole-file algorithm", async () => {
    for (const [name, text] of Object.entries(TEXT_CASES)) {
      const bytes = Buffer.from(text, "utf-8");
      const total = text.split("\n").length;
      for (const offset of [undefined, 2, 3, total, total + 1]) {
        for (const limit of [undefined, 0, 1, total]) {
          const expected = referenceOutcome(text, offset, limit);
          for (const chunkSize of [1, 4096]) {
            const label = `${name}, offset ${offset}, limit ${limit}, chunks of ${chunkSize}`;
            const streamed = await streamedOutcome(chunked(bytes, chunkSize), offset, limit);
            expect(streamed, label).toEqual(expected);
          }
        }
      }
    }
  }, 60_000);

  it("keeps the truncation's key order, which transcripts serialize", async () => {
    const text = TEXT_CASES["2001 lines"] as string;
    const streamed = await readLines(chunked(Buffer.from(text), 4096), 1, undefined);
    const expected = referenceRead(text, 1, undefined);
    expect(JSON.stringify(streamed.truncation)).toBe(JSON.stringify(expected.truncation));
  });

  it("decodes multi-byte characters split across chunks and invalid UTF-8 like Buffer.toString", async () => {
    const bytes = Buffer.concat([
      Buffer.from("a\u{e9}\u{20ac}\u{1f600}\n\u{1f600}b\u{10348}\n", "utf-8"),
      Buffer.from([
        0x61, 0xc3, 0x0a, 0xe2, 0x82, 0x0a, 0xff, 0xfe, 0x80, 0xf0, 0x9f, 0x98, 0x0a, 0xed, 0xa0,
        0x80,
      ]),
    ]);
    for (const chunkSize of [1, 2, 3]) {
      expect(await streamedOutcome(chunked(bytes, chunkSize), undefined, undefined)).toEqual(
        referenceOutcome(bytes.toString("utf-8"), undefined, undefined),
      );
    }
  });

  it("reads local files through the default stream", async () => {
    const path = join(tempDir, "local.txt");
    const text = lines(3000, (i) => `${i} ${"w".repeat(i % 40)}`);
    writeFileSync(path, text);
    const tool = readTool();
    for (const [offset, limit] of [
      [undefined, undefined],
      [1500, 10],
    ] as const) {
      const result = await tool.execute({ path, offset, limit }, toolContext());
      expect(toolOutcome(result)).toEqual(referenceRead(text, offset, limit));
    }
    expect(await tool.execute({ path: tempDir }, toolContext())).toMatchObject({
      content: `${tempDir} is a directory. Use ls to list it.`,
      isError: true,
    });
  });

  it("reads a local file up to its size when opened, like fs.readFile", async () => {
    const path = join(tempDir, "growing.txt");
    // Larger than one 64 KB chunk, so the append lands before the read reaches the end.
    writeFileSync(path, `head\n${"x".repeat(200_000)}`);
    const decode = TextDecoder.prototype.decode;
    let appended = false;
    vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
      this: TextDecoder,
      ...args: Parameters<TextDecoder["decode"]>
    ) {
      if (!appended) {
        appended = true;
        appendFileSync(path, "\nadded");
      }
      return decode.apply(this, args);
    });

    const result = await readTool().execute({ path, limit: 1 }, toolContext());

    expect(appended).toBe(true);
    expect(result.content).toBe("head\n\n[1 more lines in file. Use offset=2 to continue.]");
  });

  // #11956
  it("resolves without an unhandled error when aborted while opening a local file", async () => {
    const path = join(tempDir, "abort-on-open.txt");
    writeFileSync(path, "line\n");
    const controller = new AbortController();
    const open = fsp.open;
    vi.spyOn(fsp, "open").mockImplementation((...args: Parameters<typeof fsp.open>) => {
      controller.abort();
      return open(...args);
    });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
    try {
      expect(await readTool().execute({ path }, toolContext(controller.signal))).toEqual({
        content: "Operation aborted",
        isError: true,
      });
      // An error the stream emitted would surface on a later tick.
      await delay(20);
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it("stops reading a local file when aborted mid-read", async () => {
    const path = join(tempDir, "abort-mid-read.txt");
    // Many 64 KB chunks, so the abort lands with most of the file unread.
    writeFileSync(path, "x".repeat(1024 * 1024));
    const controller = new AbortController();
    const decode = TextDecoder.prototype.decode;
    let decodedChunks = 0;
    vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
      this: TextDecoder,
      ...args: Parameters<TextDecoder["decode"]>
    ) {
      decodedChunks++;
      controller.abort();
      return decode.apply(this, args);
    });

    expect(await readTool().execute({ path }, toolContext(controller.signal))).toEqual({
      content: "Operation aborted",
      isError: true,
    });
    await delay(20);
    expect(decodedChunks).toBe(1);
  });

  it("reads a 200 MB line without storing it", async () => {
    // 64 KB chunks, as the tool reads a file.
    const chunk = Buffer.alloc(64 * 1024, "x");
    async function* createReadStream() {
      for (let i = 0; i < 3200; i++) yield chunk;
    }
    const { text } = await readLines(createReadStream(), undefined, undefined);
    expect(text).toBe(
      `${"x".repeat(DEFAULT_MAX_BYTES)}\n\n[Showing the first 50.0KB of line 1, which is 200.0MB. Use grep to see the text around a match further along it.]`,
    );
  });

  it("stops consuming the stream when aborted", async () => {
    const controller = new AbortController();
    let chunksRead = 0;
    let closed = false;
    async function* createReadStream() {
      try {
        while (true) {
          chunksRead++;
          if (chunksRead === 3) controller.abort();
          await delay(1);
          yield Buffer.from("line\n");
        }
      } finally {
        closed = true;
      }
    }
    await expect(
      readLines(createReadStream(), undefined, undefined, controller.signal),
    ).rejects.toThrow("Operation aborted");
    await delay(20);
    expect(closed).toBe(true);
    expect(chunksRead).toBe(3);
  });
});
