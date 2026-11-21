// Which page the window shows (§2.1, §2.3): the loading page until the backend is ready, then the
// app, and the failure page when the backend fails or the window's own page does. It also words
// the shell pages. Electron-free: backend.ts drives it with the controller's states and the window's
// failures, and window.ts loads what it asks for.
import type { Language } from "../shared/bridge.ts";
import type { BackendFailure, BackendState } from "./controller.ts";
import type { ShellFailure, ShellPageStrings } from "./shell-pages.ts";
import type { Strings } from "./strings.ts";

export type WindowPage = "loading" | "app" | "failed";

/** Why the failure page shows: the backend failed, or the window's page did. */
export type Failure =
  | { readonly kind: "backend"; readonly failure: BackendFailure }
  /** A load other than an abort, the preload, or the renderer gone, in a line for the details. */
  | { readonly kind: "window"; readonly detail: string };

export interface PagesIo {
  load(page: WindowPage): void;
  /** Loads again the app page the window shows, the waiting page served in place of it. */
  reloadApp(): void;
}

/** The backend's failure in one line, after its stderr: the page shows the tail's end first. */
function summary(failure: BackendFailure): string {
  switch (failure.reason) {
    case "exited":
      return failure.signal
        ? `The server stopped on ${failure.signal}.`
        : `The server exited with code ${failure.code ?? "unknown"}.`;
    case "no-listening":
      return "The server didn't start listening within 60 s.";
    case "token":
      return "The server listened, but left no local-token to reach it with.";
    case "unanswered":
      return "The server stopped answering for 60 s.";
    case "held":
      return "Another Eidolon holds this data home and didn't answer.";
    case "error":
      return `The server couldn't be started: ${failure.message ?? "unknown error"}`;
  }
}

/** The failure page's words for `failure`, in `strings`' language; its details stay as written. */
export function failurePage(failure: Failure, { text }: Strings): ShellFailure {
  if (failure.kind === "window") {
    return { title: text.windowFailed, message: text.failed, stderr: failure.detail };
  }
  const { failure: backend } = failure;
  const stderr = [...backend.stderr, summary(backend)].join("\n");
  if (backend.reason === "held") {
    const holder = backend.holder ?? { pid: null, port: null };
    return { title: text.held, message: text.heldDetail(holder), stderr };
  }
  return { title: text.serverStopped, message: text.failed, stderr };
}

/** The shell pages' own strings, in `language`. */
export function shellPageStrings(language: Language, { label, text }: Strings): ShellPageStrings {
  return {
    lang: language,
    starting: text.loading,
    waiting: text.waiting,
    tryAgain: label.tryAgain,
    showLogs: label.showLogs,
    quit: label.quit,
    details: label.details,
  };
}

/**
 * The window's page, as the backend's state and the window's own failures move it. Main's loads
 * alone change it: the shell pages navigate nowhere, and the app's page stays on the app.
 */
export class WindowPages {
  readonly #io: PagesIo;
  #page: WindowPage | null = null;
  #failure: Failure | null = null;
  /** The forwarder served the waiting page since the backend was last ready. */
  #waited = false;

  constructor(io: PagesIo) {
    this.#io = io;
  }

  /** What the failure page says, while it shows. */
  get failure(): Failure | null {
    return this.#failure;
  }

  get page(): WindowPage | null {
    return this.#page;
  }

  /**
   * A new window, the first or one made again after the page closed its own: the page `state` calls
   * for. A new window's renderer is new too, so only the backend's failure carries over.
   */
  opened(state: BackendState): void {
    this.#waited = false;
    if (state.phase === "failed") {
      this.#fail({ kind: "backend", failure: state.failure });
      return;
    }
    this.#failure = null;
    this.#show(state.phase === "ready" ? "app" : "loading");
  }

  /**
   * The backend moved on. Ready takes the loading page to the app, or reloads the app after the
   * waiting page stood in for it; a failure shows the failure page. A window failure waits for Try
   * Again whatever the backend does, and a restart or a grace period leaves the app as it is.
   */
  backend(state: BackendState): void {
    if (state.phase === "failed") {
      this.#fail({ kind: "backend", failure: state.failure });
      return;
    }
    if (state.phase !== "ready") return;
    const waited = this.#waited;
    this.#waited = false;
    if (this.#page === "loading") this.#show("app");
    else if (this.#page === "app" && waited) this.#io.reloadApp();
  }

  /**
   * The window's page failed: a load, the preload, or the renderer gone. Never from the failure
   * page itself, whose own failure would load it again and again.
   */
  window(detail: string): void {
    if (this.#page === "failed") return;
    this.#fail({ kind: "window", detail });
  }

  /** The forwarder answered a document with the waiting page. */
  waited(): void {
    this.#waited = true;
  }

  /**
   * Try Again. True when the backend should start again: it failed. A window failure goes back to
   * the app if the backend is ready, else to the loading page until it is.
   */
  retry(state: BackendState): boolean {
    if (this.#page !== "failed") return false;
    this.#failure = null;
    if (state.phase === "ready") {
      this.#show("app");
      return false;
    }
    this.#show("loading");
    return state.phase === "failed";
  }

  #fail(failure: Failure): void {
    this.#failure = failure;
    this.#show("failed");
  }

  #show(page: WindowPage): void {
    this.#page = page;
    this.#io.load(page);
  }
}
