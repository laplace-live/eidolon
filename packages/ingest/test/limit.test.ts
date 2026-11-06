import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLEANUP_LIMIT_MS,
  createLimiter,
  criticalSection,
  REPEAT_MS,
  runWithSignals,
  type SignalHost,
  terminate,
  terminateOnAbort,
} from "../src/index.ts";
import { makeFifo, whenReading } from "./fifo.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeClock() {
  let at = 0;
  return {
    now: () => at,
    advance(ms: number): void {
      at += ms;
    },
  };
}

describe("createLimiter", () => {
  test("runs at most `concurrency` tasks, starting them in the order they came", async () => {
    const limit = createLimiter(2);
    const started: number[] = [];
    const gates = [0, 1, 2, 3].map(() => deferred());
    const runs = gates.map((gate, i) =>
      limit(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) gate.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  test("a failing task frees its slot and rejects only its own call", async () => {
    const limit = createLimiter(1);
    const failed = limit(async () => {
      throw new Error("boom");
    });
    const thrown = limit(() => {
      throw new Error("sync");
    });
    const ok = limit(async () => "next");
    const settled = await Promise.allSettled([failed, thrown, ok]);
    expect(
      settled.map((r) => (r.status === "fulfilled" ? r.value : (r.reason as Error).message)),
    ).toEqual(["boom", "sync", "next"]);
  });

  test("after an abort, queued tasks never start; running ones finish", async () => {
    const controller = new AbortController();
    const limit = createLimiter(1, controller.signal);
    const gate = deferred();
    const started: string[] = [];
    const running = limit(async () => {
      started.push("a");
      await gate.promise;
      return "a";
    });
    const queued = limit(async () => {
      started.push("b");
      return "b";
    });
    await tick();
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    await expect(limit(async () => "c")).rejects.toBe(reason);
    gate.resolve();
    expect(await running).toBe("a");
    expect(started).toEqual(["a"]);
  });

  test("concurrency below 1 is refused", () => {
    expect(() => createLimiter(0)).toThrow("concurrency must be a positive integer, not 0");
  });
});

class FakeHost implements SignalHost {
  readonly listeners = new Map<string, () => void>();
  readonly exits: number[] = [];
  written = "";
  readonly stderr = {
    write: (text: string): void => {
      this.written += text;
    },
  };
  on(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }
  off(event: string): void {
    this.listeners.delete(event);
  }
  exit(code: number): void {
    this.exits.push(code);
  }
  send(event: string): void {
    this.listeners.get(event)?.();
  }
}

describe("runWithSignals", () => {
  test("a run no signal touched keeps its exit code, and the handlers go away", async () => {
    const host = new FakeHost();
    expect(await runWithSignals(async () => 3, host)).toBe(3);
    expect(host.listeners.size).toBe(0);
  });

  test("the first signal aborts the run, which then exits 130 or 143", async () => {
    for (const [name, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const host = new FakeHost();
      const result = runWithSignals(async (signal) => {
        host.send(name);
        expect(signal.aborted).toBe(true);
        expect((signal.reason as DOMException).name).toBe("AbortError");
        return 0;
      }, host);
      expect(await result).toBe(code);
      expect(host.exits).toEqual([]);
    }
  });

  test("a signal that reaches its listener only after the run returned still exits 130 or 143", async () => {
    for (const [name, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const host = new FakeHost();
      // As a real signal sent during the run's last synchronous stretch: a later turn delivers it.
      const result = runWithSignals(async () => {
        setTimeout(() => host.send(name), 0);
        return 0;
      }, host);
      expect(await result).toBe(code);
      expect(host.exits).toEqual([]);
    }
  });

  test("a second signal, REPEAT_MS after the first, exits at once", async () => {
    const host = new FakeHost();
    const clock = fakeClock();
    const gate = deferred<number>();
    const result = runWithSignals(() => gate.promise, host, CLEANUP_LIMIT_MS, clock.now);
    host.send("SIGTERM");
    clock.advance(REPEAT_MS);
    host.send("SIGINT");
    expect(host.exits).toEqual([130]);
    gate.resolve(0);
    expect(await result).toBe(143);
  });

  test("a repeat within REPEAT_MS is the first signal delivered twice: the stop goes on", async () => {
    const host = new FakeHost();
    const clock = fakeClock();
    const gate = deferred<number>();
    const result = runWithSignals(() => gate.promise, host, CLEANUP_LIMIT_MS, clock.now);
    host.send("SIGTERM");
    clock.advance(REPEAT_MS - 1);
    host.send("SIGTERM");
    host.send("SIGINT");
    expect(host.exits).toEqual([]);
    expect(host.written).toBe("Stopping; send SIGTERM again to quit now.\n");
    gate.resolve(0);
    expect(await result).toBe(143);
    expect(host.exits).toEqual([]);
  });

  test("a stop that outlasts the cleanup limit exits anyway", async () => {
    const host = new FakeHost();
    const gate = deferred<number>();
    const result = runWithSignals(() => gate.promise, host, 10);
    host.send("SIGINT");
    await new Promise((r) => setTimeout(r, 30));
    expect(host.exits).toEqual([130]);
    gate.resolve(0);
    await result;
  });

  test("a stop that outlasts the limit inside a critical section exits as the section ends", async () => {
    const host = new FakeHost();
    const section = deferred();
    const result = runWithSignals(
      async () => {
        const writing = criticalSection(() => section.promise);
        host.send("SIGINT");
        await new Promise((r) => setTimeout(r, 30));
        expect(host.exits).toEqual([]);
        section.resolve();
        await writing;
        expect(host.exits).toEqual([130]);
        return 0;
      },
      host,
      10,
    );
    expect(await result).toBe(130);
    expect(host.exits).toEqual([130]);
  });

  test("a second signal exits at once, inside a critical section too", async () => {
    const host = new FakeHost();
    const clock = fakeClock();
    const section = deferred();
    const result = runWithSignals(
      async () => {
        const writing = criticalSection(() => section.promise);
        host.send("SIGTERM");
        clock.advance(REPEAT_MS);
        host.send("SIGINT");
        expect(host.exits).toEqual([130]);
        section.resolve();
        await writing;
        return 0;
      },
      host,
      CLEANUP_LIMIT_MS,
      clock.now,
    );
    expect(await result).toBe(143);
    expect(host.exits).toEqual([130]);
  });

  test("the first signal says how to quit at once", async () => {
    for (const [name, line] of [
      ["SIGINT", "Stopping; press Ctrl-C again to quit now.\n"],
      ["SIGTERM", "Stopping; send SIGTERM again to quit now.\n"],
    ] as const) {
      const host = new FakeHost();
      await runWithSignals(async () => {
        host.send(name);
        return 0;
      }, host);
      expect(host.written).toBe(line);
    }
  });

  test("with no cleanup time, the first signal exits at once, saying nothing", async () => {
    const host = new FakeHost();
    const gate = deferred<number>();
    const result = runWithSignals(() => gate.promise, host, 0);
    host.send("SIGINT");
    await tick();
    expect(host.exits).toEqual([130]);
    expect(host.written).toBe("");
    gate.resolve(0);
    await result;
  });

  test("a real Ctrl-C: a run that ignores its signal quits at once with no cleanup time; one that honors it stops at once and says how to quit now", async () => {
    const limit = join(import.meta.dir, "../src/limit.ts");
    for (const [run, cleanupMs, stderr] of [
      ["Bun.sleep(30_000)", 0, ""],
      [
        "new Promise((stop) => signal.addEventListener('abort', stop))",
        CLEANUP_LIMIT_MS,
        "Stopping; press Ctrl-C again to quit now.\n",
      ],
    ] as const) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `const { runWithSignals } = await import(${JSON.stringify(limit)});
           process.exitCode = await runWithSignals(async (signal) => {
             console.log("ready");
             await ${run};
             return 0;
           }, process, ${cleanupMs});`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      try {
        const { value } = await child.stdout.getReader().read();
        expect(new TextDecoder().decode(value)).toBe("ready\n");
        const sent = performance.now();
        child.kill("SIGINT");
        expect(await child.exited).toBe(130);
        expect(performance.now() - sent).toBeLessThan(2_000);
        expect(await new Response(child.stderr).text()).toBe(stderr);
      } finally {
        child.kill("SIGKILL");
      }
    }
  }, 10_000);

  test("a real SIGTERM that arrives twice, as the npm launcher's process group gets one, stops gracefully once", async () => {
    const limit = join(import.meta.dir, "../src/limit.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { runWithSignals } = await import(${JSON.stringify(limit)});
         process.exitCode = await runWithSignals(async (signal) => {
           console.log("ready");
           await new Promise((stop) => signal.addEventListener("abort", stop));
           await Bun.sleep(200);
           console.log("stopped");
           return 0;
         });`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const decoder = new TextDecoder();
    try {
      const stdout = child.stdout.getReader();
      const stderr = child.stderr.getReader();
      expect(decoder.decode((await stdout.read()).value)).toBe("ready\n");
      child.kill("SIGTERM");
      // The second once the first reached its listener, as the launcher's copy comes: two pending
      // SIGTERMs merge into one.
      expect(decoder.decode((await stderr.read()).value)).toBe(
        "Stopping; send SIGTERM again to quit now.\n",
      );
      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
      let rest = "";
      for (let chunk = await stdout.read(); !chunk.done; chunk = await stdout.read()) {
        rest += decoder.decode(chunk.value);
      }
      expect(rest).toBe("stopped\n");
    } finally {
      child.kill("SIGKILL");
    }
  }, 10_000);

  test("a real signal sent while the run is stuck in a synchronous read still exits 130 or 143", async () => {
    const limit = join(import.meta.dir, "../src/limit.ts");
    const work = mkdtempSync(join(tmpdir(), "limit-signal-"));
    try {
      for (const [name, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const) {
        const fifo = join(work, `${name}.fifo`);
        makeFifo(fifo);
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "-e",
            `const { readFileSync } = await import("node:fs");
             const { runWithSignals } = await import(${JSON.stringify(limit)});
             process.exitCode = await runWithSignals(async () => {
               readFileSync(${JSON.stringify(fifo)});
               return 0;
             });`,
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        try {
          const release = await whenReading(fifo, child);
          child.kill(name);
          await Bun.sleep(50);
          release("x");
          expect(await child.exited).toBe(code);
        } finally {
          child.kill("SIGKILL");
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("terminate", () => {
  test("SIGTERM stops a child that listens", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    await terminate(child);
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("a child that ignores SIGTERM gets SIGKILL after the grace period", async () => {
    const child = Bun.spawn(["sh", "-c", "trap '' TERM; exec sleep 30"]);
    await Bun.sleep(100);
    await terminate(child, 100);
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("an exited child is left alone; an abort terminates a running one", async () => {
    const done = Bun.spawn(["true"]);
    await done.exited;
    await terminate(done);
    expect(done.exitCode).toBe(0);

    const controller = new AbortController();
    const child = Bun.spawn(["sleep", "30"]);
    const detach = terminateOnAbort(child, controller.signal);
    controller.abort();
    await child.exited;
    detach();
    expect(child.signalCode).toBe("SIGTERM");
  });
});
