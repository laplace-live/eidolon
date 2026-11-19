// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/tools.test.ts@ac78a60
//
// pi's grep cases without context lines, which this grep doesn't have, or those that test rg itself,
// and with whole-number limits; then the search's own: regexes and case, binary files, the ignore
// rules, globs, refusals, aborts and arguments.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskToolResult } from "@eidolon/engine";
import { createGrepTool, type GrepDetails } from "../src/tools/grep.ts";
import { GREP_MAX_LINE_LENGTH } from "../src/tools/truncate.ts";
import type { AssistantTool, PathGuard } from "../src/types.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

let testDir: string;
let grepTool: AssistantTool;

function grep(args: Record<string, unknown>, signal?: AbortSignal): Promise<TaskToolResult> {
  return grepTool.execute(args, toolContext(signal));
}

function write(path: string, content: string | Buffer = ""): void {
  mkdirSync(join(testDir, path, ".."), { recursive: true });
  writeFileSync(join(testDir, path), content);
}

/** The rows a search returns, sorted, without notices. */
async function rows(args: Record<string, unknown>): Promise<string[]> {
  const result = await grep(args);
  if (result.content === "No matches found") return [];
  return (result.content.split("\n\n")[0] as string).split("\n").sort();
}

beforeEach(async () => {
  testDir = await tempFolder();
  grepTool = createGrepTool(folderGuard(testDir));
});

afterEach(removeTempFolders);

