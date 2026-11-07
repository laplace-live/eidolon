// The jobs routes over HTTP, with a fake CLI: starting, listing, the plan cache, the events stream
// and its offsets, the log, cancelling, resuming, batches, and paths that try to leave the folder.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataHome, sourceFolder } from "@eidolon/config";
import type { BatchResponse, ErrorBody, JobSnapshot } from "../../src/local/api.ts";
import { PLAN_VARIABLES } from "../../src/local/jobs/plan.ts";
import { MAX_BATCH_URLS } from "../../src/local/routes/batches.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot, raw } from "./harness.ts";
import { BATCH, isAlive, type JobsServer, seedSources, serveJobs, until } from "./jobs-harness.ts";

let logs: CapturedLogs;
let server: JobsServer;
let batch: string;

beforeEach(() => {
  logs = captureLogs();
  ({ batch } = seedSources());
  server = serveJobs();
});

afterEach(async () => {
  await server.close();
  logs.restore();
  rmSync(dataHome(), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dataHome(), { recursive: true, force: true });
});

async function post(
  path: string,
  body: unknown,
): Promise<[number, JobSnapshot & Partial<ErrorBody>]> {
  const response = await server.call("POST", path, body);
  return [response.status, (await response.json()) as JobSnapshot & Partial<ErrorBody>];
}

async function job(body: unknown, scenario = "ok"): Promise<JobSnapshot> {
  server.cli.scenario = scenario;
  const [status, snapshot] = await post("/api/local/jobs", body);
  expect({ status, error: snapshot.error }).toEqual({ status: 201, error: undefined });
  return snapshot;
}

const REFINE = { command: "refine", persona: "milky-green" };
const PLAN = { command: "plan", persona: "milky-green" };

