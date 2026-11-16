// laplace-task: one assistant task in the foreground. A worker on the assistant role's model works
// in a folder with the task's tools until it can report; every step is kept in the task's
// transcript in the data home, which --resume goes on from.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  buildTaskPrompt,
  COMPACTION_INSTRUCTIONS,
  COMPACTION_SYSTEM,
  createTaskTools,
  type FolderGrant,
  FolderPolicy,
  GrantRefused,
  loadContextFiles,
  newTaskId,
  openTaskStore,
  PathRefused,
  readSnapshot,
  type TaskSnapshot,
  type TaskStatus,
  tasksDir,
  writeSnapshot,
} from "@eidolon/assistant";
import {
  assistantSettings,
  dataHome,
  envOptional,
  errorText,
  expandUser,
  logger,
  pyRepr,
  pyStrip,
  shippedPath,
} from "@eidolon/config";
import {
  createMind,
  type MindToolCall,
  runTask,
  type TaskBrief,
  type TaskEntry,
  type TaskEvent,
  type TaskInbox,
  type TaskMeter,
  type TaskOutcome,
  type TaskRequest,
} from "@eidolon/engine";
import { acquireLock, LockedError } from "@eidolon/ingest";
import { ProviderConfigError, roleById, type UsageRecord } from "@eidolon/providers";
import { ArgparseExit, type ParserSpec, parseArgs, parserError } from "./argparse.ts";
import { type CliIo, type CommandDeps, reportExit, resolveIo } from "./io.ts";

const PROG = "laplace-task";

const USAGE = `usage: laplace-task [-h] [--folder FOLDER] [--allow PATH]
                    [--model ACCOUNT/MODEL] [--deliverable TEXT]
                    [--check TEXT] [--resume ID] [--json]
                    [goal]
`;

const HELP = `${USAGE}
Run an assistant task in the foreground: a worker on the assistant's model
reads, writes and edits files in the task's folder until the goal is met, then
reports. Every step is kept in tasks/<id>/ in the data home, and --resume goes
on from there. Assistant Mode (assistant.enabled) governs the local app and
her abilities, not this command, which runs a task whenever it is asked to.

positional arguments:
  goal                  What the task should achieve

options:
  -h, --help            show this help message and exit
  --folder FOLDER       The task's folder, which it may read and write; made
                        if missing
  --allow PATH          Another folder the task may read and write; repeat
                        for more. assistant.folders are allowed too
  --model ACCOUNT/MODEL
                        The account and model to run on, as in
                        openrouter/anthropic/claude-sonnet-5.5 (default:
                        assistant.provider and assistant.model)
  --deliverable TEXT    What the task should leave in the folder (default:
                        whatever the goal asks for)
  --check TEXT          How the task should check its work (default: that
                        the result does what the goal asks)
  --resume ID           Go on with task ID from where it stopped; with
                        --model, on another model
  --json                Write the task's events to stdout as JSON lines

It exits 0 when the task succeeded, 1 when it failed, 3 when it paused, and
130 when Ctrl-C cancelled it; each but the first prints the command that
resumes it. A task pauses each time its spend crosses a multiple of
assistant.spendPauseUsd, and in a terminal asks whether to go on.
`;

const PARSER: ParserSpec = {
  prog: PROG,
  usage: USAGE,
  help: HELP,
  actions: [
    { dest: "goal", flags: [], kind: "store", nargs: "?" },
    { dest: "folder", flags: ["--folder"], kind: "store" },
    { dest: "allow", flags: ["--allow"], kind: "append" },
    { dest: "model", flags: ["--model"], kind: "store" },
    { dest: "deliverable", flags: ["--deliverable"], kind: "store" },
    { dest: "check", flags: ["--check"], kind: "store" },
    { dest: "resume", flags: ["--resume"], kind: "store" },
    { dest: "json", flags: ["--json"], kind: "store_true" },
  ],
};

const DEFAULT_DELIVERABLE = "Whatever the goal asks for";
const DEFAULT_CHECK = "The result does what the goal asks";

