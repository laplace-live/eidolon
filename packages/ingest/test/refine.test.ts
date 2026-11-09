// fixtures/refine/vectors.golden.json holds what the validators, lenient JSON, the stream context
// and the usage accounting make of the inputs it lists. The hashes below pin milky-green's prompts
// and response schemas.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activePersona,
  consoleSink,
  cpLen,
  type JsonPoster,
  type LogRecord,
  loadsPy,
  logger,
  PyFloat,
  pyError,
  pyFloatRepr,
  pyJsonDumps,
  pyJsonLoads,
} from "@eidolon/config";
import type { CostSource } from "@eidolon/retrieval";
import { type ProgressEvent, parseStream, refine } from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures/refine");
const MILKY_GREEN = { name: "明前奶绿", shortName: "奶绿" };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

let records: [string, string][] = [];
beforeEach(() => {
  records = [];
  logger.setSink((record: LogRecord) => {
    records.push([record.level, record.message]);
  });
});
afterEach(() => {
  logger.setSink(consoleSink);
});

describe("prompts and schemas", () => {
  test("milky-green's render to refine.py's constants (Appendix B)", () => {
    const prompts = refine.refinePrompts(MILKY_GREEN);
    const rows = [
      [
        prompts.extractSystem,
        2362,
        2486,
        "e5dc0b6363ec6b797d8a049d3546cdf5792a0cb5af7642d856769f665187baab",
      ],
      [
        refine.EXTRACT_USER_TEMPLATE,
        75,
        75,
        "e4ab3f8eb88ce70004b1375952194535e3421de63f10ad8326ffc5b7f803763c",
      ],
      [
        prompts.synthesizeSystem,
        2072,
        2116,
        "2041b783399b16aab0e976ee1e0b3eb32501d0eda91e0edea38ec0dbadea83fe",
      ],
      [
        refine.SYNTHESIZE_USER_TEMPLATE,
        160,
        160,
        "b1ca0c23687a86a3a0c4c944c2389559cf4f4b5f92cf9e4b6a486a82ff97899f",
      ],
    ] as const;
    for (const [text, points, bytes, digest] of rows) {
      expect([cpLen(text), Buffer.byteLength(text), sha256(text)]).toEqual([points, bytes, digest]);
    }
    const extract = canonical(prompts.extractResponseFormat);
    const synthesis = canonical(prompts.synthesisResponseFormat);
    expect([cpLen(extract), sha256(extract)]).toEqual([
      1976,
      "3c4debce7a414e9d41bc9b3e485c53527614065abc65f688034de2e5ca630edd",
    ]);
    expect([cpLen(synthesis), sha256(synthesis)]).toEqual([
      741,
      "f698589eaccedb39fe8d406d6eb2cd5dffb649a0b29f61ba2aa5e15866aba2b2",
    ]);
  });

  test("the installed milky-green persona names herself as refine.py did", () => {
    const fromSettings = refine.refinePrompts(activePersona().identity);
    expect(fromSettings).toEqual(refine.refinePrompts(MILKY_GREEN));
  });

  test("another persona's names replace hers everywhere, and nothing else moves", () => {
    const other = refine.refinePrompts({ name: "测试姬", shortName: "小测" });
    const ours = refine.refinePrompts(MILKY_GREEN);
    for (const key of ["extractSystem", "synthesizeSystem"] as const) {
      expect(other[key]).not.toContain("奶绿");
      expect(other[key].replaceAll("测试姬", "明前奶绿").replaceAll("小测", "奶绿")).toBe(
        ours[key],
      );
    }
    expect(other.extractSystem.match(/测试姬/g)?.length).toBe(1);
    expect(other.extractSystem.match(/小测/g)?.length).toBe(3);
    expect(other.synthesizeSystem.match(/测试姬/g)?.length).toBe(1);
    expect(other.synthesizeSystem.match(/小测/g)?.length).toBe(2);
    expect(JSON.stringify(other.extractResponseFormat)).toBe(
      JSON.stringify(ours.extractResponseFormat).replace("奶绿's reply", "小测's reply"),
    );
    expect(other.synthesisResponseFormat).toEqual(ours.synthesisResponseFormat);
  });

  test("a name is filled in once, never rescanned", () => {
    const prompts = refine.refinePrompts({ name: "{shortName}", shortName: "$&" });
    expect(prompts.extractSystem).toContain("**{shortName}** ($&)");
    expect(refine.fillTemplate("{a}{b}{c}", { a: "{b}", b: "x" })).toBe("{b}x{c}");
  });
});

