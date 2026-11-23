// Notifications of her tasks while the window isn't focused: one waiting on the owner, and one that
// ended. They carry runtime facts, her name, her goal and fixed words alone, never what a worker
// wrote or a page it read could have, and they answer nothing: only the task's card does. A click
// opens the task. Electron-free: index.ts shows them through native.ts.
import type { PersonasResponse, TaskSnapshot, TaskStatus } from "../../../bot/src/local/api.ts";
import { type DesktopCommand, openTaskCommand } from "../shared/bridge.ts";
import type { NoticeHandle } from "./background.ts";
import { type BackendState, type ReadyState, sameServer } from "./controller.ts";
import type { BackendFetch } from "./quit-check.ts";
import type { Strings } from "./strings.ts";

export type NoticeKind =
  | "start"
  | "read"
  | "write"
  | "fetch"
  | "command"
  | "mcp"
  | "spend"
  | "stall"
  | "unpriced"
  | "interrupted"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Notice {
  readonly task: string;
  /** The task's chat, or null for a task without one. */
  readonly chat: string | null;
  /** The persona's display name, or null when unknown. */
  readonly persona: string | null;
  readonly kind: NoticeKind;
  /** Her goal for it on one line, clipped; may be empty. */
  readonly goal: string;
}

export interface TaskWatchOptions {
  /** A GET to the server ready now (Backend.get), Bearer included. */
  readonly fetch: BackendFetch;
  /** Whether the window is focused now. */
  readonly focused: () => boolean;
  /** Shows a notice; null when notifications can't show. */
  readonly show: (notice: Notice) => NoticeHandle | null;
  readonly log: { info(message: string): void; warn(message: string): void };
  /** Tests' clock. */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

/** The statuses that wait on the owner, and those that never run again, as apps/web has them. */
export const WAITING: ReadonlySet<TaskStatus> = new Set([
  "awaiting-approval",
  "paused",
  "interrupted",
]);
export const ENDED: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);

type Ended = Extract<TaskStatus, "succeeded" | "failed" | "cancelled">;

const TASKS = "/api/local/tasks";
const PERSONAS = "/api/local/personas";
const RUNNING_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GOAL_CHARS = 80;

/** What the watch reads of a task on the wire. */
type Watched = Pick<TaskSnapshot, "id" | "status"> &
  Partial<Pick<TaskSnapshot, "chat" | "brief" | "pending" | "pause">>;

/** A task as the last answer had it: whether it had ended, and its attention key. */
interface Seen {
  readonly ended: boolean;
  readonly key: string | null;
}

/** A task the watch hasn't seen yet counts as live, waiting on nothing. */
const UNSEEN: Seen = { ended: false, key: null };

interface Due {
  readonly task: Watched;
  readonly kind: NoticeKind;
}

function isEnded(status: TaskStatus): status is Ended {
  return ENDED.has(status);
}

/** What a task waits on the owner for, as one string; null while it waits on nothing. */
function attentionKey(task: Watched): string | null {
  if (!WAITING.has(task.status)) return null;
  return JSON.stringify([task.status, task.pending ?? null, task.pause ?? null]);
}

function waitKind({ status, pending, pause }: Watched): NoticeKind {
  if (pending !== undefined) {
    switch (pending.kind) {
      case "start":
      case "fetch":
      case "command":
      case "mcp":
        return pending.kind;
      case "path":
        return pending.access === "write" ? "write" : "read";
    }
  }
  const reason = pause?.reason;
  if (reason === "spend" || reason === "stall" || reason === "unpriced") return reason;
  return status === "interrupted" ? "interrupted" : "waiting";
}

/**
 * Her goal on one line, cut at GOAL_CHARS. It can quote what someone typed to her, and a control,
 * format or bidi character would break the notice's lines or reorder its text.
 */
function goalLine(goal: unknown): string {
  if (typeof goal !== "string") return "";
  const line = goal
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...line];
  return chars.length > GOAL_CHARS ? `${chars.slice(0, GOAL_CHARS).join("").trimEnd()}…` : line;
}

