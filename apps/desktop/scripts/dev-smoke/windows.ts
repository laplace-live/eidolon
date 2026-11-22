// The window watch, for the dev smoke in background mode on macOS: every 50 ms, which processes own
// a window on screen, from the window server's list (CGWindowListCopyWindowInfo, read through
// osascript's JavaScript bridge). A window of the app's on screen fails the run, one never focused
// or in front included, which the focus watch can't see. The owner's own windows, in the same list,
// show that it sees windows at all. Elsewhere, and with --headful, it watches nothing.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SAMPLE_MS = 50;
/** Its first look, which must come before the app's first launch. */
const READY_WITHIN_MS = 10_000;

/** Looks every `argv[0]` ms and prints each look, with the pids it sees own a window for the first time. */
const SCRIPT = `ObjC.import("CoreGraphics");
function run(argv) {
  const every = Number(argv[0]) / 1000;
  const seen = {};
  let looks = 0;
  let last = Date.now();
  let maxGapMs = 0;
  for (;;) {
    const now = Date.now();
    if (looks > 0) maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    const list = ObjC.castRefToObject(
      $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID),
    );
    const pids = ObjC.deepUnwrap(list.valueForKey("kCGWindowOwnerPID")) || [];
    const fresh = [];
    for (const pid of pids) {
      if (seen[pid] === undefined) {
        seen[pid] = true;
        fresh.push(pid);
      }
    }
    looks++;
    console.log(JSON.stringify({ looks, maxGapMs, windows: pids.length, fresh }));
    delay(every);
  }
}`;

export interface WindowLook {
  /** How many times the script has read the list. */
  readonly looks: number;
  readonly maxGapMs: number;
  /** The windows on screen, any app's. */
  readonly windows: number;
  /** The pids that own a window on screen for the first time. */
  readonly fresh: readonly number[];
}

/** One of the script's lines, or null for anything else osascript printed. */
export function parseLook(line: string): WindowLook | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const look = value as Partial<WindowLook> | null;
  if (
    typeof look?.looks !== "number" ||
    typeof look.maxGapMs !== "number" ||
    typeof look.windows !== "number" ||
    !Array.isArray(look.fresh) ||
    !look.fresh.every((pid) => Number.isInteger(pid))
  ) {
    return null;
  }
  return { looks: look.looks, maxGapMs: look.maxGapMs, windows: look.windows, fresh: look.fresh };
}

export interface WindowReport {
  /** Why it watched nothing: not macOS, or a headful run. */
  readonly skipped: string | null;
  readonly looks: number;
  readonly seconds: number;
  readonly maxGapMs: number;
  /** The most windows it saw on screen at once, any app's: none means it saw nothing at all. */
  readonly windows: number;
  readonly failures: readonly string[];
}

export interface WindowWatch {
  /** Resolves at its first look; one later than the app's first launch is a failure. */
  readonly ready: Promise<void>;
  stop(): Promise<WindowReport>;
}

export interface WindowOptions {
  /** Which of `pids` are the app's: processes the smoke started, or ones under them. */
  readonly ours: (pids: readonly number[]) => Promise<readonly number[]>;
  /** Why not to watch, or null to watch. */
  readonly skip: string | null;
  /** What the smoke is doing, for a failure's line. */
  readonly doing: () => string;
}

/** Starts the watch; await `ready` before the app's first launch, and stop() after its last. */
export function watchWindows({ ours, skip, doing }: WindowOptions): WindowWatch {
  const failures: string[] = [];
  if (skip !== null) {
    return {
      ready: Promise.resolve(),
      stop: async () => ({
        skipped: skip,
        looks: 0,
        seconds: 0,
        maxGapMs: 0,
        windows: 0,
        failures,
      }),
    };
  }
  const started = Date.now();
  const since = (): string => `+${((Date.now() - started) / 1000).toFixed(2)} s`;
  const fail = (failure: string): void => {
    failures.push(failure);
    process.stderr.write(`window watch: ${failure}\n`);
  };
  /** Whatever osascript printed that isn't a look: its errors. */
  const other: string[] = [];
  const printed = (): string => other.slice(-2).join(" | ");
  let last: WindowLook | null = null;
  let windows = 0;
  let stopping = false;
  const lookups: Promise<void>[] = [];

  const child = spawn("osascript", ["-l", "JavaScript", "-e", SCRIPT, String(SAMPLE_MS)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  // At close, not exit: its last looks can still be in the pipe once it has exited.
  const exited = new Promise<void>((done) => {
    child.once("error", (error) => {
      other.push(String(error));
      done();
    });
    child.once("close", () => done());
  });
  void exited.then(() => {
    if (!stopping) fail(`it stopped looking at ${since()}: ${printed() || "osascript ended"}`);
  });

  let looked: () => void = () => {};
  const ready = new Promise<void>((done) => {
    looked = done;
    void exited.then(done);
    setTimeout(() => {
      if (last === null) {
        fail(`no first look within ${READY_WITHIN_MS / 1000} s, before the app's first launch`);
      }
      done();
    }, READY_WITHIN_MS).unref();
  });

  createInterface({ input: child.stderr }).on("line", (line) => {
    const look = parseLook(line);
    if (look === null) {
      if (line.trim() !== "") other.push(line.trim());
      return;
    }
    last = look;
    windows = Math.max(windows, look.windows);
    looked();
    if (look.fresh.length === 0) return;
    const at = since();
    const during = doing();
    lookups.push(
      ours(look.fresh).then(
        (app) => {
          for (const pid of app) {
            fail(`pid ${pid}, the app's, had a window on screen at ${at}, during ${during}`);
          }
        },
        (error: unknown) => {
          fail(`couldn't tell whose windows pids ${look.fresh.join(", ")} had: ${String(error)}`);
        },
      ),
    );
  });

  return {
    ready,
    async stop() {
      stopping = true;
      child.kill("SIGTERM");
      await exited;
      await Promise.all(lookups);
      const seen = last as WindowLook | null;
      if (seen === null) fail(`it never looked: ${printed() || "osascript printed nothing"}`);
      return {
        skipped: null,
        looks: seen?.looks ?? 0,
        seconds: (Date.now() - started) / 1000,
        maxGapMs: seen?.maxGapMs ?? 0,
        windows,
        failures,
      };
    },
  };
}
