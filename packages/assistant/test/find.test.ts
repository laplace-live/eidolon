// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/tools.test.ts@ac78a60, packages/coding-agent/test/suite/regressions/3302-find-path-glob.test.ts@ac78a60, packages/coding-agent/test/suite/regressions/3303-find-nested-gitignore.test.ts@ac78a60 and packages/coding-agent/test/suite/regressions/12066-find-ancestor-glob.test.ts@ac78a60
//
// pi's find cases that hinge on neither fd nor Windows, where a limit is a whole number; then the
// walk's own: its ignore rules, refusals, aborts and arguments.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskToolResult } from "@eidolon/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderPolicy } from "../src/policy.ts";
import { createFindTool, type FindDetails } from "../src/tools/find.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import { truncateHead } from "../src/tools/truncate.ts";
import type { PathGuard } from "../src/types.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

function find(
  guard: PathGuard,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TaskToolResult> {
  return createFindTool(guard).execute(args, toolContext(signal));
}

/** The paths `pattern` finds in `folder`, or in `path` in it, sorted, without notices. */
async function findIn(folder: string, pattern: string, path?: string): Promise<string[]> {
  const result = await find(folderGuard(folder), { pattern, path });
  if (result.content === "No files found matching pattern") return [];
  return result.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("["))
    .sort();
}

afterEach(removeTempFolders);

