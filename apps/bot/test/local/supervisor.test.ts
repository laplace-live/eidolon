// The supervisor against a fake server child, a plain Bun script that follows a plan file and
// records each run's flags: restart on 75, signals passed on, and the child's exit code returned.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ForwardedSignal, supervise } from "../../src/local/supervisor.ts";

const FAKE_SERVER = `
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const runs = join(import.meta.dir, "runs.ndjson");
let index = 0;
try { index = readFileSync(runs, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
const step = JSON.parse(readFileSync(join(import.meta.dir, "plan.json"), "utf8"))[index];
if (step.port !== undefined) {
  process.send?.({ kind: "listening", port: step.port });
  await Bun.sleep(50);
}
if (step.onSignal !== undefined) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      appendFileSync(join(import.meta.dir, "signals.txt"), signal + "\\n");
      process.exit(step.onSignal);
    });
  }
}
appendFileSync(runs, JSON.stringify(Bun.argv.slice(2)) + "\\n");
if (step.exit !== undefined) process.exit(step.exit);
setInterval(() => {}, 1000);
`;

let dir: string;
let fire: ((signal: ForwardedSignal) => void) | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eidolon-supervisor-"));
  writeFileSync(join(dir, "server.ts"), FAKE_SERVER);
  fire = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function plan(steps: Record<string, number>[]): void {
  writeFileSync(join(dir, "plan.json"), JSON.stringify(steps));
}

function runs(): string[][] {
  const path = join(dir, "runs.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function started(count: number): Promise<void> {
  for (let waited = 0; runs().length < count; waited += 20) {
    if (waited > 10_000) throw new Error("the fake server never started");
    await Bun.sleep(20);
  }
}

function run(argv: string[]): Promise<number> {
  return supervise(argv, {
    entry: join(dir, "server.ts"),
    signals: (forward) => {
      fire = forward;
      return () => {
        fire = null;
      };
    },
  });
}

describe("supervise", () => {
  test("restarts on 75 on the port the server bound, with no second browser tab", async () => {
    plan([{ port: 41234, exit: 75 }, { port: 41234, exit: 75 }, { exit: 3 }]);
    expect(await run(["--port", "0", "-v"])).toBe(3);
    expect(runs()).toEqual([
      ["--host=localhost", "--port=0", "-v", "--open"],
      ["--host=localhost", "--port=41234", "-v", "--no-open"],
      ["--host=localhost", "--port=41234", "-v", "--no-open"],
    ]);
    expect(fire).toBeNull();
  });

  test("exits with the server's code", async () => {
    plan([{ exit: 2 }]);
    expect(await run([])).toBe(2);
    plan([{ exit: 0 }]);
    rmSync(join(dir, "runs.ndjson"));
    expect(await run(["--no-open"])).toBe(0);
  });

  test("passes SIGTERM on, and a 75 after it is not a restart", async () => {
    plan([{ onSignal: 75 }, { exit: 9 }]);
    const done = run([]);
    await started(1);
    fire?.("SIGTERM");
    expect(await done).toBe(75);
    expect(runs()).toHaveLength(1);
    expect(readFileSync(join(dir, "signals.txt"), "utf8")).toBe("SIGTERM\n");
  });

  test("passes SIGINT on as SIGINT", async () => {
    plan([{ onSignal: 0 }]);
    const done = run([]);
    await started(1);
    fire?.("SIGINT");
    expect(await done).toBe(0);
    expect(readFileSync(join(dir, "signals.txt"), "utf8")).toBe("SIGINT\n");
  });

  test("a server the signal kills reports 128 plus its number", async () => {
    plan([{ sleep: 1 }]);
    const done = run([]);
    await started(1);
    fire?.("SIGTERM");
    expect(await done).toBe(143);
  });
});
