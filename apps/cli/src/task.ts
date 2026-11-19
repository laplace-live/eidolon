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
  isEnded,
  isTaskId,
  loadContextFiles,
  loadSkills,
  newTaskId,
  openTaskStore,
  PathRefused,
  readSnapshot,
  type TaskSnapshot,
  type TaskStatus,
  taskDate,
  taskLockKey,
  tasksDir,
  type WebAccess,
  writeSnapshot,
} from "@eidolon/assistant";
import {
  assistantSettings,
  dataHome,
  envOptional,
  errorText,
  expandUser,
  findDotenv,
  logger,
  pyRepr,
  pyStrip,
  shippedPath,
} from "@eidolon/config";
import { acquireLock, LockedError } from "@eidolon/config/lock";
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
  UsageMeter,
} from "@eidolon/engine";
import { ProviderConfigError, roleById, roleSearcher } from "@eidolon/providers";
import { ArgparseExit, type ParserSpec, parseArgs, parserError } from "./argparse.ts";
import { type CliIo, type CommandDeps, reportExit, resolveIo } from "./io.ts";

const PROG = "laplace-task";

const USAGE = `usage: laplace-task [-h] [--folder FOLDER] [--allow PATH] [--web {any,off}]
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
  --web {any,off}       Whether the task may fetch web pages, from any site,
                        and search the web once assistant.search.provider
                        is set (default: off; with --resume, the task's own)
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
assistant.spendPauseUsd, or after its first request on a model with no known
price, and in a terminal asks whether to go on.
`;

