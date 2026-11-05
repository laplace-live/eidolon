import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, type LogRecord, logger, PyFloat } from "@eidolon/config";
import { transcribe } from "../src/index.ts";
import { fakeSoniox, type Override, type Recorded, sonioxError } from "./fake_soniox.ts";

const { SonioxApiError, SonioxClient, SonioxConnectionError } = transcribe;

let work = "";
let warnings: string[] = [];
let slept: number[] = [];
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ingest-soniox-"));
  warnings = [];
  slept = [];
  logger.setSink((record: LogRecord) => {
    if (record.level === "WARNING") warnings.push(record.message);
  });
});
afterEach(() => {
  logger.setSink(consoleSink);
  rmSync(work, { recursive: true, force: true });
});

const JOB = {
  file: { id: "f1", filename: "a.m4a" },
  created: { id: "t1", status: "queued", filename: "a.m4a", created_at: "2026-01-02T03:04:05Z" },
  polls: [{ id: "t1", status: "completed", filename: "a.m4a", audio_duration_ms: 1_000 }],
  transcript: { id: "t1", text: "x", tokens: [] },
};

function client(override?: Override, retryDelaysMs = [10, 20, 40]) {
  const soniox = fakeSoniox([JOB], override);
  const sonioxClient = new SonioxClient({
    apiKey: "key",
    fetch: soniox.fetch,
    retryDelaysMs,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { soniox, client: sonioxClient };
}

const paths = (requests: readonly Recorded[]) => requests.map((r) => `${r.method} ${r.path}`);

describe("the calls", () => {
  test("upload sends the file and its reference id as multipart, under the API key", async () => {
    const audio = join(work, "BV1x.m4a");
    writeFileSync(audio, "abc");
    const { soniox, client: c } = client();
    expect(await c.upload(audio, "BV1x.m4a", "laplace-eidolon:BV1x.m4a")).toEqual({ id: "f1" });
    expect(soniox.requests).toEqual([
      {
        method: "POST",
        path: "/files",
        authorization: "Bearer key",
        timeout: 600_000,
        form: { client_reference_id: "laplace-eidolon:BV1x.m4a", filename: "BV1x.m4a" },
      },
    ]);
  });

  test("create posts JSON; get and the transcript parse what Soniox sent", async () => {
    const { soniox, client: c } = client();
    const body = { model: "m", file_id: "f1", client_reference_id: "r" };
    expect(await c.createTranscription(body)).toMatchObject({ id: "t1", status: "queued" });
    expect(soniox.requests[0]?.json).toBe(JSON.stringify(body));
    expect(await c.getTranscription("t1")).toMatchObject({
      status: "completed",
      audio_duration_ms: 1_000,
      created_at: null,
      error_type: null,
    });
    expect(await c.getTranscript("t1")).toEqual({ id: "t1", text: "x", tokens: [] });
  });

  test("the transcript keeps Python's floats", async () => {
    const { client: c } = client((r) =>
      r.path.endsWith("/transcript")
        ? new Response('{"id":"t1","text":"","tokens":[{"text":"a","confidence":1.0,"x":2}]}')
        : undefined,
    );
    expect((await c.getTranscript("t1")).tokens).toEqual([
      { text: "a", confidence: new PyFloat(1), x: 2 },
    ]);
  });

  test("a delete of something already gone succeeds", async () => {
    const { soniox, client: c } = client(() => sonioxError(404, "file_not_found", "gone"));
    await c.deleteTranscription("t1");
    await c.deleteFile("f1");
    expect(paths(soniox.requests)).toEqual(["DELETE /transcriptions/t1", "DELETE /files/f1"]);
    await expect(c.getTranscription("t1")).rejects.toThrow("gone (HTTP 404, file_not_found)");
  });
});

describe("retries", () => {
  test("network errors and 408/429/500/502/503/504 are retried with backoff, on every call", async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      slept = [];
      let n = 0;
      const { soniox, client: c } = client(() =>
        ++n <= 2
          ? n === 1
            ? new TypeError("socket closed")
            : sonioxError(status, "e", "m")
          : undefined,
      );
      await c.deleteFile("f1");
      expect([status, paths(soniox.requests)]).toEqual([status, Array(3).fill("DELETE /files/f1")]);
      expect(slept).toEqual([10, 20]);
    }
    expect(warnings[0]).toBe(
      "  Soniox DELETE /files/f1 failed (1/4), retrying in 0.01s: TypeError: socket closed",
    );
  });

  test("an upload retried streams the file again", async () => {
    const audio = join(work, "a.m4a");
    writeFileSync(audio, "abc");
    let n = 0;
    const { soniox, client: c } = client((r) =>
      r.path === "/files" && ++n === 1 ? new TypeError("reset") : undefined,
    );
    await c.upload(audio, "a.m4a", "ref");
    expect(soniox.requests.map((r) => r.form)).toEqual([
      { client_reference_id: "ref", filename: "a.m4a" },
      { client_reference_id: "ref", filename: "a.m4a" },
    ]);
  });

  test("other statuses fail at once with Soniox's message", async () => {
    for (const status of [400, 401, 402, 404, 409]) {
      const { soniox, client: c } = client(() => sonioxError(status, "invalid_request", "nope"));
      const error = await c.createTranscription({}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SonioxApiError);
      expect(error).toMatchObject({ status, errorType: "invalid_request" });
      expect(soniox.requests).toHaveLength(1);
    }
  });

  test("validation errors are listed, and a body that isn't JSON still names the status", async () => {
    const invalid = Response.json(
      {
        error_type: "invalid_request",
        message: "Invalid request.",
        validation_errors: [{ location: "body.model", message: "too long" }],
      },
      { status: 400 },
    );
    const { client: c } = client(() => invalid);
    await expect(c.createTranscription({})).rejects.toThrow(
      "Invalid request. (HTTP 400, invalid_request) Validation errors: body.model: too long",
    );
    const { client: d } = client(() => new Response("<html>bad gateway</html>", { status: 418 }));
    await expect(d.createTranscription({})).rejects.toThrow("<html>bad gateway</html> (HTTP 418)");
  });

  test("once the retries run out, the last failure is the error", async () => {
    const { client: down } = client(() => new TypeError("connect ECONNREFUSED"));
    const refused = await down.getTranscription("t1").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SonioxConnectionError);
    expect((refused as Error).message).toBe(
      "Soniox GET /transcriptions/t1 failed 4 times: TypeError: connect ECONNREFUSED",
    );
    const { client: busy } = client(() => sonioxError(503, "service_unavailable", "busy"));
    await expect(busy.getTranscription("t1")).rejects.toMatchObject({ status: 503 });
  });
});

describe("cancelling", () => {
  test("a wait between retries ends at once, with the signal's reason", async () => {
    const controller = new AbortController();
    const soniox = fakeSoniox([JOB], () => new TypeError("reset"));
    const c = new SonioxClient({
      apiKey: "k",
      fetch: soniox.fetch,
      sleep: () => {
        controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
        return new Promise(() => {});
      },
    });
    await expect(c.getTranscription("t1", controller.signal)).rejects.toThrow(
      "Interrupted by SIGINT",
    );
    expect(soniox.requests).toHaveLength(1);
  });

  test("a request in flight is aborted, not retried", async () => {
    const controller = new AbortController();
    const { soniox, client: c } = client(() => {
      controller.abort(new DOMException("Interrupted by SIGTERM", "AbortError"));
      return "hang";
    });
    await expect(c.deleteFile("f1", controller.signal)).rejects.toThrow("Interrupted by SIGTERM");
    expect(soniox.requests).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});
