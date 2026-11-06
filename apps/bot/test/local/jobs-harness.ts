// What the jobs tests share: a fake CLI behind the runner's argv builder (never the real CLI, whose
// load-env.ts reads the repository's .env), a persona's sources with a batch and a video, and a
// server over the jobs routes alone.
import "../../../../packages/config/test/isolated-guard.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFolder } from "@eidolon/config";
import type { RouteHandler } from "../../src/app.ts";
import type { JobSnapshot } from "../../src/local/api.ts";
import type { ArgvBuilder, JobRunnerOptions } from "../../src/local/jobs/runner.ts";
import { createLocalRouter, type LocalApp } from "../../src/local/router.ts";
import { jobsRoutes } from "../../src/local/routes/jobs.ts";

export const FAKE_CLI = join(import.meta.dir, "jobs-fake-cli.ts");

export interface FakeCli {
  /** What the next job's fake CLI does: a case of jobs-fake-cli.ts. */
  scenario: string;
  /** Each spawn's CLI command and arguments. */
  readonly calls: string[][];
  readonly argv: ArgvBuilder;
}

export function fakeCli(): FakeCli {
  const cli: FakeCli = {
    scenario: "ok",
    calls: [],
    argv: (command, args) => {
      cli.calls.push([command, ...args]);
      return [
        process.execPath,
        "--no-env-file",
        FAKE_CLI,
        cli.scenario,
        command,
        "--json",
        ...args,
      ];
    },
  };
  return cli;
}

/** Long before any batch a test writes, which is named for the time it's written. */
export const BATCH = "videos-2020-01-02-030405";
export const VIDEO = "BV1aaaaaaaaa_p1";

/** A batch and a downloaded video in `persona`'s sources; returns their paths. */
export function seedSources(persona = "milky-green"): { batch: string; audio: string } {
  const batches = join(sourceFolder(persona, "lists"), "batches");
  mkdirSync(batches, { recursive: true });
  const batch = join(batches, `${BATCH}.txt`);
  writeFileSync(
    batch,
    "# Captured: 2026-11-05T12:00:00+08:00\nhttps://www.bilibili.com/video/BV1aaaaaaaaa\n",
  );
  const vods = sourceFolder(persona, "vods");
  mkdirSync(vods, { recursive: true });
  const audio = join(vods, `${VIDEO}.m4a`);
  writeFileSync(audio, "not really audio");
  return { batch, audio };
}

/** Polls `check` until it holds, failing after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface JobsServer {
  readonly base: string;
  readonly cli: FakeCli;
  call(method: string, path: string, body?: unknown): Promise<Response>;
  /** GET jobs/:id once it is no longer running. */
  settled(id: string): Promise<JobSnapshot>;
  /** Runs the stop hooks, as the server's stop does, then closes it. */
  close(): Promise<void>;
}

/** The jobs routes behind the local router, every caller signed in. */
export function serveJobs(options: Omit<JobRunnerOptions, "argv"> = {}): JobsServer {
  const cli = fakeCli();
  const stops: (() => Promise<void>)[] = [];
  let port = 0;
  const app: LocalApp = {
    port: () => port,
    activeCalls: () => 0,
    restart: () => {},
    onStop: (hook) => {
      stops.push(hook);
    },
    memoryAdmin: () => null,
  };
  const router: RouteHandler = createLocalRouter(
    jobsRoutes(app, { argv: cli.argv, pollMs: 20, ...options }),
    () => "bearer",
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/api/local/*": router },
    fetch: () => new Response(null, { status: 404 }),
  });
  port = server.port as number;
  const base = `http://127.0.0.1:${port}`;
  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    });
  return {
    base,
    cli,
    call,
    async settled(id) {
      let snapshot: JobSnapshot | null = null;
      await until(async () => {
        snapshot = (await (await call("GET", `/api/local/jobs/${id}`)).json()) as JobSnapshot;
        return snapshot.status !== "running";
      });
      return snapshot as unknown as JobSnapshot;
    },
    async close() {
      for (const stop of stops) await stop();
      await server.stop(true);
    },
  };
}
