// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/tools.test.ts@ac78a60 and packages/coding-agent/test/edit-tool-diff-before-write.test.ts@ac78a60
//
// pi's edit, fuzzy-matching and line-ending cases in a task's folder, a failure a result rather
// than a rejection; then the task's own: refusals, files, aborts, arguments and non-UTF-8 files.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, join } from "node:path";
import type { TaskToolResult } from "@eidolon/engine";
import { applyPatch } from "diff";
import { createEditTool } from "../src/tools/edit.ts";
import * as editDiff from "../src/tools/edit-diff.ts";
import {
  applyEditsToNormalizedContent,
  applyReplacementsToOriginal,
  type EditDiff,
  normalizeToLF,
} from "../src/tools/edit-diff.ts";
import type { AssistantTool } from "../src/types.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

let testDir: string;
let editTool: AssistantTool;

function edit(args: Record<string, unknown>, signal?: AbortSignal): Promise<TaskToolResult> {
  return editTool.execute(args, toolContext(signal));
}

function diffOf(result: TaskToolResult): EditDiff {
  return result.details as EditDiff;
}

beforeEach(async () => {
  testDir = await tempFolder();
  editTool = createEditTool(folderGuard(testDir));
});

afterEach(async () => {
  mock.restore();
  await removeTempFolders();
});

