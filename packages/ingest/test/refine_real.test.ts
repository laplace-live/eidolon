// The real transcripts and sidecars under <EIDOLON_REAL_HOME>/sources/milky-green/streams, read
// only. Each test skips when they are absent, unless EIDOLON_REQUIRE_PARITY=1.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { activePersona, consoleSink, logger, OpenAIClient } from "@eidolon/config";
import { iterStreams, loadSidecar, type ParsedStream, refine, saveSidecar } from "../src/index.ts";

const STREAMS = join(process.env.EIDOLON_REAL_HOME ?? "", "sources/milky-green/streams");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const HAVE_DATA = existsSync(STREAMS);
const MODEL = "~google/gemini-pro-latest";

let parsed: ParsedStream[] | null = null;
/** Parsed once, inside the first test that needs them: it takes longer than a hook may. */
function realStreams(): ParsedStream[] {
  parsed ??= iterStreams(STREAMS);
  return parsed;
}
beforeAll(() => {
  // Two log lines per chunk otherwise.
  logger.setSink();
});
afterAll(() => {
  logger.setSink(consoleSink);
});

test.skipIf(!HAVE_DATA && !REQUIRED)(
  "every real chunk's pass-1 request goes out once, with the persona's extract prompt and the chunk",
  async () => {
    expect(HAVE_DATA, `no transcripts at ${STREAMS}`).toBe(true);
    const bodies: string[] = [];
    const fake = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      bodies.push(init?.body as string);
      return new Response('{"error": {"message": "real-data test"}}', { status: 400 });
    };
    const client = new OpenAIClient(
      { baseUrl: refine.DEFAULT_BASE_URL, apiKey: "real-data-test" },
      { maxRetries: 4, fetch: fake as unknown as typeof fetch },
    );
    const prompts = refine.refinePrompts(activePersona().identity);
    const responseFormat = JSON.stringify(prompts.extractResponseFormat);
    let chunks = 0;
    const differing: string[] = [];
    for (const parsed of realStreams()) {
      const name = basename(parsed.mdPath);
      const context = refine.streamContext(parsed);
      for (const chunk of parsed.chunks) {
        bodies.length = 0;
        const outcome = await refine.refineChunk(client, MODEL, parsed, chunk, prompts);
        expect(outcome.refinement).toBeNull();
        chunks++;
        const user = refine.fillTemplate(refine.EXTRACT_USER_TEMPLATE, {
          context,
          timestamp: refine.headingTimestamp(chunk.heading),
          text: chunk.text,
        });
        const body =
          bodies.length === 1
            ? (JSON.parse(bodies[0] as string) as {
                model?: unknown;
                messages?: unknown;
                response_format?: unknown;
              })
            : null;
        const same =
          body !== null &&
          body.model === MODEL &&
          JSON.stringify(body.response_format) === responseFormat &&
          JSON.stringify(body.messages) ===
            JSON.stringify([
              { role: "system", content: prompts.extractSystem },
              { role: "user", content: user },
            ]);
        if (!same) differing.push(`${name}\t${chunk.id}\t${bodies.length} request(s)`);
      }
    }
    expect(differing.slice(0, 5)).toEqual([]);
    expect(chunks).toBeGreaterThan(50_000);
  },
  600_000,
);

test.skipIf(!HAVE_DATA && !REQUIRED)(
  "every real sidecar refine loads saves back byte for byte, and a save it reloads saves the same",
  async () => {
    expect(HAVE_DATA, `no transcripts at ${STREAMS}`).toBe(true);
    const out = mkdtempSync(join(tmpdir(), "refine-real-"));
    let sidecars = 0;
    const rewritten: string[] = [];
    const changed: string[] = [];
    const unstable: string[] = [];
    try {
      for (const parsed of realStreams()) {
        if (!existsSync(parsed.sidecarPath)) continue;
        sidecars++;
        const name = basename(parsed.sidecarPath);
        const copy = { ...parsed, sidecarPath: join(out, name) };
        saveSidecar(copy, loadSidecar(parsed));
        const once = readFileSync(copy.sidecarPath);
        saveSidecar(copy, loadSidecar(copy));
        const twice = readFileSync(copy.sidecarPath);
        rmSync(copy.sidecarPath);
        const original = readFileSync(parsed.sidecarPath);
        if (!once.equals(original)) {
          rewritten.push(name);
          const [after, before] = [once, original].map((bytes) => JSON.parse(bytes.toString()));
          if (!Bun.deepEquals(after, before)) changed.push(name);
        }
        if (!twice.equals(once)) unstable.push(name);
      }
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    expect(unstable.slice(0, 5)).toEqual([]);
    // A sidecar refine didn't write last (one ends in a newline it never writes) is reformatted,
    // its content kept.
    expect(changed.slice(0, 5)).toEqual([]);
    expect(rewritten.length).toBeLessThan(sidecars / 100);
    expect(sidecars).toBeGreaterThan(1_000);
  },
  600_000,
);

test.skipIf(!HAVE_DATA && !REQUIRED)(
  "the dry run over the real transcripts lists each one's new chunks and totals them",
  async () => {
    expect(HAVE_DATA, `no transcripts at ${STREAMS}`).toBe(true);
    const streams = realStreams();
    const rows: string[] = [];
    let pending = 0;
    let done = 0;
    for (const parsed of streams) {
      const work = refine.refineWork(parsed, loadSidecar(parsed));
      pending += work.pending;
      done += work.done;
      const name = basename(parsed.mdPath);
      rows.push(
        work.pending === 0 ? `  ${name}: 0 new chunks` : `  ${name}: ${work.pending} chunks × 2`,
      );
    }
    for (const model of [MODEL, "~google/gemini-flash-latest"]) {
      const report = await refine.dryRun(streams, model);
      const listed = report.text
        .split("\n")
        .filter((line) => /^ {2}\S.*\.md: /.test(line))
        .map((line) => line.replace(/ passes, ~.*$/, ""));
      expect(listed).toEqual(rows);
      expect([report.streams, report.chunks, report.skipped]).toEqual([
        streams.length,
        pending,
        done,
      ]);
      expect(report.text).toContain(`\nEstimated total: ${pending} chunks (2 passes each), ~`);
      expect(report.text.includes("not in local price table")).toBe(report.costUsd === null);
    }
    expect(streams.length).toBeGreaterThan(1_000);
  },
  600_000,
);