const NO_MODEL =
  "no model to run the task on: pass --model ACCOUNT/MODEL, or choose the assistant's account " +
  "and model under Assistant Mode in the app's Settings (assistant.provider and " +
  "assistant.model in settings.yaml, or ASSISTANT_PROVIDER and ASSISTANT_MODEL)";

/** newTaskId's UUIDv7, so --resume never names a folder outside the tasks folder. */
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXIT_CODES: Readonly<Record<TaskOutcome["status"], number>> = {
  succeeded: 0,
  failed: 1,
  paused: 3,
  cancelled: 130,
};

export interface ModelChoice {
  readonly account: string;
  readonly model: string;
}

export type TaskArgs =
  | {
      readonly kind: "new";
      readonly goal: string;
      /** Absolute. */
      readonly folder: string;
      /** Absolute. */
      readonly allow: readonly string[];
      readonly deliverable: string;
      readonly check: string;
      readonly model: ModelChoice | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "resume";
      readonly id: string;
      readonly model: ModelChoice | null;
      readonly json: boolean;
    };

/** `--model`, split at its first slash: OpenRouter's model ids have slashes of their own. */
function modelChoice(text: string): ModelChoice {
  const at = text.indexOf("/");
  const account = at === -1 ? "" : pyStrip(text.slice(0, at)).toLowerCase();
  const model = at === -1 ? "" : pyStrip(text.slice(at + 1));
  if (account === "" || model === "") {
    throw parserError(
      PARSER,
      `argument --model: expected ACCOUNT/MODEL, as in openrouter/anthropic/claude-sonnet-5.5, not ${pyRepr(text)}`,
    );
  }
  return { account, model };
}

/** Throws ArgparseExit for -h and usage errors. */
export function parseTaskArgs(argv: readonly string[]): TaskArgs {
  const ns = parseArgs(PARSER, argv);
  const model = ns.model === null ? null : modelChoice(ns.model as string);
  const json = ns.json as boolean;
  const resume = ns.resume as string | null;
  if (resume !== null) {
    const given = (
      [
        ["goal", ns.goal],
        ["--folder", ns.folder],
        ["--allow", ns.allow],
        ["--deliverable", ns.deliverable],
        ["--check", ns.check],
      ] as const
    ).find(([, value]) => value !== null);
    if (given !== undefined) {
      throw parserError(PARSER, `argument --resume: not allowed with argument ${given[0]}`);
    }
    if (!TASK_ID.test(resume)) {
      throw parserError(PARSER, `argument --resume: no task ${pyRepr(resume)}`);
    }
    return { kind: "resume", id: resume.toLowerCase(), model, json };
  }
  const goal = ns.goal as string | null;
  const folder = ns.folder as string | null;
  if (goal === null || folder === null) {
    const missing = [folder === null ? "--folder" : null, goal === null ? "goal" : null];
    throw parserError(
      PARSER,
      `the following arguments are required: ${missing.filter((name) => name !== null).join(", ")}`,
    );
  }
  if (pyStrip(goal) === "") throw parserError(PARSER, "argument goal: must not be empty");
  const text = (value: unknown): string | null =>
    typeof value === "string" && pyStrip(value) !== "" ? pyStrip(value) : null;
  return {
    kind: "new",
    goal: pyStrip(goal),
    folder: resolve(expandUser(folder)),
    allow: ((ns.allow as string[] | null) ?? []).map((path) => resolve(expandUser(path))),
    deliverable: text(ns.deliverable) ?? DEFAULT_DELIVERABLE,
    check: text(ns.check) ?? DEFAULT_CHECK,
    model,
    json,
  };
}

/** The assistant role's account and model as the settings name them; null while either is unset. */
function settingsModel(): ModelChoice | null {
  const { providerEnv, modelEnv } = roleById("assistant");
  const account = pyStrip(envOptional(providerEnv) ?? "").toLowerCase();
  const model = pyStrip(envOptional(modelEnv) ?? "");
  return account === "" || model === "" ? null : { account, model };
}