async function lines(response: Response): Promise<{ text: string; events: { item?: string }[] }> {
  const text = await response.text();
  return {
    text,
    events: text
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

describe("POST jobs", () => {
  test("runs the request as the CLI, which the server alone gives --persona", async () => {
    const started = await job({
      command: "pipeline",
      persona: "milky-green",
      options: { batch: BATCH },
    });
    expect(started).toMatchObject({
      command: "pipeline",
      persona: "milky-green",
      options: { batch: BATCH },
      status: "running",
      endedAt: null,
      ephemeral: false,
    });
    expect(server.cli.calls).toEqual([["pipeline", "--persona", "milky-green", "--", batch]]);
    expect(await server.settled(started.id)).toMatchObject({ status: "succeeded", exitCode: 0 });
  });

  test("refuses what the typed requests don't allow, echoing none of it", async () => {
    for (const [body, code] of [
      [{ ...REFINE, options: { args: ["--yt-dlp-args", "--exec touch x"] } }, "invalid-option"],
      [{ command: "refine", persona: "../x" }, "invalid-persona-id"],
      [{ command: "generate-image", persona: "milky-green" }, "unknown-command"],
      [
        { command: "expand", persona: "milky-green", options: { url: "--exec=touch x" } },
        "invalid-option",
      ],
      [
        { command: "expand", persona: "milky-green", options: { url: "file:///etc/passwd" } },
        "invalid-url",
      ],
      ['{"command": "refine", "persona": "--exec', "bad-json"],
    ] as const) {
      const [status, answer] = await post("/api/local/jobs", body);
      expect([body, status, answer.error?.code]).toEqual([body, 400, code]);
      for (const sent of ["--exec", "../x", "generate-image", "/etc/passwd"]) {
        expect(answer.error?.message.includes(sent)).toBe(false);
      }
    }
    expect(server.cli.calls).toEqual([]);
  });

  test("GET jobs lists every job newest first; GET jobs/:id answers one", async () => {
    const first = await job(REFINE);
    await server.settled(first.id);
    const second = await job({ command: "ingest-facts", persona: "milky-green" });
    await server.settled(second.id);
    const list = (await (await server.call("GET", "/api/local/jobs")).json()) as JobSnapshot[];
    expect(list.map((snapshot) => snapshot.id)).toEqual([second.id, first.id]);
    expect(list[0]).toMatchObject({
      status: "succeeded",
      stages: [{ stage: "ingest-facts", done: 2 }],
    });
    const one = await server.call("GET", `/api/local/jobs/${first.id}`);
    expect(one.headers.get("cache-control")).toBe("no-store");
    expect(await one.json()).toMatchObject({ id: first.id, command: "refine" });
  });
});

describe("the plan cache", () => {
  test("answers a finished plan again until a job that changes the sources ends", async () => {
    const plan = await job(PLAN, "plan");
    expect(plan.ephemeral).toBe(true);
    await server.settled(plan.id);
    const [again, cached] = await post("/api/local/jobs", PLAN);
    expect([again, cached.id]).toEqual([200, plan.id]);
    expect(server.cli.calls).toHaveLength(1);

    const refined = await job(REFINE);
    await server.settled(refined.id);
    const fresh = await job(PLAN, "plan");
    expect(fresh.id).not.toBe(plan.id);
    await server.settled(fresh.id);
    // A plan's own end, or an index of facts, changes no plan.
    const facts = await job({ command: "ingest-facts", persona: "milky-green" });
    await server.settled(facts.id);
    expect((await post("/api/local/jobs", PLAN))[1].id).toBe(fresh.id);
  });

  test("answers a running plan, and refresh plans anew", async () => {
    const running = await job(PLAN, "slow");
    const [status, cached] = await post("/api/local/jobs", PLAN);
    expect([status, cached.id, cached.status]).toEqual([200, running.id, "running"]);
    server.cli.scenario = "plan";
    const [refreshed, fresh] = await post("/api/local/jobs", {
      ...PLAN,
      options: { refresh: true },
    });
    expect(refreshed).toBe(201);
    expect(fresh.id).not.toBe(running.id);
    await server.call("DELETE", `/api/local/jobs/${running.id}`);
    await server.settled(running.id);
    await server.settled(fresh.id);
  });

  test("never answers a plan that failed, and keeps each persona's apart", async () => {
    mkdirSync(join(dataHome(), "personas", "alice"), { recursive: true });
    const crashed = await job(PLAN, "crash");
    await server.settled(crashed.id);
    const retried = await job(PLAN, "plan");
    expect(retried.id).not.toBe(crashed.id);
    await server.settled(retried.id);
    const alice = await job({ command: "plan", persona: "alice" }, "plan");
    expect(alice.id).not.toBe(retried.id);
    await server.settled(alice.id);
    expect((await post("/api/local/jobs", PLAN))[1].id).toBe(retried.id);
  });

  test("a setting the plan reads makes the next plan run again; another setting doesn't", async () => {
    expect(PLAN_VARIABLES.toSorted()).toEqual([
      "LANCEDB_PATH",
      "REFINE_MODEL",
      "SONIOX_ASYNC_MODEL",
    ]);
    const yaml = join(dataHome(), "personas", "milky-green", "persona.yaml");
    mkdirSync(join(yaml, ".."), { recursive: true });
    writeFileSync(yaml, "transcription:\n  language: ja\n");
    let latest = (await job(PLAN, "plan")).id;
    await server.settled(latest);
    writeFileSync(yaml, "transcription:\n  language: en\n");
    expect((await post("/api/local/jobs", PLAN))[1].id).toBe(latest);

    const changes: [string, () => void][] = [
      [
        "REFINE_MODEL",
        () => {
          process.env.REFINE_MODEL = "from/env";
        },
      ],
      ["refine.model", () => writeFileSync(yaml, "refine:\n  model: other/refiner\n")],
      [
        "transcription.model",
        () => writeFileSync(yaml, "refine:\n  model: other/refiner\ntranscription:\n  model: x\n"),
      ],
      ["knowledge.index", () => appendFileSync(yaml, "knowledge:\n  index: elsewhere\n")],
    ];
    try {
      for (const [setting, change] of changes) {
        change();
        const [status, fresh] = await post("/api/local/jobs", PLAN);
        expect([setting, status, fresh.id === latest]).toEqual([setting, 201, false]);
        await server.settled(fresh.id);
        expect((await post("/api/local/jobs", PLAN))[1].id).toBe(fresh.id);
        latest = fresh.id;
      }
      // Her refine.model decides now: the environment's no longer reaches her plan.
      process.env.REFINE_MODEL = "other/env";
      expect((await post("/api/local/jobs", PLAN))[1].id).toBe(latest);
    } finally {
      delete process.env.REFINE_MODEL;
    }
  });

  test("a new batch makes the next plan run again", async () => {
    const plan = await job(PLAN, "plan");
    await server.settled(plan.id);
    const [status] = await post("/api/local/personas/milky-green/batches", {
      urls: ["https://www.youtube.com/watch?v=aaaaaaaaaaa"],
    });
    expect(status).toBe(201);
    const fresh = await job(PLAN, "plan");
    expect(fresh.id).not.toBe(plan.id);
    await server.settled(fresh.id);
  });
});

describe("GET jobs/:id/events", () => {
  test("streams whole lines as they're written, until the job ends", async () => {
    const started = await job(REFINE, "steps");
    const response = await server.call("GET", `/api/local/jobs/${started.id}/events`);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const { text, events } = await lines(response);
    expect(events.map((event) => event.item ?? "summary")).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
      "s9",
      "s10",
      "summary",
    ]);
    const snapshot = await server.settled(started.id);
    expect(snapshot.eventsSize).toBe(Buffer.byteLength(text));
  });

  test("resumes from ?after= at the line that follows it", async () => {
    const started = await job(REFINE, "steps");
    const done = await server.settled(started.id);
    const whole = await (await server.call("GET", `/api/local/jobs/${started.id}/events`)).text();
    const all = whole.split("\n").slice(0, -1);
    const after = Buffer.byteLength(`${all.slice(0, 5).join("\n")}\n`);
    const rest = await lines(
      await server.call("GET", `/api/local/jobs/${started.id}/events?after=${after}`),
    );
    expect(rest.text).toBe(`${all.slice(5).join("\n")}\n`);
    const end = await server.call(
      "GET",
      `/api/local/jobs/${started.id}/events?after=${done.eventsSize}`,
    );
    expect(await end.text()).toBe("");
  });

  test("follows a running job past the point it was opened at, through its cancel", async () => {
    const started = await job(REFINE, "slow");
    const response = await server.call("GET", `/api/local/jobs/${started.id}/events`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(first)).toMatchObject({ type: "stage", status: "start" });
    await server.call("DELETE", `/api/local/jobs/${started.id}`);
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('"cancelled":true');
  });

  test("refuses an offset that isn't one, or lies past the end", async () => {
    const started = await job(REFINE);
    const { eventsSize } = await server.settled(started.id);
    for (const after of ["-1", "abc", "1e3", "0x10", "", String(eventsSize + 1)]) {
      const response = await server.call(
        "GET",
        `/api/local/jobs/${started.id}/events?after=${after}`,
      );
      expect([after, response.status]).toEqual([after, 400]);
    }
  });
});

