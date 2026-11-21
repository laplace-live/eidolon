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

/** What quitting would stop, or `unknown` when the backend didn't say in time. */
export type QuitCheck = Stopping | "unknown";

/** A GET to our own backend, Bearer included, at a root-relative `path`. */
export type BackendFetch = (
  path: string,
  init: { readonly signal: AbortSignal },
) => Promise<BackendResponse>;

export interface BackendResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

/** One deadline for both requests, their bodies included. */
const DEADLINE_MS = 2_000;

/** The box's buttons, in this order on Windows and right to left on macOS. */
const QUIT = 0;
const CANCEL = 1;

async function body(fetch: BackendFetch, path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`${path} failed`);
  return response.json();
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The answers' counts, or null when either isn't the shape GET status and GET jobs answer. */
function counted(status: unknown, jobs: unknown): Stopping | null {
  const { activeCalls, assistant } = (status ?? {}) as Partial<
    Pick<Status, "activeCalls" | "assistant">
  >;
  const calls = count(activeCalls);
  const tasks = count(assistant?.running);
  if (calls === null || tasks === null || !Array.isArray(jobs)) return null;
  const running = (jobs as readonly (Partial<Pick<JobSnapshot, "status">> | null)[]).filter(
    (job) => job?.status === "running",
  );
  return { calls, tasks, jobs: running.length };
}

/**
 * Asks our own ready backend what quitting would stop: GET /api/local/status's `activeCalls` and
 * `assistant.running`, and the running jobs of GET /api/local/jobs, both under one deadline.
 * Anything else, a failure or no answer in time, is `unknown`, and the requests are cancelled.
 */
export async function checkQuit(fetch: BackendFetch): Promise<QuitCheck> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"unknown">((resolve) => {
    timer = setTimeout(() => resolve("unknown"), DEADLINE_MS);
  });
  const answer = Promise.all([
    body(fetch, "/api/local/status", controller.signal),
    body(fetch, "/api/local/jobs", controller.signal),
  ]).then(
    ([status, jobs]) => counted(status, jobs) ?? "unknown",
    () => "unknown" as const,
  );
  try {
    return await Promise.race([answer, deadline]);
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
  /** Starts one check; null while no backend of ours is ready, and the quit goes ahead unasked. */
  readonly check: () => Promise<QuitCheck> | null;
  readonly strings: () => Strings;
  /** A native box with no owner window, so a hidden window stays hidden. */
  readonly show: (options: MessageBoxOptions) => Promise<{ readonly response: number }>;
  /** Brings the open box forward when quitting is asked for again meanwhile. */
  readonly focus: () => void;
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
  #disposed = false;

  constructor(options: QuitConfirmationOptions) {
    this.#options = options;
  }

  /** True to quit now; false when the owner cancelled. */
  confirm(): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
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

  /**
   * The app is quitting by a way that doesn't ask, such as an update's install: a decision still
   * pending, and every later one, answers false without a box. A box already open is left to its
   * answer, which no longer quits.
   */
  dispose(): void {
    this.#disposed = true;
  }

  async #decide(): Promise<boolean> {
    const check = this.#options.check();
    if (check === null) return true;
    const box = quitBox(await check, this.#options.strings(), this.#options.platform);
    if (this.#disposed) return false;
    if (box === null) return true;
    const { response } = await this.#options.show(box);
    return !this.#disposed && response === QUIT;
  }
}