interface Vectors {
  extract: { input: string; result?: string; error?: string }[];
  synthesis: { input: string; result?: string; error?: string }[];
  lenient: { input: string; value: string; note: string | null }[];
  sanitize: { input: string; output: string }[];
  context: { metadata: Record<string, unknown>; context: string }[];
  timestamps: { heading: string; timestamp: string }[];
  usage_pairs: (UsageOut & { self: CostSource; other: CostSource })[];
  usage_chains: (UsageOut & { chain: [CostSource, number][] })[];
  extract_usage: (UsageOut & { model: string; response: unknown })[];
  v2: { record: unknown; v2: boolean }[];
}

interface UsageOut {
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: string;
  cost_source: string;
  fmt: string;
}

const vectorsText = readFileSync(join(FIXTURES, "vectors.golden.json"), "utf8");
const vectors = JSON.parse(vectorsText) as Vectors;
// Floats kept as floats: str(180.0) is "180.0".
const vectorFloats = loadsPy(vectorsText) as Vectors;

function outcome(run: () => unknown): { result?: string; error?: string } {
  try {
    return { result: pyJsonDumps(run(), { ensureAscii: false }) };
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

const loads = (text: string) => pyJsonLoads(text, { strict: true, floats: true });

function usageOut(usage: refine.Usage): UsageOut {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    cost_usd: pyFloatRepr(usage.costUsd),
    cost_source: usage.costSource,
    fmt: refine.fmtCost(usage),
  };
}

function usageOf(prompt: number, completion: number, cost: number, source: CostSource) {
  const usage = new refine.Usage();
  usage.promptTokens = prompt;
  usage.completionTokens = completion;
  usage.costUsd = cost;
  usage.costSource = source;
  return usage;
}

describe("refine.py's vectors", () => {
  test("validateExtract", () => {
    for (const { input, ...expected } of vectors.extract) {
      expect([input, outcome(() => refine.validateExtract(loads(input)))]).toEqual([
        input,
        expected,
      ]);
    }
  });

  test("validateSynthesis", () => {
    for (const { input, ...expected } of vectors.synthesis) {
      expect([input, outcome(() => refine.validateSynthesis(loads(input)))]).toEqual([
        input,
        expected,
      ]);
    }
  });

  test("parseJsonLenient", () => {
    for (const { input, value, note } of vectors.lenient) {
      const [parsed, got] = refine.parseJsonLenient(input);
      expect([input, pyJsonDumps(parsed), got]).toEqual([input, value, note]);
    }
  });

  test("sanitizeJsonText", () => {
    for (const { input, output } of vectors.sanitize) {
      expect([input, refine.sanitizeJsonText(input)]).toEqual([input, output]);
    }
  });

  test("streamContext and headingTimestamp", () => {
    for (const { metadata, context } of vectorFloats.context) {
      expect(refine.streamContext({ metadata })).toBe(context);
    }
    for (const { heading, timestamp } of vectors.timestamps) {
      expect(refine.headingTimestamp(heading)).toBe(timestamp);
    }
  });

  test("Usage.add, extractUsage and fmtCost", () => {
    for (const { self, other, ...expected } of vectors.usage_pairs) {
      const usage = usageOf(1, 2, 0.5, self);
      usage.add(usageOf(3, 4, 0.25, other));
      expect([self, other, usageOut(usage)]).toEqual([self, other, expected]);
    }
    for (const { chain, ...expected } of vectors.usage_chains) {
      const usage = new refine.Usage();
      for (const [source, cost] of chain) usage.add(usageOf(1, 1, cost, source));
      expect([chain, usageOut(usage)]).toEqual([chain, expected]);
    }
    for (const { model, response, ...expected } of vectors.extract_usage) {
      records = [];
      const got = usageOut(refine.extractUsage(response, model));
      expect([model, response, got]).toEqual([model, response, expected]);
      const warned = expected.cost_source === "unknown";
      expect(records.length).toBe(warned ? 1 : 0);
    }
  });

  test("isV2Refinement", () => {
    for (const { record, v2 } of vectors.v2)
      expect([record, refine.isV2Refinement(record)]).toEqual([record, v2]);
  });
});

/** A chat completion carrying `content`. */
function reply(content: string, finishReason = "stop", cost = 0.001): unknown {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost },
  };
}

