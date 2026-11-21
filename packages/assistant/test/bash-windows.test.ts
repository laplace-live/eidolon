// The bash tool's Windows branch, on any computer: the shell is this Node, and the tree kill a spy
// that ends the direct child.
import { jsRuntime } from "@eidolon/config";
import { afterEach, expect, test, vi } from "vitest";
import { createLocalBashOperations } from "../src/tools/bash.ts";
import { killProcessTree } from "../src/tools/shell.ts";
import { removeTempFolders, tempFolder } from "./tool-folder.ts";

vi.mock("../src/tools/shell.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/shell.ts")>()),
  getShellConfig: () => ({ shell: process.execPath, args: ["-e"] }),
  killProcessTree: vi.fn((pid: number) => process.kill(pid)),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.mocked(killProcessTree).mockClear();
  await removeTempFolders();
});

async function onWindows(code: string, signal?: AbortSignal): Promise<unknown> {
  const folder = await tempFolder();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  return createLocalBashOperations().exec(code, folder, {
    onData: () => {},
    env: { ...jsRuntime().env, PATH: process.env.PATH ?? "" },
    ...(signal === undefined ? {} : { signal }),
  });
}

test("on Windows a shell that has exited is never killed: its pid may be another process's", async () => {
  expect(await onWindows("process.exitCode = 3")).toEqual({ exitCode: 3 });
  expect(killProcessTree).not.toHaveBeenCalled();
});

test("on Windows a stop while the shell runs kills its tree", async () => {
  const controller = new AbortController();
  const running = onWindows("setInterval(() => {}, 1000)", controller.signal);
  // Past the folder check, into the spawn.
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await expect(running).rejects.toThrow("aborted");
  expect(killProcessTree).toHaveBeenCalledTimes(1);
});
