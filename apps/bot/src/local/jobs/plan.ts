// Plans, cached per persona: a plan reads every list, audio file, transcript and index meta of
// hers, and the videos tab asks for one whenever it opens. What it reports changes only when a
// job that changes her sources ends or a batch is written.
import { SOURCE_COMMANDS } from "./argv.ts";
import type { Job, JobRunner } from "./runner.ts";

export class PlanCache {
  private readonly latest = new Map<string, string>();
  private readonly runner: JobRunner;

  constructor(runner: JobRunner) {
    this.runner = runner;
    runner.onEnd((job) => {
      if (SOURCE_COMMANDS.has(job.record.command)) this.forget(job.record.persona);
    });
  }

  /** The persona's plan to answer with: one still running, or one that finished with its summary. */
  reusable(persona: string): Job | null {
    const id = this.latest.get(persona);
    const job = id === undefined ? undefined : this.runner.find(id);
    if (job === undefined) return null;
    const { status } = job.record;
    return status === "running" || status === "succeeded" ? job : null;
  }

  remember(job: Job): void {
    this.latest.set(job.record.persona, job.record.id);
  }

  forget(persona: string): void {
    this.latest.delete(persona);
  }
}
