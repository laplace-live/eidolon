// Starts the local web app's server, the bot plus the app, on loopback only, and prints the link
// that signs a browser in. server.ts runs it as the supervisor's child.
import { envOptional, type LogLevel, logger } from "@eidolon/config";
import type { SignallingServer } from "@eidolon/runtime";
import type { IceService } from "@eidolon/turn";
import { type BotDeps, type BotServer, startBotServer } from "../server.ts";
import { type LocalHost, parseLocalArgs, resolveLocalHost } from "./args.ts";
import { createLocalExtension } from "./extension.ts";
import { usePersonaMemoryScope } from "./identity.ts";
import { loadStaticSite, MissingDist, WEB_DIST } from "./static.ts";
import { type ListeningMessage, RESTART_EXIT_CODE } from "./supervisor.ts";
import { type LocalToken, loadLocalToken, probeNonce, TokenError } from "./token.ts";
import { ensureDataHome } from "./write.ts";

/** The packages, as main.ts hands them to startBotServer; the signalling server counts calls. */
export interface LocalModules extends Omit<BotDeps, "runtime" | "local"> {
  readonly runtime: Omit<BotDeps["runtime"], "createSignallingServer"> & {
    createSignallingServer(options: {
      ice: Pick<IceService, "serverPlan">;
    }): Pick<SignallingServer, "offer" | "patch" | "close" | "activeSessions">;
  };
}

export interface BootIo {
  /** The link line, written past the logger so no log sink ever holds a link code. */
  stdout(text: string): void;
  stderr(text: string): void;
  exit(code: number): void;
  openBrowser(url: string): void;
  /** Calls `handler` on SIGINT, SIGTERM and SIGHUP, and when the supervisor goes away. */
  onShutdown(handler: () => void): void;
  /** Tells the supervisor the port, which a restart keeps so an open tab reconnects. */
  notify(message: ListeningMessage): void;
  nowSeconds(): number;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    // No opener on this system: the printed link works on its own.
  }
}

const processIo: BootIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  exit: (code) => process.exit(code),
  openBrowser,
  onShutdown(handler) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, handler);
    // Killed outright, the supervisor can't forward a signal; its IPC channel just closes.
    if (process.send) process.on("disconnect", handler);
  },
  notify: (message) => void process.send?.(message),
  nowSeconds: () => Date.now() / 1000,
};

export interface BootOptions {
  readonly dist?: string;
  readonly io?: BootIo;
}

export interface LocalServer {
  readonly bot: BotServer;
  readonly url: string;
  /** What POST /api/local/restart calls: stop shortly, then exit 75. */
  restart(): void;
}

function logLevel(verbose: number): LogLevel {
  return verbose === 0 ? "INFO" : verbose === 1 ? "DEBUG" : "TRACE";
}

/** Ctrl-C under `bun run` arrives twice, once from the terminal and once from bun. */
const REPEAT_MS = 500;
/** Long enough for the restart request's own response to leave first. */
const RESTART_DELAY_MS = 200;

/**
 * Stops the server, then exits with `code`. A repeat within REPEAT_MS is the same keypress; a
 * later one exits at once, for a stop that hangs.
 */
export function shutdownOnce(
  bot: Pick<BotServer, "stop">,
  exit: (code: number) => void,
  now: () => number = () => performance.now(),
): (code: number) => void {
  let since: number | null = null;
  return (code) => {
    const at = now();
    if (since === null) {
      since = at;
      void bot
        .stop()
        .catch((error: unknown) => logger.error("Shutdown failed", error))
        .finally(() => exit(code));
    } else if (at - since >= REPEAT_MS) {
      exit(code);
    }
  };
}

function linkUrl(host: LocalHost, port: number, token: LocalToken, nowSeconds: number): string {
  return `http://${host.urlHost}:${port}/#${token.linkCode(nowSeconds)}`;
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "EADDRINUSE";
}

/** Whether `port` is this data home's Eidolon: it proves it holds the token without seeing ours. */
async function answersAsThisEidolon(port: number, token: LocalToken): Promise<boolean> {
  const nonce = probeNonce();
  const expected = token.probeProof(nonce);
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const response = await fetch(`http://${host}:${port}/api/local/session?probe=${nonce}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      const body = (await response.json()) as { proof?: unknown };
      if (response.ok && body.proof === expected) return true;
    } catch {
      // Not listening there, or not Eidolon.
    }
  }
  return false;
}

/**
 * Boots, prints the link and returns the server; null when it exited instead: a usage error (2),
 * no built app (2), an unusable token (1), or a port already serving this Eidolon (0, after
 * printing a fresh link to it).
 */
export async function bootLocal(
  argv: readonly string[],
  modules: LocalModules,
  options: BootOptions = {},
): Promise<LocalServer | null> {
  const io = options.io ?? processIo;
  const args = parseLocalArgs(argv);
  const host = await resolveLocalHost(args.host);
  let site: ReturnType<typeof loadStaticSite>;
  try {
    site = loadStaticSite(options.dist ?? WEB_DIST);
  } catch (error) {
    if (!(error instanceof MissingDist)) throw error;
    io.stderr(`eidolon: ${error.message}. Build it first: bun run build:web\n`);
    io.exit(2);
    return null;
  }
  ensureDataHome();
  let token: LocalToken;
  try {
    token = loadLocalToken();
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    io.stderr(`eidolon: ${error.message}\n`);
    io.exit(1);
    return null;
  }
  usePersonaMemoryScope();

  let signalling: Pick<SignallingServer, "activeSessions"> | null = null;
  let shutdown: ((code: number) => void) | null = null;
  const restart = (): void => {
    setTimeout(() => shutdown?.(RESTART_EXIT_CODE), RESTART_DELAY_MS);
  };
  const deps: BotDeps = {
    ...modules,
    // The local app answers only its own pages, so the bot's CORS has nothing to add.
    access: {
      ...modules.access,
      corsPreflightResponse: () => null,
      withCors: (_request, response) => response,
    },
    runtime: {
      ...modules.runtime,
      configureLogging: () => modules.runtime.configureLogging({ level: logLevel(args.verbose) }),
      createSignallingServer(options) {
        const created = modules.runtime.createSignallingServer(options);
        signalling = created;
        return created;
      },
    },
    local: createLocalExtension({
      token,
      site,
      boundLiterals: host.literals,
      memoryAdmin: () => modules.memory.memoryAdmin(),
      activeCalls: () => signalling?.activeSessions ?? 0,
      restart,
      nowSeconds: () => io.nowSeconds(),
    }),
  };

  let bot: BotServer;
  try {
    bot = await startBotServer({ host: host.bind, port: args.port, verbose: args.verbose }, deps);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    if (await answersAsThisEidolon(args.port, token)) {
      io.stdout(
        `Eidolon is already running: ${linkUrl(host, args.port, token, io.nowSeconds())}\n`,
      );
      io.exit(0);
    } else {
      io.stderr(`eidolon: port ${args.port} is taken by another program; choose one with --port\n`);
      io.exit(1);
    }
    return null;
  }
  shutdown = shutdownOnce(bot, (code) => io.exit(code));
  const port = bot.server.port as number;
  io.notify({ kind: "listening", port });
  const url = linkUrl(host, port, token, io.nowSeconds());
  io.stdout(`Eidolon is ready: ${url}\n`);
  if (args.open && !envOptional("SSH_CONNECTION")) io.openBrowser(url);
  const stop = shutdown;
  io.onShutdown(() => stop(0));
  return { bot, url, restart };
}