describe("edit tool", () => {
  it("should replace text in file", async () => {
    const testFile = join(testDir, "edit-test.txt");
    const originalContent = "Hello, world!";
    writeFileSync(testFile, originalContent);

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "world", newText: "testing" }],
    });

    expect(result.content).toContain("Successfully replaced");
    const details = diffOf(result);
    expect(typeof details.diff).toBe("string");
    expect(details.diff).toContain("testing");
    expect(details.patch).toContain("--- ");
    expect(details.patch).toContain("+++ ");
    expect(details.patch).toContain("@@");
    expect(details.patch).toContain("-Hello, world!");
    expect(details.patch).toContain("+Hello, testing!");
    expect(applyPatch(originalContent, details.patch)).toBe("Hello, testing!");
  });

  it("should fail if text not found", async () => {
    const testFile = join(testDir, "edit-test.txt");
    writeFileSync(testFile, "Hello, world!");

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "nonexistent", newText: "testing" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Could not find the exact text/);
  });

  it("should include ENOENT when the edit target does not exist", async () => {
    const missingFile = join(testDir, "missing.txt");

    const result = await edit({
      path: missingFile,
      edits: [{ oldText: "hello", newText: "world" }],
    });

    expect(result).toEqual({
      content: `Could not edit file: ${missingFile}. Error code: ENOENT.`,
      isError: true,
    });
  });

  it("should fail if text appears multiple times", async () => {
    const testFile = join(testDir, "edit-test.txt");
    writeFileSync(testFile, "foo foo foo");

    const result = await edit({ path: testFile, edits: [{ oldText: "foo", newText: "bar" }] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Found 3 occurrences/);
  });

  it("should replace multiple disjoint regions in one call", async () => {
    const testFile = join(testDir, "edit-multi.txt");
    writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

    const result = await edit({
      path: testFile,
      edits: [
        { oldText: "alpha\n", newText: "ALPHA\n" },
        { oldText: "gamma\n", newText: "GAMMA\n" },
      ],
    });

    expect(result.content).toContain("Successfully replaced 2 block(s)");
    expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
    expect(diffOf(result).diff).toContain("ALPHA");
    expect(diffOf(result).diff).toContain("GAMMA");
  });

  it("should collapse large unchanged gaps in multi-edit diffs", async () => {
    const testFile = join(testDir, "edit-multi-large-gap.txt");
    const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
    writeFileSync(testFile, `${lines.join("\n")}\n`);

    const result = await edit({
      path: testFile,
      edits: [
        { oldText: "line 100\n", newText: "LINE 100\n" },
        { oldText: "line 300\n", newText: "LINE 300\n" },
        { oldText: "line 500\n", newText: "LINE 500\n" },
      ],
    });

    const diff = diffOf(result).diff;
    expect(diff).toContain("LINE 100");
    expect(diff).toContain("LINE 300");
    expect(diff).toContain("LINE 500");
    expect(diff).toContain("...");
    expect(diff).not.toContain("line 250");
    expect(diff.split("\n").length).toBeLessThan(50);
  });

  it("should match edits against the original file, not incrementally", async () => {
    const testFile = join(testDir, "edit-multi-original.txt");
    writeFileSync(testFile, "foo\nbar\nbaz\n");

    await edit({
      path: testFile,
      edits: [
        { oldText: "foo\n", newText: "foo bar\n" },
        { oldText: "bar\n", newText: "BAR\n" },
      ],
    });

    expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
  });

  it("should fail when edits is empty", async () => {
    const testFile = join(testDir, "edit-empty-edits.txt");
    writeFileSync(testFile, "hello\nworld\n");

    const result = await edit({ path: testFile, edits: [] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/edits must contain at least one replacement/);
  });

  it("should fail when multi-edit regions overlap", async () => {
    const testFile = join(testDir, "edit-overlap.txt");
    writeFileSync(testFile, "one\ntwo\nthree\n");

    const result = await edit({
      path: testFile,
      edits: [
        { oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
        { oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/overlap/);
  });

  it("should not partially apply edits when one edit fails", async () => {
    const testFile = join(testDir, "edit-no-partial.txt");
    const originalContent = "alpha\nbeta\ngamma\n";
    writeFileSync(testFile, originalContent);

    const result = await edit({
      path: testFile,
      edits: [
        { oldText: "alpha\n", newText: "ALPHA\n" },
        { oldText: "missing\n", newText: "MISSING\n" },
      ],
    });

    expect(result.content).toMatch(/Could not find/);
    expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
  });

  it("should include EACCES for read-only files", async () => {
    const testFile = join(testDir, "edit-readonly.txt");
    writeFileSync(testFile, "hello\n");
    chmodSync(testFile, 0o444);

    const result = await edit({ path: testFile, edits: [{ oldText: "hello", newText: "world" }] });

    expect(result.content).toBe(`Could not edit file: ${testFile}. Error code: EACCES.`);
  });

  it("should include the original error message for unknown edit access errors", async () => {
    writeFileSync(join(testDir, "broken.txt"), "hello\n");
    spyOn(fsp, "access").mockImplementation(async () => {
      throw new Error("disk offline");
    });

    const result = await edit({
      path: "broken.txt",
      edits: [{ oldText: "hello", newText: "world" }],
    });

    expect(result.content).toBe("Could not edit file: broken.txt. Error: disk offline.");
  });

  it("should compute the diff before writing, so a diff failure leaves the file unchanged", async () => {
    writeFileSync(join(testDir, "f.txt"), "a\nb\n");
    spyOn(editDiff, "generateEditDiff").mockImplementation(() => {
      throw new Error("diff failed");
    });
    const writeFile = spyOn(fsp, "writeFile");

    const result = await edit({ path: "f.txt", edits: [{ oldText: "b", newText: "B" }] });

    expect(result).toEqual({ content: "diff failed", isError: true });
    expect(writeFile).not.toHaveBeenCalled();
    expect(readFileSync(join(testDir, "f.txt"), "utf-8")).toBe("a\nb\n");
  });

  it("edits a relative path in the task's folder", async () => {
    const testFile = join(testDir, "ctx-cwd-edit.txt");
    writeFileSync(testFile, "old text");

    await edit({
      path: "ctx-cwd-edit.txt",
      edits: [{ oldText: "old text", newText: "new text" }],
    });

    expect(readFileSync(testFile, "utf-8")).toBe("new text");
  });
});

describe("edit tool fuzzy matching", () => {
  it("should match text with trailing whitespace stripped", async () => {
    const testFile = join(testDir, "trailing-ws.txt");
    // File has trailing spaces on lines
    writeFileSync(testFile, "line one   \nline two  \nline three\n");

    // oldText without trailing whitespace should still match
    const result = await edit({
      path: testFile,
      edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
    });

    expect(result.content).toContain("Successfully replaced");
    expect(readFileSync(testFile, "utf-8")).toBe("replaced\nline three\n");
  });

  it("should match fullwidth punctuation in Chinese text", async () => {
    const testFile = join(testDir, "chinese-punctuation.txt");
    writeFileSync(testFile, "你好\u{ff0c}世界\n你好\u{ff08}世界\u{ff09}\n");

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好\u{ff0c}pi\n你好(pi)\n" }],
    });

    expect(result.content).toContain("Successfully replaced");
    expect(readFileSync(testFile, "utf-8")).toBe("你好\u{ff0c}pi\n你好(pi)\n");
  });

  it("should match compatibility-equivalent Unicode forms", async () => {
    const testFile = join(testDir, "unicode-compatibility.txt");
    writeFileSync(testFile, "\u{ff21}\u{ff22}\u{ff23}\u{ff11}\u{ff12}\u{ff13}\ncafe\u{301}\n");

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "ABC123\ncaf\u{e9}\n", newText: "XYZ789\ncoffee\n" }],
    });

    expect(result.content).toContain("Successfully replaced");
    expect(readFileSync(testFile, "utf-8")).toBe("XYZ789\ncoffee\n");
  });

  it("should match smart single quotes to ASCII quotes", async () => {
    const testFile = join(testDir, "smart-quotes.txt");
    // File has smart/curly single quotes (U+2018, U+2019)
    writeFileSync(testFile, "console.log(\u{2018}hello\u{2019});\n");

    // oldText with ASCII quotes should match
    const result = await edit({
      path: testFile,
      edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
    });

    expect(result.content).toContain("Successfully replaced");
    expect(readFileSync(testFile, "utf-8")).toContain("world");
  });

  it("should match smart double quotes to ASCII quotes", async () => {
    const testFile = join(testDir, "smart-double-quotes.txt");
    // File has smart/curly double quotes (U+201C, U+201D)
    writeFileSync(testFile, "const msg = \u{201c}Hello World\u{201d};\n");

    // oldText with ASCII quotes should match
    const result = await edit({
      path: testFile,
      edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
    });

    expect(result.content).toContain("Successfully replaced");
    expect(readFileSync(testFile, "utf-8")).toContain("Goodbye");
  });

  it("should match Unicode dashes to ASCII hyphen", async () => {
    const testFile = join(testDir, "unicode-dashes.txt");
    // File has en-dash (U+2013) and em-dash (U+2014)
    writeFileSync(testFile, "range: 1\u{2013}5\nbreak\u{2014}here\n");

    // oldText with ASCII hyphens should match
    const result = await edit({
      path: testFile,
      edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
    });

    expect(result.content).toContain("Successfully replaced");
    expect(readFileSync(testFile, "utf-8")).toContain("10-50");
  });

  it("should match non-breaking space to regular space", async () => {
    const testFile = join(testDir, "nbsp.txt");
    // File has non-breaking space (U+00A0)
    writeFileSync(testFile, "hello\u{a0}world\n");

    // oldText with regular space should match
    const result = await edit({
      path: testFile,
      edits: [{ oldText: "hello world", newText: "hello universe" }],
    });

    expect(result.content).toContain("Successfully replaced");
    expect(readFileSync(testFile, "utf-8")).toContain("universe");
  });

  it("should prefer exact match over fuzzy match", async () => {
    const testFile = join(testDir, "exact-preferred.txt");
    // File has both exact and fuzzy-matchable content
    writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
    });

    expect(result.content).toContain("Successfully replaced");
    expect(readFileSync(testFile, "utf-8")).toBe("const x = 'changed';\nconst y = 'other';\n");
  });

  it("should still fail when text is not found even with fuzzy matching", async () => {
    const testFile = join(testDir, "no-match.txt");
    writeFileSync(testFile, "completely different content\n");

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "this does not exist", newText: "replacement" }],
    });

    expect(result.content).toMatch(/Could not find the exact text/);
  });

  it("should detect duplicates after fuzzy normalization", async () => {
    const testFile = join(testDir, "fuzzy-dups.txt");
    // Two lines that are identical after trailing whitespace is stripped
    writeFileSync(testFile, "hello world   \nhello world\n");

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "hello world", newText: "replaced" }],
    });

    expect(result.content).toMatch(/Found 2 occurrences/);
  });

  it("should support fuzzy matching in multi-edit mode", async () => {
    const testFile = join(testDir, "fuzzy-multi.txt");
    writeFileSync(testFile, "console.log(\u{2018}hello\u{2019});\nhello\u{a0}world\n");

    await edit({
      path: testFile,
      edits: [
        { oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
        { oldText: "hello world\n", newText: "hello universe\n" },
      ],
    });

    expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\nhello universe\n");
  });

  it("should preserve the correct occurrence when fuzzy replacement equals a nearby line", async () => {
    const testFile = join(testDir, "fuzzy-preserve-duplicate-line.txt");
    const originalContent = ["replace me   ", "after   ", ""].join("\n");
    writeFileSync(testFile, originalContent);

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "replace me\n", newText: "after\n" }],
    });

    const expectedContent = ["after", "after   ", ""].join("\n");
    expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
    expect(applyPatch(originalContent, diffOf(result).patch)).toBe(expectedContent);
  });

  it("should keep the text around a fuzzy match as it was, on the lines it touches too", async () => {
    const cases = [
      // Fullwidth punctuation and a trailing space outside the match.
      {
        before: "周一\u{ff1a}写周报\u{ff0c}整理笔记 \n周二\u{ff1a}开会\u{ff01}\n",
        edits: [{ oldText: "整理笔记\n周二", newText: "整理笔记\n周三" }],
        after: "周一\u{ff1a}写周报\u{ff0c}整理笔记\n周三\u{ff1a}开会\u{ff01}\n",
      },
      // An exact edit batched with a fuzzy one; fullwidth digits and brackets stay.
      {
        before:
          "负责人\u{ff1a}小明\u{ff08}组长\u{ff09}\u{ff0c}电话\u{ff1a}\u{ff11}\u{ff13}\u{ff18}\n他说\u{ff1a}\u{201c}明天见\u{201d}\n",
        edits: [
          { oldText: "小明", newText: "小红" },
          { oldText: '"明天见"', newText: "\u{201c}后天见\u{201d}" },
        ],
        after:
          "负责人\u{ff1a}小红\u{ff08}组长\u{ff09}\u{ff0c}电话\u{ff1a}\u{ff11}\u{ff13}\u{ff18}\n他说\u{ff1a}\u{201c}后天见\u{201d}\n",
      },
      // Curly quotes and a dash on the same line as the match.
      {
        before: "He said \u{201c}hi\u{201d} \u{2014} then She said \u{201c}bye\u{201d}.\n",
        edits: [{ oldText: 'She said "bye".', newText: 'She said "see you".' }],
        after: 'He said \u{201c}hi\u{201d} \u{2014} then She said "see you".\n',
      },
      // A match that starts inside a ligature takes the whole ligature, normalized.
      {
        before: "\u{fb01}x the \u{fb02}ow\n",
        edits: [{ oldText: "ix the", newText: "IX THE" }],
        after: "fIX THE \u{fb02}ow\n",
      },
    ];
    for (const [index, { before, edits, after }] of cases.entries()) {
      const testFile = join(testDir, `fuzzy-keeps-${index}.txt`);
      writeFileSync(testFile, before);

      const result = await edit({ path: testFile, edits });

      expect([index, result.content]).toEqual([
        index,
        `Successfully replaced ${edits.length} block(s) in ${testFile}.`,
      ]);
      expect([index, readFileSync(testFile, "utf-8")]).toEqual([index, after]);
      expect(applyPatch(before, diffOf(result).patch)).toBe(after);
    }
  });

  it("matches an edit in a 10 MB Chinese file in a few times what NFKC alone takes", () => {
    // NFKC changes every line, by its fullwidth punctuation.
    const line =
      "今天直播唱了三首歌，分别是《晴天》、《稻香》和《七里香》！观众说：“太好听了（真的）。”\n";
    const body = line.repeat(Math.floor((10 * 1024 * 1024) / Buffer.byteLength(line)));
    const quickest = (work: () => void) => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        work();
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const nfkc = quickest(() => body.split("\n").map((each) => each.normalize("NFKC")));
    for (const oldText of ["最后一行：结束", "最后一行:结束"]) {
      const elapsed = quickest(() => {
        const { newContent } = applyEditsToNormalizedContent(
          `${body}最后一行：结束\n`,
          [{ oldText, newText: "最后一行：完" }],
          "notes.md",
        );
        expect(newContent).toBe(`${body}最后一行：完\n`);
      });
      expect([oldText, elapsed < nfkc * 8]).toEqual([oldText, true]);
    }
  });

  it("should preserve untouched lines and produce an applicable patch for fuzzy multi-edits", async () => {
    const testFile = join(testDir, "fuzzy-preserve-multi.txt");
    const originalContent = [
      "keep before  ",
      "first target  ",
      "first after",
      "keep middle   ",
      "second target  ",
      "second after",
      "keep after  ",
      "",
    ].join("\n");
    writeFileSync(testFile, originalContent);

    const result = await edit({
      path: testFile,
      edits: [
        { oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
        { oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
      ],
    });

    const expectedContent = [
      "keep before  ",
      "FIRST",
      "FIRST2",
      "keep middle   ",
      "SECOND",
      "SECOND2",
      "keep after  ",
      "",
    ].join("\n");
    expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
    expect(applyPatch(originalContent, diffOf(result).patch)).toBe(expectedContent);
  });
});

