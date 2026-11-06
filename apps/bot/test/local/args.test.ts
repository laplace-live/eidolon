import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type LocalArgs,
  localArgv,
  parseLocalArgs,
  resolveLocalHost,
} from "../../src/local/args.ts";

class Exit extends Error {
  readonly code: number | undefined;
  constructor(code: number | undefined) {
    super(`exit ${code}`);
    this.code = code;
  }
}

let stderr: string[];
let stdout: string[];
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  stderr = [];
  stdout = [];
  spies.push(
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exit(code);
    }) as typeof process.exit),
    spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }),
    spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function exitOf(run: () => unknown): Promise<number | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
  throw new Error("did not exit");
}

const USAGE = "usage: eidolon [-h] [--host HOST] [--port PORT] [-v] [--open | --no-open]";

describe("parseLocalArgs", () => {
  test("defaults: localhost:7860, INFO, and the browser opens", () => {
    expect(parseLocalArgs([])).toEqual({ host: "localhost", port: 7860, verbose: 0, open: true });
  });

  test("every flag, the last --open/--no-open winning", () => {
    expect(
      parseLocalArgs(["--host=::1", "--port", "0", "-vv", "--no-open", "--open", "--no-open"]),
    ).toEqual({ host: "::1", port: 0, verbose: 2, open: false });
  });

  test("usage errors exit 2 with prog eidolon", async () => {
    for (const [argv, message] of [
      [["--port", "x"], "argument --port: invalid int value: 'x'"],
      [["--port", "70000"], "argument --port: 70000 is not a port number (0 to 65535)"],
      [["--host"], "argument --host: expected one argument"],
      [["--open=yes"], "argument --open/--no-open: ignored explicit argument 'yes'"],
      [["--local", "x"], "unrecognized arguments: --local x"],
      [["--allow-remote"], "unrecognized arguments: --allow-remote"],
    ] as const) {
      stderr.length = 0;
      expect(await exitOf(() => parseLocalArgs(argv))).toBe(2);
      expect(stderr.join("")).toBe(`${USAGE}\neidolon: error: ${message}\n`);
    }
  });

  test("-h prints the help and exits 0", async () => {
    expect(await exitOf(() => parseLocalArgs(["-h"]))).toBe(0);
    const help = stdout.join("");
    expect(help.startsWith(`${USAGE}\n`)).toBe(true);
    expect(help).toContain("--open, --no-open");
    expect(help).toContain("ssh -L 7860:localhost:7860");
  });

  test("localArgv round-trips", () => {
    const cases: LocalArgs[] = [
      { host: "localhost", port: 7860, verbose: 0, open: true },
      { host: "::1", port: 0, verbose: 3, open: false },
      { host: "-1", port: 1, verbose: 1, open: true },
    ];
    for (const args of cases) expect(parseLocalArgs(localArgv(args))).toEqual(args);
  });
});

describe("resolveLocalHost", () => {
  const lookup = (addresses: string[]) => async () => addresses.map((address) => ({ address }));

  test("loopback literals bind as given and name the link", async () => {
    expect(await resolveLocalHost("127.0.0.1")).toEqual({
      bind: "127.0.0.1",
      urlHost: "127.0.0.1",
      literals: ["127.0.0.1"],
    });
    expect(await resolveLocalHost("[::1]")).toEqual({
      bind: "::1",
      urlHost: "[::1]",
      literals: ["[::1]"],
    });
    expect(await resolveLocalHost("127.0.0.2")).toMatchObject({ literals: ["127.0.0.2"] });
  });

  test("a name binds as a name when every address it resolves to is loopback", async () => {
    expect(await resolveLocalHost("localhost", lookup(["::1", "127.0.0.1"]))).toEqual({
      bind: "localhost",
      urlHost: "localhost",
      literals: [],
    });
  });

  test("anything that would listen beyond this computer exits 2", async () => {
    for (const [host, addresses] of [
      ["0.0.0.0", []],
      ["::", []],
      ["192.168.1.9", []],
      ["lan.example", ["127.0.0.1", "192.168.1.9"]],
      ["empty.example", []],
    ] as const) {
      stderr.length = 0;
      expect(await exitOf(() => resolveLocalHost(host, lookup([...addresses])))).toBe(2);
      expect(stderr.join("")).toContain("is not a loopback address");
    }
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await exitOf(() => resolveLocalHost("nowhere.invalid", failing))).toBe(2);
    expect(stderr.join("")).toContain("cannot resolve 'nowhere.invalid'");
  });
});
