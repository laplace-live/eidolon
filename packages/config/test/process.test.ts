import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { jsRuntime, killTree, spawnProcess } from "../src/index.ts";
import { asElectron, asNode } from "./electron.ts";

/** Node running `script` as CommonJS (no top-level await), so `require` is there. */
function node(script: string): [string, ...string[]] {
  return [process.execPath, "-e", script];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await delay(10);
  }
}

describe("spawnProcess", () => {
  test("exited is the exit code, and a piped stdout is a web stream", async () => {
    const child = spawnProcess(node("process.stdout.write('out'); process.exitCode = 3;"));
    expect(child.stdout).toBeInstanceOf(ReadableStream);
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect({ text, code }).toEqual({ text: "out", code: 3 });
    expect({ exitCode: child.exitCode, signalCode: child.signalCode }).toEqual({
      exitCode: 3,
      signalCode: null,
    });
  });

  test("a signal's exit is 128 + its number", async () => {
    const child = spawnProcess(node("setInterval(() => {}, 1000);"), { stdout: "ignore" });
    child.kill("SIGKILL");
    expect(await child.exited).toBe(128 + 9);
    expect({ exitCode: child.exitCode, signalCode: child.signalCode }).toEqual({
      exitCode: null,
      signalCode: "SIGKILL",
    });
    const terminated = spawnProcess(node("setInterval(() => {}, 1000);"), { stdout: "ignore" });
    terminated.kill();
    expect(await terminated.exited).toBe(128 + 15);
  });

  // POSIX's errno and file modes.
  test.skipIf(process.platform === "win32")(
    "a program that can't start throws at once, and its late error event goes nowhere",
    async () => {
      const work = mkdtempSync(join(tmpdir(), "eidolon-spawn-"));
      const missing = join(work, "missing");
      const thrown = (argv: [string, ...string[]], options = {}): unknown => {
        try {
          spawnProcess(argv, options);
        } catch (error) {
          return error;
        }
        return null;
      };
      expect(thrown([missing, "--version"])).toMatchObject({
        message: `spawn ${missing} ENOENT`,
        code: "ENOENT",
        errno: -2,
        syscall: `spawn ${missing}`,
        path: missing,
        spawnargs: ["--version"],
      });
      expect(thrown(["eidolon-no-such-program"], { env: { PATH: work } })).toMatchObject({
        code: "ENOENT",
      });
      expect(thrown(["true"], { cwd: missing })).toMatchObject({ code: "ENOENT" });
      const plain = join(work, "plain");
      writeFileSync(plain, "#!/bin/sh\n");
      chmodSync(plain, 0o644);
      expect(thrown([plain])).toMatchObject({ message: `spawn ${plain} EACCES`, code: "EACCES" });
      expect(thrown([work])).toMatchObject({ code: "EACCES" });
      // Node emits the failure a tick later: unheard, it would fail this file as an uncaught error.
      await delay(50);
    },
  );

  test("ipc carries JSON both ways", async () => {
    const received: unknown[] = [];
    let heard = (): void => {};
    const both = new Promise<void>((resolve) => {
      heard = () => {
        if (received.length === 2) resolve();
      };
    });
    const child = spawnProcess(
      node(
        "process.on('message', (m) => { process.send({ echo: m }); if (m.last) process.disconnect(); });",
      ),
      {
        stdout: "ignore",
        ipc: (message) => {
          received.push(message);
          heard();
        },
      },
    );
    child.send({ n: 1, text: "中文" });
    child.send({ n: 2, last: true });
    await both;
    expect(await child.exited).toBe(0);
    expect(received).toEqual([{ echo: { n: 1, text: "中文" } }, { echo: { n: 2, last: true } }]);
  });

  test("send needs an ipc channel", () => {
    const child = spawnProcess(node(""), { stdout: "ignore" });
    expect(() => child.send({})).toThrow("send() needs a process spawned with ipc");
  });

  test("killTree ends a detached child and what it started, as a job's force stop does", async () => {
    const child = spawnProcess(
      node(
        `const grandchild = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
         console.log(grandchild.pid);
         setInterval(() => {}, 1000);`,
      ),
      { detached: true },
    );
    const { value } = await (child.stdout as ReadableStream<Uint8Array>).getReader().read();
    const grandchild = Number(new TextDecoder().decode(value).trim());
    expect(alive(grandchild)).toBe(true);
    // The group's id is the child's pid: setsid() made it the leader. Windows has no groups.
    if (process.platform !== "win32") expect(() => process.kill(-child.pid, 0)).not.toThrow();
    killTree(child.pid);
    // taskkill's exit code, on Windows.
    expect(await child.exited).toBe(process.platform === "win32" ? 1 : 128 + 9);
    await until(() => !alive(grandchild));
  });

  test.skipIf(process.platform === "win32")(
    "an undetached child stays in this process's group",
    async () => {
      const child = spawnProcess(node("setInterval(() => {}, 1000);"), { stdout: "ignore" });
      try {
        expect(() => process.kill(-child.pid, 0)).toThrow();
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    },
  );

  test("timeout sends SIGTERM once it has passed", async () => {
    const started = performance.now();
    const child = spawnProcess(node("setInterval(() => {}, 1000);"), {
      stdout: "ignore",
      timeout: 100,
    });
    expect(await child.exited).toBe(128 + 15);
    expect(performance.now() - started).toBeGreaterThanOrEqual(90);
  });

  test("an fd takes the output, stdin can be piped, and env is the whole environment", async () => {
    const work = mkdtempSync(join(tmpdir(), "eidolon-spawn-"));
    const out = join(work, "out.txt");
    const fd = openSync(out, "w");
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(
        node(
          "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.stdout.write(':' + Object.keys(process.env).filter((k) => k.startsWith('EIDOLON_SPAWN')).join(',')));",
        ),
        { stdin: "pipe", stdout: fd, env: { EIDOLON_SPAWN_ONLY: "1" } },
      );
    } finally {
      closeSync(fd);
    }
    expect(child.stdout).toBeNull();
    child.stdin?.end("piped");
    expect(await child.exited).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("piped:EIDOLON_SPAWN_ONLY");
  });

  test("without env it inherits this process's, as it is now", async () => {
    process.env.EIDOLON_SPAWN_INHERITED = "now";
    try {
      const child = spawnProcess(
        node("process.stdout.write(process.env.EIDOLON_SPAWN_INHERITED ?? 'unset');"),
        { cwd: tmpdir() },
      );
      const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(text).toBe("now");
    } finally {
      delete process.env.EIDOLON_SPAWN_INHERITED;
    }
  });
});

describe("jsRuntime", () => {
  test("on Node: this runtime, with nothing to add", () => {
    const restore = asNode();
    try {
      expect(jsRuntime()).toEqual({ command: process.execPath, args: [], env: {} });
    } finally {
      restore();
    }
  });

  test("inside Electron: its binary as Node, deaf to SIGUSR1 and trusting the OS's CAs", () => {
    const restore = asElectron();
    try {
      expect(jsRuntime()).toEqual({
        command: process.execPath,
        args: ["--disable-sigusr1", "--use-system-ca"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
    } finally {
      restore();
    }
  });

  test("its flags, put before the script, are this runtime's own options", async () => {
    const restore = asElectron();
    let runtime: ReturnType<typeof jsRuntime>;
    try {
      runtime = jsRuntime();
    } finally {
      restore();
    }
    const child = spawnProcess(
      [
        runtime.command,
        ...runtime.args,
        "-e",
        "process.stdout.write(JSON.stringify([process.execArgv.slice(0, 2), process.argv.length]))",
      ],
      { env: runtime.env },
    );
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect([code, JSON.parse(text)]).toEqual([0, [["--disable-sigusr1", "--use-system-ca"], 1]]);
  });
});