describe("edit tool CRLF handling", () => {
  it("should match LF oldText against CRLF file content", async () => {
    const testFile = join(testDir, "crlf-test.txt");
    writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
    });

    expect(result.content).toContain("Successfully replaced");
  });

  it("should preserve CRLF line endings after edit", async () => {
    const testFile = join(testDir, "crlf-preserve.txt");
    writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

    await edit({ path: testFile, edits: [{ oldText: "second\n", newText: "REPLACED\n" }] });

    expect(readFileSync(testFile, "utf-8")).toBe("first\r\nREPLACED\r\nthird\r\n");
  });

  it("should preserve LF line endings for LF files", async () => {
    const testFile = join(testDir, "lf-preserve.txt");
    writeFileSync(testFile, "first\nsecond\nthird\n");

    await edit({ path: testFile, edits: [{ oldText: "second\n", newText: "REPLACED\n" }] });

    expect(readFileSync(testFile, "utf-8")).toBe("first\nREPLACED\nthird\n");
  });

  it("should detect duplicates across CRLF/LF variants", async () => {
    const testFile = join(testDir, "mixed-endings.txt");
    writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

    const result = await edit({
      path: testFile,
      edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
    });

    expect(result.content).toMatch(/Found 2 occurrences/);
  });

  it("should preserve UTF-8 BOM after edit", async () => {
    const testFile = join(testDir, "bom-test.txt");
    writeFileSync(testFile, "\u{feff}first\r\nsecond\r\nthird\r\n");

    await edit({ path: testFile, edits: [{ oldText: "second\n", newText: "REPLACED\n" }] });

    expect(readFileSync(testFile, "utf-8")).toBe("\u{feff}first\r\nREPLACED\r\nthird\r\n");
  });

  it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
    const testFile = join(testDir, "bom-crlf-multi.txt");
    writeFileSync(testFile, "\u{feff}first\r\nsecond\r\nthird\r\nfourth\r\n");

    await edit({
      path: testFile,
      edits: [
        { oldText: "second\n", newText: "SECOND\n" },
        { oldText: "fourth\n", newText: "FOURTH\n" },
      ],
    });

    expect(readFileSync(testFile, "utf-8")).toBe("\u{feff}first\r\nSECOND\r\nthird\r\nFOURTH\r\n");
  });

  it("should write CRLF for inserted lines in CRLF files", async () => {
    const testFile = join(testDir, "crlf-bytes.txt");
    writeFileSync(testFile, "first\r\nsecond\r\nthird");

    await edit({
      path: testFile,
      edits: [{ oldText: "second\nthird", newText: "2a\r\n2b\nthird!" }],
    });

    expect(readFileSync(testFile).equals(Buffer.from("first\r\n2a\r\n2b\r\nthird!"))).toBe(true);
  });

  it("should write LF for inserted lines in LF files", async () => {
    const testFile = join(testDir, "lf-bytes.txt");
    writeFileSync(testFile, "first\nsecond\nthird");

    await edit({
      path: testFile,
      edits: [{ oldText: "second\nthird", newText: "2a\r\n2b\nthird!" }],
    });

    expect(readFileSync(testFile).equals(Buffer.from("first\n2a\n2b\nthird!"))).toBe(true);
  });

  // #8544
  it("should keep CRLF lines when the first line ends with LF", async () => {
    const testFile = join(testDir, "mixed-lf-first.txt");
    writeFileSync(testFile, "a\nb\r\nX = 1\r\n");

    await edit({ path: testFile, edits: [{ oldText: "X = 1", newText: "X = 2" }] });

    expect(readFileSync(testFile).equals(Buffer.from("a\nb\r\nX = 2\r\n"))).toBe(true);
  });

  // #8544
  it("should keep LF lines when the first line ends with CRLF", async () => {
    const testFile = join(testDir, "mixed-crlf-first.txt");
    writeFileSync(testFile, "a\r\nb\nc");

    await edit({ path: testFile, edits: [{ oldText: "c", newText: "C" }] });

    expect(readFileSync(testFile).equals(Buffer.from("a\r\nb\nC"))).toBe(true);
  });

  // #8544
  it("should keep a lone CR in an untouched line", async () => {
    const testFile = join(testDir, "lone-cr.txt");
    writeFileSync(testFile, "a\rb\nX = 1\n");

    await edit({ path: testFile, edits: [{ oldText: "X = 1", newText: "X = 2" }] });

    expect(readFileSync(testFile).equals(Buffer.from("a\rb\nX = 2\n"))).toBe(true);
  });

  // #8544
  it("should give inserted lines the line ending of the line they replace in multi-edit mode", async () => {
    const testFile = join(testDir, "mixed-multi.txt");
    writeFileSync(testFile, "lf1\nlf2\ncr1\r\ncr2\r\n");

    await edit({
      path: testFile,
      edits: [
        { oldText: "lf1\n", newText: "A\nB\n" },
        { oldText: "cr1\n", newText: "C\nD\n" },
      ],
    });

    expect(readFileSync(testFile).equals(Buffer.from("A\nB\nlf2\nC\r\nD\r\ncr2\r\n"))).toBe(true);
  });

  // #8544
  it("should keep untouched line endings when fuzzy matching widens the edit to whole lines", async () => {
    const testFile = join(testDir, "mixed-fuzzy.txt");
    writeFileSync(testFile, "a\r\nfoo   \r\nb\n");

    await edit({ path: testFile, edits: [{ oldText: "foo\n", newText: "FOO\n" }] });

    expect(readFileSync(testFile).equals(Buffer.from("a\r\nFOO\r\nb\n"))).toBe(true);
  });

  // A kept CR and an LF meeting at a splice seam must not merge into one CRLF line break.
  it("should not merge a kept lone CR with a line feed after it", async () => {
    const cases = [
      // Inserted text starting with LF after a kept lone CR.
      { edit: { oldText: "b", newText: "\nB" }, written: "a\r\n\nB\nc", diffed: "a\n\nB\nc" },
      // Deleted text between a kept lone CR and a kept LF.
      { edit: { oldText: "b", newText: "" }, written: "a\r\n\nc", diffed: "a\n\nc" },
    ];
    for (const [index, { edit: change, written, diffed }] of cases.entries()) {
      const testFile = join(testDir, `cr-seam-${index}.txt`);
      writeFileSync(testFile, "a\rb\nc");

      const result = await edit({ path: testFile, edits: [change] });

      expect(readFileSync(testFile).equals(Buffer.from(written))).toBe(true);
      expect(applyPatch("a\nb\nc", diffOf(result).patch)).toBe(diffed);
    }
  });

  it("should not merge an inserted CR line ending with a kept line feed after it", () => {
    // Only files without LF give inserted text CR line endings, so check the seam directly.
    const written = applyReplacementsToOriginal("a\rb\nc", [
      { matchIndex: 2, matchLength: 1, newText: "\r" },
    ]);

    expect(normalizeToLF(written)).toBe("a\n\n\nc");
  });

  it("should write content that normalizes to the diffed content for random mixed line endings", () => {
    let seed = 1;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // The high bits: the low bits of this generator repeat with a short period.
      return Math.floor((seed / 0x80000000) * n);
    };
    const endings = ["\n", "\r\n", "\r", ""];
    for (let run = 0; run < 3000; run++) {
      let original = "";
      for (let line = random(12) + 1; line > 0; line--) {
        original += `w${random(100)}${random(5) === 0 ? "  " : ""}${endings[random(4)]}`;
      }
      const normalized = normalizeToLF(original);
      const start = random(normalized.length);
      const oldText = normalized.slice(start, start + 1 + random(12));
      const newText = ["", "\n", "X\n", "\nY", "\r", "Z"][random(6)] as string;
      let applied: ReturnType<typeof applyEditsToNormalizedContent>;
      try {
        applied = applyEditsToNormalizedContent(normalized, [{ oldText, newText }], "f.txt");
      } catch {
        continue; // duplicate, not found or no change
      }

      expect(normalizeToLF(applyReplacementsToOriginal(original, applied.replacements))).toBe(
        applied.newContent,
      );
    }
  });
});