describe("find tool", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await tempFolder();
  });

  it("should include hidden files that are not gitignored", async () => {
    const hiddenDir = join(testDir, ".secret");
    mkdirSync(hiddenDir);
    writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
    writeFileSync(join(testDir, "visible.txt"), "visible");

    const result = await find(folderGuard(testDir), { pattern: "**/*.txt", path: testDir });

    const outputLines = result.content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(outputLines).toContain("visible.txt");
    expect(outputLines).toContain(".secret/hidden.txt");
  });

  it("should respect .gitignore", async () => {
    writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(testDir, "ignored.txt"), "ignored");
    writeFileSync(join(testDir, "kept.txt"), "kept");

    const result = await find(folderGuard(testDir), { pattern: "**/*.txt", path: testDir });

    expect(result.content).toContain("kept.txt");
    expect(result.content).not.toContain("ignored.txt");
  });

  it("should treat flag-like patterns as search text", async () => {
    const result = await find(folderGuard(testDir), { pattern: "--help", path: testDir });

    expect(result.content).toContain("No files found matching pattern");
  });

  // #12020: fd matches nothing for a leading "./", so the tool drops it.
  it("should ignore a leading ./ in the pattern", async () => {
    mkdirSync(join(testDir, "src"));
    writeFileSync(join(testDir, "src", "a.ts"), "a");
    writeFileSync(join(testDir, "package.json"), "{}");

    for (const pattern of ["./src/*.ts", "./src/**/*.ts", "././src/*.ts"]) {
      const result = await find(folderGuard(testDir), { pattern, path: testDir });
      expect(result.content).toBe("src/a.ts");
    }
    // Without a "/" left, "./*.json" matches basenames at any depth, like "*.json".
    writeFileSync(join(testDir, "src", "b.json"), "{}");
    const json = await find(folderGuard(testDir), { pattern: "./*.json", path: testDir });
    expect(json.content.split("\n").sort()).toEqual(["package.json", "src/b.json"]);
  });

  // #7121: exactly `limit` matches must not report that the limit was reached.
  it("should report the result limit only when more results exist", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(testDir, name), name);

    const exact = await find(folderGuard(testDir), { pattern: "*.txt", path: testDir, limit: 3 });
    expect(exact.content.split("\n").sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(exact.details).toBeUndefined();

    const over = await find(folderGuard(testDir), { pattern: "*.txt", path: testDir, limit: 2 });
    const [listing, notice] = over.content.split("\n\n");
    expect(listing?.split("\n")).toHaveLength(2);
    expect(notice).toBe("[2 results limit reached. Use limit=4 for more, or refine pattern]");
    expect(over.details).toEqual({ resultLimitReached: 2 });
  });

  it("should treat limits below 1 as 1", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(testDir, name), name);

    for (const limit of [0, -5]) {
      const result = await find(folderGuard(testDir), { pattern: "*.txt", path: testDir, limit });
      const [listing, notice] = result.content.split("\n\n");
      expect(listing?.split("\n")).toHaveLength(1);
      expect(notice).toBe("[1 results limit reached. Use limit=2 for more, or refine pattern]");
      expect(result.details).toEqual({ resultLimitReached: 1 });
    }
  });

  it("should report full output totals past the byte cap", async () => {
    // 300 names of 200 bytes join to about 60KB.
    const names = Array.from(
      { length: 300 },
      (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(193)}.txt`,
    );
    for (const name of names) writeFileSync(join(testDir, name), "");

    const result = await find(folderGuard(testDir), { pattern: "*.txt", path: testDir });

    const details = result.details as FindDetails;
    const expected = truncateHead(names.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    expect(details.truncation).toEqual({ ...expected, content: details.truncation?.content ?? "" });
    expect(details.truncation?.content.split("\n")).toHaveLength(expected.outputLines);
    expect(details.resultLimitReached).toBeUndefined();
    expect(result.content).toMatch(/\n\n\[50\.0KB limit reached\]$/);
  });

  it("find uses the task's folder when no path is given", async () => {
    writeFileSync(join(testDir, "ctx-cwd-find.txt"), "find me");

    const result = await find(folderGuard(testDir), { pattern: "ctx-cwd-find.txt" });

    expect(result.content).toContain("ctx-cwd-find.txt");
  });
});

/** https://github.com/earendil-works/pi/issues/3302: path patterns match the path, not the name. */
describe("issue #3302 find returns no results for path-based glob patterns", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await tempFolder();
    mkdirSync(join(tempRoot, "some", "parent", "child"), { recursive: true });
    mkdirSync(join(tempRoot, "src", "foo", "bar"), { recursive: true });
    writeFileSync(join(tempRoot, "some", "parent", "child", "file.ext"), "");
    writeFileSync(join(tempRoot, "some", "parent", "child", "test.spec.ts"), "");
    writeFileSync(join(tempRoot, "src", "foo", "bar", "example.spec.ts"), "");
    writeFileSync(join(tempRoot, "src", "direct.spec.ts"), "");
  });

  it("basename pattern still matches (regression-safe)", async () => {
    expect(await findIn(tempRoot, "*.spec.ts")).toEqual([
      "some/parent/child/test.spec.ts",
      "src/direct.spec.ts",
      "src/foo/bar/example.spec.ts",
    ]);
  });

  it("directory-prefixed pattern with ** tail matches subtree", async () => {
    const files = await findIn(tempRoot, "some/parent/child/**");
    expect(files).toContain("some/parent/child/file.ext");
    expect(files).toContain("some/parent/child/test.spec.ts");
    // Like fd's glob, 'dir/**' matches entries below 'dir', not 'dir' itself.
    expect(files).not.toContain("some/parent/child/");
  });

  it("leading ** wildcard with path segments matches", async () => {
    const files = await findIn(tempRoot, "**/parent/child/*");
    expect(files).toContain("some/parent/child/file.ext");
    expect(files).toContain("some/parent/child/test.spec.ts");
  });

  it("src/**/*.spec.ts matches direct and nested spec files", async () => {
    expect(await findIn(tempRoot, "src/**/*.spec.ts")).toEqual([
      "src/direct.spec.ts",
      "src/foo/bar/example.spec.ts",
    ]);
  });

  it("src/*.spec.ts does not cross directories", async () => {
    expect(await findIn(tempRoot, "src/*.spec.ts")).toEqual(["src/direct.spec.ts"]);
  });

  it("path patterns support braces, classes, and literal regex characters", async () => {
    writeFileSync(join(tempRoot, "src", "a&b (1).ts"), "");
    expect(await findIn(tempRoot, "{src,some}/**/[et]*.spec.ts")).toEqual([
      "some/parent/child/test.spec.ts",
      "src/foo/bar/example.spec.ts",
    ]);
    expect(await findIn(tempRoot, "src/[!x]&b (1).ts")).toEqual(["src/a&b (1).ts"]);
  });

  it("path patterns stop at the result limit", async () => {
    const result = await find(folderGuard(tempRoot), { pattern: "src/**/*.spec.ts", limit: 1 });
    expect((result.details as FindDetails).resultLimitReached).toBe(1);
    expect(result.content.split("\n")[0]).toMatch(/^src\/(direct|foo\/bar\/example)\.spec\.ts$/);
  });

  it("POSIX backslash still escapes glob characters", async () => {
    writeFileSync(join(tempRoot, "src", "*.ts"), "");
    writeFileSync(join(tempRoot, "src", "other.ts"), "");
    expect(await findIn(tempRoot, String.raw`src/\*.ts`)).toEqual(["src/*.ts"]);
  });
});

/** https://github.com/earendil-works/pi/issues/3303: a .gitignore applies to its own folder. */
describe("issue #3303 nested .gitignore rules leak into sibling directories", () => {
  it("applies a/.gitignore only inside a/ and leaves b/ untouched", async () => {
    const tempRoot = await tempFolder();
    mkdirSync(join(tempRoot, "a"), { recursive: true });
    mkdirSync(join(tempRoot, "b"), { recursive: true });
    writeFileSync(join(tempRoot, "a", ".gitignore"), "ignored.txt\n");
    writeFileSync(join(tempRoot, "a", "ignored.txt"), "");
    writeFileSync(join(tempRoot, "a", "kept.txt"), "");
    writeFileSync(join(tempRoot, "b", "ignored.txt"), "");
    writeFileSync(join(tempRoot, "b", "kept.txt"), "");
    writeFileSync(join(tempRoot, "root.txt"), "");

    expect(await findIn(tempRoot, "**/*.txt")).toEqual([
      "a/kept.txt",
      "b/ignored.txt",
      "b/kept.txt",
      "root.txt",
    ]);
  });

  it("scopes each .gitignore to its own subtree", async () => {
    const tempRoot = await tempFolder();
    mkdirSync(join(tempRoot, "a", "deep"), { recursive: true });
    mkdirSync(join(tempRoot, "b"), { recursive: true });
    writeFileSync(join(tempRoot, "a", ".gitignore"), "ignored.txt\n");
    writeFileSync(join(tempRoot, "a", "deep", ".gitignore"), "secret.txt\n");
    writeFileSync(join(tempRoot, "a", "ignored.txt"), "");
    writeFileSync(join(tempRoot, "a", "kept.txt"), "");
    writeFileSync(join(tempRoot, "a", "deep", "ignored.txt"), "");
    writeFileSync(join(tempRoot, "a", "deep", "secret.txt"), "");
    writeFileSync(join(tempRoot, "a", "deep", "kept.txt"), "");
    writeFileSync(join(tempRoot, "b", "ignored.txt"), "");
    writeFileSync(join(tempRoot, "b", "kept.txt"), "");
    writeFileSync(join(tempRoot, "root.txt"), "");

    // a/.gitignore ignores 'ignored.txt' within a/ and a/deep/; a/deep/.gitignore adds
    // 'secret.txt' within a/deep/; b/ is untouched by either.
    expect(await findIn(tempRoot, "**/*.txt")).toEqual([
      "a/deep/kept.txt",
      "a/kept.txt",
      "b/ignored.txt",
      "b/kept.txt",
      "root.txt",
    ]);
  });
});

/** https://github.com/earendil-works/pi/issues/12066: path patterns start at the search path. */
describe("issue #12066 find path globs do not match above the search path", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await tempFolder();
  });

  function createProject(root: string): void {
    for (const dir of ["src", "lib", "test", "pkg/src"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(root, "lib", "b.ts"), "");
    writeFileSync(join(root, "test", "c.ts"), "");
    writeFileSync(join(root, "pkg", "src", "d.ts"), "");
  }

  it("does not match through an ancestor folder with the same name", async () => {
    const project = join(tempRoot, "src", "app");
    createProject(project);

    expect(await findIn(project, "src/**/*.ts")).toEqual(["src/a.ts"]);
    expect(await findIn(project, "app/**/*.ts")).toEqual([]);
  });

  it("anchors path patterns at the search path; a leading **/ matches at any depth", async () => {
    const project = join(tempRoot, "src", "app");
    createProject(project);

    expect(await findIn(project, "src/*.ts")).toEqual(["src/a.ts"]);
    expect(await findIn(project, "./src/*.ts")).toEqual(["src/a.ts"]);
    expect(await findIn(project, "pkg/src/*.ts")).toEqual(["pkg/src/d.ts"]);
    expect(await findIn(project, "**/src/*.ts")).toEqual(["pkg/src/d.ts", "src/a.ts"]);
    expect(await findIn(project, "**/src/**/*.ts")).toEqual(["pkg/src/d.ts", "src/a.ts"]);
    // Basename and absolute patterns are unchanged.
    expect(await findIn(project, "*.ts")).toEqual([
      "lib/b.ts",
      "pkg/src/d.ts",
      "src/a.ts",
      "test/c.ts",
    ]);
    expect(await findIn(project, `${project}/lib/*.ts`)).toEqual(["lib/b.ts"]);
  });

  it("treats glob characters in the search path literally", async () => {
    const project = join(tempRoot, "w*?[1]{x,y}", "src");
    createProject(project);

    expect(await findIn(project, "src/*.ts")).toEqual(["src/a.ts"]);
  });

  it("keeps smart case when the search path has upper-case letters", async () => {
    const project = join(tempRoot, "Upper");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "A.ts"), "");
    writeFileSync(join(project, "src", "b.ts"), "");

    expect(await findIn(project, "src/a.ts")).toEqual(["src/A.ts"]);
    expect(await findIn(project, "src/B.ts")).toEqual([]);
  });

  it("works through a symlinked search path", async () => {
    const project = join(tempRoot, "src", "app");
    createProject(project);
    const link = join(tempRoot, "src", "link");
    symlinkSync(project, link);

    expect(await findIn(link, "src/**/*.ts")).toEqual(["src/a.ts"]);
  });

  it("matches an absolute pattern with the folder as the task names it, through a link", async () => {
    const project = join(tempRoot, "src", "app");
    createProject(project);
    writeFileSync(join(project, "lib", "b.ts"), "TODO\n");
    // The prompt shows the folder as named; the policy resolves where it lies, as /tmp is /private/tmp.
    const named = join(tempRoot, "named");
    symlinkSync(project, named);
    const home = join(tempRoot, "home");
    const policy = new FolderPolicy({
      folder: named,
      grants: [],
      home,
      dataHome: join(home, ".laplace", "eidolon"),
      appRoot: join(home, "Git", "laplace-eidolon"),
    });
    for (const pattern of [`${named}/lib/*.ts`, `${named}/**/b.ts`, `${project}/lib/*.ts`]) {
      expect([pattern, (await find(policy, { pattern })).content]).toEqual([pattern, "lib/b.ts"]);
      const grep = await createGrepTool(policy).execute(
        { pattern: "TODO", glob: pattern },
        toolContext(),
      );
      expect([pattern, grep.content]).toEqual([pattern, "lib/b.ts:1: TODO"]);
    }
  });
});

