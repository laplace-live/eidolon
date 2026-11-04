// Expected outputs are argparse's, recorded from a Python parser with the runner's three flags.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BOT_USAGE, parseBotArgs } from "../src/args.ts";

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

function exitOf(argv: string[]): number | undefined {
  try {
    parseBotArgs(argv);
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
  throw new Error(`parseBotArgs(${JSON.stringify(argv)}) did not exit`);
}

describe("parseBotArgs", () => {
  test("defaults are the runner's", () => {
    expect(parseBotArgs([])).toEqual({ host: "localhost", port: 7860, verbose: 0 });
  });

  test("the Docker CMD's flags", () => {
    expect(parseBotArgs(["--host", "0.0.0.0", "--port", "7861", "-v"])).toEqual({
      host: "0.0.0.0",
      port: 7861,
      verbose: 1,
    });
  });

  test("argparse's value forms", () => {
    expect(parseBotArgs(["--port=7861", "--host="])).toEqual({ host: "", port: 7861, verbose: 0 });
    expect(parseBotArgs(["--host=a=b"]).host).toBe("a=b");
    expect(parseBotArgs(["--port", " 7861 "]).port).toBe(7861);
    expect(parseBotArgs(["--port", "+7"]).port).toBe(7);
    expect(parseBotArgs(["--port", "7_861"]).port).toBe(7861);
    expect(parseBotArgs(["--port", "-5"]).port).toBe(-5);
    expect(parseBotArgs(["--port", "1", "--port", "2"]).port).toBe(2);
    expect(parseBotArgs(["--host", "-"]).host).toBe("-");
    expect(parseBotArgs(["--host", "-a b"]).host).toBe("-a b");
    expect(parseBotArgs(["--port", "0"]).port).toBe(0);
  });

  test("PIPECAT_HOST and PIPECAT_PORT are the Docker CMD's to expand, never read", () => {
    const saved = { host: process.env.PIPECAT_HOST, port: process.env.PIPECAT_PORT };
    process.env.PIPECAT_HOST = "0.0.0.0";
    process.env.PIPECAT_PORT = "9999";
    try {
      expect(parseBotArgs([])).toEqual({ host: "localhost", port: 7860, verbose: 0 });
    } finally {
      for (const [name, value] of [
        ["PIPECAT_HOST", saved.host],
        ["PIPECAT_PORT", saved.port],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("-v counts", () => {
    expect(parseBotArgs(["-vv"]).verbose).toBe(2);
    expect(parseBotArgs(["-v", "-v", "--verbose"]).verbose).toBe(3);
  });

  test("usage errors exit 2 with argparse's message on stderr", () => {
    const cases: [string[], string][] = [
      [["--port", "x"], "argument --port: invalid int value: 'x'"],
      [["--port", "1.5"], "argument --port: invalid int value: '1.5'"],
      [["--port"], "argument --port: expected one argument"],
      [["--host"], "argument --host: expected one argument"],
      [["--host", "--port"], "argument --host: expected one argument"],
      [["--bogus"], "unrecognized arguments: --bogus"],
      [["extra"], "unrecognized arguments: extra"],
      [["-"], "unrecognized arguments: -"],
      [["--bogus=1", "x", "-5"], "unrecognized arguments: --bogus=1 x -5"],
      [["-vx"], "unrecognized arguments: -x"],
      [["-v3"], "unrecognized arguments: -3"],
      [["-t", "webrtc"], "unrecognized arguments: -t webrtc"],
      [["--verbose=1"], "argument -v/--verbose: ignored explicit argument '1'"],
      [["--bogus", "--port", "x"], "argument --port: invalid int value: 'x'"],
    ];
    for (const [argv, message] of cases) {
      stderr.length = 0;
      expect(exitOf(argv)).toBe(2);
      expect(stderr.join("")).toBe(`${BOT_USAGE}\nmain.ts: error: ${message}\n`);
    }
    expect(BOT_USAGE).toBe("usage: main.ts [-h] [--host HOST] [--port PORT] [-v]");
  });

  test("-h prints the help on stdout and exits 0", () => {
    for (const argv of [["-h"], ["--help"], ["-vh"], ["--port", "1", "-h", "--bogus"]]) {
      stdout.length = 0;
      expect(exitOf(argv)).toBe(0);
      expect(stdout.join("")).toBe(
        "usage: main.ts [-h] [--host HOST] [--port PORT] [-v]\n\n" +
          "options:\n" +
          "  -h, --help     show this help message and exit\n" +
          "  --host HOST    Host address\n" +
          "  --port PORT    Port number\n" +
          "  -v, --verbose  Increase logging verbosity\n",
      );
    }
    expect(stderr).toEqual([]);
  });
});