describe("edit tool in a task", () => {
  it("names the file it wrote, and none when it fails", async () => {
    writeFileSync(join(testDir, "a.txt"), "alpha\n");

    const done = await edit({ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] });
    const failed = await edit({ path: "a.txt", edits: [{ oldText: "alpha", newText: "beta" }] });

    expect(done.files).toEqual({ written: [join(testDir, "a.txt")] });
    expect(failed.isError).toBe(true);
    expect(failed.files).toBeUndefined();
  });

  it("refuses a path outside the task's folders, and leaves the file alone", async () => {
    const outside = await tempFolder();
    const target = join(outside, "notes.txt");
    writeFileSync(target, "keep\n");

    for (const path of [target, `../${basename(outside)}/notes.txt`]) {
      expect(await edit({ path, edits: [{ oldText: "keep", newText: "lost" }] })).toEqual({
        content: `${target} is outside the folders this task may write. If the task needs it, ask for access rather than working around it.`,
        isError: true,
        refused: { path: target, access: "write" },
      });
    }
    expect(readFileSync(target, "utf-8")).toBe("keep\n");
  });

  it("refuses a denied path with nothing to ask for", async () => {
    const keys = join(testDir, ".aws");
    editTool = createEditTool(folderGuard(testDir, [keys]));

    expect(
      await edit({ path: ".aws/credentials", edits: [{ oldText: "a", newText: "b" }] }),
    ).toEqual({
      content: `No task may write ${join(keys, "credentials")}, whatever access it is given.`,
      isError: true,
    });
  });

  it("leaves the file alone once aborted", async () => {
    const guard = folderGuard(testDir);
    editTool = createEditTool(guard);
    writeFileSync(join(testDir, "a.txt"), "alpha\n");
    const controller = new AbortController();
    controller.abort();

    const result = await edit(
      { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
      controller.signal,
    );

    expect(result).toEqual({ content: "Operation aborted", isError: true });
    expect(readFileSync(join(testDir, "a.txt"), "utf-8")).toBe("alpha\n");
    expect(guard.resolved).toEqual([]);
  });

  it("won't edit a file that isn't UTF-8, which writing back would damage", async () => {
    const gbk = Buffer.from([
      0x63, 0x6f, 0x64, 0x65, 0x3d, 0x31, 0x0a, 0xc4, 0xe3, 0xba, 0xc3, 0x0a,
    ]);
    writeFileSync(join(testDir, "gbk.txt"), gbk);

    const result = await edit({
      path: "gbk.txt",
      edits: [{ oldText: "code=1", newText: "code=2" }],
    });

    expect(result).toEqual({
      content: "gbk.txt isn't UTF-8 text, so edit would damage it.",
      isError: true,
    });
    expect(readFileSync(join(testDir, "gbk.txt")).equals(gbk)).toBe(true);
  });

  it("takes edits sent as a JSON string or as one edit", async () => {
    writeFileSync(join(testDir, "a.txt"), "one\ntwo\n");

    const fromString = await edit({
      path: "a.txt",
      edits: JSON.stringify([{ oldText: "one", newText: "ONE" }]),
    });
    const fromObject = await edit({ path: "a.txt", edits: { oldText: "two", newText: "TWO" } });

    expect(fromString.content).toBe("Successfully replaced 1 block(s) in a.txt.");
    expect(fromObject.content).toBe("Successfully replaced 1 block(s) in a.txt.");
    expect(readFileSync(join(testDir, "a.txt"), "utf-8")).toBe("ONE\nTWO\n");
  });

  it("rejects arguments it can't use, naming each", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ path: "a.txt" }, "  - edits: missing"],
      [{ path: "a.txt", edits: 3 }, "  - edits: expected array, got integer"],
      [{ path: "a.txt", edits: "not json" }, "  - edits: expected array, got string"],
      [{ path: "a.txt", edits: ["x"] }, "  - edits.0: expected object, got string"],
      [
        { path: "a.txt", edits: [{ oldText: "a", newText: "b" }, { oldText: "c" }] },
        "  - edits.1.newText: missing",
      ],
      [{ edits: [{ oldText: "a", newText: "b" }] }, "  - path: missing"],
    ];
    for (const [args, problem] of cases) {
      const result = await edit(args);
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith(`Validation failed for tool "edit":\n${problem}\n`);
      expect(result.content).toEndWith(`Received arguments:\n${JSON.stringify(args, null, 2)}`);
    }
    expect(existsSync(join(testDir, "a.txt"))).toBe(false);
  });

  it("describes itself as pi's edit does", () => {
    const { schema } = editTool;
    expect(schema.name).toBe("edit");
    expect(schema.required).toEqual(["path", "edits"]);
    expect(schema.properties.edits).toMatchObject({
      type: "array",
      items: {
        type: "object",
        properties: { oldText: { type: "string" }, newText: { type: "string" } },
        required: ["oldText", "newText"],
      },
    });
    expect(editTool.replay).toBe("never");
    expect(editTool.executionMode).toBeUndefined();
    expect(editTool.snippet).toBe(
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    );
    expect(editTool.guidelines).toEqual([
      "Use edit for targeted changes. Batch changes to one file in a single call.",
      "Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
    ]);
  });
});
