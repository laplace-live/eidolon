// The native engine reaches pipedog nowhere, so src/native keeps building once pipedog is gone.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NATIVE = join(import.meta.dir, "..", "src", "native");
// Type-only imports included, which the transpiler's import scan leaves out.
const PIPEDOG = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']@pipedog\//;

test("nothing under src/native imports @pipedog/*", () => {
  const files = (readdirSync(NATIVE, { recursive: true }) as string[]).filter((name) =>
    name.endsWith(".ts"),
  );
  expect(files).toContain("engine.ts");
  const importing = files.filter((name) => PIPEDOG.test(readFileSync(join(NATIVE, name), "utf8")));
  expect(importing).toEqual([]);
});

test("the check sees every form an import takes", () => {
  for (const line of [
    'import { x } from "@pipedog/core/frames/frames";',
    'import type { X } from "@pipedog/transport-smallwebrtc/connection";',
    'export { y } from "@pipedog/asyncio";',
    'await import("@pipedog/onnx");',
  ]) {
    expect([line, PIPEDOG.test(line)]).toEqual([line, true]);
  }
  expect(PIPEDOG.test("// Ported from pipedog packages/core/src/x.ts@ce8f8bc")).toBe(false);
});