test("GET jobs/:id/log is the job's stderr as plain text", async () => {
  const started = await job(REFINE, "crash");
  await server.settled(started.id);
  const response = await server.call("GET", `/api/local/jobs/${started.id}/log`);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const text = await response.text();
  expect(text.startsWith("fake CLI crash refine")).toBe(true);
  expect(text.endsWith("TypeError: boom\n")).toBe(true);
});

test("GET jobs/:id/log answers a long log's last MiB, from a whole line, saying so", async () => {
  const started = await job(REFINE);
  await server.settled(started.id);
  const lines = Array.from({ length: 30_000 }, (_, i) => `line ${i} ${"x".repeat(60)}\n`);
  const log = lines.join("");
  writeFileSync(join(dataHome(), "jobs", `${started.id}.log`), log);
  const text = await (await server.call("GET", `/api/local/jobs/${started.id}/log`)).text();
  const [note, ...rest] = text.split("\n");
  const kept = rest.join("\n");
  expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(1024 * 1024);
  expect(Buffer.byteLength(kept)).toBeGreaterThan(1024 * 1024 - 100);
  expect(log.endsWith(kept)).toBe(true);
  expect(kept.startsWith("line ")).toBe(true);
  expect(note).toBe(
    `[The first ${Buffer.byteLength(log) - Buffer.byteLength(kept)} bytes of this log are left out.]`,
  );
});

