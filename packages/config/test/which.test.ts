import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { expect, test } from "vitest";
import { which } from "../src/index.ts";

function tool(path: string, mode: number): string {
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, mode);
  return path;
}

test("which finds the first executable file on the path it is given, as Bun.which did", () => {
  const work = mkdtempSync(join(tmpdir(), "eidolon-which-"));
  const [folder, plain, runnable] = ["folder", "plain", "runnable"].map((name) => {
    mkdirSync(join(work, name));
    return join(work, name);
  }) as [string, string, string];
  mkdirSync(join(folder, "tool"));
  tool(join(plain, "tool"), 0o644);
  const found = tool(join(runnable, "tool"), 0o755);
  const path = [folder, plain, "", runnable].join(delimiter);
  expect(which("tool", path)).toBe(found);
  expect(which("tool", [folder, plain].join(delimiter))).toBeNull();
  expect(which("tool", "")).toBeNull();
  expect(which("", path)).toBeNull();
  // A name with a slash is that file, from this process's working folder.
  expect(which(found, "")).toBe(found);
  expect(which(relative(process.cwd(), found), "")).toBe(found);
  expect(which(join(plain, "tool"), path)).toBeNull();
});

test("which reads PATH as it is now by default", () => {
  const work = mkdtempSync(join(tmpdir(), "eidolon-which-"));
  const found = tool(join(work, "eidolon-which-tool"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = work;
  try {
    expect(which("eidolon-which-tool")).toBe(found);
  } finally {
    process.env.PATH = before;
  }
});