/** GET tasks' answer, each task's id and status checked; throws when it holds no list. */
function tasksOf(answer: unknown): Watched[] {
  const { tasks } = (answer ?? {}) as { tasks?: unknown };
  if (!Array.isArray(tasks)) throw new Error(`GET ${TASKS}: no task list`);
  return (tasks as (Partial<Watched> | null)[]).filter(
    (task): task is Watched => typeof task?.id === "string" && typeof task.status === "string",
  );
}

/** GET personas' answer as each persona's name by id; throws when it holds no list. */
function namesOf(answer: unknown): Map<string, string> {
  const { personas } = (answer ?? {}) as Partial<PersonasResponse>;
  if (!Array.isArray(personas)) throw new Error(`GET ${PERSONAS}: no persona list`);
  return new Map(
    personas.flatMap(({ id, name }) =>
      typeof id === "string" && typeof name === "string" ? [[id, name] as const] : [],
    ),
  );
}

async function read(fetch: BackendFetch, path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return await response.json();
}

/** Rejects with `signal`'s reason once it aborts, so a request that ignores it still ends. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** `error`'s message and its causes', as one line. */
function explain(error: unknown): string {
  const messages: string[] = [];
  for (let at = error; at !== undefined; at = at instanceof Error ? at.cause : undefined) {
    messages.push(at instanceof Error ? at.message : String(at));
  }
  return messages.join(": ");
}

/**
 * Asks the ready server for its tasks, every few seconds while one runs, and notifies what changed
 * since the answer before: a task that ended, or one that waits on the owner for something new.
 * The first answer after ready() is the baseline, which notifies nothing.
 */
export class TaskWatch {
  readonly #options: TaskWatchOptions;
  readonly #timers: NonNullable<TaskWatchOptions["timers"]>;
  /** The polls ready() started, which stop() ends; null while stopped. */
  #run: object | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #request: AbortController | null = null;
  /** Each task as the last answer had it; null until this run's baseline. */
  #seen: Map<string, Seen> | null = null;
  /** The personas' names by id, read once a run and again for an id they lack. */
  #names: ReadonlyMap<string, string> | null = null;
  /** Each task's last notice: Electron drops a notification nothing holds, and its click with it. */
  readonly #shown = new Map<string, NoticeHandle>();
  #failing = false;

  constructor(options: TaskWatchOptions) {
    this.#options = options;
    this.#timers = options.timers ?? globalThis;
  }

  /** A server is ready (owned or attached): a new baseline, then polls. */
  ready(): void {
    this.stop();
    const run = {};
    this.#run = run;
    this.#seen = null;
    this.#names = null;
    this.#failing = false;
    this.#schedule(run, 0);
  }

  /** No server is ready, or Eidolon quits: stops polling. */
  stop(): void {
    this.#run = null;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#request?.abort();
    this.#request = null;
  }

