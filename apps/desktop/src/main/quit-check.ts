// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/src/quit-confirmation.ts@2e39e70496
//
// Before quitting stops our own backend: whether it runs a call, a task or a job, and the box that
// asks first when anything would be cut, or when it couldn't say.
import type { MessageBoxOptions } from "electron";
import type { JobSnapshot, Status } from "../../../bot/src/local/api.ts";
import type { Stopping, Strings } from "./strings.ts";

/** What quitting would stop, or `unknown` when the backend couldn't say. */
export type QuitCheck = Stopping | "unknown";

/** A GET to our own backend, Bearer included, at a root-relative `path`. */
export type BackendFetch = (
  path: string,
  init: { readonly signal: AbortSignal },
) => Promise<BackendResponse>;

export interface BackendResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

const STATUS = "/api/local/status";
const JOBS = "/api/local/jobs";

/** One deadline for both requests, their bodies included. */
const DEADLINE_MS = 2_000;

/** The box's buttons, in this order on Windows and right to left on macOS. */
const QUIT = 0;
const CANCEL = 1;

async function get(fetch: BackendFetch, path: string, signal: AbortSignal): Promise<unknown> {
  try {
    const response = await fetch(path, { signal });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return await response.json();
  } catch (error) {
    throw new Error(`GET ${path}`, { cause: error });
  }
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The answers' counts; throws when either isn't the shape GET status and GET jobs answer. */
function counted(status: unknown, jobs: unknown): Stopping {
  const { activeCalls, assistant } = (status ?? {}) as Partial<
    Pick<Status, "activeCalls" | "assistant">
  >;
  const calls = count(activeCalls);
  const tasks = count(assistant?.running);
  if (calls === null || tasks === null) {
    throw new Error(`GET ${STATUS}: no counts in activeCalls and assistant.running`);
  }
  if (!Array.isArray(jobs)) throw new Error(`GET ${JOBS}: no list`);
  const running = (jobs as readonly (Partial<Pick<JobSnapshot, "status">> | null)[]).filter(
    (job) => job?.status === "running",
  );
  return { calls, tasks, jobs: running.length };
}

/** `error`'s message and its causes', as one line. */
function explain(error: unknown): string {
  const messages: string[] = [];
  let at: unknown = error;
  while (at !== undefined) {
    messages.push(at instanceof Error ? at.message : String(at));
    at = at instanceof Error ? at.cause : undefined;
  }
  return messages.join(": ");
}

/**
 * Asks our own ready backend what quitting would stop: GET /api/local/status's `activeCalls` and
 * `assistant.running`, and the running jobs of GET /api/local/jobs, both under one deadline.
 * Rejects with the cause when a request fails, an answer has another shape, or the deadline
 * passes; the requests are cancelled either way.
 */
export async function checkQuit(fetch: BackendFetch): Promise<Stopping> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer in ${DEADLINE_MS / 1000} s`)),
      DEADLINE_MS,
    );
  });
  try {
    const [status, jobs] = await Promise.race([
      Promise.all([get(fetch, STATUS, controller.signal), get(fetch, JOBS, controller.signal)]),
      deadline,
    ]);
    return counted(status, jobs);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The "Quit Eidolon?" box for `check`, or null when quitting cuts nothing off. */
export function quitBox(
  check: QuitCheck,
  strings: Strings,
  platform: NodeJS.Platform = process.platform,
): MessageBoxOptions | null {
  if (check !== "unknown" && check.calls + check.tasks + check.jobs === 0) return null;
  // Windows' task dialog takes the app's icon, which the caller can add; macOS draws it on its own
  // warning icon.
  return {
    type: platform === "win32" ? "none" : "warning",
    title: "Eidolon",
    message: strings.text.quitTitle,
    detail: check === "unknown" ? strings.text.quitUnknown : strings.text.quitDetail(check),
    buttons: [strings.label.quit, strings.label.cancel],
    defaultId: QUIT,
    cancelId: CANCEL,
    noLink: true,
  };
}

export interface QuitConfirmationOptions {
  /**
   * Starts one check; null while no backend of ours is ready, and the quit goes ahead unasked. A
   * check that rejects asks as when the backend can't say, and its cause goes to `log`.
   */
  readonly check: () => Promise<Stopping> | null;
  readonly strings: () => Strings;
  /** A native box with no owner window, so a hidden window stays hidden. */
  readonly show: (options: MessageBoxOptions) => Promise<{ readonly response: number }>;
  /** Brings the open box forward when quitting is asked for again meanwhile. */
  readonly focus: () => void;
  /** main.log. */
  readonly log?: { warn(message: string): void };
  readonly platform?: NodeJS.Platform;
}

/**
 * One quit decision at a time: asking again while one is open joins it rather than stacking a
 * second box. A decision checks once, so work that starts or ends while the box is open doesn't
 * change it.
 */
export class QuitConfirmation {
  readonly #options: QuitConfirmationOptions;
  #pending: Promise<boolean> | null = null;

  constructor(options: QuitConfirmationOptions) {
    this.#options = options;
  }

  /** True to quit now; false when the owner cancelled. */
  confirm(): Promise<boolean> {
    if (this.#pending !== null) {
      this.#options.focus();
      return this.#pending;
    }
    const pending = this.#decide().finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }

  async #decide(): Promise<boolean> {
    const pending = this.#options.check();
    if (pending === null) return true;
    const check = await pending.catch((error: unknown): QuitCheck => {
      const log = this.#options.log ?? console;
      log.warn(`Eidolon: couldn't check what quitting stops: ${explain(error)}`);
      return "unknown";
    });
    const box = quitBox(check, this.#options.strings(), this.#options.platform);
    if (box === null) return true;
    const { response } = await this.#options.show(box);
    return response === QUIT;
  }
}