/** The command line steers nothing: a task runs on its brief alone. */
const NO_LINES: TaskInbox = {
  hasSteering: () => false,
  takeSteering: () => [],
  takeFollowUps: () => [],
};

/** The task's spend and its last request's input, from each usage record its mind reports. */
export class Spend implements TaskMeter {
  #spent: number;
  #input: number | null = null;
  #unpriced = false;

  constructor(spent: number) {
    this.#spent = spent;
  }

  readonly tap = (record: UsageRecord): void => {
    if (record.costUsd !== null) this.#spent += record.costUsd;
    else if (!this.#unpriced) {
      this.#unpriced = true;
      logger.warning(
        `No price is known for ${record.model} at ${record.provider}, so the task's spend pauses can't count it`,
      );
    }
    // The context's size: what the provider read from its cache counts as much as the rest.
    const { inputTokens, cachedTokens, cacheWriteTokens } = record.units;
    const counted = [inputTokens, cachedTokens, cacheWriteTokens].filter((n) => n !== undefined);
    this.#input = counted.length === 0 ? null : counted.reduce((sum, n) => sum + n, 0);
  };

  spentUsd(): number {
    return this.#spent;
  }

  lastInputTokens(): number | null {
    return this.#input;
  }
}

const ENDED: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);

/** task.json, kept current: written again whenever what it says changes. */
class Snapshots {
  readonly #dir: string;
  readonly #meter: Spend;
  #snapshot: TaskSnapshot;
  #text: string;
  readonly #read: Set<string>;
  readonly #written: Set<string>;

  constructor(dir: string, snapshot: TaskSnapshot, meter: Spend) {
    this.#dir = dir;
    this.#meter = meter;
    this.#snapshot = snapshot;
    this.#text = "";
    this.#read = new Set(snapshot.files.read);
    this.#written = new Set(snapshot.files.written);
  }

