// laplace-discover: a persona's new videos on Bilibili and YouTube, her official streams first,
// printed as JSON, and with --save written into a new batch for the pipeline.
import { activePersona, personaTimeZone, pyRepr, sourceFolder } from "@eidolon/config";
import { discover } from "@eidolon/ingest";
import {
  ArgparseExit,
  type ArgType,
  ArgumentTypeError,
  commandPersona,
  INT,
  type Namespace,
  type ParserSpec,
  parseArgs,
} from "./argparse.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";
import { REPORTED } from "./prepare_batch.ts";

const USAGE = `usage: laplace-discover [-h] [--channel URL] [--clips] [--min-minutes N]
                        [--pages N] [--skip VIDEO] [--save]
                        [--persona PERSONA]
`;

const MAX_PAGES = 50;

const CHANNEL: ArgType<string> = {
  name: "channel",
  parse(text: string): string {
    if (discover.parseChannel(text) !== null) return text;
    throw new ArgumentTypeError(
      `not a Bilibili space or list, nor a YouTube channel: ${pyRepr(text)}`,
    );
  },
};

const VIDEO: ArgType<string> = {
  name: "video",
  parse(text: string): string {
    if (discover.videoKey(text) !== null) return text;
    throw new ArgumentTypeError(`not a Bilibili or YouTube video: ${pyRepr(text)}`);
  },
};

const MINUTES: ArgType<number> = {
  name: "int",
  parse(text: string): number {
    const value = INT.parse(text);
    if (value < 1) throw new ArgumentTypeError("must be at least 1");
    return value;
  },
};

const PAGES: ArgType<number> = {
  name: "int",
  parse(text: string): number {
    const value = INT.parse(text);
    if (value < 1 || value > MAX_PAGES) {
      throw new ArgumentTypeError(`must be from 1 to ${MAX_PAGES}`);
    }
    return value;
  },
};

export const DISCOVER_PARSER: ParserSpec = {
  prog: "laplace-discover",
  usage: USAGE,
  help: `${USAGE}
Find a persona's videos that no list of hers has yet: her official channels'
past streams, then others' full recordings of the days those miss, then clips.
Prints them as JSON, a video to a line; --save writes them into a new batch,
official first.

options:
  -h, --help         show this help message and exit
  --channel URL      An official channel of hers: a Bilibili space or one of
                     its lists, or a YouTube channel; repeat it for more
                     (default: those her batches' # Source: lines name)
  --clips            List and save clips too
  --min-minutes N    Shortest full stream, in minutes (default: 60)
  --pages N          Bilibili search pages, 20 videos each (default: 5)
  --skip VIDEO       A video to leave out, by its URL or BV ID; repeat it for
                     more
  --save             Write the new videos into a new batch
  --persona PERSONA  Persona whose sources to use (default: the active
                     persona)
`,
  actions: [
    { dest: "channel", flags: ["--channel"], kind: "append", type: CHANNEL },
    { dest: "clips", flags: ["--clips"], kind: "store_true" },
    {
      dest: "min_minutes",
      flags: ["--min-minutes"],
      kind: "store",
      type: MINUTES,
      default: discover.DEFAULT_MIN_MINUTES,
    },
    {
      dest: "pages",
      flags: ["--pages"],
      kind: "store",
      type: PAGES,
      default: discover.DEFAULT_PAGES,
    },
    { dest: "skip", flags: ["--skip"], kind: "append", type: VIDEO },
    { dest: "save", flags: ["--save"], kind: "store_true" },
    { dest: "persona", flags: ["--persona"], kind: "store" },
  ],
};

/**
 * `result` as indented JSON, but each channel, candidate and video on one line: a first fill lists
 * hundreds of videos, and a task's command shows 2,000 lines of its output at most.
 */
function printed(result: discover.DiscoverResult): string {
  const one = (value: unknown): string => JSON.stringify(value);
  const list = (items: readonly unknown[], indent: string): string =>
    items.length === 0
      ? "[]"
      : `[\n${items.map((item) => `${indent}  ${one(item)}`).join(",\n")}\n${indent}]`;
  const tier = ({ count, hours, videos }: discover.Tier): string =>
    `{\n    "count": ${count},\n    "hours": ${hours},\n    "videos": ${list(videos, "    ")}\n  }`;
  return [
    "{",
    `  "persona": ${one(result.persona)},`,
    `  "channels": ${list(result.channels, "  ")},`,
    `  "candidates": ${list(result.candidates, "  ")},`,
    `  "official": ${tier(result.official)},`,
    `  "recordings": ${tier(result.recordings)},`,
    `  "clips": ${tier(result.clips)},`,
    `  "known": ${result.known},`,
    `  "batch": ${one(result.batch)},`,
    `  "warnings": ${list(result.warnings, "  ")}`,
    "}",
  ].join("\n");
}

export interface DiscoverDeps extends CommandDeps {
  /** Tests' stand-ins for the clock, Bilibili and yt-dlp. */
  readonly options?: Pick<discover.DiscoverOptions, "now" | "bilibili" | "expand">;
}

/** The `laplace-discover` command; resolves to its exit code. */
export async function discoverMain(
  argv: readonly string[],
  deps: DiscoverDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  let ns: Namespace;
  let persona: string;
  try {
    ns = parseArgs(DISCOVER_PARSER, argv);
    persona = commandPersona(DISCOVER_PARSER, ns.persona as string | null);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const { identity } = activePersona();
  try {
    const result = await discover.discoverVideos({
      persona: { id: persona, name: identity.name, shortName: identity.shortName },
      listsDir: sourceFolder(persona, "lists"),
      streamsDir: sourceFolder(persona, "streams"),
      timeZone: personaTimeZone(),
      channels: (ns.channel as string[] | null) ?? [],
      clips: ns.clips as boolean,
      skip: (ns.skip as string[] | null) ?? [],
      minMinutes: ns.min_minutes as number,
      pages: ns.pages as number,
      save: ns.save as boolean,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...deps.options,
    });
    io.stdout(`${printed(result)}\n`);
    return 0;
  } catch (error) {
    // Stopped: runWithSignals exits with the signal's code.
    if (deps.signal?.aborted) return 1;
    if (error instanceof Error && REPORTED.has(error.name)) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