describe("grep tool", () => {
  it("should include filename when searching a single file", async () => {
    const testFile = join(testDir, "example.txt");
    writeFileSync(testFile, "first line\nmatch line\nlast line");

    const result = await grep({ pattern: "match", path: testFile });

    expect(result.content).toContain("example.txt:2: match line");
  });

  it("should respect global limit", async () => {
    const testFile = join(testDir, "context.txt");
    const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
    writeFileSync(testFile, content);

    const result = await grep({ pattern: "match", path: testFile, limit: 1 });

    expect(result.content).toContain("context.txt:2: match one");
    expect(result.content).toContain(
      "[1 matches limit reached. Use limit=2 for more, or refine pattern]",
    );
    expect(result.content).not.toContain("match two");
  });

  // https://github.com/earendil-works/pi/issues/9276
  it("should keep counting matches past the byte cap", async () => {
    const testFile = join(testDir, "byte-cap.txt");
    const line = `match ${"x".repeat(400)}`;
    writeFileSync(testFile, Array.from({ length: 200 }, () => line).join("\n"));

    const result = await grep({ pattern: "match", path: testFile, limit: 150 });

    expect(result.content).toContain("150 matches limit reached");
    expect(result.content).toContain("50.0KB limit reached");
    const details = result.details as GrepDetails;
    expect(details.matchLimitReached).toBe(150);
    expect(details.truncation?.totalLines).toBe(150);
  });

  // https://github.com/earendil-works/pi/issues/9276
  it("should report truncation when stored output ends exactly at the byte cap", async () => {
    const testFile = join(testDir, "x");
    // The first 104 rows, with newlines between them, join to exactly 50KB; one more match follows.
    writeFileSync(
      testFile,
      [...Array(103).fill("x".repeat(490)), "x".repeat(7), "extra x"].join("\n"),
    );

    const result = await grep({ pattern: "x", path: testFile, limit: 1000 });

    expect(result.content).toContain("[50.0KB limit reached]");
    expect((result.details as GrepDetails).truncation?.totalLines).toBe(105);
  });

  // https://github.com/earendil-works/pi/issues/11423
  it("should decode UTF-16 files", async () => {
    const testFile = join(testDir, "utf16.txt");
    writeFileSync(testFile, Buffer.from("﻿before\nneedle 中文\nafter\n", "utf16le"));

    const result = await grep({ pattern: "needle", path: testFile });

    expect(result.content).toBe("utf16.txt:2: needle 中文");
  });

  it("reads text that isn't UTF-8 as GB18030, as read does", async () => {
    // 你好，世界 as GBK.
    write("notes.txt", Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]));

    expect(await rows({ pattern: "你好" })).toEqual(["notes.txt:1: 你好，世界"]);
  });

  it("reads UTF-8 with a stray byte, or Latin-1, as UTF-8, as read does", async () => {
    // A Windows-1252 apostrophe pasted into UTF-8 notes, and a Windows-1252 CSV.
    write(
      "notes.md",
      Buffer.concat([
        Buffer.from("# 直播笔记\n今天的歌单：晴天、稻香\nIt"),
        Buffer.from([0x92]),
        Buffer.from("s done\n明天直播唱歌\n"),
      ]),
    );
    write("kunden.csv", Buffer.from("Name;Stadt\nM\xfcller;M\xfcnchen\n", "latin1"));

    expect(await rows({ pattern: "直播" })).toEqual([
      "notes.md:1: # 直播笔记",
      "notes.md:4: 明天直播唱歌",
    ]);
    expect(await rows({ pattern: "nchen|ller" })).toEqual([
      "kunden.csv:2: M\ufffdller;M\ufffdnchen",
    ]);
  });

  it("should keep a lone CR inside a line and strip CRLF terminators", async () => {
    const testFile = join(testDir, "mixed-cr.txt");
    writeFileSync(testFile, "one\rtwo needle\r\nnext\r\n");

    const plain = await grep({ pattern: "needle", path: testFile });

    expect(plain.content).toBe("mixed-cr.txt:1: one\rtwo needle");
  });

  it("should not report the match limit when exactly limit matches exist", async () => {
    const testFile = join(testDir, "exact-limit.txt");
    writeFileSync(testFile, ["match one", "x", "match two", "y"].join("\n"));

    const exact = await grep({ pattern: "match", path: testFile, limit: 2 });
    expect(exact.content).not.toContain("limit reached");
    expect(exact.details).toBeUndefined();

    const over = await grep({ pattern: "match", path: testFile, limit: 1 });
    expect(over.content).toContain(
      "[1 matches limit reached. Use limit=2 for more, or refine pattern]",
    );
    expect((over.details as GrepDetails).matchLimitReached).toBe(1);
  });

  // https://github.com/earendil-works/pi/issues/11807
  it("should resolve folder globs relative to path", async () => {
    const repo = join(testDir, "repo");
    mkdirSync(join(repo, "migrations", "main"), { recursive: true });
    mkdirSync(join(repo, "nested", "migrations", "main"), { recursive: true });
    writeFileSync(join(repo, "migrations", "main", "a.js"), "hello\n");
    writeFileSync(join(repo, "nested", "migrations", "main", "b.js"), "hello\n");
    const link = join(testDir, "repo-link");
    symlinkSync(repo, link);

    for (const searchPath of [repo, link]) {
      const anchored = await grep({
        pattern: "hello",
        path: searchPath,
        glob: "migrations/main/*.js",
      });
      // The decoy under nested/ stays out: the glob is anchored at path.
      expect(anchored.content).toBe("migrations/main/a.js:1: hello");

      const anyDepth = await grep({
        pattern: "hello",
        path: searchPath,
        glob: "**/migrations/main/*.js",
      });
      expect(anyDepth.content.split("\n").sort()).toEqual([
        "migrations/main/a.js:1: hello",
        "nested/migrations/main/b.js:1: hello",
      ]);

      // rg matches nothing for a leading "./", so the tool drops it.
      const dotSlash = await grep({
        pattern: "hello",
        path: searchPath,
        glob: "./migrations/main/*.js",
      });
      expect(dotSlash.content).toBe("migrations/main/a.js:1: hello");

      const negated = await grep({
        pattern: "hello",
        path: searchPath,
        glob: "!./migrations/**",
      });
      expect(negated.content).toBe("nested/migrations/main/b.js:1: hello");
    }
  });

  it("should treat flag-like patterns as search text", async () => {
    writeFileSync(join(testDir, "target.txt"), "target\n");

    const result = await grep({ pattern: "--pre=payload.sh", path: testDir });

    expect(result.content).toContain("No matches found");
  });

  it("grep uses the task's folder when no path is given", async () => {
    writeFileSync(join(testDir, "ctx-cwd-grep.txt"), "match in ctx.cwd");

    const result = await grep({ pattern: "match" });

    expect(result.content).toContain("ctx-cwd-grep.txt");
  });
});

