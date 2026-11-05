// A fake Soniox for the transcribe tests: an injected fetch that serves canned jobs (run.golden.json
// holds the ones Python was served) and records every request. Fake ffprobe and ffmpeg too.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeJob {
  readonly file: Record<string, unknown>;
  readonly created: Record<string, unknown> & { readonly id: string };
  readonly polls: readonly Record<string, unknown>[];
  readonly transcript: Record<string, unknown>;
}

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly form?: { readonly client_reference_id: string; readonly filename: string };
  readonly json?: string;
  readonly authorization?: string;
  readonly timeout?: unknown;
}

/** What a test answers instead of the canned job: a response, or an error to throw (a network failure). */
export type Override = (request: Recorded, n: number) => Response | Error | "hang" | undefined;

function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export function fakeSoniox(
  jobs: readonly FakeJob[],
  override?: Override,
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  let uploads = 0;
  let creates = 0;
  const byId = new Map(jobs.map((job) => [job.created.id, job]));
  const polls = new Map(jobs.map((job) => [job.created.id, [...job.polls]]));
  const fetchFake = async (input: unknown, init: RequestInit & { timeout?: unknown } = {}) => {
    const signal = init.signal;
    signal?.throwIfAborted();
    const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
    const method = init.method ?? "GET";
    const headers = init.headers as Record<string, string>;
    let recorded: Recorded = {
      method,
      path,
      authorization: headers.Authorization,
      timeout: init.timeout,
    };
    if (init.body instanceof FormData) {
      // As Soniox receives it: FormData.get() names a Bun.file entry by its path instead.
      const wire = await new Response(init.body).text();
      recorded = {
        ...recorded,
        form: {
          client_reference_id:
            /name="client_reference_id"\r\n\r\n([^\r]*)\r\n/.exec(wire)?.[1] ?? "",
          filename: /name="file"; filename="([^"]*)"/.exec(wire)?.[1] ?? "",
        },
      };
    } else if (typeof init.body === "string") {
      recorded = { ...recorded, json: init.body };
    }
    requests.push(recorded);
    const answer = override?.(recorded, requests.length);
    if (answer === "hang") return waitForAbort(signal);
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    if (path === "/files" && method === "POST") {
      return Response.json(jobs[uploads++]?.file, { status: 201 });
    }
    if (path === "/transcriptions" && method === "POST") {
      return Response.json(jobs[creates++]?.created, { status: 201 });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    const [, , id, rest] = path.split("/");
    const job = byId.get(id ?? "");
    if (job === undefined) return Response.json({ message: "not found" }, { status: 404 });
    if (rest === "transcript") return Response.json(job.transcript);
    const queue = polls.get(job.created.id) as Record<string, unknown>[];
    return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
  };
  return { fetch: fetchFake as unknown as typeof fetch, requests };
}

/** An error response as Soniox shapes one. */
export function sonioxError(status: number, errorType: string, message: string): Response {
  return Response.json(
    { status_code: status, error_type: errorType, message, request_id: "r-1" },
    { status },
  );
}

/**
 * Scripts standing in for ffprobe (printing `durationSec`, or failing for null) and ffmpeg (writing
 * the part it was asked for, and logging its argv a line each).
 */
export function fakeBinaries(
  dir: string,
  durationSec: number | null,
): { ffprobe: string; ffmpeg: string; ffmpegLog: string } {
  const ffprobe = join(dir, "ffprobe");
  const ffmpeg = join(dir, "ffmpeg");
  const ffmpegLog = join(dir, "ffmpeg.log");
  writeFileSync(
    ffprobe,
    durationSec === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho ${durationSec}\n`,
  );
  writeFileSync(
    ffmpeg,
    `#!/bin/sh\nfor arg; do printf '%s\\n' "$arg" >> '${ffmpegLog}'; last="$arg"; done\n` +
      `printf '%s\\n' --- >> '${ffmpegLog}'\nprintf part > "$last"\n`,
  );
  chmodSync(ffprobe, 0o755);
  chmodSync(ffmpeg, 0o755);
  return { ffprobe, ffmpeg, ffmpegLog };
}
