// Python 3.13 argparse's parsing rules for the flags these CLIs declare, so a command line parses,
// or fails with the same message and exit code, as it does under the Python CLI. Usage and help
// are Python's own text at 80 columns.
import {
  activePersona,
  cpLen,
  partition,
  personaIds,
  pyParseInt,
  pyPath,
  pyRepr,
  pyStr,
} from "@eidolon/config";
import { fromIsoformat, type IsoDate } from "@eidolon/retrieval";

/** An argparse `type=`: `parse` throws on a value the Python callable rejects. */
export interface ArgType<T> {
  /** The callable's `__name__`, as argparse's "invalid <name> value" message shows it. */
  readonly name: string;
  parse(text: string): T;
}

export type ActionKind =
  | "store"
  | "store_true"
  | "store_false"
  | "append"
  | "boolean_optional"
  | "help";

export interface ArgAction {
  readonly dest: string;
  /** Option strings; empty for a positional. */
  readonly flags: readonly string[];
  readonly kind: ActionKind;
  /** argparse `nargs`; omitted means exactly one value. */
  readonly nargs?: "?" | "+" | "*";
  readonly type?: ArgType<unknown>;
  readonly choices?: readonly string[] | null;
  readonly default?: unknown;
}

export interface ParserSpec {
  readonly prog: string;
  /** What `print_usage` writes, ending in a newline. */
  readonly usage: string;
  /** What `-h` writes. */
  readonly help: string;
  /** Every action but `-h/--help`, which argparse adds first. */
  readonly actions: readonly ArgAction[];
}

