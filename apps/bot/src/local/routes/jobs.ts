// /api/local/jobs: the offline chain's commands as child processes, and the URL batches they read.
import { statSync } from "node:fs";
import { JobRefused, type JobSpec, parseJobRequest } from "../jobs/argv.ts";
import { endOf } from "../jobs/events.ts";
import { PlanCache } from "../jobs/plan.ts";
import { type Job, JobRunner, type JobRunnerOptions } from "../jobs/runner.ts";
import { JOB_ID, jobFiles } from "../jobs/store.ts";
import { localError, localJson, readJson } from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";
import { batchesRoutes } from "./batches.ts";

const JOB_BODY_LIMIT = 16 * 1024;
/** Past this, GET log answers with the log's end. */
const LOG_LIMIT_BYTES = 1024 * 1024;

/** The job a path's `:id` names, or the 400 or 404 to answer; ids are only ever looked up. */
function lookup(runner: JobRunner, id: string | undefined): Job | Response {
  if (id === undefined || !JOB_ID.test(id)) {
    return localError(400, "bad-request", "That is not a job id");
  }
  return runner.find(id) ?? localError(404, "unknown-job", "No job has that id");
}

/** A request run as a job, or JobRefused's answer when it can't be. */
function parsed(body: unknown): JobSpec | Response {
  try {
    return parseJobRequest(body);
  } catch (error) {
    if (error instanceof JobRefused) return error.response();
    throw error;
  }
}

interface Jobs {
  readonly runner: JobRunner;
  readonly plans: PlanCache;
}

export function jobsRoutes(app: LocalApp, options: JobRunnerOptions = {}): LocalRouteSpec[] {
  // Made by the first request that needs it: the runner starts by settling the jobs on disk,
  // which building the route table must leave alone.
  let made: Jobs | null = null;
  const jobs = (): Jobs => {
    if (made === null) {
      const runner = new JobRunner(options);
      made = { runner, plans: new PlanCache(runner) };
    }
    return made;
  };
  app.onStop(async () => {
    await made?.runner.stop();
  });

  const run = (spec: JobSpec, resumedFrom: string | null = null): Response => {
    const { runner, plans } = jobs();
    const job = runner.start(spec, resumedFrom);
    if (spec.command === "plan") plans.remember(job);
    return localJson(201, runner.snapshot(job));
  };

  return [
    {
      route: "POST /api/local/jobs",
      async handler(request) {
        const body = await readJson(request, JOB_BODY_LIMIT);
        if (!body.ok) return body.response;
        const spec = parsed(body.value);
        if (spec instanceof Response) return spec;
        if (spec.command === "plan" && spec.options.refresh !== true) {
          const { runner, plans } = jobs();
          const cached = plans.reusable(spec.persona);
          if (cached !== null) return localJson(200, runner.snapshot(cached));
        }
        return run(spec);
      },
    },
    {
      route: "GET /api/local/jobs",
      handler: () => localJson(200, jobs().runner.list()),
    },
    {
      route: "GET /api/local/jobs/:id",
      handler(_request, { params }) {
        const { runner } = jobs();
        const job = lookup(runner, params.id);
        return job instanceof Response ? job : localJson(200, runner.snapshot(job));
      },
    },
    {
      route: "GET /api/local/jobs/:id/events",
      handler(_request, { params, url }) {
        const { runner } = jobs();
        const job = lookup(runner, params.id);
        if (job instanceof Response) return job;
        const after = url.searchParams.get("after") ?? "0";
        let size = 0;
        try {
          size = statSync(jobFiles(job.record.id).events).size;
        } catch {
          // Never written: no events yet.
        }
        if (!/^\d{1,15}$/.test(after) || Number(after) > size) {
          return localError(400, "bad-request", "`after` is a byte offset within the events");
        }
        return new Response(runner.eventsStream(job, Number(after)), {
          headers: { "content-type": "application/x-ndjson", "x-content-type-options": "nosniff" },
        });
      },
    },
    {
      route: "GET /api/local/jobs/:id/log",
      handler(_request, { params }) {
        const job = lookup(jobs().runner, params.id);
        if (job instanceof Response) return job;
        return new Response(endOf(jobFiles(job.record.id).log, LOG_LIMIT_BYTES), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
    {
      route: "DELETE /api/local/jobs/:id",
      handler(_request, { params, url }) {
        const force = url.searchParams.get("force");
        if (force !== null && force !== "1") {
          return localError(400, "bad-request", "`force` is 1, or left out");
        }
        const { runner } = jobs();
        const job = lookup(runner, params.id);
        if (job instanceof Response) return job;
        const outcome = runner.cancel(job, force === "1");
        if (outcome === "ended") {
          return localError(409, "job-not-running", "The job has ended already");
        }
        if (outcome === "not-ours") {
          return localError(
            409,
            "conflict",
            "An earlier start of Eidolon ran this job, so this one can't stop it",
          );
        }
        return localJson(202, runner.snapshot(job));
      },
    },
    {
      route: "POST /api/local/jobs/:id/resume",
      handler(_request, { params }) {
        const job = lookup(jobs().runner, params.id);
        if (job instanceof Response) return job;
        const { record } = job;
        if (record.status === "running" || record.status === "succeeded") {
          return localError(
            409,
            "job-not-resumable",
            "Only an interrupted, failed or cancelled job resumes",
          );
        }
        if (record.resumedBy !== null) {
          return localError(409, "job-not-resumable", `Job ${record.resumedBy} resumed it already`);
        }
        const spec = parsed({
          command: record.command,
          persona: record.persona,
          options: record.options,
        });
        return spec instanceof Response ? spec : run(spec, record.id);
      },
    },
    // No plan is cached before the runner exists.
    ...batchesRoutes((persona) => made?.plans.forget(persona)),
  ];
}