test("the route table is built without the data home; the first request loads the jobs", async () => {
  await server.close();
  rmSync(dataHome(), { recursive: true, force: true });
  server = serveJobs();
  expect(existsSync(dataHome())).toBe(false);
  await server.close();

  const plan = "20261105T120000-ABCDEF";
  mkdirSync(join(dataHome(), "jobs"), { recursive: true });
  const record = join(dataHome(), "jobs", `${plan}.json`);
  writeFileSync(
    record,
    JSON.stringify({
      id: plan,
      command: "plan",
      persona: "milky-green",
      options: {},
      status: "succeeded",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
      ephemeral: true,
      resumedFrom: null,
      resumedBy: null,
      pid: null,
    }),
  );
  server = serveJobs();
  expect(existsSync(record)).toBe(true);
  // A runner drops an earlier start's plans as it loads.
  expect(await (await server.call("GET", "/api/local/jobs")).json()).toEqual([]);
  expect(existsSync(record)).toBe(false);
});

describe("DELETE jobs/:id", () => {
  test("stops a running job: 202 while it stops, then cancelled", async () => {
    const started = await job(REFINE, "slow");
    // Once the fake CLI has started, so it answers SIGTERM the way the CLI does.
    await until(async () => {
      const snapshot = (await (
        await server.call("GET", `/api/local/jobs/${started.id}`)
      ).json()) as JobSnapshot;
      return snapshot.stages.length > 0;
    });
    expect(started.signalable).toBe(true);
    const response = await server.call("DELETE", `/api/local/jobs/${started.id}`);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "running",
      stopping: true,
      signalable: true,
    });
    expect(await server.settled(started.id)).toMatchObject({
      status: "cancelled",
      stopping: false,
      signalable: false,
    });
    const again = await server.call("DELETE", `/api/local/jobs/${started.id}`);
    expect([again.status, ((await again.json()) as ErrorBody).error.code]).toEqual([
      409,
      "job-not-running",
    ]);
  });

  test("?force=1 kills a job a first DELETE is stopping; anything else is 400", async () => {
    const started = await job(REFINE, "stubborn");
    await until(async () => {
      const snapshot = (await (
        await server.call("GET", `/api/local/jobs/${started.id}`)
      ).json()) as JobSnapshot;
      return snapshot.stages.length > 0;
    });
    const refused = await server.call("DELETE", `/api/local/jobs/${started.id}?force=true`);
    expect([refused.status, ((await refused.json()) as ErrorBody).error.code]).toEqual([
      400,
      "bad-request",
    ]);
    expect((await server.call("DELETE", `/api/local/jobs/${started.id}`)).status).toBe(202);
    await Bun.sleep(200);
    const ignored = (await (
      await server.call("GET", `/api/local/jobs/${started.id}`)
    ).json()) as JobSnapshot;
    expect(ignored).toMatchObject({ status: "running", stopping: true, signalable: true });
    expect((await server.call("DELETE", `/api/local/jobs/${started.id}?force=1`)).status).toBe(202);
    expect(await server.settled(started.id)).toMatchObject({
      status: "cancelled",
      exitCode: 137,
      summarySeen: false,
    });
  });

  test("an unknown id is 404, and anything that isn't an id is 400", async () => {
    const unknown = await server.call("DELETE", "/api/local/jobs/20261105T120000-ABCDEF");
    expect([unknown.status, ((await unknown.json()) as ErrorBody).error.code]).toEqual([
      404,
      "unknown-job",
    ]);
    const bad = await server.call("DELETE", "/api/local/jobs/latest");
    expect(bad.status).toBe(400);
  });

  test("an earlier server's job, left stopping, isn't signalable: a cancel, forced or not, is 409", async () => {
    await server.close();
    const stranger = Bun.spawn(["sleep", "30"]);
    try {
      const id = "20261105T120000-ABCDEF";
      mkdirSync(join(dataHome(), "jobs"), { recursive: true });
      writeFileSync(
        join(dataHome(), "jobs", `${id}.json`),
        JSON.stringify({
          id,
          command: "refine",
          persona: "milky-green",
          options: {},
          status: "running",
          // Since this boot: an earlier one's job would be gone, whatever its pid names now.
          startedAt: new Date().toISOString(),
          endedAt: null,
          exitCode: null,
          ephemeral: false,
          resumedFrom: null,
          resumedBy: null,
          // A stale record naming a live, unrelated process, which must survive.
          pid: stranger.pid,
          stopReason: "shutdown",
        }),
      );
      server = serveJobs();
      expect(await (await server.call("GET", `/api/local/jobs/${id}`)).json()).toMatchObject({
        status: "running",
        stopping: true,
        signalable: false,
      });
      for (const query of ["", "?force=1"]) {
        const response = await server.call("DELETE", `/api/local/jobs/${id}${query}`);
        expect([response.status, ((await response.json()) as ErrorBody).error.code]).toEqual([
          409,
          "conflict",
        ]);
      }
      await Bun.sleep(100);
      expect(isAlive(stranger.pid)).toBe(true);
      expect(stranger.exitCode).toBeNull();
    } finally {
      stranger.kill();
      await stranger.exited;
    }
  });
});