  get written(): readonly string[] {
    return [...this.#written];
  }

  /** Adds the files `entry` read and wrote. */
  note(entry: TaskEntry): void {
    if (entry.type !== "tool-result") return;
    for (const path of entry.files?.read ?? []) this.#read.add(path);
    for (const path of entry.files?.written ?? []) this.#written.add(path);
  }

  /** Writes the snapshot as the task stands, `outcome` its latest. */
  async save(status: TaskStatus, outcome?: TaskOutcome): Promise<void> {
    const { endedAt: _, outcome: __, ...base } = this.#snapshot;
    const next: TaskSnapshot = {
      ...base,
      status,
      spentUsd: this.#meter.spentUsd(),
      files: { read: [...this.#read], written: [...this.#written] },
      ...(ENDED.has(status) ? { endedAt: Date.now() } : {}),
      ...(outcome === undefined ? {} : { outcome }),
    };
    const text = JSON.stringify(next);
    if (text === this.#text) return;
    await writeSnapshot(this.#dir, next);
    this.#snapshot = next;
    this.#text = text;
  }

  /** Writes the snapshot again if the run changed what it says. */
  async update(): Promise<void> {
    await this.save(this.#snapshot.status, this.#snapshot.outcome);
  }
}

interface Prepared {
  readonly id: string;
  readonly dir: string;
  readonly brief: TaskBrief;
  readonly model: ModelChoice;
  readonly resumed: boolean;
  readonly request: TaskRequest;
  readonly snapshots: Snapshots;
  readonly release: () => void;
}

/** The owner's date, as their computer keeps it. */
function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}, ${weekday}`;
}

/**
 * The task's request on `brief`. A folder no task may write, or a mind it can't have, is refused
 * before the folder is made.
 */
async function equip(
  id: string,
  brief: TaskBrief,
  grants: readonly FolderGrant[],
  choice: ModelChoice,
  meter: Spend,
  deps: TaskDeps,
): Promise<Omit<TaskRequest, "store" | "limits" | "signal">> {
  const home = homedir();
  let policy: FolderPolicy;
  let folder: string;
  try {
    policy = new FolderPolicy({
      folder: brief.folder,
      grants,
      home,
      dataHome: dataHome(),
      // EIDOLON_APP_ROOT's package, or this checkout.
      appRoot: shippedPath(".", "."),
    });
    folder = await policy.resolve(brief.folder, "write");
  } catch (error) {
    if (error instanceof GrantRefused || error instanceof PathRefused) {
      throw parserError(PARSER, error.message);
    }
    throw error;
  }
  const mind = (deps.createMind ?? createMind)("assistant", {
    tap: meter.tap,
    account: choice.account,
    model: choice.model,
  });
  try {
    await mkdir(folder, { recursive: true });
  } catch (error) {
    throw parserError(PARSER, `${brief.folder} can't be the task's folder: ${errorText(error)}`);
  }
  const tools = createTaskTools(policy);
  const system = buildTaskPrompt({
    brief,
    tools,
    contextFiles: await loadContextFiles(brief.folder, home),
    date: today(),
    folder: brief.folder,
  });
  return {
    id,
    mind,
    system,
    tools,
    inbox: NO_LINES,
    meter,
    compaction: { system: COMPACTION_SYSTEM, instructions: COMPACTION_INSTRUCTIONS },
  };
}

async function newTask(
  args: Extract<TaskArgs, { kind: "new" }>,
  deps: TaskDeps,
  signal: AbortSignal,
): Promise<Prepared> {
  const model = args.model ?? settingsModel();
  if (model === null) throw parserError(PARSER, NO_MODEL);
  const settings = assistantSettings();
  const grants = [...new Set([...args.allow, ...settings.folders])].map(
    (path): FolderGrant => ({ path, access: "read-write" }),
  );
  const brief: TaskBrief = {
    goal: args.goal,
    deliverable: args.deliverable,
    folder: args.folder,
    check: args.check,
  };
  const id = newTaskId();
  const meter = new Spend(0);
  const equipped = await equip(id, brief, grants, model, meter, deps);
  const dir = join(tasksDir(), id);
  const release = acquireLock(`task:${id}`, PROG);
  try {
    const store = openTaskStore(dir);
    await store.append({ type: "brief", brief });
    const snapshot: TaskSnapshot = {
      v: 1,
      id,
      createdAt: Date.now(),
      status: "running",
      brief,
      model,
      grants,
      spendPauseUsd: settings.spendPauseUsd,
      spentUsd: 0,
      files: { read: [], written: [] },
    };
    const snapshots = new Snapshots(dir, snapshot, meter);
    await snapshots.save("running");
    const limits = { contextTokens: settings.contextTokens, spendPauseUsd: settings.spendPauseUsd };
    const request: TaskRequest = { ...equipped, store, limits, signal };
    return { id, dir, brief, model, resumed: false, request, snapshots, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function resumedTask(
  args: Extract<TaskArgs, { kind: "resume" }>,
  deps: TaskDeps,
  signal: AbortSignal,
): Promise<Prepared> {
  const { id } = args;
  const dir = join(tasksDir(), id);
  const found = await readSnapshot(dir);
  if (found === null) throw parserError(PARSER, `argument --resume: no task ${pyRepr(id)}`);
  const release = acquireLock(`task:${id}`, PROG);
  try {
    const model = args.model ?? found.model;
    const meter = new Spend(found.spentUsd);
    const equipped = await equip(id, found.brief, found.grants, model, meter, deps);
    const snapshots = new Snapshots(dir, { ...found, model }, meter);
    await snapshots.save("running");
    const limits = {
      contextTokens: assistantSettings().contextTokens,
      spendPauseUsd: found.spendPauseUsd,
    };
    const request: TaskRequest = { ...equipped, store: openTaskStore(dir), limits, signal };
    return { id, dir, brief: found.brief, model, resumed: true, request, snapshots, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Runs the task once, handing `onEvent` each event before taking the next. */
async function follow(
  request: TaskRequest,
  onEvent: (event: TaskEvent) => Promise<void>,
): Promise<TaskOutcome> {
  const run = runTask(request);
  let finished = false;
  try {
    for (;;) {
      const next = await run.next();
      if (next.done) {
        finished = true;
        return next.value;
      }
      await onEvent(next.value);
    }
  } finally {
    // Or the run would go on, and bill, behind a command that has given up on it.
    if (!finished) await run.return({ status: "cancelled" });
  }
}

/** What a run shows: how it starts, each event, and how it ended. */
interface Report {
  start(): void;
  event(event: TaskEvent): void;
  end(outcome: TaskOutcome): void;
}

/** The command that resumes task `id`, as this install runs it. */
function resumeCommand(id: string): string {
  return `${envOptional("EIDOLON_APP_ROOT") ? "eidolon task" : "bun run laplace-task"} --resume ${id}`;
}

function firstLine(text: string): string {
  const line = text.trimStart().split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** A tool's line: what it ran on, and why it failed if it did. */
function toolLine(
  call: MindToolCall | undefined,
  result: Extract<TaskEntry, { type: "tool-result" }>,
): string {
  const { pattern, path } = call?.arguments ?? {};
  const target = [pattern, path]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" in ");
  if (result.isError) {
    return `✗ ${result.name}${target === "" ? "" : ` ${target}`}: ${firstLine(result.content)}`;
  }
  return `· ${result.name} ${target === "" ? firstLine(result.content).replace(/:$/, "") : target}`;
}

/** For a person: the worker's words as they stream, a line per tool, then how it ended. */
class HumanReport implements Report {
  readonly #write: (text: string) => void;
  readonly #task: Prepared;
  readonly #calls = new Map<string, MindToolCall>();
  #midLine = false;
  #spoke = false;

  constructor(write: (text: string) => void, task: Prepared) {
    this.#write = write;
    this.#task = task;
  }

  start(): void {
    const { id, dir, model, resumed, brief } = this.#task;
    logger.info(
      `${resumed ? "Resuming" : "Starting"} task ${id} in ${brief.folder} on ` +
        `${model.account}/${model.model}; its transcript is in ${dir}`,
    );
  }

  event(event: TaskEvent): void {
    if (event.type === "delta") {
      this.#write(event.text);
      this.#midLine = !event.text.endsWith("\n");
      this.#spoke = true;
      return;
    }
    if (event.type !== "entry") return;
    const { entry } = event;
    if (entry.type === "assistant") {
      for (const call of entry.calls) this.#calls.set(call.id, call);
    } else if (entry.type === "tool-result") {
      this.#line(toolLine(this.#calls.get(entry.callId), entry));
    }
  }

  end(outcome: TaskOutcome): void {
    const { id, snapshots } = this.#task;
    // A resumed task whose last reply was already its report ends without a request.
    if (outcome.status === "succeeded" && !this.#spoke && outcome.report !== "") {
      this.#write(outcome.report);
      this.#midLine = !outcome.report.endsWith("\n");
    }
    if (this.#midLine) this.#write("\n");
    this.#midLine = false;
    const lines = [""];
    if (outcome.status === "succeeded") {
      const written = snapshots.written;
      lines.push(`Task ${id} succeeded${written.length === 0 ? "." : ". It wrote:"}`);
      lines.push(...written.map((path) => `  ${path}`));
    } else {
      if (outcome.status === "failed") lines.push(`Task ${id} failed: ${outcome.error}`);
      if (outcome.status === "cancelled") lines.push(`Task ${id} was cancelled.`);
      if (outcome.status === "paused") lines.push(`Task ${id} paused: ${outcome.detail}`);
      lines.push(`Resume it with: ${resumeCommand(id)}`);
    }
    this.#write(`${lines.join("\n")}\n`);
  }

  #line(text: string): void {
    if (this.#midLine) this.#write("\n");
    this.#midLine = false;
    this.#write(`${text}\n`);
  }
}

/** For whatever spawned the command: every event as a JSON line, between the task and its end. */
class JsonReport implements Report {
  readonly #write: (text: string) => void;
  readonly #task: Prepared;

  constructor(write: (text: string) => void, task: Prepared) {
    this.#write = write;
    this.#task = task;
  }

  start(): void {
    const { id, dir, brief, model, resumed } = this.#task;
    this.#line({ type: "task", id, dir, folder: brief.folder, model, resumed });
  }

  event(event: TaskEvent): void {
    this.#line(event);
  }

  end(outcome: TaskOutcome): void {
    const { id, request, snapshots } = this.#task;
    this.#line({
      type: "outcome",
      id,
      outcome,
      spentUsd: request.meter.spentUsd(),
      written: snapshots.written,
    });
  }

  #line(value: unknown): void {
    this.#write(`${JSON.stringify(value)}\n`);
  }
}

/** Asks on the terminal; anything but y or yes, the end of input or a signal is no. */
async function askOnTerminal(question: string, signal: AbortSignal): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });
  const ended = new Promise<string>((resolve) => terminal.once("close", () => resolve("")));
  try {
    const answer = await Promise.race([terminal.question(question, { signal }), ended]);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    terminal.close();
  }
}

export type Confirm = (question: string, signal: AbortSignal) => Promise<boolean>;

export interface TaskDeps extends CommandDeps {
  /** createMind, unless a test scripts the task's mind. */
  readonly createMind?: typeof createMind;
  /**
   * Whether a task its spend paused goes on. Default: the question on the terminal, when stdin
   * and stderr are one; null never asks, and the command exits 3. --json never asks.
   */
  readonly confirm?: Confirm | null;
}

/** Who answers a spend pause: never under --json, else the test's, else a person at a terminal. */
function confirmer(json: boolean, deps: TaskDeps): Confirm | null {
  if (json) return null;
  if (deps.confirm !== undefined) return deps.confirm;
  return process.stdin.isTTY && process.stderr.isTTY ? askOnTerminal : null;
}

async function runInForeground(
  task: Prepared,
  io: CliIo,
  json: boolean,
  confirm: Confirm | null,
): Promise<number> {
  const { request, snapshots } = task;
  const report: Report = json ? new JsonReport(io.stdout, task) : new HumanReport(io.stdout, task);
  const onEvent = async (event: TaskEvent): Promise<void> => {
    report.event(event);
    if (event.type === "request" && event.error !== undefined) {
      const retry =
        event.retryInMs === undefined ? "" : `; retrying in ${event.retryInMs / 1000} s`;
      logger.warning(`The task's request failed${retry}: ${event.error}`);
    }
    if (event.type !== "entry") return;
    if (event.entry.type === "compaction") {
      logger.info(`Compacted the task's context of about ${event.entry.tokensBefore} tokens`);
    }
    snapshots.note(event.entry);
    await snapshots.update();
  };
  report.start();
  let outcome = await follow(request, onEvent);
  while (outcome.status === "paused" && outcome.reason === "spend" && confirm !== null) {
    await snapshots.save("paused", outcome);
    if (!(await confirm(`${outcome.detail} Continue? [y/N] `, request.signal))) break;
    await snapshots.save("running");
    outcome = await follow(request, onEvent);
  }
  await snapshots.save(outcome.status, outcome);
  report.end(outcome);
  return EXIT_CODES[outcome.status];
}

/** The `laplace-task` command; resolves to its exit code. */
export async function taskMain(argv: readonly string[], deps: TaskDeps = {}): Promise<number> {
  const io = resolveIo(deps);
  const signal = deps.signal ?? new AbortController().signal;
  try {
    const args = parseTaskArgs(argv);
    const task =
      args.kind === "new"
        ? await newTask(args, deps, signal)
        : await resumedTask(args, deps, signal);
    try {
      return await runInForeground(task, io, args.json, confirmer(args.json, deps));
    } finally {
      task.release();
    }
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    if (error instanceof ProviderConfigError || error instanceof LockedError) {
      logger.error(error.message);
      return 1;
    }
    throw error;
  }
}
