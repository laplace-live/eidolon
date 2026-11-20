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

// POSIX's file modes, and its extensionless programs.
test.skipIf(process.platform === "win32")(
  "which finds the first executable file on the path it is given, as Bun.which did",
  () => {
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
  },
);

test.skipIf(process.platform === "win32")("which reads PATH as it is now by default", () => {
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

test("on Windows a bare name runs with PATHEXT's extensions, and a backslash makes it a path", () => {
  const work = mkdtempSync(join(tmpdir(), "eidolon-which-"));
  const [first, second] = ["first", "second"].map((name) => {
    mkdirSync(join(work, name));
    return join(work, name);
  }) as [string, string];
  const npx = tool(join(first, "npx.cmd"), 0o755);
  const ffmpeg = tool(join(second, "ffmpeg.exe"), 0o755);
  tool(join(first, "ffmpeg"), 0o755);
  const path = [first, second].join(delimiter);
  // An extensionless file is no program there, as cmd.exe runs none.
  expect(which("ffmpeg", path, "win32")).toBe(ffmpeg);
  expect(which("npx", path, "win32")).toBe(npx);
  expect(which("ffmpeg.exe", path, "win32")).toBe(ffmpeg);
  expect(which(join(second, "ffmpeg"), "", "win32")).toBe(ffmpeg);
  // Elsewhere the name is the file's whole name.
  expect(which("ffmpeg", path, "linux")).toBe(join(first, "ffmpeg"));
});