const EXTRACT_REPLY = JSON.stringify({ topics: ["t"], events: ["e"] });
const SYNTH_REPLY = JSON.stringify({ heading: "标题", summary: "摘要。", details: "细节。" });

interface FakeCall {
  readonly user: string;
  readonly pass: 1 | 2;
}

/** A client that answers each pass as `answer` says, recording what it was asked. */
function fakeClient(
  answer: (call: FakeCall) => unknown | Promise<unknown>,
): JsonPoster & { calls: FakeCall[]; inFlight: number; peak: number } {
  const client = {
    calls: [] as FakeCall[],
    inFlight: 0,
    peak: 0,
    async post(_path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
      const messages = body.messages as { content: string }[];
      const user = messages[1]?.content as string;
      const call: FakeCall = { user, pass: user.includes("Structured extract:") ? 2 : 1 };
      client.calls.push(call);
      client.inFlight++;
      client.peak = Math.max(client.peak, client.inFlight);
      try {
        await Bun.sleep(1);
        return await answer(call);
      } finally {
        client.inFlight--;
      }
    },
  };
  return client;
}

const normal = (call: FakeCall) => reply(call.pass === 1 ? EXTRACT_REPLY : SYNTH_REPLY);

let work = "";
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ingest-refine-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A transcript of `n` scenes, the k-th headed `k:00 — 第k段`. */
function transcript(name: string, n: number): string {
  const scenes = Array.from({ length: n }, (_, k) => `## ${k}:00 — 第${k}段\n\n第${k}段的文字。`);
  const text = `---\nstream_date: 2026-02-01\nstream_id: ${name}\nsource_file: ${name}.m4a\n---\n\n${scenes.join("\n\n")}\n`;
  const path = join(work, `${name}.md`);
  writeFileSync(path, text);
  return path;
}

function options(
  client: JsonPoster,
  extra: Partial<refine.RefineOptions> = {},
): refine.RefineOptions {
  return {
    client,
    model: "~google/gemini-flash-latest",
    concurrency: 2,
    identity: MILKY_GREEN,
    now: () => new Date("2026-02-02T00:00:00Z"),
    monotonic: () => 0,
    ...extra,
  };
}

const chunkId = (stream: string, k: number) => `${stream}::${String(k).padStart(3, "0")}`;

function readSidecar(stream: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(work, `${stream}.refined.json`), "utf8"));
}

