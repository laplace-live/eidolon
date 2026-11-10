// The native engine reaches pipedog through one file, which @eidolon/webrtc replaces in G6; the
// rest of src/native keeps building once pipedog is gone.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NATIVE = join(import.meta.dir, "..", "src", "native");
// Type-only imports included, which the transpiler's import scan leaves out.
const PIPEDOG = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']@pipedog\//;

test("under src/native, only transport_pipedog.ts imports @pipedog/*", () => {
  const files = (readdirSync(NATIVE, { recursive: true }) as string[]).filter((name) =>
    name.endsWith(".ts"),
  );
  expect(files).toContain("engine.ts");
  const importing = files.filter((name) => PIPEDOG.test(readFileSync(join(NATIVE, name), "utf8")));
  expect(importing).toEqual(["transport_pipedog.ts"]);
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