describe("find's walk", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await tempFolder();
  });

  function write(path: string, content = ""): void {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), content);
  }

  it("lists directories with a trailing slash, in name order, depth first", async () => {
    write("b/inner.txt");
    write("a.txt");
    write("C.txt");

    expect((await find(folderGuard(folder), { pattern: "*" })).content).toBe(
      "a.txt\nb/\nb/inner.txt\nC.txt",
    );
  });

  it("matches a name that starts with a parenthesis, as a Next.js route group's does", async () => {
    write("app/(auth)/login/page.tsx");
    write("app/(shop)/page.tsx");
    write("(draft).md");
    write("notes.md");

    expect(await findIn(folder, "(draft).md")).toEqual(["(draft).md"]);
    expect(await findIn(folder, "app/(auth)/**/page.tsx")).toEqual(["app/(auth)/login/page.tsx"]);
  });

  it("never lists .git or node_modules, whatever .gitignore says", async () => {
    write(".git/config");
    write("node_modules/pkg/index.js");
    write("pkg/node_modules/dep/index.js");
    write(".gitignore", "!node_modules\n");
    write("index.js");

    expect(await findIn(folder, "**")).toEqual([".gitignore", "index.js", "pkg/"]);
  });

  it("follows .gitignore negations, and never enters an ignored directory", async () => {
    write(".gitignore", "*.log\n!keep.log\nbuild/\n");
    write("debug.log");
    write("keep.log");
    write("build/out.js");
    write("src/build/x.js");
    write("src/app.js");

    expect(await findIn(folder, "**")).toEqual([".gitignore", "keep.log", "src/", "src/app.js"]);
  });

  it("lets a deeper .gitignore re-include what a shallower one ignores", async () => {
    write(".gitignore", "*.txt\n");
    write("a/.gitignore", "!keep.txt\n");
    write("a/keep.txt");
    write("a/drop.txt");
    write("keep.txt");

    expect(await findIn(folder, "*.txt")).toEqual(["a/keep.txt"]);
  });

  it("applies the .gitignore files above a subfolder it searches, up to the repository's top", async () => {
    write(".git/HEAD");
    write(".gitignore", "*.log\n/src/generated/\n");
    write("src/generated/types.ts");
    write("src/debug.log");
    write("src/app.ts");

    expect(await findIn(folder, "**", "src")).toEqual(["app.ts"]);
  });

  it("applies no .gitignore above a repository's top", async () => {
    write(".gitignore", "*.ts\n");
    write("repo/.git/HEAD");
    write("repo/src/app.ts");

    expect(await findIn(folder, "*.ts", "repo/src")).toEqual(["app.ts"]);
  });

  it("reads no .gitignore above the folders the task may read", async () => {
    write(".gitignore", "*.ts\n");
    write("inner/app.ts");

    expect(await findIn(join(folder, "inner"), "*.ts")).toEqual(["app.ts"]);
  });

  it("drops the rules above a repository nested in the folder", async () => {
    write(".gitignore", "*.ts\n");
    write("app.ts");
    write("vendor/lib/.git/HEAD");
    write("vendor/lib/index.ts");

    expect(await findIn(folder, "*.ts")).toEqual(["vendor/lib/index.ts"]);
    expect(await findIn(folder, "*.ts", "vendor/lib")).toEqual(["index.ts"]);
  });

  it("searches an ignored folder when asked to", async () => {
    write(".gitignore", "dist/\n");
    write("dist/bundle.js");

    expect(await findIn(folder, "*.js")).toEqual([]);
    expect(await findIn(folder, "*.js", "dist")).toEqual(["bundle.js"]);
  });

  it("lists a symbolic link without following it", async () => {
    const outside = await tempFolder();
    writeFileSync(join(outside, "inner.txt"), "");
    symlinkSync(outside, join(folder, "link"));

    expect(await findIn(folder, "**")).toEqual(["link"]);
  });

  it("lists a denied folder but never enters it", async () => {
    write("secret/key.txt");
    write("notes.txt");
    const guard = folderGuard(folder, [join(folder, "secret")]);

    expect((await find(guard, { pattern: "**" })).content).toBe("notes.txt\nsecret/");
  });

  it("refuses a folder outside the task's, naming it for an approval", async () => {
    const outside = await tempFolder();

    const result = await find(folderGuard(folder), { pattern: "*", path: outside });

    expect(result.isError).toBe(true);
    expect(result.refused).toEqual({ path: outside, access: "read" });
  });

  it("refuses a denied folder with nothing to ask for", async () => {
    const secret = join(folder, "secret");
    write("secret/key.txt");

    const result = await find(folderGuard(folder, [secret]), { pattern: "*", path: "secret" });

    expect(result.isError).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result.content).toContain(secret);
  });

  it("fails on a missing path or a file", async () => {
    write("file.txt");

    expect(await find(folderGuard(folder), { pattern: "*", path: "missing" })).toEqual({
      content: `Path not found: ${join(folder, "missing")}`,
      isError: true,
    });
    expect(await find(folderGuard(folder), { pattern: "*", path: "file.txt" })).toEqual({
      content: `Not a directory: ${join(folder, "file.txt")}`,
      isError: true,
    });
  });

  it("answers bad arguments as pi's validation does, and reads null as left out", async () => {
    write("a.txt");

    for (const [args, problem] of [
      [{}, "  - pattern: missing"],
      [{ pattern: "" }, "  - pattern: must not be empty"],
      [{ pattern: 1 }, "  - pattern: expected string, got integer"],
      [{ pattern: "*", path: ["src"] }, "  - path: expected string, got array"],
      [{ pattern: "*", limit: "ten" }, "  - limit: expected integer, got string"],
      [{ pattern: "*", limit: 0.5 }, "  - limit: expected integer, got number"],
    ] as const) {
      const result = await find(folderGuard(folder), args);
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith(`Validation failed for tool "find":\n${problem}\n`);
    }
    expect(await find(folderGuard(folder), { pattern: "*", path: null, limit: null })).toEqual({
      content: "a.txt",
    });
  });

  it("stops at once when the task is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const guard = folderGuard(folder);

    expect(await find(guard, { pattern: "*" }, controller.signal)).toEqual({
      content: "Operation aborted",
      isError: true,
    });
    expect(guard.resolved).toEqual([]);
  });

  it("enters no folder after a cancel during the walk", async () => {
    write("a/one.txt");
    write("b/two.txt");
    write("c/three.txt");
    const controller = new AbortController();
    const guard = folderGuard(folder);
    const aborting: PathGuard = {
      folder,
      resolve(path, access) {
        if (path === join(folder, "a")) controller.abort();
        return guard.resolve(path, access);
      },
    };

    expect(await find(aborting, { pattern: "*" }, controller.signal)).toEqual({
      content: "Operation aborted",
      isError: true,
    });
    expect(guard.resolved).toContain(join(folder, "a"));
    expect(guard.resolved).not.toContain(join(folder, "b"));
  });

  it("describes itself as pi does", () => {
    const tool = createFindTool(folderGuard(folder));

    expect(tool.schema.name).toBe("find");
    expect(tool.schema.required).toEqual(["pattern"]);
    expect(tool.replay).toBe("safe");
    expect(tool.snippet).toBe("Find files by glob pattern (respects .gitignore)");
    expect(tool.guidelines).toEqual([]);
  });
});
