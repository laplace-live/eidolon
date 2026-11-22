// grep's matcher, a process of its own, starts on jsRuntime(): inside Electron, with its flags
// before the script.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnProcess } from "@eidolon/config";
import { afterEach, expect, test, vi } from "vitest";
import { asElectron } from "../../config/test/electron.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

vi.mock("@eidolon/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@eidolon/config")>();
  return { ...actual, spawnProcess: vi.fn(actual.spawnProcess) };
});

afterEach(removeTempFolders);

test("inside Electron, the matcher runs with the runtime's flags and variable", async () => {
  const folder = await tempFolder();
  writeFileSync(join(folder, "a.txt"), "hello needle\n");
  const restore = asElectron();
  try {
    const result = await createGrepTool(folderGuard(folder)).execute(
      { pattern: "needle" },
      toolContext(),
    );
    expect(result.content).toBe("a.txt:1: hello needle");
  } finally {
    restore();
  }
  const [argv, options] = vi.mocked(spawnProcess).mock.calls[0] ?? [];
  expect(argv?.slice(0, 4)).toEqual([
    process.execPath,
    "--disable-sigusr1",
    "--use-system-ca",
    "-e",
  ]);
  expect(options?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
});
