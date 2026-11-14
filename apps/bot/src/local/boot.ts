// Starts the local web app's server, the bot plus the app, on loopback only, and prints the link
// that signs a browser in. server.ts runs it as the supervisor's child.
import { envOptional, errorText, type LogLevel, logger, pyRepr } from "@eidolon/config";
import { type BotDeps, type BotServer, startBotServer } from "../server.ts";
import { type LocalHost, parseLocalArgs, resolveLocalHost } from "./args.ts";
import { createLocalExtension } from "./extension.ts";
import { parseListedOrigins } from "./guard.ts";
import { usePersonaMemoryScope } from "./identity.ts";
import { recordServerPort, type ServerHolder, takeServerLock } from "./server-lock.ts";
import { loadStaticSite, MissingDist } from "./static.ts";
import { type ListeningMessage, RESTART_EXIT_CODE } from "./supervisor.ts";
import { type LocalToken, loadLocalToken, probeNonce, TokenError } from "./token.ts";
import { ensureDataHome } from "./write.ts";

/** The packages, as main.ts hands them to startBotServer. */
export type LocalModules = Omit<BotDeps, "local">;

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

/** The local token, or null after exiting 1 for one that can't be used. */
function tokenOrExit(io: BootIo): LocalToken | null {
  try {
    return loadLocalToken();
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    io.stderr(`eidolon: ${error.message}\n`);
    io.exit(1);
    return null;
  }
}

/** Prints a fresh link to this data home's Eidolon and exits 0, if `port` answers as it. */
async function linkToRunning(
  port: number,
  host: LocalHost,
  token: LocalToken,
  io: BootIo,
): Promise<boolean> {
  if (!(await answersAsThisEidolon(port, token))) return false;
  io.stdout(`Eidolon is already running: ${linkUrl(host, port, token, io.nowSeconds())}\n`);
  io.exit(0);
  return true;
}

/**
 * A second server on the data home exits 2 naming the first, unless it was asked for the first's
 * port, which gets that server's link as a taken port would.
 */
async function refuseSecond(
  holder: ServerHolder,
  port: number,
  host: LocalHost,
  io: BootIo,
): Promise<null> {
  if (holder.port !== null && holder.port === port) {
    const token = tokenOrExit(io);
    if (token === null || (await linkToRunning(port, host, token, io))) return null;
  }
  const named = [
    holder.pid === null ? null : `pid ${holder.pid}`,
    holder.port === null ? null : `port ${holder.port}`,
  ].filter((part) => part !== null);
  const which = named.length > 0 ? ` (${named.join(", ")})` : "";
  io.stderr(`eidolon: Eidolon is already running on this data home${which}; stop it first\n`);
  io.exit(2);
  return null;
}

/**
 * Boots, prints the link and returns the server; null when it exited instead: a usage error (2),
 * no built app (2), another server on the data home (2), an unusable token (1), or a port
 * already serving this Eidolon (0, after printing a fresh link to it).
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
    site = loadStaticSite(options.dist);
  } catch (error) {
    if (!(error instanceof MissingDist)) throw error;
    io.stderr(`eidolon: ${error.message}. Build it first: bun run build:web\n`);
    io.exit(2);
    return null;
  }
  ensureDataHome();
  // Before the token, which a first start makes: two first starts would each write their own.
  const lock = takeServerLock();
  if ("holder" in lock) return refuseSecond(lock.holder, args.port, host, io);
  let token: LocalToken | null = null;
  try {
    token = tokenOrExit(io);
  } finally {
    if (token === null) lock.release();
  }
  if (token === null) return null;
  usePersonaMemoryScope();
  const listed = parseListedOrigins(envOptional("EIDOLON_LOCAL_ALLOWED_ORIGINS"));
  for (const entry of listed.rejected) {
    logger.warning(
      `EIDOLON_LOCAL_ALLOWED_ORIGINS: ${pyRepr(entry)} is not an origin such as ` +
        "http://localhost:3000; ignoring it",
    );
  }
  if (listed.origins.size > 0) {
    logger.info(`[local] The bot's API also answers ${[...listed.origins].join(", ")}`);
  }

  let shutdown: ((code: number) => void) | null = null;
  const restart = (): void => {
    setTimeout(() => shutdown?.(RESTART_EXIT_CODE), RESTART_DELAY_MS);
  };
  const deps: BotDeps = {
    ...modules,
    // The bot's CORS allows every origin; the extension adds headers for a listed one only.
    access: {
      ...modules.access,
      corsPreflightResponse: () => null,
      withCors: (_request, response) => response,
    },
    runtime: {
      ...modules.runtime,
      configureLogging: () => modules.runtime.configureLogging({ level: logLevel(args.verbose) }),
    },
    local: createLocalExtension({
      token,
      site,
      boundLiterals: host.literals,
      memoryAdmin: () => modules.memory.memoryAdmin(),
      restart,
      nowSeconds: () => io.nowSeconds(),
      origins: listed.origins,
    }),
  };

  let started: BotServer;
  try {
    started = await startBotServer(
      { host: host.bind, port: args.port, verbose: args.verbose },
      deps,
    );
  } catch (error) {
    lock.release();
    if (!isAddressInUse(error)) throw error;
    if (!(await linkToRunning(args.port, host, token, io))) {
      io.stderr(`eidolon: port ${args.port} is taken by another program; choose one with --port\n`);
      io.exit(1);
    }
    return null;
  }
  const bot: BotServer = {
    server: started.server,
    async stop() {
      try {
        await started.stop();
      } finally {
        lock.release();
      }
    },
  };
  shutdown = shutdownOnce(bot, (code) => io.exit(code));
  const port = bot.server.port as number;
  try {
    recordServerPort(port);
  } catch (error) {
    logger.warning(`A second start won't be told this one's port: ${errorText(error)}`);
  }
  io.notify({ kind: "listening", port });
  const url = linkUrl(host, port, token, io.nowSeconds());
  io.stdout(`Eidolon is ready: ${url}\n`);
  if (args.open && !envOptional("SSH_CONNECTION")) io.openBrowser(url);
  const stop = shutdown;
  io.onShutdown(() => stop(0));
  return { bot, url, restart };
}
