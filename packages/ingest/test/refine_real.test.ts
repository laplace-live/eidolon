// The real transcripts and sidecars under <EIDOLON_REAL_HOME>/sources/milky-green/streams, read
// only. Python's side comes from fixtures/refine/real.py, run at test time through
// `uv run --offline --no-sync`; its output is never committed. Each test skips when the data or uv
// is absent, unless EIDOLON_REQUIRE_PARITY=1.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePersona, consoleSink, logger, OpenAIClient } from "@eidolon/config";
import { iterStreams, loadSidecar, type ParsedStream, refine, saveSidecar } from "../src/index.ts";

const STREAMS = join(process.env.EIDOLON_REAL_HOME ?? "", "sources/milky-green/streams");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const REPO = join(import.meta.dir, "../../..");
const SCRIPT = join(import.meta.dir, "fixtures/refine/real.py");
const UV = Bun.which("uv");
const HAVE_DATA = existsSync(STREAMS);
const MODEL = "~google/gemini-pro-latest";

let parsed: ParsedStream[] | null = null;
/** Parsed once, inside the first test that needs them: it takes longer than a hook may. */
function realStreams(): ParsedStream[] {
  parsed ??= iterStreams(STREAMS);
  return parsed;
}
beforeAll(() => {
  // Two log lines per chunk otherwise, and Python's are silenced too.
  logger.setSink();
});
afterAll(() => {
  logger.setSink(consoleSink);
});

async function python(...args: string[]): Promise<string> {
  const proc = Bun.spawn(
    [UV as string, "run", "--offline", "--no-sync", "python", SCRIPT, ...args],
    {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, err).toBe(0);
  return out;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test.skipIf((!HAVE_DATA || UV === null) && !REQUIRED)(
  "every real chunk's pass-1 request body is the one refine.py sends (§7 5b)",
  async () => {
    expect(HAVE_DATA, `no transcripts at ${STREAMS}`).toBe(true);
    expect(UV, "uv is not on PATH").not.toBeNull();
    const fromPython = new Map<string, string>();
    for (const line of (await python("bodies", STREAMS, MODEL)).trimEnd().split("\n")) {
      const [name, id, digest] = line.split("\t");
      fromPython.set(`${name}\t${id}`, digest as string);
    }

    let body = "";
    const fake = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      body = init?.body as string;
      return new Response('{"error": {"message": "parity test"}}', { status: 400 });
    };
    const client = new OpenAIClient(
      { baseUrl: refine.DEFAULT_BASE_URL, apiKey: "parity-test" },
      { maxRetries: 4, fetch: fake as unknown as typeof fetch },
    );
    const prompts = refine.refinePrompts(activePersona().identity);
    const fromTs = new Map<string, string>();
    for (const parsed of realStreams()) {
      const name = parsed.mdPath.slice(parsed.mdPath.lastIndexOf("/") + 1);
      for (const chunk of parsed.chunks) {
        body = "";
        const outcome = await refine.refineChunk(client, MODEL, parsed, chunk, prompts);
        expect(outcome.refinement).toBeNull();
        fromTs.set(`${name}\t${chunk.id}`, sha256(body));
      }
    }

    expect(fromTs.size).toBe(fromPython.size);
    const differing = [...fromPython].filter(([key, digest]) => fromTs.get(key) !== digest);
    expect(differing.slice(0, 5)).toEqual([]);
    expect(fromPython.size).toBeGreaterThan(50_000);
  },
  600_000,
);

test.skipIf((!HAVE_DATA || UV === null) && !REQUIRED)(
  "every real sidecar refine loads saves back as refine.py saves it, byte for byte",
  async () => {
    expect(HAVE_DATA, `no transcripts at ${STREAMS}`).toBe(true);
    expect(UV, "uv is not on PATH").not.toBeNull();
    const fromPython = new Map<string, [string, string]>();
    for (const line of (await python("resave", STREAMS)).trimEnd().split("\n")) {
      const [name, digest, same] = line.split("\t");
      fromPython.set(name as string, [digest as string, same as string]);
    }
    const out = mkdtempSync(join(tmpdir(), "refine-real-"));
    const fromTs = new Map<string, [string, string]>();
    try {
      for (const parsed of realStreams()) {
        if (!existsSync(parsed.sidecarPath)) continue;
        const name = parsed.sidecarPath.slice(parsed.sidecarPath.lastIndexOf("/") + 1);
        const copy = { ...parsed, sidecarPath: join(out, name) };
        saveSidecar(copy, loadSidecar(parsed));
        const written = readFileSync(copy.sidecarPath);
        rmSync(copy.sidecarPath);
        const same = written.equals(readFileSync(parsed.sidecarPath)) ? "1" : "0";
        fromTs.set(name, [createHash("sha256").update(written).digest("hex"), same]);
      }
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    expect(fromTs.size).toBe(fromPython.size);
    const differing = [...fromPython].filter(
      ([name, [digest]]) => fromTs.get(name)?.[0] !== digest,
    );
    expect(differing.slice(0, 5)).toEqual([]);
    // A file refine.py didn't write last (one ends in a newline it never writes) changes for both.
    const rewritten = [...fromPython].filter(([, [, same]]) => same === "0").length;
    expect(rewritten).toBeLessThan(fromPython.size / 100);
    expect(fromPython.size).toBeGreaterThan(1_000);
  },
  600_000,
);

test.skipIf((!HAVE_DATA || UV === null) && !REQUIRED)(
  "the dry run over the real transcripts prints what refine.py's prints",
  async () => {
    expect(HAVE_DATA, `no transcripts at ${STREAMS}`).toBe(true);
    expect(UV, "uv is not on PATH").not.toBeNull();
    for (const model of [MODEL, "~google/gemini-flash-latest"]) {
      const expected = await python("dry-run", STREAMS, model);
      expect((await refine.dryRun(realStreams(), model)).text).toBe(expected);
    }
  },
  600_000,
);
