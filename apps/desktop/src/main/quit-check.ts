// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/src/quit-confirmation.ts@2e39e70496
//
// Before a quit: whether our own backend runs a call, a task or a job, and the box that asks first
// when anything would be cut, the window's unsaved edits included, or when it couldn't say.
import type { MessageBoxOptions } from "electron";
import type { JobSnapshot, Status } from "../../../bot/src/local/api.ts";
import type { Stopping, Strings } from "./strings.ts";

/** What quitting would stop, or `unknown` when the backend couldn't say. */
export type QuitCheck = Stopping | "unknown";

/** What stops the backend: a quit, or the restart that installs an update. */
export type QuitPurpose = "quit" | "restart";

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

/** What `check` says would stop, in `text`; null when nothing would. */
function stopsText(
  check: QuitCheck | null,
  text: Strings["text"],
  restart: boolean,
): string | null {
  if (check === null) return null;
  if (check === "unknown") return restart ? text.restartUnknown : text.quitUnknown;
  if (check.calls + check.tasks + check.jobs === 0) return null;
  return restart ? text.restartDetail(check) : text.quitDetail(check);
}

/**
 * The "Quit LAPLACE Eidolon?" box, or "Restart LAPLACE Eidolon?" before an update's restart, for
 * what our own backend's `check` found (null with none of ours ready) and the window's `unsaved`
 * edits; null when it cuts nothing off.
 */
export function quitBox(
  check: QuitCheck | null,
  { label, text }: Strings,
  platform: NodeJS.Platform = process.platform,
  purpose: QuitPurpose = "quit",
  unsaved = false,
): MessageBoxOptions | null {
  const restart = purpose === "restart";
  const stops = stopsText(check, text, restart);
  const detail = unsaved ? text.unsavedLost(stops) : stops;
  if (detail === null) return null;
  // Windows' task dialog takes the app's icon, which the caller can add; macOS draws it on its own
  // warning icon.
  return {
    type: platform === "win32" ? "none" : "warning",
    title: "LAPLACE Eidolon",
    message: restart ? text.restartTitle : text.quitTitle,
    detail,
    buttons: [restart ? label.restart : label.quit, label.cancel],
    defaultId: QUIT,
    cancelId: CANCEL,
    noLink: true,
  };
}

export interface QuitConfirmationOptions {
  /**
   * Starts one check of what our own backend runs; null while none of ours is ready. A check that
   * rejects asks as when the backend can't say, and its cause goes to `log`.
   */
  readonly check: () => Promise<Stopping> | null;
  /**
   * Whether the window's page holds unsaved edits, read once the check answers: the quit drops
   * them whatever server the page talks to, so the box asks over them alone too.
   */
  readonly unsaved: () => boolean;
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

  /** True to go ahead now; false when the owner cancelled. One asked meanwhile joins the open box. */
  confirm(purpose: QuitPurpose = "quit"): Promise<boolean> {
    if (this.#pending !== null) {
      this.#options.focus();
      return this.#pending;
    }
    const pending = this.#decide(purpose).finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }

  async #decide(purpose: QuitPurpose): Promise<boolean> {
    const options = this.#options;
    const pending = options.check();
    const check =
      pending === null
        ? null
        : await pending.catch((error: unknown): QuitCheck => {
            const log = options.log ?? console;
            log.warn(`Eidolon: couldn't check what quitting stops: ${explain(error)}`);
            return "unknown";
          });
    const box = quitBox(check, options.strings(), options.platform, purpose, options.unsaved());
    if (box === null) return true;
    const { response } = await options.show(box);
    return response === QUIT;
  }
}
