// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/src/login-shell-environment.ts@2e39e70496
//
// What the owner's login shell exports. An app opened from Finder or the Dock inherits only
// launchd's environment, without the PATH and the variables a terminal has.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import type { Readable } from "node:stream";

const DELIMITER = "_EIDOLON_SHELL_ENV_DELIMITER_";
const MARKER = Buffer.from(`\0${DELIMITER}\0`);
const DUMP = `printf '\\0%s\\0' '${DELIMITER}'; command env -0 || exit; printf '\\0%s\\0' '${DELIMITER}'; exit`;
const FALLBACK_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];
const TIMEOUT_MS = 10_000;

/** Keeps oh-my-zsh's update prompt and tmux autostart plugins from blocking a read with no terminal. */
export const PROBE_ENVIRONMENT: Readonly<Record<string, string>> = {
  DISABLE_AUTO_UPDATE: "true",
  ZSH_TMUX_AUTOSTARTED: "true",
  ZSH_TMUX_AUTOSTART: "false",
};

/** A candidate shell that gave no environment. */
export interface LoginShellFailure {
  readonly shell: string;
  /**
   * `exit <code>`, the signal that ended it, a spawn error, `timeout`, `aborted`, or `unparsed`
   * for output without both delimiters.
   */
  readonly reason: string;
}

export interface LoginShellRead {
  /** What the first shell that answered exports, or null when none did. */
  readonly variables: Readonly<Record<string, string>> | null;
  /** The candidates that failed before it, or all of them. */
  readonly failures: readonly LoginShellFailure[];
}

export interface LoginShellOptions {
  /** The candidates in the order tried; `loginShellCandidates()` unless a test names its own. */
  readonly shells?: readonly string[];
  /** Each candidate's deadline. */
  readonly timeoutMs?: number;
  /** Aborting kills the running candidate's process group and skips the rest. */
  readonly signal?: AbortSignal;
}

/** The account's login shell (its record, not `$SHELL`), then zsh, bash and sh, each once. */
export function loginShellCandidates(): readonly string[] {
  let account: string | null = null;
  try {
    account = userInfo().shell;
  } catch {
    // No account record for this uid: the fixed shells only.
  }
  return [...new Set([...(account ? [account] : []), ...FALLBACK_SHELLS])];
}

/** The variables printed between the dump's two delimiters; undefined without both. */
export function parseLoginShellOutput(stdout: string): Record<string, string> | undefined {
  const parts = stdout.split("\0");
  const first = parts.indexOf(DELIMITER);
  const last = parts.lastIndexOf(DELIMITER);
  if (first === -1 || first === last) return undefined;
  const variables: Record<string, string> = {};
  for (const entry of parts.slice(first + 1, last)) {
    const separator = entry.indexOf("=");
    if (separator > 0) variables[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return variables;
}

function readShell(
  shell: string,
  base: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Record<string, string> | string> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      // -i and -l run the shell's login and interactive files, ~/.zprofile and ~/.zshrc or its own.
      // stdin is closed, so a prompt in one reads EOF instead of waiting.
      child = spawn(shell, ["-ilc", DUMP], {
        cwd: homedir(),
        env: { ...base, ...PROBE_ENVIRONMENT },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch (error) {
      resolve(String(error));
      return;
    }
    const chunks: Buffer[] = [];
    let tail = Buffer.alloc(0);
    let markers = 0;
    const output = (): Record<string, string> | string =>
      parseLoginShellOutput(Buffer.concat(chunks).toString("utf8")) ?? "unparsed";
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const window = Buffer.concat([tail, chunk]);
      for (
        let index = window.indexOf(MARKER);
        index !== -1;
        index = window.indexOf(MARKER, index + MARKER.length)
      ) {
        markers++;
      }
      tail = window.subarray(Math.max(0, window.length - MARKER.length + 1));
      // A background child an rc file started inherits stdout and can hold it open long after the
      // shell exits, so the read ends at the closing delimiter, not at `close`.
      if (markers >= 2) finish(output());
    };
    const killGroup = (): void => {
      // A spawn that fails asynchronously settles through `error` before a timer or an abort can
      // fire, so the pid is there.
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        // The group already exited.
      }
    };
    // A member that left the group can keep stdout open after the kill, so a stopped read
    // settles without waiting for `close`.
    const stop = (reason: "timeout" | "aborted"): void => {
      finish(reason);
      killGroup();
    };
    const onAbort = (): void => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    function finish(result: Record<string, string> | string): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Still drained, so an rc-started child that writes to stdout doesn't fail with EPIPE.
      child.stdout.off("data", onData);
      child.stdout.resume();
      resolve(result);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", onData);
    child.on("error", (error) => finish(error.message));
    child.on("close", (code, closeSignal) => {
      if (code !== 0) finish(closeSignal ?? `exit ${String(code)}`);
      else finish(output());
    });
  });
}

/**
 * Runs each candidate as a login shell, `-ilc`, until one prints its environment; never rejects.
 * Every failure is recorded, and when all fail, or the read is aborted, there are no variables.
 */
export async function readLoginShell(
  base: NodeJS.ProcessEnv,
  { shells = loginShellCandidates(), timeoutMs = TIMEOUT_MS, signal }: LoginShellOptions = {},
): Promise<LoginShellRead> {
  const failures: LoginShellFailure[] = [];
  for (const shell of shells) {
    const result = await readShell(shell, base, timeoutMs, signal);
    if (typeof result !== "string") return { variables: result, failures };
    failures.push({ shell, reason: result });
    if (result === "aborted") break;
  }
  return { variables: null, failures };
}
