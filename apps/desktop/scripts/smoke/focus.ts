// The focus watch, for a desktop smoke in background mode on macOS: `lsappinfo front` every 50 ms.
// The app under test in front, by its name or by a pid the smoke started or one under it, fails the
// smoke, and so does a system prompt in front; the owner switching between their own apps doesn't.
// The app's main process must also be an accessory (UIElement), with no Dock icon, once it runs.
// Elsewhere, and with --headful, it watches nothing.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAMPLE_MS = 50;
const TYPE_SAMPLE_MS = 500;
/**
 * macOS registers every Electron process as a regular app for about 50–150 ms at launch, before
 * main's first line can make it an accessory; a main that isn't one by then never becomes one.
 */
const ACCESSORY_WITHIN_MS = 10_000;
/** The names the app under test runs as: Electron unpackaged, Eidolon packaged. */
const APP_NAMES = /^(electron|eidolon)$/i;
/** What puts a system prompt in front: the keychain, privacy, an alert, an Open or Save panel. */
const PROMPT_NAMES =
  /^(SecurityAgent|UserNotificationCenter|CoreServicesUIAgent|universalAccessAuthWarn|Open and Save Panel Service)$/i;

export interface FocusReport {
  /** Why it watched nothing: not macOS, or a headful run. */
  readonly skipped: string | null;
  readonly samples: number;
  readonly seconds: number;
  /** The longest time between two samples. */
  readonly maxGapMs: number;
  /** Each app seen in front, with how many samples saw it. */
  readonly front: Readonly<Record<string, number>>;
  /** The main processes' ApplicationType samples, by type. */
  readonly types: Readonly<Record<string, number>>;
  readonly failures: readonly string[];
}

export interface FocusWatch {
  /** The app's main process, from its launch: it must be a UIElement once it runs. */
  main(pid: number): void;
  /** What has failed so far. */
  readonly failures: readonly string[];
  stop(): Promise<FocusReport>;
}

export interface FocusOptions {
  /** Whether `pid` is the app's: a process the smoke started, or one under it. */
  readonly ours: (pid: number) => Promise<boolean>;
  /** Why not to watch, or null to watch. */
  readonly skip: string | null;
}

/**
 * `lsappinfo info -only`'s answer as macOS 26 prints it, a `"pid"=612` pair for each key asked
 * for, a NULL value as null; or null for what macOS 27 prints instead, ignoring -only: the whole
 * record, `"Finder" ASN:…` and then `pid = 612 … type="UIElement"`.
 */
function pairs(text: string): Map<string, string | null> | null {
  const found = new Map<string, string | null>();
  for (const [, key, value] of text.matchAll(/"(\w+)"=("[^"]*"|\[ NULL \]|[^\s"]+)/g)) {
    found.set(key, value === "[ NULL ]" ? null : value.replace(/^"(.*)"$/, "$1"));
  }
  return found.size > 0 ? found : null;
}

/** The front app's name and pid, from `lsappinfo info -only name -only pid`. */
export function parseFront(text: string): { readonly name: string; readonly pid: number | null } {
  const found = pairs(text);
  const name = found === null ? /^\s*"([^"]*)"/.exec(text)?.[1] : found.get("LSDisplayName");
  const pid = found === null ? /\bpid = (\d+)/.exec(text)?.[1] : found.get("pid");
  return {
    name: name ?? (text.includes("[ NULL ]") ? "(none)" : "?"),
    pid: typeof pid === "string" && /^\d+$/.test(pid) ? Number(pid) : null,
  };
}

/** The type in `lsappinfo info -only ApplicationType`'s answer, as `UIElement`, or null. */
export function parseType(text: string): string | null {
  const found = pairs(text);
  return found === null
    ? (/\btype="([^"]*)"/.exec(text)?.[1] ?? null)
    : (found.get("ApplicationType") ?? null);
}

/** The ASN in `lsappinfo find pid=<pid>`'s answer, as `ASN:0x0-0x4e04e`, or null. */
export function parseFind(text: string): string | null {
  return /ASN:0x[0-9a-f]+-0x[0-9a-f]+/i.exec(text)?.[0] ?? null;
}

async function lsappinfo(...args: string[]): Promise<string> {
  return (await execFileAsync("lsappinfo", args, { encoding: "utf8" })).stdout;
}

async function front(): Promise<{ readonly name: string; readonly pid: number | null }> {
  const asn = (await lsappinfo("front")).trim();
  if (asn === "" || asn.includes("NULL")) return { name: "(none)", pid: null };
  return parseFront(await lsappinfo("info", "-only", "name", "-only", "pid", asn));
}

/** `pid`'s ApplicationType, or null while LaunchServices knows no app by it. */
export async function applicationType(pid: number): Promise<string | null> {
  const asn = parseFind(await lsappinfo("find", `pid=${pid}`));
  return asn === null ? null : parseType(await lsappinfo("info", "-only", "ApplicationType", asn));
}

