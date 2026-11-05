// Same levels, record shape and line format as pipedog's logger, so runtime can route pipedog's
// records through these sinks and lines from both interleave cleanly.

export const LOG_LEVELS = {
  TRACE: 5,
  DEBUG: 10,
  INFO: 20,
  SUCCESS: 25,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

export interface LogRecord {
  level: LogLevel;
  message: string;
  time: Date;
  error?: unknown;
}

export type LogSink = (record: LogRecord) => void;

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

export function formatLogRecord(record: LogRecord): string {
  const line = `${record.time.toISOString()} | ${record.level.padEnd(8)} | ${record.message}`;
  return record.error === undefined ? line : `${line}\n${describe(record.error)}`;
}

export const consoleSink: LogSink = (record) => {
  const text = formatLogRecord(record);
  if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) console.error(text);
  else console.log(text);
};

/** Every level to stderr, as loguru's default sink writes. */
const stderrSink: LogSink = (record) => {
  console.error(formatLogRecord(record));
};

class Logger {
  #threshold: number = LOG_LEVELS.DEBUG;
  #sinks: LogSink[] = [consoleSink];

  setLevel(level: LogLevel): void {
    this.#threshold = LOG_LEVELS[level];
  }

  isEnabledFor(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.#threshold;
  }

  /** Replace every sink. */
  setSink(...sinks: LogSink[]): void {
    this.#sinks = sinks;
  }

  /** Add a sink; the returned function removes it. */
  addSink(sink: LogSink): () => void {
    this.#sinks.push(sink);
    return () => {
      this.#sinks = this.#sinks.filter((s) => s !== sink);
    };
  }

  log(level: LogLevel, message: string, error?: unknown): void {
    if (!this.isEnabledFor(level)) return;
    const record: LogRecord = { level, message, time: new Date() };
    if (error !== undefined) record.error = error;
    for (const sink of this.#sinks) sink(record);
  }

  trace(message: string): void {
    this.log("TRACE", message);
  }
  debug(message: string): void {
    this.log("DEBUG", message);
  }
  info(message: string): void {
    this.log("INFO", message);
  }
  success(message: string): void {
    this.log("SUCCESS", message);
  }
  warning(message: string): void {
    this.log("WARNING", message);
  }
  error(message: string, error?: unknown): void {
    this.log("ERROR", message, error);
  }
  /** loguru's `logger.exception`: an ERROR carrying the error's stack. */
  exception(message: string, error: unknown): void {
    this.log("ERROR", message, error);
  }
  critical(message: string, error?: unknown): void {
    this.log("CRITICAL", message, error);
  }
}

export type { Logger };
export const logger = new Logger();

export function setLogLevel(level: LogLevel): void {
  logger.setLevel(level);
}

/** Sends every log line to stderr, for a command whose stdout is its output. */
export function logToStderr(): void {
  logger.setSink(stderrSink);
}