/** argparse exiting: `-h` (0, help on stdout) or a usage error (2, usage and message on stderr). */
export class ArgparseExit extends Error {
  override name = "ArgparseExit";
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  constructor(code: number, stdout: string, stderr: string) {
    super(`argparse exit ${code}`);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Raised by a `type` to have argparse print its message, not "invalid <type> value". */
export class ArgumentTypeError extends Error {
  override name = "ArgumentTypeError";
}

/** `parser.error(message)`. */
export function parserError(spec: ParserSpec, message: string): ArgparseExit {
  return new ArgparseExit(2, "", `${spec.usage}${spec.prog}: error: ${message}\n`);
}

/**
 * The persona a command runs for, given its parsed `--persona`. load-env.ts installed the settings
 * for `--persona` spelled out; an abbreviation (`--pers x`) reaches argparse alone, which would
 * leave another persona's settings in place, so it is a usage error. So is a persona with no
 * folder, in the data home or among the templates: a typo would otherwise start a new persona's
 * sources and index, with none of her settings.
 */
export function commandPersona(spec: ParserSpec, value: string | null | undefined): string {
  const active = activePersona().id;
  if (value && value !== active) {
    throw parserError(spec, `argument --persona: write --persona ${value} in full`);
  }
  const known = personaIds();
  if (!known.includes(active)) {
    throw parserError(
      spec,
      `argument --persona: unknown persona ${pyRepr(active)} (choose from ${known.join(", ")})`,
    );
  }
  return active;
}

/** The namespace, keyed by `dest`. */
export type Namespace = Record<string, unknown>;

/** `int(text)`: surrounding whitespace, a sign, digit underscores and any Unicode decimal digit. */
export const INT: ArgType<number> = {
  name: "int",
  parse(text: string): number {
    const value = pyParseInt(text);
    if (value === null) {
      throw new RangeError(`invalid literal for int() with base 10: ${pyRepr(text)}`);
    }
    return value;
  },
};

/** `type=Path`: never rejects, but the value prints normalized (`streams/` → `streams`). */
export const PATH: ArgType<string> = { name: "Path", parse: pyPath };

/** `date.fromisoformat`, as CPython's C parser reads it. */
export const FROMISOFORMAT: ArgType<IsoDate> = { name: "fromisoformat", parse: fromIsoformat };

const HELP_ACTION: ArgAction = { dest: "help", flags: ["-h", "--help"], kind: "help" };
// argparse treats these as values, not flags, when no option looks like a negative number.
const NEGATIVE_NUMBER = /^-\p{Nd}+\n?$|^-\p{Nd}*\.\p{Nd}+\n?$/u;

interface OptionTuple {
  readonly action: ArgAction | null;
  readonly optionString: string;
  readonly sep: string | null;
  readonly explicitArg: string | null;
}

function takesValues(action: ArgAction): boolean {
  return action.kind === "store" || action.kind === "append";
}

function nargsPattern(action: ArgAction): string {
  const optional = action.flags.length > 0;
  if (!takesValues(action)) return optional ? "()" : "(-*)";
  if (action.nargs === "?") return optional ? "(A?)" : "(-*A?-*)";
  if (action.nargs === "+") return optional ? "(A+)" : "(-*A[A-]*)";
  if (action.nargs === "*") return optional ? "(A*)" : "(-*[A-]*)";
  return optional ? "([A])" : "(-*A-*)";
}

function actionName(action: ArgAction | null): string | null {
  if (action === null) return null;
  return action.flags.length > 0 ? action.flags.join("/") : action.dest;
}

class ArgumentError extends Error {
  constructor(action: ArgAction | null, message: string) {
    const name = actionName(action);
    super(name === null ? message : `argument ${name}: ${message}`);
  }
}

/** A positional, unless `?`, or `*` given a default. */
function isRequired(action: ArgAction): boolean {
  if (action.flags.length > 0 || !takesValues(action) || action.nargs === "?") return false;
  return action.nargs !== "*" || action.default === undefined;
}

function defaultOf(action: ArgAction): unknown {
  if (action.default !== undefined) return action.default;
  if (action.kind === "store_true") return false;
  return action.kind === "store_false" ? true : null;
}

/**
 * `parser.parse_args(argv)`. Throws ArgparseExit for `-h` and for every usage error, with the
 * text argparse writes.
 */
export function parseArgs(spec: ParserSpec, argv: readonly string[]): Namespace {
  const actions = [HELP_ACTION, ...spec.actions];
  const optionActions = new Map<string, ArgAction>();
  for (const action of actions) for (const flag of action.flags) optionActions.set(flag, action);
  const namespace: Namespace = {};
  for (const action of spec.actions) namespace[action.dest] = defaultOf(action);
  try {
    const extras = parseKnownArgs(actions, optionActions, argv, namespace, spec);
    if (extras.length > 0)
      throw new ArgumentError(null, `unrecognized arguments: ${extras.join(" ")}`);
  } catch (error) {
    if (error instanceof ArgumentError) throw parserError(spec, error.message);
    throw error;
  }
  return namespace;
}

function optionTuples(optionActions: Map<string, ArgAction>, arg: string): OptionTuple[] {
  const result: OptionTuple[] = [];
  const points = [...arg];
  const [prefix, sep, explicit] = partition(arg, "=");
  const explicitSep = sep ? sep : null;
  const explicitArg = sep ? explicit : null;
  if (points[0] === "-" && points[1] === "-") {
    for (const [optionString, action] of optionActions) {
      if (optionString.startsWith(prefix)) {
        result.push({ action, optionString, sep: explicitSep, explicitArg });
      }
    }
  } else {
    const shortPrefix = points.slice(0, 2).join("");
    const shortExplicit = points.slice(2).join("");
    for (const [optionString, action] of optionActions) {
      if (optionString === shortPrefix) {
        result.push({ action, optionString, sep: "", explicitArg: shortExplicit });
      } else if (optionString.startsWith(prefix)) {
        result.push({ action, optionString, sep: explicitSep, explicitArg });
      }
    }
  }
  return result;
}

function parseOptional(optionActions: Map<string, ArgAction>, arg: string): OptionTuple[] | null {
  if (!arg.startsWith("-")) return null;
  const exact = optionActions.get(arg);
  if (exact) return [{ action: exact, optionString: arg, sep: null, explicitArg: null }];
  if (cpLen(arg) === 1) return null;
  const [optionString, sep, explicitArg] = partition(arg, "=");
  const withValue = sep ? optionActions.get(optionString) : undefined;
  if (withValue) return [{ action: withValue, optionString, sep, explicitArg }];
  const tuples = optionTuples(optionActions, arg);
  if (tuples.length > 0) return tuples;
  if (NEGATIVE_NUMBER.test(arg)) return null;
  if (arg.includes(" ")) return null;
  return [{ action: null, optionString: arg, sep: null, explicitArg: null }];
}

function parseKnownArgs(
  actions: readonly ArgAction[],
  optionActions: Map<string, ArgAction>,
  argStrings: readonly string[],
  namespace: Namespace,
  spec: ParserSpec,
): string[] {
  const optionIndices = new Map<number, OptionTuple[]>();
  let pattern = "";
  for (let i = 0; i < argStrings.length; i++) {
    const arg = argStrings[i] as string;
    if (arg === "--") {
      pattern += `-${"A".repeat(argStrings.length - i - 1)}`;
      break;
    }
    const tuples = parseOptional(optionActions, arg);
    if (tuples === null) {
      pattern += "A";
    } else {
      optionIndices.set(i, tuples);
      pattern += "O";
    }
  }

  const seen = new Set<ArgAction>();
  const extras: string[] = [];

  const getValue = (action: ArgAction, text: string): unknown => {
    if (!action.type) return text;
    try {
      return action.type.parse(text);
    } catch (error) {
      if (error instanceof ArgumentTypeError) throw new ArgumentError(action, error.message);
      throw new ArgumentError(action, `invalid ${action.type.name} value: ${pyRepr(text)}`);
    }
  };
  const checkValue = (action: ArgAction, value: unknown): void => {
    const { choices } = action;
    if (choices && !choices.includes(value as string)) {
      throw new ArgumentError(
        action,
        `invalid choice: ${pyRepr(pyStr(value))} (choose from ${choices.map(pyStr).join(", ")})`,
      );
    }
  };
  const getValues = (action: ArgAction, args: readonly string[]): unknown => {
    if (args.length === 0 && action.nargs === "?") {
      return action.default ?? null;
    }
    if (args.length === 0 && action.nargs === "*" && action.flags.length === 0) {
      if (action.default === undefined || action.default === null) return [];
      checkValue(action, action.default);
      return action.default;
    }
    if (args.length === 1 && takesValues(action) && (!action.nargs || action.nargs === "?")) {
      const value = getValue(action, args[0] as string);
      checkValue(action, value);
      return value;
    }
    const values = args.map((arg) => getValue(action, arg));
    for (const value of values) checkValue(action, value);
    return values;
  };
  const takeAction = (action: ArgAction, args: readonly string[], optionString?: string) => {
    seen.add(action);
    const value = getValues(action, args);
    switch (action.kind) {
      case "store":
        namespace[action.dest] = value;
        break;
      case "store_true":
        namespace[action.dest] = true;
        break;
      case "store_false":
        namespace[action.dest] = false;
        break;
      case "append": {
        const items = namespace[action.dest];
        namespace[action.dest] = [...(Array.isArray(items) ? items : []), value];
        break;
      }
      case "boolean_optional":
        if (optionString !== undefined && action.flags.includes(optionString)) {
          namespace[action.dest] = !optionString.startsWith("--no-");
        }
        break;
      case "help":
        throw new ArgparseExit(0, spec.help, "");
    }
  };

  const matchArgument = (action: ArgAction, patternSlice: string): number => {
    const match = new RegExp(`^${nargsPattern(action)}`).exec(patternSlice);
    if (!match) {
      const message =
        action.nargs === "+"
          ? "expected at least one argument"
          : action.nargs === "?"
            ? "expected at most one argument"
            : "expected one argument";
      throw new ArgumentError(action, message);
    }
    return (match[1] as string).length;
  };

  const consumeOptional = (startIndex: number): number => {
    const tuples = optionIndices.get(startIndex) as OptionTuple[];
    if (tuples.length > 1) {
      const options = tuples.map((t) => t.optionString).join(", ");
      throw new ArgumentError(
        null,
        `ambiguous option: ${argStrings[startIndex]} could match ${options}`,
      );
    }
    let { action, optionString, sep, explicitArg } = tuples[0] as OptionTuple;
    const actionTuples: [ArgAction, string[], string][] = [];
    let stop: number;
    for (;;) {
      if (action === null) {
        extras.push(argStrings[startIndex] as string);
        return startIndex + 1;
      }
      if (explicitArg !== null) {
        const argCount = matchArgument(action, "A");
        const flag = [...optionString];
        if (argCount === 0 && flag[1] !== "-" && explicitArg !== "") {
          const rest = [...explicitArg];
          if (sep || rest[0] === "-") {
            throw new ArgumentError(action, `ignored explicit argument ${pyRepr(explicitArg)}`);
          }
          actionTuples.push([action, [], optionString]);
          optionString = (flag[0] as string) + rest[0];
          const next = optionActions.get(optionString);
          if (next) {
            action = next;
            const remaining = rest.slice(1).join("");
            if (!remaining) {
              sep = null;
              explicitArg = null;
            } else if (remaining.startsWith("=")) {
              sep = "=";
              explicitArg = remaining.slice(1);
            } else {
              sep = "";
              explicitArg = remaining;
            }
          } else {
            extras.push((flag[0] as string) + explicitArg);
            stop = startIndex + 1;
            break;
          }
        } else if (argCount === 1) {
          stop = startIndex + 1;
          actionTuples.push([action, [explicitArg], optionString]);
          break;
        } else {
          throw new ArgumentError(action, `ignored explicit argument ${pyRepr(explicitArg)}`);
        }
      } else {
        const start = startIndex + 1;
        stop = start + matchArgument(action, pattern.slice(start));
        actionTuples.push([action, argStrings.slice(start, stop), optionString]);
        break;
      }
    }
    for (const [taken, args, flag] of actionTuples) takeAction(taken, args, flag);
    return stop;
  };

  let positionals = actions.filter((action) => action.flags.length === 0);
  const consumePositionals = (startIndex: number): number => {
    const counts = matchPositionals(positionals, pattern.slice(startIndex));
    let index = startIndex;
    counts.forEach((count, k) => {
      const args = argStrings.slice(index, index + count);
      if (pattern.slice(index, index + count).includes("-")) args.splice(args.indexOf("--"), 1);
      index += count;
      takeAction(positionals[k] as ArgAction, args);
    });
    positionals = positionals.slice(counts.length);
    return index;
  };

  let startIndex = 0;
  const maxOptionIndex = optionIndices.size > 0 ? Math.max(...optionIndices.keys()) : -1;
  while (startIndex <= maxOptionIndex) {
    let nextOptionIndex = startIndex;
    while (nextOptionIndex <= maxOptionIndex && !optionIndices.has(nextOptionIndex)) {
      nextOptionIndex++;
    }
    if (startIndex !== nextOptionIndex) {
      const positionalsEnd = consumePositionals(startIndex);
      if (positionalsEnd > startIndex) {
        startIndex = positionalsEnd;
        continue;
      }
      startIndex = positionalsEnd;
    }
    if (!optionIndices.has(startIndex)) {
      extras.push(...argStrings.slice(startIndex, nextOptionIndex));
      startIndex = nextOptionIndex;
    }
    startIndex = consumeOptional(startIndex);
  }
  extras.push(...argStrings.slice(consumePositionals(startIndex)));

  const missing = actions.filter((action) => !seen.has(action) && isRequired(action));
  if (missing.length > 0) {
    throw new ArgumentError(
      null,
      `the following arguments are required: ${missing.map(actionName).join(", ")}`,
    );
  }
  return extras;
}

/** `_match_arguments_partial`: as many positionals as the pattern can feed, greedily. */
function matchPositionals(positionals: readonly ArgAction[], patternSlice: string): number[] {
  for (let i = positionals.length; i > 0; i--) {
    const regex = new RegExp(`^${positionals.slice(0, i).map(nargsPattern).join("")}`);
    const match = regex.exec(patternSlice);
    if (!match) continue;
    const result = match.slice(1).map((group) => (group ?? "").length);
    const end = match[0].length;
    if (end < patternSlice.length && patternSlice[end] === "O") {
      while (result.length > 0 && !result.at(-1)) result.pop();
    }
    return result;
  }
  return [];
}
