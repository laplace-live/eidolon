import { consoleSink, type LogRecord, logger } from "@eidolon/config";

/** Routes the process logger into memory until `restore()`. */
export class LogCapture {
  readonly records: LogRecord[] = [];

  constructor() {
    logger.setSink((record) => {
      this.records.push(record);
    });
  }

  /** `LEVEL|message`, the layout the expected log lines use. */
  lines(): string[] {
    return this.records.map((r) => `${r.level}|${r.message}`);
  }

  /** The lines logged since the last take, then forgets them. */
  take(): string[] {
    const lines = this.lines();
    this.records.length = 0;
    return lines;
  }

  restore(): void {
    logger.setSink(consoleSink);
  }
}

/** A monotonic clock the test moves by hand. */
export class FakeClock {
  t: number;
  readonly now = (): number => this.t;

  constructor(t = 0) {
    this.t = t;
  }
}

/** Sets env vars for one test; `restore()` puts back what was there. */
export class EnvPatch {
  readonly #saved = new Map<string, string | undefined>();

  set(name: string, value: string | undefined): this {
    if (!this.#saved.has(name)) this.#saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return this;
  }

  restore(): void {
    for (const [name, value] of this.#saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    this.#saved.clear();
  }
}