describe("POST jobs/:id/resume", () => {
  test("reruns a failed job's request once, linking the two", async () => {
    const options = { batch: BATCH, stages: ["transcribe", "refine"], transcribeConcurrency: 4 };
    const failed = await job({ command: "pipeline", persona: "milky-green", options }, "crash");
    await server.settled(failed.id);
    server.cli.scenario = "ok";
    const [status, resumed] = await post(`/api/local/jobs/${failed.id}/resume`, undefined);
    expect(status).toBe(201);
    expect(resumed).toMatchObject({ command: "pipeline", options, resumedFrom: failed.id });
    expect(server.cli.calls[1]).toEqual(server.cli.calls[0] as string[]);
    const old = (await (
      await server.call("GET", `/api/local/jobs/${failed.id}`)
    ).json()) as JobSnapshot;
    expect(old.resumedBy).toBe(resumed.id);
    const [twice, refused] = await post(`/api/local/jobs/${failed.id}/resume`, undefined);
    expect([twice, refused.error?.code]).toEqual([409, "job-not-resumable"]);
    expect((await server.settled(resumed.id)).status).toBe("succeeded");
    const [done, notAgain] = await post(`/api/local/jobs/${resumed.id}/resume`, undefined);
    expect([done, notAgain.error?.code]).toEqual([409, "job-not-resumable"]);
  });

  test("a running job doesn't resume", async () => {
    const running = await job(REFINE, "slow");
    const [status, answer] = await post(`/api/local/jobs/${running.id}/resume`, undefined);
    expect([status, answer.error?.code]).toEqual([409, "job-not-resumable"]);
    await server.call("DELETE", `/api/local/jobs/${running.id}`);
    await server.settled(running.id);
  });

  test("a job an earlier server left running comes back interrupted, and resumes", async () => {
    await server.close();
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    const id = "20261105T120000-ABCDEF";
    mkdirSync(join(dataHome(), "jobs"), { recursive: true });
    writeFileSync(
      join(dataHome(), "jobs", `${id}.json`),
      JSON.stringify({
        id,
        command: "download",
        persona: "milky-green",
        options: { batch: BATCH },
        status: "running",
        startedAt: "2026-11-05T12:00:00.000Z",
        endedAt: null,
        exitCode: null,
        ephemeral: false,
        resumedFrom: null,
        resumedBy: null,
        pid: gone.pid,
      }),
    );
    server = serveJobs();
    const before = (await (
      await server.call("GET", `/api/local/jobs/${id}`)
    ).json()) as JobSnapshot;
    expect(before.status).toBe("interrupted");
    const [status, resumed] = await post(`/api/local/jobs/${id}/resume`, undefined);
    expect([status, resumed.command, resumed.resumedFrom]).toEqual([201, "download", id]);
    expect(server.cli.calls).toEqual([["download", "--persona", "milky-green", "--", batch]]);
    await server.settled(resumed.id);
  });
});

