// The folder dialog's options, and one dialog at a time: a second ask joins the open one.
import { describe, expect, test } from "vitest";
import { folderDialogOptions, joinPending } from "../src/main/folder-dialog.ts";
import { STRINGS } from "../src/main/strings.ts";

test("the dialog picks one folder, can make one, opens at home and stays off the recent list", () => {
  expect(folderDialogOptions(STRINGS.en, "/Users/me")).toEqual({
    properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
    defaultPath: "/Users/me",
    title: "Choose a Folder",
    message: "Her tasks can read and write in the folders you choose.",
    buttonLabel: "Choose",
  });
  expect(folderDialogOptions(STRINGS["zh-Hans"], "C:\\Users\\me")).toMatchObject({
    defaultPath: "C:\\Users\\me",
    title: "选择文件夹",
    buttonLabel: "选择",
  });
});

/** A call whose answer the test gives. */
function deferred<T>() {
  let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

describe("joinPending", () => {
  test("a call while one is pending joins it, and both get its answer", async () => {
    const calls: ReturnType<typeof deferred<string | null>>[] = [];
    const choose = joinPending(() => {
      const call = deferred<string | null>();
      calls.push(call);
      return call.promise;
    });
    const first = choose();
    const second = choose();
    expect(calls).toHaveLength(1);
    calls[0]?.resolve("/Users/me/Projects");
    expect(await first).toBe("/Users/me/Projects");
    expect(await second).toBe("/Users/me/Projects");
  });

  test("once it has settled, the next call starts another", async () => {
    let started = 0;
    const choose = joinPending(async () => ++started);
    expect(await choose()).toBe(1);
    expect(await choose()).toBe(2);
  });

  test("a failure reaches every caller, and the next call starts afresh", async () => {
    const calls: ReturnType<typeof deferred<string | null>>[] = [];
    const choose = joinPending(() => {
      const call = deferred<string | null>();
      calls.push(call);
      return call.promise;
    });
    const first = choose();
    const second = choose();
    calls[0]?.reject(new Error("the dialog failed"));
    await expect(first).rejects.toThrow("the dialog failed");
    await expect(second).rejects.toThrow("the dialog failed");
    const third = choose();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(null);
    expect(await third).toBeNull();
  });
});