/** The app's main process, as the watch has seen it. */
export interface WatchedMain {
  readonly pid: number;
  readonly since: number;
  /** Seen as an accessory (UIElement) at least once. */
  accessory: boolean;
  /** Failed for its type already. */
  reported: boolean;
  /** Its type at the last sample, or null while LaunchServices has known no app by it. */
  last: string | null;
}

/**
 * What a stopped watch can't vouch for: a front app it never sampled, or a main it never saw as an
 * accessory, such as one that ran less than ACCESSORY_WITHIN_MS as a regular app.
 */
export function unproven(samples: number, mains: readonly WatchedMain[]): string[] {
  const failures = samples === 0 ? ["lsappinfo named no front app in any sample"] : [];
  for (const main of mains) {
    if (main.accessory || main.reported) continue;
    failures.push(
      `the app's main (pid ${main.pid}) was never seen as an accessory (UIElement)${main.last === null ? ": LaunchServices never knew it" : `, only as ${main.last}`}`,
    );
  }
  return failures;
}

/** Starts the watch; stop() ends it and reports. */
export function watchFocus({ ours, skip }: FocusOptions): FocusWatch {
  const failures: string[] = [];
  if (skip !== null) {
    return {
      main() {},
      failures,
      stop: async () => ({
        skipped: skip,
        samples: 0,
        seconds: 0,
        maxGapMs: 0,
        front: {},
        types: {},
        failures,
      }),
    };
  }
  const started = Date.now();
  const fronts: Record<string, number> = {};
  const types: Record<string, number> = {};
  const mains: WatchedMain[] = [];
  /** The pids seen in front; whether each is the app's is a lookup the sampling doesn't wait on. */
  const looked = new Set<number>();
  const lookups: Promise<void>[] = [];
  let samples = 0;
  let maxGapMs = 0;
  let stopping = false;
  const fail = (failure: string): void => {
    failures.push(failure);
    process.stderr.write(`focus watch: ${failure}\n`);
  };
  /** What was in front that shouldn't be, reported at its first sample. */
  const reported = new Set<string>();
  const inFront = (key: string, failure: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    fail(failure);
  };

  const sampling = (async () => {
    let last = Date.now();
    while (!stopping) {
      const at = Date.now();
      maxGapMs = Math.max(maxGapMs, at - last);
      last = at;
      try {
        const { name, pid } = await front();
        samples++;
        fronts[name] = (fronts[name] ?? 0) + 1;
        const seconds = ((at - started) / 1000).toFixed(2);
        const key = `${name}:${pid}`;
        if (APP_NAMES.test(name)) {
          inFront(key, `${name} (pid ${pid}) was in front at +${seconds} s`);
        } else if (PROMPT_NAMES.test(name)) {
          inFront(key, `a system prompt (${name}) was in front at +${seconds} s`);
        } else if (pid !== null && !looked.has(pid)) {
          looked.add(pid);
          const failure = `${name} (pid ${pid}), a process of the app's, was in front at +${seconds} s`;
          lookups.push(
            ours(pid).then(
              (app) => (app ? inFront(key, failure) : undefined),
              () => undefined,
            ),
          );
        }
      } catch {
        // lsappinfo between apps; the next sample looks again.
      }
      const wait = SAMPLE_MS - (Date.now() - at);
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    }
  })();

  const typing = (async () => {
    while (!stopping) {
      for (const main of mains) await sampleType(main);
      await new Promise((done) => setTimeout(done, TYPE_SAMPLE_MS));
    }
  })();

  async function sampleType(main: WatchedMain): Promise<void> {
    let type: string | null;
    try {
      type = await applicationType(main.pid);
    } catch {
      return;
    }
    if (type === null) return;
    main.last = type;
    types[type] = (types[type] ?? 0) + 1;
    if (type === "UIElement") {
      main.accessory = true;
      return;
    }
    const late = Date.now() - main.since > ACCESSORY_WITHIN_MS;
    if ((main.accessory || late) && !main.reported) {
      main.reported = true;
      fail(
        main.accessory
          ? `the app's main (pid ${main.pid}) became ${type} after it was an accessory`
          : `the app's main (pid ${main.pid}) is still ${type}, not an accessory (UIElement)`,
      );
    }
  }

  return {
    main(pid) {
      mains.push({ pid, since: Date.now(), accessory: false, reported: false, last: null });
    },
    failures,
    async stop() {
      stopping = true;
      await Promise.all([sampling, typing, ...lookups]);
      for (const failure of unproven(samples, mains)) fail(failure);
      return {
        skipped: null,
        samples,
        seconds: (Date.now() - started) / 1000,
        maxGapMs,
        front: fronts,
        types,
        failures,
      };
    },
  };
}
