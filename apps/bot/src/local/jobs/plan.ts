// Plans, cached per persona: a plan reads every list, audio file, transcript and index meta of
// hers, and the videos tab asks for one whenever it opens. What it reports changes only when a
// job that changes her sources ends, a batch is written, or a setting it reads changes.
import { envOverride, readSettingsLayers, SETTINGS } from "@eidolon/config";
import { PLAN_SETTINGS } from "../api.ts";
import { SOURCE_COMMANDS } from "./argv.ts";
import type { Job, JobRunner } from "./runner.ts";

/** PLAN_SETTINGS by the variables the CLI reads them as. */
export const PLAN_VARIABLES: readonly string[] = SETTINGS.filter((field) =>
  (PLAN_SETTINGS as readonly string[]).includes(field.path),
).map((field) => field.env);

/** What a plan of `persona` reads of the settings, as its CLI reads them: the environment first. */
export function planInputs(persona: string): string {
  const layers = readSettingsLayers(persona).values;
  return JSON.stringify(
    PLAN_VARIABLES.map((name) => envOverride(name) ?? layers.get(name)?.value ?? null),
  );
}

interface Cached {
  readonly id: string;
  /** planInputs when it started. */
  readonly inputs: string;
}

export class PlanCache {
  private readonly latest = new Map<string, Cached>();
  private readonly runner: JobRunner;

  constructor(runner: JobRunner) {
    this.runner = runner;
    runner.onEnd((job) => {
      if (SOURCE_COMMANDS.has(job.record.command)) this.forget(job.record.persona);
    });
  }

  /**
   * The persona's plan to answer with: one still running, or one that finished with its summary,
   * made with the settings she has now.
   */
  reusable(persona: string): Job | null {
    const cached = this.latest.get(persona);
    if (cached === undefined || cached.inputs !== planInputs(persona)) return null;
    const job = this.runner.find(cached.id);
    if (job === undefined) return null;
    const { status } = job.record;
    return status === "running" || status === "succeeded" ? job : null;
  }

  remember(job: Job): void {
    const { persona, id } = job.record;
    this.latest.set(persona, { id, inputs: planInputs(persona) });
  }

  forget(persona: string): void {
    this.latest.delete(persona);
  }
}
