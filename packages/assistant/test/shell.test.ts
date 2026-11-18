// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/shell-kill-process-tree.test.ts@ac78a60
//
// pi's tree kill, on a stubbed process.kill; then the environment a command gets: the names it keeps
// and the PATH it runs with, which no folder a task may write can lead.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createLocalBashOperations } from "../src/tools/bash.ts";
import { bashOffered, getShellConfig, killProcessTree, shellEnv } from "../src/tools/shell.ts";
import { folderGuard, removeTempFolders, tempFolder } from "./tool-folder.ts";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

afterAll(removeTempFolders);

// Regression coverage for #11252: stop-before-kill is macOS-only and best-effort.
describe("killProcessTree", () => {
  let kill: ReturnType<typeof spyOn<typeof process, "kill">>;

  beforeEach(() => {
    setPlatform("darwin");
    kill = spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    kill.mockRestore();
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  });

  test("stops the macOS process group before killing it without resuming it", () => {
    killProcessTree(1234);
    expect(kill.mock.calls).toEqual([
      [-1234, "SIGSTOP"],
      [-1234, "SIGKILL"],
    ]);
  });

  test("still kills the group when stopping fails", () => {
    kill.mockImplementationOnce(() => {
      throw new Error("stop failed");
    });
    killProcessTree(1234);
    expect(kill.mock.calls).toEqual([
      [-1234, "SIGSTOP"],
      [-1234, "SIGKILL"],
    ]);
  });

  test("falls back to killing the shell when the group kill fails", () => {
    kill.mockImplementation((pid, signal) => {
      if (pid < 0 && signal === "SIGKILL") throw new Error("group kill failed");
      return true;
    });
    killProcessTree(1234);
    expect(kill.mock.calls).toEqual([
      [-1234, "SIGSTOP"],
      [-1234, "SIGKILL"],
      [1234, "SIGKILL"],
    ]);
  });

  test("tolerates failure of both group signals and the fallback", () => {
    kill.mockImplementation(() => {
      throw new Error("process no longer exists");
    });
    expect(() => killProcessTree(1234)).not.toThrow();
    expect(kill.mock.calls).toEqual([
      [-1234, "SIGSTOP"],
      [-1234, "SIGKILL"],
      [1234, "SIGKILL"],
    ]);
  });

  test("keeps Linux group termination unchanged", () => {
    setPlatform("linux");
    killProcessTree(1234);
    expect(kill.mock.calls).toEqual([[-1234, "SIGKILL"]]);
  });
});

describe("shellEnv", () => {
  test("keeps the listed names, every LC_* and the proxies in both cases, and nothing else", async () => {
    const env = await shellEnv(undefined, {
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      USER: "owner",
      SHELL: "/bin/zsh",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      LC_CTYPE: "UTF-8",
      TMPDIR: "/tmp/owner",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HTTP_PROXY: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://127.0.0.1:7890",
      no_proxy: "localhost",
      TERM: "xterm-256color",
      OPENROUTER_API_KEY: "sk-or-secret",
      EIDOLON_APP_ROOT: "/app",
      BUN_OPTIONS: "--preload x",
      NODE_OPTIONS: "--require x",
      GIT_DIR: "/elsewhere/.git",
      BASH_ENV: "/tmp/run-me.sh",
      DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
      DISPLAY: ":0",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      USER: "owner",
      SHELL: "/bin/zsh",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      LC_CTYPE: "UTF-8",
      TMPDIR: "/tmp/owner",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HTTP_PROXY: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://127.0.0.1:7890",
      no_proxy: "localhost",
      TERM: "dumb",
    });
  });

  test("drops empty and relative PATH entries, node_modules/.bin, Bun's node shim and repeats", async () => {
    const path = [
      "",
      ".",
      "bin",
      "/Users/owner/proj/node_modules/.bin",
      "/Users/owner/node_modules/.bin/",
      "/private/tmp/bun-node-501-38afee6c8",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/opt/homebrew/bin",
    ].join(delimiter);
    const env = await shellEnv(undefined, { PATH: path });
    expect(env.PATH).toBe(["/opt/homebrew/bin", "/usr/bin"].join(delimiter));
  });

  test("falls back to the system's PATH when none is left, as bash would search the folder", async () => {
    expect((await shellEnv(undefined, {})).PATH).toBe(["/usr/bin", "/bin"].join(delimiter));
    const only = ["/x/node_modules/.bin", ".", ""].join(delimiter);
    expect((await shellEnv(undefined, { PATH: only })).PATH).toBe(
      ["/usr/bin", "/bin"].join(delimiter),
    );
  });

  test.skipIf(!bashOffered())(
    "a program a task plants in its folder doesn't run by name when the server had no PATH",
    async () => {
      const task = await tempFolder();
      writeFileSync(join(task, "planted"), "#!/bin/sh\necho planted-ran\n");
      chmodSync(join(task, "planted"), 0o755);
      const env = await shellEnv(folderGuard(task), { HOME: task });
      const chunks: Buffer[] = [];
      const { exitCode } = await createLocalBashOperations().exec("planted", task, {
        onData: (data) => chunks.push(data),
        env,
      });
      expect(exitCode).toBe(127);
      expect(Buffer.concat(chunks).toString()).not.toContain("planted-ran");
    },
  );

  test("drops every PATH folder the task may write, its folder's and its grants' alike", async () => {
    const task = await tempFolder();
    const elsewhere = await tempFolder();
    const guard = folderGuard(task);
    const path = [
      join(task, "node_modules", ".bin"),
      join(task, "bin"),
      join(task, "tools", "not-made-yet"),
      join(elsewhere, "x", "node_modules", ".bin"),
      ".",
      "/usr/bin",
      join(elsewhere, "bin"),
    ].join(delimiter);
    const env = await shellEnv(guard, { PATH: path });
    expect(env.PATH).toBe(["/usr/bin", join(elsewhere, "bin")].join(delimiter));
  });

  test.skipIf(!bashOffered())(
    "a program a task plants in its node_modules/.bin is not the one a command runs",
    async () => {
      const task = await tempFolder();
      const bin = join(task, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "ls"), "#!/bin/sh\necho planted\n");
      chmodSync(join(bin, "ls"), 0o755);
      const env = await shellEnv(folderGuard(task), {
        ...process.env,
        PATH: [bin, join(task, "bin"), "/usr/bin", "/bin"].join(delimiter),
      });
      const chunks: Buffer[] = [];
      const { exitCode } = await createLocalBashOperations().exec(
        "command -v ls; echo $PATH",
        task,
        { onData: (data) => chunks.push(data), env },
      );
      expect(exitCode).toBe(0);
      const [found, seen] = Buffer.concat(chunks).toString().trim().split("\n");
      expect(found).not.toStartWith(task);
      expect(seen).toBe(["/usr/bin", "/bin"].join(delimiter));
    },
  );
});

describe("getShellConfig", () => {
  test.skipIf(!bashOffered())("takes /bin/bash, as pi does", () => {
    expect(getShellConfig("")).toEqual({ shell: "/bin/bash", args: ["-c"] });
  });
});

describe("bashOffered", () => {
  test("offers commands on macOS and Linux only", () => {
    expect(
      ["darwin", "linux", "win32", "freebsd"].map((p) => bashOffered(p as NodeJS.Platform)),
    ).toEqual([true, true, false, false]);
  });
});