describe("grep's search", () => {
  it("reads the pattern as a regex unless it is literal, and ignores case when asked", async () => {
    write("fixture.txt", "aXb\na.b\nA.B\n");

    expect(await rows({ pattern: "a.b" })).toEqual(["fixture.txt:1: aXb", "fixture.txt:2: a.b"]);
    expect(await rows({ pattern: "a.b", literal: true })).toEqual(["fixture.txt:2: a.b"]);
    expect(await rows({ pattern: "a.b", literal: true, ignoreCase: true })).toEqual([
      "fixture.txt:2: a.b",
      "fixture.txt:3: A.B",
    ]);
    expect(await rows({ pattern: "^a\\.b$" })).toEqual(["fixture.txt:2: a.b"]);
  });

  it("takes escapes that Unicode regexes refuse, and Unicode properties", async () => {
    write("names.txt", "first-name\n名字\n");

    expect(await rows({ pattern: "first\\-name" })).toEqual(["names.txt:1: first-name"]);
    expect(await rows({ pattern: "\\p{Script=Han}" })).toEqual(["names.txt:2: 名字"]);
  });

  it("answers a pattern that isn't a regex with an error", async () => {
    write("a.txt", "x");

    const result = await grep({ pattern: "(" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid regular expression");
  });

  it("skips binary files, and stops in a file where binary data starts", async () => {
    write("image.bin", Buffer.concat([Buffer.from("needle\n"), Buffer.from([0, 1, 2])]));
    write("late.txt", `needle one\n${"x\n".repeat(40_000)}\0needle two\n`);
    write("text.txt", "needle\n");

    expect(await rows({ pattern: "needle" })).toEqual([
      "late.txt:1: needle one",
      "text.txt:1: needle",
    ]);
    expect(await grep({ pattern: "needle", path: "image.bin" })).toEqual({
      content: "No matches found: image.bin is a binary file",
    });
  });

  it("reads a line that runs across chunks whole, and a last line with no newline", async () => {
    write("long.txt", `start ${"y".repeat(200_000)} needle\nnext\nneedle at the end`);

    const result = await grep({ pattern: "needle" });

    expect(result.content.split("\n\n")[0]?.split("\n")).toEqual([
      `long.txt:1: [truncated] ...${"y".repeat(GREP_MAX_LINE_LENGTH - " needle".length)} needle`,
      "long.txt:3: needle at the end",
    ]);
    expect(result.content).toContain(
      "[Some lines truncated to 500 chars. Use read tool to see full lines of up to 50.0KB; to see more of a longer one, grep a pattern further along it]",
    );
    expect(result.details).toEqual({ linesTruncated: true });
  });

  it("sends a truncated line to read only when read shows it whole", async () => {
    write("notes.txt", `${"a".repeat(2000)} needle\n`);
    // read shows the first 50 KB of this line, short of the match.
    write("export.json", `${"b".repeat(70_000)} needle ${"c".repeat(1000)}\n`);

    expect((await grep({ pattern: "needle", path: "notes.txt" })).content).toEndWith(
      "\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]",
    );
    expect((await grep({ pattern: "needle", path: "export.json" })).content).toEndWith(
      "\n\n[Some lines truncated to 500 chars. Use read tool to see full lines of up to 50.0KB; to see more of a longer one, grep a pattern further along it]",
    );
  });

  it("shows a long line around its match, so a one-line file can be read where it matters", async () => {
    const viewers = Array.from(
      { length: 3000 },
      (_, i) => `{"uid":${10_000 + i},"name":"viewer${i}"}`,
    );
    write("danmaku.json", `[${viewers.join(",")}]\n`);
    write("head.txt", `needle ${"z".repeat(1000)}\n`);

    const deep = await grep({ pattern: "viewer1499\\b", path: "danmaku.json" });
    const row = deep.content.split("\n")[0] as string;

    expect(row).toStartWith("danmaku.json:1: [truncated] ...");
    expect(row).toContain('{"uid":11499,"name":"viewer1499"}');
    expect(row).toEndWith("... [truncated]");
    expect(row.length).toBeLessThan(GREP_MAX_LINE_LENGTH + 60);
    expect((await grep({ pattern: "needle", path: "head.txt" })).content).toStartWith(
      `head.txt:1: needle ${"z".repeat(GREP_MAX_LINE_LENGTH - "needle ".length)}... [truncated]`,
    );
  });

  it("follows .gitignore files, and never searches .git or node_modules", async () => {
    write(".gitignore", "*.log\n");
    write("sub/.gitignore", "local.txt\n");
    write("app.log", "needle");
    write("sub/local.txt", "needle");
    write("sub/kept.txt", "needle");
    write(".git/config", "needle");
    write("node_modules/pkg/index.js", "needle");
    write("main.ts", "needle");

    expect(await rows({ pattern: "needle" })).toEqual([
      "main.ts:1: needle",
      "sub/kept.txt:1: needle",
    ]);
  });

  it("filters by glob: names at any depth, paths from the folder, and exclusions", async () => {
    write("a.ts", "needle");
    write("src/b.ts", "needle");
    write("src/c.md", "needle");
    write("vendor/d.ts", "needle");
    write("src/vendor/e.ts", "needle");

    expect(await rows({ pattern: "needle", glob: "*.ts" })).toEqual([
      "a.ts:1: needle",
      "src/b.ts:1: needle",
      "src/vendor/e.ts:1: needle",
      "vendor/d.ts:1: needle",
    ]);
    expect(await rows({ pattern: "needle", glob: "src/*" })).toEqual([
      "src/b.ts:1: needle",
      "src/c.md:1: needle",
    ]);
    expect(await rows({ pattern: "needle", glob: "!*.md" })).toHaveLength(4);
    // An excluded folder takes what is under it along, at any depth.
    expect(await rows({ pattern: "needle", glob: "!vendor" })).toEqual([
      "a.ts:1: needle",
      "src/b.ts:1: needle",
      "src/c.md:1: needle",
    ]);
  });

  it("searches a single file whatever the glob and the ignore rules say", async () => {
    write(".gitignore", "*.log\n");
    write("app.log", "needle");

    expect(await rows({ pattern: "needle", path: "app.log", glob: "*.ts" })).toEqual([
      "app.log:1: needle",
    ]);
  });

  it("never reads through a symbolic link or into a denied folder", async () => {
    const outside = await tempFolder();
    writeFileSync(join(outside, "secret.txt"), "needle");
    symlinkSync(join(outside, "secret.txt"), join(testDir, "link.txt"));
    symlinkSync(outside, join(testDir, "link-dir"));
    write("private/key.txt", "needle");
    write("notes.txt", "needle");
    const tool = createGrepTool(folderGuard(testDir, [join(testDir, "private")]));

    expect(await tool.execute({ pattern: "needle" }, toolContext())).toEqual({
      content: "notes.txt:1: needle",
    });
  });

  it("skips a file the guard denies inside a folder it allows", async () => {
    write(".netrc", "needle");
    write("notes.txt", "needle");
    const tool = createGrepTool(folderGuard(testDir, [join(testDir, ".netrc")]));

    expect(await tool.execute({ pattern: "needle" }, toolContext())).toEqual({
      content: "notes.txt:1: needle",
    });
  });

  it("refuses a path outside the task's folder, naming it for an approval", async () => {
    const outside = await tempFolder();

    const result = await grep({ pattern: "x", path: outside });

    expect(result.isError).toBe(true);
    expect(result.refused).toEqual({ path: outside, access: "read" });
  });

  it("refuses a denied path with nothing to ask for", async () => {
    write(".netrc", "needle");
    const netrc = join(testDir, ".netrc");
    const tool = createGrepTool(folderGuard(testDir, [netrc]));

    const result = await tool.execute({ pattern: "needle", path: ".netrc" }, toolContext());

    expect(result.isError).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result.content).toContain(netrc);
  });

  it("fails on a missing path", async () => {
    expect(await grep({ pattern: "x", path: "missing" })).toEqual({
      content: `Path not found: ${join(testDir, "missing")}`,
      isError: true,
    });
  });

  it("answers bad arguments as pi's validation does, and reads null as left out", async () => {
    write("a.txt", "needle");

    for (const [args, problem] of [
      [{}, "  - pattern: missing"],
      [{ pattern: "" }, "  - pattern: must not be empty"],
      [{ pattern: "x", path: 1 }, "  - path: expected string, got integer"],
      [{ pattern: "x", glob: ["*.ts"] }, "  - glob: expected string, got array"],
      [{ pattern: "x", ignoreCase: "yes" }, "  - ignoreCase: expected boolean, got string"],
      [{ pattern: "x", literal: 1 }, "  - literal: expected boolean, got integer"],
      [{ pattern: "x", limit: "ten" }, "  - limit: expected integer, got string"],
      [{ pattern: "x", limit: 1.5 }, "  - limit: expected integer, got number"],
    ] as const) {
      const result = await grep(args);
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith(`Validation failed for tool "grep":\n${problem}\n`);
    }
    expect(
      await grep({
        pattern: "needle",
        path: null,
        glob: null,
        ignoreCase: null,
        literal: null,
        limit: null,
      }),
    ).toEqual({ content: "a.txt:1: needle" });
  });

  it("stops at once when the task is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const guard = folderGuard(testDir);

    const result = await createGrepTool(guard).execute(
      { pattern: "x" },
      toolContext(controller.signal),
    );

    expect(result).toEqual({ content: "Operation aborted", isError: true });
    expect(guard.resolved).toEqual([]);
  });

  it("reads no file after a cancel during the search", async () => {
    write("a.txt", "needle");
    write("b.txt", "needle");
    const controller = new AbortController();
    const guard = folderGuard(testDir);
    const aborting: PathGuard = {
      folder: testDir,
      resolve(path, access) {
        if (path === join(testDir, "a.txt")) controller.abort();
        return guard.resolve(path, access);
      },
    };

    const result = await createGrepTool(aborting).execute(
      { pattern: "needle" },
      toolContext(controller.signal),
    );

    expect(result).toEqual({ content: "Operation aborted", isError: true });
    expect(guard.resolved).toContain(join(testDir, "a.txt"));
    expect(guard.resolved).not.toContain(join(testDir, "b.txt"));
  });

  it("reads patterns as Unicode-mode regexes, and refuses rg's own syntax rather than misread it", async () => {
    write("notes.md", "# Plan\n今天直播唱歌\nrun the app\nhappy path\n");
    write("dash.txt", "foo-bar: baz\n");

    expect(await rows({ pattern: "\\p{Script=Han}+", path: "notes.md" })).toEqual([
      "notes.md:2: 今天直播唱歌",
    ]);
    for (const pattern of ["\\p{Han}+", "[\\p{Han}]", "\\pL", "\\Arun", "\\x{4eca}"]) {
      const result = await grep({ pattern, path: "notes.md" });
      expect([pattern, result.isError]).toEqual([pattern, true]);
      expect(result.content).toEndWith(
        "grep takes JavaScript regexes in Unicode mode: write \\p{Script=Han} for \\p{Han}, \\p{L} for \\pL, \\u{...} for \\x{...}, and ^ and $ for \\A and \\z.",
      );
    }
    // Punctuation rg takes escaped stands for itself, a class's \- included.
    expect(await rows({ pattern: "foo\\-bar\\:\\ [\\w\\-]+", path: "dash.txt" })).toEqual([
      "dash.txt:1: foo-bar: baz",
    ]);
  });

  it("takes a ] or } that closes nothing as itself, as rg does", async () => {
    write("main.ts", "const first = args[0];\n}\nconst o = { a: 1 };\nitems[12]\n");

    const cases: [string, string[]][] = [
      ["args\\[0]", ["main.ts:1: const first = args[0];"]],
      ["\\d+]", ["main.ts:1: const first = args[0];", "main.ts:4: items[12]"]],
      ["items\\[\\d{2}]", ["main.ts:4: items[12]"]],
      ["^}", ["main.ts:2: }"]],
      ["1 }", ["main.ts:3: const o = { a: 1 };"]],
      ["[}\\]]$", ["main.ts:2: }", "main.ts:4: items[12]"]],
    ];
    for (const [pattern, matched] of cases) {
      expect([pattern, await rows({ pattern, path: "main.ts" })]).toEqual([pattern, matched]);
    }
    // As rg, a { that opens no count is still an error.
    expect((await grep({ pattern: "{ a: 1 }", path: "main.ts" })).isError).toBe(true);
  });

  it("a cancel lands while a pattern backtracks, on a long line or on line after line", async () => {
    // \w+bar rescans the line from every start; (\w+\s?)+\( nests quantifiers.
    write("long.txt", `${"x".repeat(64 * 1024)}\n`);
    write("prose.md", "The quick brown fox jumps over the lazy dog and runs far away\n".repeat(20));
    for (const [pattern, path] of [
      ["\\w+bar", "long.txt"],
      ["(\\w+\\s?)+\\(", "prose.md"],
    ]) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const started = performance.now();
      const result = await grep({ pattern, path }, controller.signal);
      const elapsed = performance.now() - started;
      expect([pattern, result]).toEqual([pattern, { content: "Operation aborted", isError: true }]);
      expect([pattern, elapsed < 1000]).toEqual([pattern, true]);
    }
  });

  it("names a line the pattern may have given up on, and searches on past it", async () => {
    // JavaScriptCore stops backtracking at a limit and reports no match.
    write("log.txt", `${"a".repeat(30)}!ab\nshort ab\n`);

    const result = await grep({ pattern: "(a+)+b" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toStartWith(
      "log.txt:2: short ab\n\n[Not searched, the pattern was too slow there: log.txt:1. JavaScript regexes backtrack: avoid nested quantifiers such as (a+)+, and \\w+x or .* after a common word, which rescan a long line from every start",
    );
    expect(result.details).toEqual({ unsearched: ["log.txt:1"] });
  });

  it("returns what it found past a long minified line the pattern is merely slow on", async () => {
    // .* after a common word scans on to the line's end from each one: right, but slowly.
    write("public/vendor/app.min.js", `${"return a&&b(c,d);".padEnd(100, "x=1;").repeat(2000)}\n`);
    write(
      "src/user.ts",
      "export function load(id) {\n  return isLoading ? null : fetchUser(id);\n}\n",
    );

    const result = await grep({ pattern: "return.*isLoading" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toStartWith("src/user.ts:2:   return isLoading ? null : fetchUser(id);");
  });

  it("leaves a line the pattern still runs on after two seconds, and searches on", async () => {
    write("min.js", `${"x".repeat(256 * 1024)}\n`);
    write("src/a.ts", "foobar\n");

    const started = performance.now();
    const result = await grep({ pattern: "\\w+bar" });

    expect(result.content).toStartWith(
      "src/a.ts:1: foobar\n\n[Not searched, the pattern was too slow there: min.js:1. ",
    );
    expect(performance.now() - started).toBeLessThan(4000);
  }, 10_000);

  it("stops once lines it can't search have taken five seconds, with what it found", async () => {
    write("a.txt", "ab\n");
    write("log.txt", `${"a".repeat(30)}!ab\n`.repeat(60));
    write("z.txt", "ab\n");

    const started = performance.now();
    const result = await grep({ pattern: "(a+)+b" });
    const elapsed = performance.now() - started;

    expect(result.content).toStartWith(
      "a.txt:1: ab\n\n[Not searched, the pattern was too slow there: log.txt:1, log.txt:2,",
    );
    expect(result.content).toContain(
      ". grep stopped after 5 s on such lines, and searched nothing after them. ",
    );
    expect(result.content).not.toContain("z.txt");
    expect(elapsed).toBeGreaterThan(5000);
    expect(elapsed).toBeLessThan(8000);
  }, 20_000);

  it("ends its matcher with the process that started it, even one killed outright", async () => {
    write("long.txt", `${"x".repeat(1024 * 1024)}\n`);
    const module = (name: string) => JSON.stringify(join(import.meta.dir, name));
    const task = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { createGrepTool } = await import(${module("../src/tools/grep.ts")});
         const { folderGuard, toolContext } = await import(${module("tool-folder.ts")});
         await createGrepTool(folderGuard(${JSON.stringify(testDir)}))
           .execute({ pattern: "\\\\w+bar" }, toolContext());`,
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    const children = () =>
      Bun.spawnSync(["pgrep", "-P", String(task.pid)])
        .stdout.toString()
        .split("\n")
        .filter(Boolean)
        .map(Number);
    let matcher: number | undefined;
    for (let wait = 0; wait < 500 && matcher === undefined; wait++) {
      await Bun.sleep(10);
      matcher = children()[0];
    }
    if (matcher === undefined) throw new Error("grep started no matcher");
    // Busy in its test of the line, so it can't hear its channel close.
    await Bun.sleep(300);
    task.kill("SIGKILL");
    await task.exited;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let gone = false;
    for (let wait = 0; wait < 100 && !gone; wait++) {
      await Bun.sleep(20);
      gone = !alive(matcher);
    }
    if (!gone) process.kill(matcher, "SIGKILL");
    expect(gone).toBe(true);
  }, 10_000);

  it("matches from a process whose working folder has been removed", async () => {
    write("a.txt", "hello needle\n");
    const gone = await tempFolder();
    const before = process.cwd();
    process.chdir(gone);
    rmSync(gone, { recursive: true });
    try {
      expect(await grep({ pattern: "needle" })).toEqual({ content: "a.txt:1: hello needle" });
    } finally {
      process.chdir(before);
    }
  });

  it("fails when its matcher can't start, rather than finding nothing", async () => {
    write("a.txt", "hello needle\n");
    const bun = process.execPath;
    // As when the Bun running the task is reinstalled under it.
    process.execPath = join(testDir, "bun");
    try {
      for (const path of [".", "a.txt"]) {
        const result = await grep({ pattern: "needle", path });
        expect([path, result.isError, result.content]).toEqual([
          path,
          true,
          expect.stringContaining("ENOENT"),
        ]);
      }
    } finally {
      process.execPath = bun;
    }
  });

  it("describes itself as pi does", () => {
    expect(grepTool.schema.name).toBe("grep");
    expect(grepTool.schema.required).toEqual(["pattern"]);
    expect(Object.keys(grepTool.schema.properties)).toEqual([
      "pattern",
      "path",
      "glob",
      "ignoreCase",
      "literal",
      "limit",
    ]);
    expect(grepTool.replay).toBe("safe");
    expect(grepTool.snippet).toBe("Search file contents for patterns (respects .gitignore)");
    expect(grepTool.guidelines).toEqual([]);
  });
});