describe("refineStreams", () => {
  test("at most `concurrency` chunks are in flight, each holding its slot across both passes", async () => {
    const client = fakeClient(normal);
    const parsed = parseStream(transcript("s", 7));
    const report = await refine.refineStreams([parsed], options(client, { concurrency: 3 }));
    expect(report.ok).toBe(true);
    expect(client.peak).toBe(3);
    expect(client.calls.length).toBe(14);
    expect(Object.keys(readSidecar("s").chunks as object).length).toBe(7);
  });

  test("--force checkpoints keep each old record until its chunk is redone; the final save holds the new ones", async () => {
    const path = transcript("f", 3);
    const old = (heading: string) => ({ heading, summary: "旧", details: "旧", key_quotes: [] });
    writeFileSync(
      join(work, "f.refined.json"),
      JSON.stringify({
        schema_version: 2,
        stream_id: "f",
        chunks: {
          [chunkId("f", 0)]: old("零"),
          [chunkId("f", 1)]: old("一"),
          "f::009": old("孤儿"),
        },
      }),
    );
    const saves: unknown[] = [];
    let second: () => void = () => {};
    const client = fakeClient(async (call) => {
      if (call.user.includes("第1段") && call.pass === 1) {
        // Chunk 001 waits until a checkpoint has been written without it.
        await new Promise<void>((resolve) => {
          second = resolve;
        });
      }
      return normal(call);
    });
    const report = refine.refineStreams(
      [parseStream(path)],
      options(client, {
        force: true,
        concurrency: 3,
        saveEvery: 2,
        onProgress: (event: ProgressEvent) => {
          if (event.type === "progress" && event.done === 2) {
            saves.push(readSidecar("f").chunks);
            second();
          }
        },
      }),
    );
    expect((await report).ok).toBe(true);
    // The checkpoint after two completions: the new records, then the old ones not yet redone.
    expect(Object.entries(saves[0] as object).map(([id, rec]) => [id, rec.heading])).toEqual([
      [chunkId("f", 0), "标题"],
      [chunkId("f", 2), "标题"],
      [chunkId("f", 1), "一"],
      ["f::009", "孤儿"],
    ]);
    const final = readSidecar("f");
    expect(Object.keys(final.chunks as object)).toEqual([
      chunkId("f", 0),
      chunkId("f", 2),
      chunkId("f", 1),
    ]);
    expect((final.stats as Record<string, unknown>).chunks_refined).toBe(3);
  });

  test("an aborted --force run keeps the records it hadn't redone", async () => {
    const path = transcript("g", 3);
    const old = { heading: "旧", summary: "旧", details: "旧", key_quotes: [] };
    writeFileSync(
      join(work, "g.refined.json"),
      JSON.stringify({
        schema_version: 2,
        stream_id: "g",
        chunks: { [chunkId("g", 0)]: old, [chunkId("g", 1)]: old, [chunkId("g", 2)]: old },
      }),
    );
    const controller = new AbortController();
    const client = fakeClient(async (call) => {
      if (call.user.includes("第1段")) {
        controller.abort(new DOMException("Interrupted", "AbortError"));
        throw controller.signal.reason;
      }
      return normal(call);
    });
    const events: ProgressEvent[] = [];
    const report = await refine.refineStreams(
      [parseStream(path), parseStream(transcript("h", 1))],
      options(client, {
        force: true,
        concurrency: 1,
        signal: controller.signal,
        onProgress: (e) => events.push(e),
      }),
    );
    expect(report.cancelled).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.results.length).toBe(1);
    const saved = readSidecar("g");
    expect(Object.entries(saved.chunks as object).map(([id, rec]) => [id, rec.heading])).toEqual([
      [chunkId("g", 0), "标题"],
      [chunkId("g", 1), "旧"],
      [chunkId("g", 2), "旧"],
    ]);
    expect(saved.stats).toBeUndefined();
    expect(client.calls.filter((c) => c.user.includes("第2段"))).toEqual([]);
    expect(readdirSync(work).filter((name) => name.startsWith("h."))).toEqual(["h.md"]);
    expect(events.at(-1)).toMatchObject({ type: "summary", ok: false, cancelled: true });
  });

  test("an unexpected error fails the whole stream, stops its queued chunks, and the run goes on", async () => {
    const client = fakeClient((call) => {
      if (call.user.includes("第1段")) return Promise.reject(new SyntaxError("Unexpected token"));
      return normal(call);
    });
    const report = await refine.refineStreams(
      [parseStream(transcript("x", 5)), parseStream(transcript("y", 1))],
      options(client, { concurrency: 1 }),
    );
    const [x, y] = report.results;
    expect([x?.error, x?.chunksFailed, x?.chunksSkipped, x?.usage.promptTokens]).toEqual([
      "Unexpected token",
      5,
      0,
      0,
    ]);
    expect(client.calls.some((c) => /第[234]段/.test(c.user))).toBe(false);
    expect(y?.chunksSucceeded).toBe(1);
    expect(records).toContainEqual(["ERROR", "  ✗ x.md: Unexpected token"]);
    // Nothing is saved for the crashed stream.
    expect(readdirSync(work).sort()).toEqual(["x.md", "y.md", "y.refined.json"]);
    expect(report.ok).toBe(false);
  });

  test("int(inf) in an SC amount fails the stream, as refine.py lets it", async () => {
    const client = fakeClient(() =>
      reply('{"sc_events": [{"viewer": "v", "amount_yuan": Infinity}]}'),
    );
    const report = await refine.refineStreams([parseStream(transcript("i", 1))], options(client));
    expect(report.results[0]?.error).toBe("cannot convert float infinity to integer");
  });

  test("a checkpoint every saveEvery completions, failures included, then the final save", async () => {
    let n = 0;
    const client = fakeClient((call) => {
      n++;
      if (call.pass === 1 && call.user.includes("第3段")) return reply("");
      return normal(call);
    });
    const parsed = parseStream(transcript("c", 4));
    const writes: string[] = [];
    const report = await refine.refineStreams(
      [parsed],
      options(client, {
        concurrency: 1,
        saveEvery: 2,
        onProgress: (event) => {
          if (event.type === "progress") writes.push(`${event.done}`);
        },
      }),
    );
    expect(n).toBe(7);
    expect(report.results[0]?.chunksFailed).toBe(1);
    expect(records.filter(([, m]) => m.startsWith("  ... "))).toEqual([
      ["INFO", "  ... 2/4 done, running cost: $0.0040"],
      ["INFO", "  ... 4/4 done, running cost: $0.0070"],
    ]);
    const saved = readSidecar("c");
    expect(saved.stats).toEqual({
      chunks_total: 4,
      chunks_refined: 3,
      tokens_in: 70,
      tokens_out: 35,
      cost_usd: 0.007,
      cost_source: "openrouter",
      model: "~google/gemini-flash-latest",
      duration_sec: 0,
    });
    expect(writes).toEqual(["1", "2", "3", "4"]);
  });

  test("an API error is logged and fails only its chunk", async () => {
    const client = fakeClient((call) => {
      if (call.user.includes("第0段")) throw pyError("RateLimitError", "Error code: 429 - {}");
      return normal(call);
    });
    const report = await refine.refineStreams([parseStream(transcript("a", 2))], options(client));
    expect(report.results[0]?.chunksFailed).toBe(1);
    expect(report.results[0]?.chunksSucceeded).toBe(1);
    expect(records).toContainEqual(["ERROR", "  API error: Error code: 429 - {}"]);
    expect(records).toContainEqual(["ERROR", "  ✗ a::000: pass 1 (extract) failed"]);
  });

  test("a run with nothing left to refine costs $0, as an ingest the cache served does", async () => {
    const streams = [parseStream(transcript("a", 1))];
    await refine.refineStreams(streams, options(fakeClient(normal)));
    const events: ProgressEvent[] = [];
    await refine.refineStreams(streams, {
      ...options(fakeClient(normal)),
      onProgress: (event) => events.push(event),
    });
    expect(events.at(-1)).toMatchObject({ type: "summary", ok: true, costUsd: 0 });
    expect(events.at(-1)).not.toHaveProperty("costSource");
  });

  test("a rejected key fails each stream and the stage with code auth-failed", async () => {
    const events: ProgressEvent[] = [];
    const rejected = fakeClient(() => {
      throw pyError("AuthenticationError", "Error code: 401 - {'error': {'message': 'no'}}");
    });
    const streams = [parseStream(transcript("a", 2)), parseStream(transcript("b", 1))];
    const report = await refine.refineStreams(streams, {
      ...options(rejected),
      onProgress: (event) => events.push(event),
    });
    expect(report.ok).toBe(false);
    const failed = events.filter((e) => e.type === "item" && e.status === "failed");
    expect(failed.map((e) => (e.type === "item" ? [e.item, e.code, e.provider] : null))).toEqual([
      ["a", "auth-failed", "refine"],
      ["b", "auth-failed", "refine"],
    ]);
    expect(events.find((e) => e.type === "stage" && e.status === "failed")).toMatchObject({
      code: "auth-failed",
      provider: "refine",
    });

    // Failures of different kinds share no code.
    const mixed: ProgressEvent[] = [];
    const client = fakeClient((call) => {
      if (call.user.includes("第0段")) throw pyError("APIStatusError", "Error code: 402 - {}");
      return reply("not json");
    });
    await refine.refineStreams([parseStream(transcript("c", 2))], {
      ...options(client),
      onProgress: (event) => mixed.push(event),
    });
    const item = mixed.find((e) => e.type === "item" && e.status === "failed");
    expect(item).toMatchObject({ item: "c" });
    expect(item && "code" in item ? item.code : undefined).toBeUndefined();
  });
});