describe("POST personas/:id/batches", () => {
  const batches = (persona = "milky-green") => join(sourceFolder(persona, "lists"), "batches");

  test("writes the URLs no list has yet as a new batch a pipeline can name", async () => {
    const [status, answer] = (await post("/api/local/personas/milky-green/batches", {
      urls: [
        "https://www.bilibili.com/video/BV1bbbbbbbbb/?spm_id_from=333",
        "https://www.bilibili.com/video/BV1aaaaaaaaa",
        "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        "https://www.bilibili.com/video/BV1bbbbbbbbb",
      ],
    })) as unknown as [number, BatchResponse];
    expect(status).toBe(201);
    expect(answer).toMatchObject({ count: 2, known: 1 });
    const text = readFileSync(join(batches(), `${answer.batch}.txt`), "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines.filter((line) => !line.startsWith("# "))).toEqual([
      "https://www.bilibili.com/video/BV1bbbbbbbbb",
      "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    ]);
    expect(lines.filter((line) => line.startsWith("# "))).toHaveLength(3);
    const run = await job({
      command: "pipeline",
      persona: "milky-green",
      options: { batch: answer.batch, stages: ["download"] },
    });
    expect(server.cli.calls.at(-1)?.at(-1)).toBe(join(batches(), `${answer.batch}.txt`));
    await server.settled(run.id);
  });

  test("answers no batch when every URL is listed already", async () => {
    const response = await server.call("POST", "/api/local/personas/milky-green/batches", {
      urls: ["https://www.bilibili.com/video/BV1aaaaaaaaa"],
    });
    expect([response.status, await response.json()]).toEqual([
      200,
      { batch: null, count: 0, known: 1 },
    ]);
  });

  test("refuses anything but http(s) video URLs, echoing none of them", async () => {
    for (const [urls, code] of [
      [["--exec=touch x"], "invalid-url"],
      [["https://www.youtube.com/watch?v=a b"], "invalid-url"],
      [["https://www.youtube.com/\u0000"], "invalid-url"],
      [["javascript:alert(1)"], "invalid-url"],
      [["https://space.bilibili.com/1/lists/2"], "invalid-url"],
      [[`https://www.youtube.com/watch?v=${"a".repeat(2048)}`], "invalid-url"],
      [[7], "invalid-url"],
      [[], "bad-request"],
      ["https://www.youtube.com/watch?v=aaaaaaaaaaa", "bad-request"],
      [
        Array.from({ length: MAX_BATCH_URLS + 1 }, (_, i) => `https://a.example/v/${i}`),
        "bad-request",
      ],
    ] as const) {
      const [status, answer] = await post("/api/local/personas/milky-green/batches", { urls });
      expect([String(urls).slice(0, 40), status, answer.error?.code]).toEqual([
        String(urls).slice(0, 40),
        400,
        code,
      ]);
      expect(answer.error?.message.includes("exec")).toBe(false);
    }
    const [extra] = await post("/api/local/personas/milky-green/batches", {
      urls: ["https://www.youtube.com/watch?v=aaaaaaaaaaa"],
      source: "x",
    });
    expect(extra).toBe(400);
  });

  test("names the persona in its path: unknown is 404, not a slug is 400", async () => {
    const [unknown, answer] = await post("/api/local/personas/nobody/batches", { urls: [] });
    expect([unknown, answer.error?.code]).toEqual([404, "unknown-persona"]);
    const [bad] = await post("/api/local/personas/Milky/batches", { urls: [] });
    expect(bad).toBe(400);
  });

  test("a hand-made list with a line that names no video is a conflict to fix first", async () => {
    writeFileSync(join(sourceFolder("milky-green", "lists"), "mine.txt"), "not a url\n");
    const [status, answer] = await post("/api/local/personas/milky-green/batches", {
      urls: ["https://www.youtube.com/watch?v=aaaaaaaaaaa"],
    });
    expect([status, answer.error?.code]).toEqual([409, "conflict"]);
    expect(answer.error?.message).toContain("mine.txt:1");
  });
});

describe("paths that try to leave the jobs folder", () => {
  test("every jobs route refuses an id that isn't one, before the disk", async () => {
    const sentinel = join(dataHome(), "sentinel.json");
    writeFileSync(sentinel, "keep");
    const before = statSync(sentinel).mtimeMs;
    const port = new URL(server.base).port;
    for (const id of [
      "..%2F..%2Fsentinel",
      "%2e%2e%2fsentinel",
      "..%5C..%5Csentinel",
      "%2Fetc%2Fpasswd",
      "%00",
    ]) {
      for (const [method, suffix] of [
        ["GET", ""],
        ["GET", "/events"],
        ["GET", "/log"],
        ["DELETE", ""],
        ["POST", "/resume"],
      ] as const) {
        const head = `${method} /api/local/jobs/${id}${suffix} HTTP/1.1\nHost: 127.0.0.1:${port}\nContent-Length: 0`;
        const response = await raw(Number(port), head);
        expect([id, method, suffix, response.status]).toEqual([id, method, suffix, 400]);
        expect(response.body).not.toContain("keep");
      }
    }
    const dots = await raw(
      Number(port),
      `GET /api/local/jobs/../../sentinel.json HTTP/1.1\nHost: 127.0.0.1:${port}`,
    );
    expect([400, 404]).toContain(dots.status);
    const persona = await raw(
      Number(port),
      `POST /api/local/personas/..%2Fx/batches HTTP/1.1\nHost: 127.0.0.1:${port}\nContent-Type: application/json\nContent-Length: 2`,
      "{}",
    );
    expect(persona.status).toBe(400);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(statSync(sentinel).mtimeMs).toBe(before);
  });
});

describe("in the local server", () => {
  let booted: Booted;

  beforeEach(async () => {
    booted = await bootFixture();
  });

  afterEach(async () => {
    await booted.stop();
    cleanUpBoot();
  });

  test("the routes are registered behind the session, with the CLI's own argv", async () => {
    const headers = {
      ...booted.session,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    };
    const list = await fetch(`${booted.base}/api/local/jobs`, { headers });
    expect([list.status, await list.json()]).toEqual([200, []]);
    const refused = await fetch(`${booted.base}/api/local/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "generate-image", persona: "milky-green" }),
    });
    expect([refused.status, ((await refused.json()) as ErrorBody).error.code]).toEqual([
      400,
      "unknown-command",
    ]);
    const signedOut = await fetch(`${booted.base}/api/local/jobs`);
    expect(signedOut.status).toBe(401);
  });
});
