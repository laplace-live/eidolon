// /api/local/jobs: the offline chain's commands as child processes, and the URL batches they read.
import { statSync } from "node:fs";
import { JobRefused, type JobSpec, parseJobRequest } from "../jobs/argv.ts";
import { PlanCache } from "../jobs/plan.ts";
import { type Job, JobRunner, type JobRunnerOptions } from "../jobs/runner.ts";
import { JOB_ID, jobFiles } from "../jobs/store.ts";
import { localError, localJson, readJson } from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";
import { batchesRoutes } from "./batches.ts";

const JOB_BODY_LIMIT = 16 * 1024;

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

export function jobsRoutes(app: LocalApp, options: JobRunnerOptions = {}): LocalRouteSpec[] {
  const runner = new JobRunner(options);
  const plans = new PlanCache(runner);
  app.onStop(() => runner.stop());

  const run = (spec: JobSpec, resumedFrom: string | null = null): Response => {
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
          const cached = plans.reusable(spec.persona);
          if (cached !== null) return localJson(200, runner.snapshot(cached));
        }
        return run(spec);
      },
    },
    {
      route: "GET /api/local/jobs",
      handler: () => localJson(200, runner.list()),
    },
    {
      route: "GET /api/local/jobs/:id",
      handler(_request, { params }) {
        const job = lookup(runner, params.id);
        return job instanceof Response ? job : localJson(200, runner.snapshot(job));
      },
    },
    {
      route: "GET /api/local/jobs/:id/events",
      handler(_request, { params, url }) {
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
      async handler(_request, { params }) {
        const job = lookup(runner, params.id);
        if (job instanceof Response) return job;
        const log = Bun.file(jobFiles(job.record.id).log);
        return new Response((await log.exists()) ? log : "", {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
    {
      route: "DELETE /api/local/jobs/:id",
      handler(_request, { params }) {
        const job = lookup(runner, params.id);
        if (job instanceof Response) return job;
        const outcome = runner.cancel(job);
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
        const job = lookup(runner, params.id);
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
    ...batchesRoutes(plans),
  ];
}
