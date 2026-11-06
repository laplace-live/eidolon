// The one write helper: under the data home only, never into a persona template, atomic, and a
// secret private from its first byte. The templates' bytes are pinned across this whole file.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, personaHomeDir, personaTemplateDir, templatesDir } from "@eidolon/config";
import {
  checkFileName,
  fileIn,
  isPersonaId,
  personaWriteTarget,
  readPersonaFile,
  updatePersonaFile,
  WriteRefused,
  writeDataFile,
} from "../../src/local/write.ts";

function hashTree(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const path = join(root, name);
    if (statSync(path).isFile()) {
      hashes.set(name, createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  }
  return hashes;
}

let templates: Map<string, string>;
beforeAll(() => {
  // An earlier file in the same run can leave folders whose mode the first test checks.
  rmSync(dataHome(), { recursive: true, force: true });
  templates = hashTree(templatesDir());
  expect(templates.size).toBeGreaterThan(0);
});

afterAll(() => {
  expect(hashTree(templatesDir())).toEqual(templates);
});

afterEach(() => {
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("writeDataFile", () => {
  test("replaces a file under the data home through a temp file, leaving none behind", () => {
    const target = join(dataHome(), "personas", "x", "prompt.md");
    writeDataFile(target, "one");
    writeDataFile(target, "two");
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(readdirSync(join(dataHome(), "personas", "x"))).toEqual(["prompt.md"]);
    expect(statSync(join(dataHome(), "personas")).mode & 0o777).toBe(0o700);
  });

  test("creates a secret mode 0600 from its first byte", () => {
    const opened = spyOn(fs, "openSync");
    try {
      writeDataFile(join(dataHome(), "credentials.json"), "{}", { secret: true });
      writeDataFile(join(dataHome(), "settings.yaml"), "{}");
      expect(opened.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        ["wx", 0o600],
        ["wx", 0o644],
      ]);
    } finally {
      opened.mockRestore();
    }
    expect(statSync(join(dataHome(), "credentials.json")).mode & 0o777).toBe(0o600);
  });

  test("refuses anything outside the data home, the home itself, and the templates", () => {
    const template = join(personaTemplateDir("milky-green"), "prompt.md");
    for (const target of [
      join(tmpdir(), "elsewhere.txt"),
      join(dataHome(), "..", "escape.txt"),
      dataHome(),
      template,
      join(templatesDir(), "new", "persona.yaml"),
    ]) {
      expect(() => writeDataFile(target, "x")).toThrow(WriteRefused);
    }
  });

  test("a symlink inside the data home can't carry a write, or a folder, outside it", () => {
    const outside = mkdtempSync(join(tmpdir(), "eidolon-outside-"));
    try {
      fs.mkdirSync(join(dataHome(), "personas"), { recursive: true });
      symlinkSync(outside, join(dataHome(), "personas", "evil"));
      expect(() => writeDataFile(join(dataHome(), "personas", "evil", "a", "b.md"), "x")).toThrow(
        WriteRefused,
      );
      symlinkSync(personaTemplateDir("milky-green"), join(dataHome(), "personas", "template"));
      expect(() =>
        writeDataFile(join(dataHome(), "personas", "template", "prompt.md"), "x"),
      ).toThrow(WriteRefused);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("persona files", () => {
  test("the first write starts from the template's text and lands in the data home", () => {
    const original = readPersonaFile("milky-green", "persona.yaml") as string;
    expect(original).toContain("明前奶绿");
    const target = updatePersonaFile("milky-green", "persona.yaml", (text) => `${text}# mine\n`);
    expect(target).toBe(join(personaHomeDir("milky-green"), "persona.yaml"));
    expect(readFileSync(target, "utf8")).toBe(`${original}# mine\n`);
    expect(readPersonaFile("milky-green", "persona.yaml")).toBe(`${original}# mine\n`);
    expect(readPersonaFile("milky-green", "nope.md")).toBeNull();
  });

  test("a path can't leave the persona's folder", () => {
    for (const rel of ["../other/prompt.md", "../../credentials.json", "/etc/passwd", ""]) {
      expect(() => personaWriteTarget("milky-green", rel)).toThrow(WriteRefused);
    }
    expect(readPersonaFile("milky-green", "../../package.json")).toBeNull();
  });
});

describe("input rules", () => {
  test("persona ids are slugs", () => {
    for (const id of ["milky-green", "a", "x_1", "9lives", "a".repeat(64)]) {
      expect([id, isPersonaId(id)]).toEqual([id, true]);
    }
    for (const id of ["", "-x", "_x", "Milky", "a/b", "..", "a b", "a".repeat(65), 7, null]) {
      expect([id, isPersonaId(id)]).toEqual([id, false]);
    }
  });

  test("file names: one segment, no leading dot, an allowed extension, NFC", () => {
    const facts = [".txt"];
    expect(checkFileName("设定集.txt", facts)).toBe("设定集.txt");
    expect(checkFileName("Café.TXT", facts)).toBe("Café.TXT");
    for (const name of [
      "a.md",
      ".hidden.txt",
      "../x.txt",
      "a/b.txt",
      "a\\b.txt",
      "c:x.txt",
      "a\u0000.txt",
      "a\nb.txt",
      ".txt",
      "..",
      `${"a".repeat(126)}.txt`,
      "noext",
    ]) {
      expect([name, checkFileName(name, facts)]).toEqual([name, null]);
    }
    expect(checkFileName("x.webp", [".png", ".jpg", ".jpeg", ".webp"])).toBe("x.webp");
  });

  test("fileIn keeps a name inside its folder", () => {
    const folder = join(dataHome(), "sources", "x", "facts");
    expect(fileIn(folder, "a.txt")).toBe(join(folder, "a.txt"));
    for (const name of ["../a.txt", "sub/a.txt", "..", "."]) {
      expect(() => fileIn(folder, name)).toThrow(WriteRefused);
    }
  });
});
