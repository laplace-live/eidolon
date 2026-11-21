// The dev smoke's steps: each prints one line, PASS or FAIL with what decided it, made of the
// checks inside it, and its record (every check, how long it took, its screenshots) goes into the
// run's results.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { Check, Checks } from "../smoke/kit.ts";

export interface StepRecord {
  readonly name: string;
  readonly pass: boolean;
  readonly ms: number;
  readonly checks: readonly Check[];
  readonly screenshots: readonly string[];
  /** What it threw, which ended it early. */
  readonly error: string | null;
}

/** One step's checks and screenshots, as its body adds them. */
export class Step {
  readonly checks: Check[] = [];
  readonly screenshots: string[] = [];
  readonly #folder: string;

  constructor(folder: string) {
    this.#folder = folder;
  }

  check(name: string, pass: boolean, detail = ""): boolean {
    this.checks.push({ name, pass, detail });
    return pass;
  }

  /** `page` as `<name>.png` in the results' screenshots. */
  async shot(page: Page, name: string): Promise<string> {
    const file = join(this.#folder, `${name}.png`);
    await page.screenshot({ path: file, timeout: 15_000 });
    this.screenshots.push(file);
    return file;
  }
}

/** A step's line: every check's detail after a pass; after a failure, what failed and why. */
export function stepLine(checks: readonly Check[], error: string | null): string {
  const failed = checks.filter((check) => !check.pass);
  if (failed.length === 0 && error === null) {
    return checks.map((check) => check.detail || check.name).join("; ");
  }
  return [
    ...failed.map((check) => `${check.name}: ${check.detail}`),
    ...(error === null ? [] : [`it stopped: ${error}`]),
  ].join("; ");
}

/** An error's first line, and for Playwright's timeouts what its call log was waiting for. */
export function described(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error)).split("\n");
  const waiting = lines.find((line) => /^\s*- waiting for /.test(line));
  return waiting === undefined ? lines[0] : `${lines[0]} (${waiting.trim().replace(/^- /, "")})`;
}

export class Steps {
  readonly records: StepRecord[] = [];
  readonly #checks: Checks;
  readonly #screenshots: string;

  /** Screenshots go into `folder`/screenshots. */
  constructor(checks: Checks, folder: string) {
    this.#checks = checks;
    this.#screenshots = join(folder, "screenshots");
    mkdirSync(this.#screenshots, { recursive: true, mode: 0o700 });
  }

  /** Runs `body`, then adds the step's one check; a throw fails it with what it had checked. */
  async run(name: string, body: (step: Step) => Promise<void>): Promise<boolean> {
    const step = new Step(this.#screenshots);
    const started = Date.now();
    let error: string | null = null;
    try {
      await body(step);
    } catch (thrown) {
      error = described(thrown);
    }
    if (error === null && step.checks.length === 0) error = "it checked nothing";
    const pass = error === null && step.checks.every((check) => check.pass);
    this.records.push({
      name,
      pass,
      ms: Date.now() - started,
      checks: step.checks,
      screenshots: step.screenshots,
      error,
    });
    return this.#checks.add(name, pass, stepLine(step.checks, error));
  }
}

/** Writes `results` as `folder`/results.json. */
export function writeResults(folder: string, results: object): string {
  const file = join(folder, "results.json");
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  return file;
}
