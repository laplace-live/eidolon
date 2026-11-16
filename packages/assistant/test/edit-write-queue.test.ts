// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/file-mutation-queue.test.ts@ac78a60
//
// The edit and write tools' cases. pi slows its tools through their operations; these spy on
// node:fs/promises, which the tools call.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { createEditTool } from "../src/tools/edit.ts";
import { createWriteTool } from "../src/tools/write.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

const { readFile, writeFile } = fsp;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

/** Runs `afterRead` after each read the tools make, and `write` in place of each write. */
function slowFiles(options: {
  readonly afterRead?: () => Promise<void>;
  readonly write: (path: string, content: string) => Promise<void>;
}): void {
  spyOn(fsp, "readFile").mockImplementation((async (path: string) => {
    const buffer = await readFile(path);
    await options.afterRead?.();
    return buffer;
  }) as typeof fsp.readFile);
  spyOn(fsp, "writeFile").mockImplementation((async (path: string, content: string) =>
    options.write(path, content)) as typeof fsp.writeFile);
}

afterEach(async () => {
  mock.restore();
  await removeTempFolders();
});

describe("built-in edit and write tools", () => {
  it("preserves both parallel edits on the same file", async () => {
    const dir = await tempFolder();
    const filePath = join(dir, "parallel-edit.txt");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
    slowFiles({
      afterRead: () => delay(30),
      write: async (path, content) => {
        await delay(30);
        await writeFile(path, content, "utf8");
      },
    });
    const editTool = createEditTool(folderGuard(dir));

    await Promise.all([
      editTool.execute(
        { path: filePath, edits: [{ oldText: "alpha", newText: "ALPHA" }] },
        toolContext(),
      ),
      editTool.execute(
        { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] },
        toolContext(),
      ),
    ]);

    expect(await readFile(filePath, "utf8")).toBe("ALPHA\nBETA\ngamma\n");
  });

  it("shares the queue between edit and write", async () => {
    const dir = await tempFolder();
    const filePath = join(dir, "mixed.txt");
    await writeFile(filePath, "original\n", "utf8");
    slowFiles({
      afterRead: () => delay(30),
      write: async (path, content) => {
        // The edit's write is slow, the write tool's quicker.
        await delay(content === "edited\n" ? 30 : 10);
        await writeFile(path, content, "utf8");
      },
    });
    const editTool = createEditTool(folderGuard(dir));
    const writeTool = createWriteTool(folderGuard(dir));

    const editPromise = editTool.execute(
      { path: filePath, edits: [{ oldText: "original", newText: "edited" }] },
      toolContext(),
    );
    await delay(5);
    const writePromise = writeTool.execute(
      { path: filePath, content: "replacement\n" },
      toolContext(),
    );

    await Promise.all([editPromise, writePromise]);

    expect(await readFile(filePath, "utf8")).toBe("replacement\n");
  });

  it("keeps write queue locked while an aborted write is still in flight", async () => {
    const dir = await tempFolder();
    const filePath = join(dir, "abort-write.txt");
    const firstWriteStarted = createDeferred();
    const finishFirstWrite = createDeferred();
    const secondWriteStarted = createDeferred();
    let firstWriteSettled = false;
    slowFiles({
      write: async (path, content) => {
        if (content === "first\n") {
          firstWriteStarted.resolve();
          await finishFirstWrite.promise;
          await writeFile(path, content, "utf8");
          firstWriteSettled = true;
          return;
        }
        if (content === "second\n") {
          expect(firstWriteSettled).toBe(true);
          secondWriteStarted.resolve();
        }
        await writeFile(path, content, "utf8");
      },
    });
    const writeTool = createWriteTool(folderGuard(dir));

    const controller = new AbortController();
    const firstWrite = writeTool.execute(
      { path: filePath, content: "first\n" },
      toolContext(controller.signal),
    );
    await firstWriteStarted.promise;
    controller.abort();

    const secondWrite = writeTool.execute({ path: filePath, content: "second\n" }, toolContext());
    expect(await resolvesWithin(secondWriteStarted.promise, 20)).toBe(false);

    finishFirstWrite.resolve();
    expect(await firstWrite).toEqual({ content: "Operation aborted", isError: true });
    expect((await secondWrite).isError).toBeUndefined();

    expect(await readFile(filePath, "utf8")).toBe("second\n");
  });

  it("keeps edit queue locked while an aborted edit write is still in flight", async () => {
    const dir = await tempFolder();
    const filePath = join(dir, "abort-edit.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf8");
    const firstWriteStarted = createDeferred();
    const finishFirstWrite = createDeferred();
    const secondWriteStarted = createDeferred();
    let firstWriteSettled = false;
    slowFiles({
      write: async (path, content) => {
        if (content === "ALPHA\nbeta\n") {
          firstWriteStarted.resolve();
          await finishFirstWrite.promise;
          await writeFile(path, content, "utf8");
          firstWriteSettled = true;
          return;
        }
        if (content === "ALPHA\nBETA\n" || content === "alpha\nBETA\n") {
          expect(firstWriteSettled).toBe(true);
          secondWriteStarted.resolve();
        }
        await writeFile(path, content, "utf8");
      },
    });
    const editTool = createEditTool(folderGuard(dir));

    const controller = new AbortController();
    const firstEdit = editTool.execute(
      { path: filePath, edits: [{ oldText: "alpha", newText: "ALPHA" }] },
      toolContext(controller.signal),
    );
    await firstWriteStarted.promise;
    controller.abort();

    const secondEdit = editTool.execute(
      { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] },
      toolContext(),
    );
    expect(await resolvesWithin(secondWriteStarted.promise, 20)).toBe(false);

    finishFirstWrite.resolve();
    expect(await firstEdit).toEqual({ content: "Operation aborted", isError: true });
    expect((await secondEdit).isError).toBeUndefined();

    expect(await readFile(filePath, "utf8")).toBe("ALPHA\nBETA\n");
  });
});