  #schedule(run: object, delay: number): void {
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      void this.#poll(run);
    }, delay);
  }

  async #poll(run: object): Promise<void> {
    let delay = IDLE_POLL_MS;
    try {
      const tasks = tasksOf(await this.#get(TASKS));
      if (this.#run !== run) return;
      if (this.#failing) {
        this.#failing = false;
        this.#options.log.info("Eidolon: notifications read the tasks again");
      }
      if (tasks.some((task) => task.status === "running")) delay = RUNNING_POLL_MS;
      await this.#take(run, tasks);
    } catch (error) {
      if (this.#run !== run) return;
      if (!this.#failing) {
        this.#failing = true;
        this.#options.log.warn(`Eidolon: notifications couldn't read the tasks: ${explain(error)}`);
      }
    }
    if (this.#run === run) this.#schedule(run, delay);
  }

  /** Records `tasks`, closes the notices they outdate, and shows the new ones while unfocused. */
  async #take(run: object, tasks: readonly Watched[]): Promise<void> {
    const before = this.#seen;
    const seen = new Map<string, Seen>();
    const due: Due[] = [];
    for (const task of tasks) {
      const now: Seen = { ended: isEnded(task.status), key: attentionKey(task) };
      seen.set(task.id, now);
      if (before === null) continue;
      const was = before.get(task.id) ?? UNSEEN;
      let kind: NoticeKind | null;
      if (isEnded(task.status) && !was.ended) kind = task.status;
      else if (now.key !== null && now.key !== was.key) kind = waitKind(task);
      else if (now.key === null && was.key !== null) kind = null;
      else continue;
      // Focused or not: a notice left open would name a wait that's over.
      this.#close(task.id);
      if (kind !== null) due.push({ task, kind });
    }
    this.#seen = seen;
    if (due.length === 0 || this.#options.focused()) return;
    const names = await this.#personaNames(run, due);
    if (this.#run !== run) return;
    for (const { task, kind } of due) {
      const persona = task.chat?.persona;
      const handle = this.#options.show({
        task: task.id,
        chat: task.chat?.id ?? null,
        persona: persona === undefined ? null : (names?.get(persona) ?? null),
        kind,
        goal: goalLine(task.brief?.goal),
      });
      if (handle !== null) this.#shown.set(task.id, handle);
    }
  }

  /** The names for `due`'s personas, read again when one is unknown; null when never read. */
  async #personaNames(
    run: object,
    due: readonly Due[],
  ): Promise<ReadonlyMap<string, string> | null> {
    const known = this.#names;
    const ids = due.flatMap(({ task }) => task.chat?.persona ?? []);
    if (ids.every((id) => known?.has(id) === true)) return known;
    let names: ReadonlyMap<string, string>;
    try {
      names = namesOf(await this.#get(PERSONAS));
    } catch (error) {
      if (this.#run === run) {
        this.#options.log.warn(
          `Eidolon: notifications couldn't read the personas' names: ${explain(error)}`,
        );
      }
      return known;
    }
    if (this.#run === run) this.#names = names;
    return names;
  }

  #close(task: string): void {
    this.#shown.get(task)?.close();
    this.#shown.delete(task);
  }

  /** GET `path`'s JSON under REQUEST_TIMEOUT_MS; stop() cancels it. */
  async #get(path: string): Promise<unknown> {
    const request = new AbortController();
    this.#request = request;
    const timer = this.#timers.setTimeout(
      () => request.abort(new Error(`no answer in ${REQUEST_TIMEOUT_MS / 1000} s`)),
      REQUEST_TIMEOUT_MS,
    );
    try {
      return await Promise.race([
        read(this.#options.fetch, path, request.signal),
        aborted(request.signal),
      ]);
    } finally {
      this.#timers.clearTimeout(timer);
      request.abort();
      if (this.#request === request) this.#request = null;
    }
  }
}

/**
 * The watch following the backend's states: a ready server it doesn't follow yet starts it on a new
 * baseline, and a state with no server stops it. Holding leaves it be: an attached server holds at
 * each close of the page's idle connection and is nearly always the same server after, and a new
 * baseline then would swallow whatever changed since the last poll.
 */
export function followBackend(
  watch: Pick<TaskWatch, "ready" | "stop">,
): (state: BackendState) => void {
  let followed: ReadyState | null = null;
  return (state) => {
    if (state.phase === "ready") {
      if (followed === null || !sameServer(followed, state)) watch.ready();
      followed = state;
    } else if (state.phase !== "holding") {
      followed = null;
      watch.stop();
    }
  };
}

/** The notice's title (the persona, else "Eidolon") and body (the phrase, then the goal on a second line when there is one). */
export function noticeText(notice: Notice, strings: Strings): { title: string; body: string } {
  const phrase = strings.notice[notice.kind];
  const goal = notice.goal.trim();
  return {
    title: notice.persona?.trim() || "Eidolon",
    body: goal === "" ? phrase : `${phrase}\n${goal}`,
  };
}

const STATUS = "/api/local/status";
const STATUS_TIMEOUT_MS = 2_000;

/**
 * What a notice's click asks of the page once the window shows: the task in its chat, or the Tasks
 * page for one without a chat. Null while the server counts a live call, since a page that leaves a
 * call hangs it up. Rejects when the status can't be read.
 */
export async function noticeCommand(
  notice: Notice,
  fetch: BackendFetch,
): Promise<DesktopCommand | null> {
  const response = await fetch(STATUS, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${STATUS} answered ${response.status}`);
  const { activeCalls } = ((await response.json()) ?? {}) as { activeCalls?: unknown };
  if (activeCalls !== 0) return null;
  return notice.chat === null ? "tasks" : openTaskCommand(notice.chat, notice.task);
}