const PARSER: ParserSpec = {
  prog: PROG,
  usage: USAGE,
  help: HELP,
  actions: [
    { dest: "goal", flags: [], kind: "store", nargs: "?" },
    { dest: "folder", flags: ["--folder"], kind: "store" },
    { dest: "allow", flags: ["--allow"], kind: "append" },
    { dest: "web", flags: ["--web"], kind: "store", choices: ["any", "off"] },
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

/** `--web`: `any` offers web_fetch for every site, `off` leaves it out. */
export type WebChoice = "any" | "off";

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
      readonly web: WebChoice;
      readonly json: boolean;
    }
  | {
      readonly kind: "resume";
      readonly id: string;
      readonly model: ModelChoice | null;
      /** Null: `any` if the task had it, else `off`. */
      readonly web: WebChoice | null;
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
  const web = ns.web as WebChoice | null;
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
    if (!isTaskId(resume.toLowerCase())) {
      throw parserError(PARSER, `argument --resume: no task ${pyRepr(resume)}`);
    }
    return { kind: "resume", id: resume.toLowerCase(), model, web, json };
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
    web: web ?? "off",
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

/** `--web any`. web_fetch still refuses this computer and its network. */
const ANY_SITE: WebAccess = { allows: () => true };

/** The command line steers nothing: a task runs on its brief alone. */
const NO_LINES: TaskInbox = {
  hasSteering: () => false,
  takeSteering: () => [],
  takeFollowUps: () => [],
};

/** task.json, kept current: written again whenever what it says changes. */
class Snapshots {
  readonly #dir: string;
  readonly #meter: TaskMeter;
  #snapshot: TaskSnapshot;
  #text: string;
  readonly #read: Set<string>;
  readonly #written: Set<string>;

  constructor(dir: string, snapshot: TaskSnapshot, meter: TaskMeter) {
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
      ...(isEnded(status) ? { endedAt: Date.now() } : {}),
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

  /** From the next save on, the task has no spend pauses, so a --resume asks nothing. */
  withoutSpendPauses(): void {
    this.#snapshot = { ...this.#snapshot, spendPauseUsd: 0 };
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

/**
 * The task's request on `brief`. A folder no task may write, or a mind it can't have, is refused
 * before the folder is made.
 */
async function equip(
  id: string,
  brief: TaskBrief,
  grants: readonly FolderGrant[],
  choice: ModelChoice,
  meter: UsageMeter,
  web: WebChoice,
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
      // The one load-env.ts reads: from a worktree, its main checkout's.
      dotenv: findDotenv(import.meta.dir),
    });
    folder = await policy.resolve(brief.folder, "write");
  } catch (error) {
    if (error instanceof GrantRefused || error instanceof PathRefused) {
      throw parserError(PARSER, error.message);
    }
    // A link in it that leads nowhere on disk, say.
    throw parserError(PARSER, `${brief.folder} can't be the task's folder: ${errorText(error)}`);
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
  const search = web === "any" ? roleSearcher(meter.charge) : undefined;
  const skills = await loadSkills({ dataHome: dataHome(), folder: brief.folder });
  for (const { path, message, skipped } of skills.problems) {
    logger.warning(visible(`${skipped ? "Skipping " : ""}skill ${path}: ${message}`));
  }
  if (skills.unlisted > 0) {
    logger.warning(`${skills.unlisted} more skills aren't listed: the catalog is full`);
  }
  const tools = createTaskTools(policy, {
    ...(web === "any" ? { web: ANY_SITE } : {}),
    ...(search === undefined ? {} : { search }),
    skills: skills.skills,
  });
  const system = buildTaskPrompt({
    brief,
    tools,
    contextFiles: await loadContextFiles(brief.folder, home, policy),
    skills: skills.skills,
    date: taskDate(),
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
  const meter = new UsageMeter(model);
  const equipped = await equip(id, brief, grants, model, meter, args.web, deps);
  const dir = join(tasksDir(), id);
  const release = acquireLock(taskLockKey(id), PROG);
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
      web: { mode: args.web, hosts: [], denied: [] },
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
  // The app's manager runs it, answers its card, and reports its end to the chat.
  if (found.chat !== undefined) {
    throw parserError(
      PARSER,
      `argument --resume: task ${id} belongs to a chat in the local app, and goes on from its card there`,
    );
  }
  const release = acquireLock(taskLockKey(id), PROG);
  try {
    // A transcript gone or damaged since can't be resumed; its task stays as it was.
    const store = openTaskStore(dir);
    const entries = await store.entries().catch((error: unknown) => {
      throw parserError(PARSER, `argument --resume: task ${id} can't be read: ${errorText(error)}`);
    });
    if (entries[0]?.type !== "brief") {
      throw parserError(PARSER, `argument --resume: task ${id} has no brief in its transcript`);
    }
    const model = args.model ?? found.model;
    const meter = new UsageMeter({ ...model, spentUsd: found.spentUsd });
    const web = args.web ?? (found.web?.mode === "any" ? "any" : "off");
    const equipped = await equip(id, found.brief, found.grants, model, meter, web, deps);
    const chosen = args.web && { web: { mode: args.web, hosts: [], denied: [] } };
    const snapshots = new Snapshots(dir, { ...found, model, ...chosen }, meter);
    // A crash can come between a result's entry and task.json: the transcript has its files.
    for (const entry of entries) snapshots.note(entry);
    await snapshots.save("running");
    const limits = {
      contextTokens: assistantSettings().contextTokens,
      spendPauseUsd: found.spendPauseUsd,
    };
    const request: TaskRequest = { ...equipped, store, limits, signal };
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

/**
 * `text` with its control characters, but newlines and tabs, as \u escapes: a file name, the
 * worker's words or a provider's error could otherwise drive the terminal, as OSC 52 writes the
 * clipboard.
 */
function visible(text: string): string {
  return text.replace(
    /(?![\t\n])\p{Cc}/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** For a person: the worker's words as they stream, a line per tool, then how it ended. */
class HumanReport implements Report {
  readonly #write: (text: string) => void;
  readonly #task: Prepared;
  readonly #calls = new Map<string, MindToolCall>();
  #midLine = false;
  #spoke = false;

  constructor(write: (text: string) => void, task: Prepared) {
    this.#write = (text) => write(visible(text));
    this.#task = task;
  }

  start(): void {
    const { id, dir, model, resumed, brief } = this.#task;
    logger.info(
      visible(
        `${resumed ? "Resuming" : "Starting"} task ${id} in ${brief.folder} on ` +
          `${model.account}/${model.model}; its transcript is in ${dir}`,
      ),
    );
  }

  event(event: TaskEvent): void {
    if (event.type === "delta") {
      this.#write(event.text);
      this.#midLine = !event.text.endsWith("\n");
      this.#spoke = true;
      return;
    }
    // A failed attempt's words stay; its retry, and the warning on stderr, start a line of their own.
    if (event.type === "request" && event.error !== undefined && this.#midLine) {
      this.#write("\n");
      this.#midLine = false;
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
  const { snapshots } = task;
  let { request } = task;
  const report: Report = json ? new JsonReport(io.stdout, task) : new HumanReport(io.stdout, task);
  const onEvent = async (event: TaskEvent): Promise<void> => {
    report.event(event);
    if (event.type === "request" && event.error !== undefined) {
      const retry =
        event.retryInMs === undefined ? "" : `; retrying in ${event.retryInMs / 1000} s`;
      logger.warning(visible(`The task's request failed${retry}: ${event.error}`));
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
  while (outcome.status === "paused" && confirm !== null) {
    const uncounted = outcome.reason === "unpriced";
    if (outcome.reason !== "spend" && !uncounted) break;
    await snapshots.save("paused", outcome);
    const question = `${outcome.detail} Continue${uncounted ? " without spend pauses" : ""}? [y/N] `;
    if (!(await confirm(question, request.signal))) break;
    // Spend the meter can't count can't pause the task, so it goes on without the pauses.
    if (uncounted) {
      request = { ...request, limits: { ...request.limits, spendPauseUsd: 0 } };
      snapshots.withoutSpendPauses();
    }
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