describe("a signal", () => {
  test("stops the transcript load and the dry run between files, with its reason", async () => {
    const first = transcript("a", 1);
    transcript("b", 2);
    const loaded = await refine.selectStreams([], work);
    expect(loaded.map((stream) => stream.streamId)).toEqual(["a", "b"]);
    const controller = new AbortController();
    const reason = new DOMException("Interrupted by SIGINT", "AbortError");
    controller.abort(reason);
    await expect(refine.selectStreams([], work, controller.signal)).rejects.toBe(reason);
    await expect(refine.selectStreams([first], work, controller.signal)).rejects.toBe(reason);
    await expect(
      refine.dryRun(loaded, "~google/gemini-flash-latest", controller.signal),
    ).rejects.toBe(reason);
  });
});

describe("estimates for the plan", () => {
  test("refineCost is the dry run's arithmetic on counts, for a video not yet transcribed", () => {
    expect(refine.refineCost("~google/gemini-flash-latest", 2, 101)).toEqual({
      tokensIn: 3450,
      tokensOut: 2800,
      costUsd: (3450 * 0.075 + 2800 * 0.3) / 1_000_000,
      basis: "price-table",
    });
    const history = { model: "m", usdPerChunk: 0.5, sidecars: 1, chunks: 4 };
    expect(refine.refineCost("m", 3, 0, history)).toEqual({
      tokensIn: 5100,
      tokensOut: 4200,
      costUsd: 1.5,
      basis: "history",
    });
    expect(refine.refineCost("other", 1, 3, history)).toEqual({
      tokensIn: 1701,
      tokensOut: 1400,
      basis: "unpriced",
    });
  });

  test("estimateRefine counts what the dry run counts, priced by history, the table, or nothing", () => {
    const parsed = parseStream(transcript("e", 3));
    const v2 = { heading: "h", details: "d", key_quotes: [] };
    const sidecar = { chunks: { [chunkId("e", 0)]: v2, [chunkId("e", 1)]: { heading: "v1" } } };
    const chars = [1, 2].reduce(
      (sum, k) => sum + cpLen(`第${k}段的文字。`) + cpLen(`${k}:00 — 第${k}段`),
      0,
    );
    const tokensIn = 1700 * 2 + Math.floor(chars / 2);
    const tokensOut = 1400 * 2;
    const flash = refine.estimateRefine(parsed, "~google/gemini-flash-latest", { sidecar });
    expect(flash).toEqual({
      chunks: 3,
      done: 1,
      tokensIn,
      tokensOut,
      costUsd: (tokensIn * 0.075 + tokensOut * 0.3) / 1_000_000,
      basis: "price-table",
    });
    expect(refine.estimateRefine(parsed, "~google/gemini-pro-latest", { sidecar })).toEqual({
      chunks: 3,
      done: 1,
      tokensIn,
      tokensOut,
      basis: "unpriced",
    });
    const history = refine.refineHistory(
      [
        {
          stats: {
            model: "m",
            cost_usd: new PyFloat(0.3),
            chunks_refined: 10,
            cost_source: "openrouter",
          },
        },
        { stats: { model: "m", cost_usd: 0.1, chunks_refined: 10, cost_source: "estimate" } },
        { stats: { model: "m", cost_usd: 0, chunks_refined: 5, cost_source: "unknown" } },
        { stats: { model: "other", cost_usd: 9, chunks_refined: 1, cost_source: "openrouter" } },
        { chunks: {} },
        null,
      ],
      "m",
    );
    expect(history).toEqual({ model: "m", usdPerChunk: 0.4 / 20, sidecars: 2, chunks: 20 });
    expect(refine.estimateRefine(parsed, "m", { sidecar, history })).toMatchObject({
      costUsd: 2 * (0.4 / 20),
      basis: "history",
    });
    expect(refine.refineHistory([], "m")).toBeNull();
    // Without a sidecar given, the stream's own is read; here there is none.
    expect(refine.estimateRefine(parsed, "m").done).toBe(0);
  });
});
