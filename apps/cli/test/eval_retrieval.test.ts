import "../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, installSettings, resetSettings } from "@eidolon/config";
import { setUsageSink, type UsageRecord } from "@eidolon/providers";
import type { HybridSearchOptions, Reranker, SearchRow } from "@eidolon/retrieval";
import {
  aggregate,
  benchmarkMeanMs,
  benchmarkMedianMs,
  benchmarkP95Ms,
  type EvalDeps,
  type EvalQuery,
  evalRetrievalMain,
  fmtPct,
  loadQueries,
  namedReranker,
  type QueryResult,
  type RerankerBenchmark,
  rowTextForMatch,
} from "../src/index.ts";
import {
  blockNetwork,
  captureIo,
  captureLogs,
  FIX,
  golden,
  placehold,
  setEnv,
  substitute,
} from "./helpers.ts";

blockNetwork();

interface Case {
  argv: string[];
  reranker: string | null;
  env: Record<string, string>;
  code: number;
  crash: [string, string] | null;
  stdout: string;
  stderr: string;
  logs: [string, string][];
  calls: unknown[][];
  embeds: string[];
  opened: string[];
  saved: string | null;
}

const ROWS: Record<string, SearchRow[]> = (await Bun.file(`${FIX}/eval/rows.json`).json()).rows;
// The fake clock's steps in milliseconds, which the goldens' timings follow.
const STEPS = [125, 250, 500, 62.5, 1000];
const goldens = await golden<Case[]>("eval_retrieval.json");

let out = "";
let restoreEnv = () => {};
let logs!: ReturnType<typeof captureLogs>;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "cli-eval-"));
  restoreEnv = setEnv({
    OPENROUTER_API_KEY: undefined,
    RERANK_API_KEY: undefined,
    RERANK_BASE_URL: undefined,
    // The --db-path the goldens were recorded with.
    LANCEDB_PATH: "data/lancedb",
  });
  logs = captureLogs();
});
afterEach(() => {
  logs.stop();
  restoreEnv();
  rmSync(out, { recursive: true, force: true });
});

/** The fakes behind the goldens: canned rows by (table, text, path), a stepping clock. */
function fakes(reranker: string | null) {
  const calls: unknown[][] = [];
  const embeds: string[] = [];
  const opened: string[] = [];
  const texts: string[] = [];
  let clock = 0;
  let ticks = 0;
  const rows = (key: string) => structuredClone(ROWS[key] ?? []);
  const deps: EvalDeps = {
    listTables: async (dbPath) =>
      dbPath === "data/lancedb" ? ["persona_facts", "stream_chunks"] : [],
    openTable: async (_dbPath, name) => {
      opened.push(name);
      return { name };
    },
    embed: async ([text = ""]) => {
      embeds.push(text);
      if (text === "embedding 返回空") return [];
      if (!texts.includes(text)) texts.push(text);
      return [[texts.indexOf(text)]];
    },
    vectorSearch: async (table, options) => {
      const name = (table as { name: string }).name;
      const text = texts[options.vector[0] as number] as string;
      calls.push(["vector", name, text, options.limit, options.where]);
      return rows(`${name}|${text}|vector`);
    },
    hybridSearch: async (table, options: HybridSearchOptions) => {
      const name = (table as { name: string }).name;
      const model = options.rerank ? (options.reranker?.modelName ?? null) : null;
      calls.push([
        "hybrid",
        name,
        options.queryText,
        options.candidates,
        options.where ?? null,
        options.finalK ?? null,
        model,
      ]);
      if (model === "bad" && options.queryText === "坚果体重多少斤") {
        throw new Error("upstream 500");
      }
      if (model === "dead") throw new Error("model gone");
      return rows(`${name}|${options.queryText}|${model === null ? "rrf" : `rerank:${model}`}`);
    },
    makeReranker: () =>
      reranker === null
        ? null
        : ({ modelName: reranker, column: "text", rerank: async () => [] } as Reranker),
    now: () => {
      clock += STEPS[ticks++ % STEPS.length] as number;
      return clock;
    },
  };
  return { deps, calls, embeds, opened };
}

describe("laplace-eval-retrieval matches the Python CLI", () => {
  for (const c of goldens) {
    test(c.argv.join(" "), async () => {
      const paths = { "<FIX>": FIX, "<OUT>": out };
      Object.assign(process.env, c.env);
      const { deps, calls, embeds, opened } = fakes(c.reranker);
      const io = captureIo();
      let code: number;
      let crash: [string, string] | null = null;
      try {
        code = await evalRetrievalMain(
          c.argv.map((arg) => substitute(arg, paths)),
          { ...io.io, ...deps },
        );
      } catch (error) {
        code = 1;
        crash = [(error as Error).name, placehold((error as Error).message, paths)];
      }
      const saveAt = c.argv.indexOf("--save");
      const savedPath = saveAt === -1 ? null : substitute(c.argv[saveAt + 1] as string, paths);
      expect({
        code,
        crash,
        stdout: io.stdout(),
        stderr: io.stderr(),
        logs: logs.records.map(([level, message]) => [level, placehold(message, paths)]),
        calls,
        embeds,
        opened,
        saved: savedPath && existsSync(savedPath) ? readFileSync(savedPath, "utf8") : null,
      }).toEqual({
        code: c.code,
        crash: c.crash,
        stdout: c.stdout,
        stderr: c.stderr,
        logs: c.logs.filter(([level]) => level !== "INFO"),
        calls: c.calls,
        embeds: c.embeds,
        opened: c.opened,
        saved: c.saved,
      });
    });
  }
});

describe("pieces", () => {
  test("loadQueries coerces with str() and defaults notes", () => {
    const queries = loadQueries(`${FIX}/eval/queries.toml`);
    expect(queries).toHaveLength(9);
    expect(queries[0]).toEqual({
      table: "persona_facts",
      text: "你梦想是什么",
      expectSubstrings: ["包租婆", "击碎花店外的大boss"],
      notes: "homophone",
    });
    expect(queries[1]?.notes).toBe("");
    expect(queries[2]?.notes).toBe("3");
  });

  test("loadQueries prints the path as pathlib does", () => {
    expect(() => loadQueries("./x//missing.toml")).toThrow(
      "Queries file not found: x/missing.toml",
    );
  });

  test("rowTextForMatch unions the four fields, falsy ones as empty", () => {
    expect(rowTextForMatch({ text: "t", summary: null, details: 0, heading: "h" })).toBe("t   h");
    expect(rowTextForMatch({})).toBe("   ");
  });

  test("fmtPct rounds ties to even, as Python's format does", () => {
    expect(fmtPct(1)).toBe("100.0%");
    expect(fmtPct(0)).toBe("  0.0%");
    expect(fmtPct(11 / 12)).toBe(" 91.7%");
    // 0.25 and 0.75 are exact ties; toFixed would give 0.3.
    expect(fmtPct(0.0025)).toBe("  0.2%");
    expect(fmtPct(0.0075)).toBe("  0.8%");
  });

  test("aggregate of nothing is the (none) report", () => {
    expect(aggregate([], "t")).toEqual({
      mode: "(none)",
      table: "t",
      nQueries: 0,
      recallAt: new Map([
        [1, 0],
        [3, 0],
        [5, 0],
        [10, 0],
      ]),
      mrr: 0,
      misses: [],
    });
  });

  test("aggregate sums reciprocal ranks in order", () => {
    const query: EvalQuery = { table: "t", text: "q", expectSubstrings: [], notes: "" };
    const result = (rank: number | null): QueryResult => ({
      query,
      mode: "hybrid",
      rank,
      topKHits: new Map([1, 3, 5, 10].map((k) => [k, rank !== null && rank <= k])),
      topText: "",
    });
    const report = aggregate([result(1), result(3), result(null)], "t");
    expect(report.mrr).toBe((1 + 1 / 3 + 0) / 3);
    expect([...report.recallAt.values()]).toEqual([1 / 3, 2 / 3, 2 / 3, 2 / 3]);
    expect(report.misses).toEqual(["q"]);
  });

  test("benchmark latency: statistics.median, nearest-rank p95, mean", () => {
    const bench = (rerankMs: number[]): RerankerBenchmark => ({
      model: "m",
      table: "t",
      nQueries: rerankMs.length,
      recallAt: new Map(),
      mrr: 0,
      rerankMs,
    });
    expect(benchmarkMedianMs(bench([4, 1, 3, 2]))).toBe(2.5);
    expect(benchmarkP95Ms(bench([4, 1, 3, 2]))).toBe(4);
    expect(benchmarkP95Ms(bench(Array.from({ length: 20 }, (_, i) => i)))).toBe(19);
    expect(benchmarkMeanMs(bench([1, 2, 6]))).toBe(3);
    for (const stat of [benchmarkMedianMs, benchmarkP95Ms, benchmarkMeanMs]) {
      expect(stat(bench([]))).toBe(0);
    }
  });

  test("namedReranker takes RERANK_* over OPENROUTER_API_KEY and needs one of them", () => {
    expect(() => namedReranker("m")).toThrow("--rerank-models requires RERANK_API_KEY");
    process.env.OPENROUTER_API_KEY = "or";
    process.env.RERANK_BASE_URL = "https://api.cohere.com/v1/";
    const reranker = namedReranker("rerank-v4.0-fast") as Reranker & { baseUrl: string };
    expect(reranker.modelName).toBe("rerank-v4.0-fast");
    expect(reranker.baseUrl).toBe("https://api.cohere.com/v1");
  });

  test("namedReranker reports each rerank to the usage ledger, as the provider it went to", async () => {
    process.env.OPENROUTER_API_KEY = "or";
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    const blocked = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        results: [{ index: 0, relevance_score: 0.9 }],
        usage: { search_units: 1, cost: 0.002 },
      })) as unknown as typeof globalThis.fetch;
    try {
      await namedReranker("cohere/rerank-4-fast").rerank("q", ["a"]);
      process.env.RERANK_BASE_URL = "https://api.cohere.com/v1";
      await namedReranker("rerank-v4.0-fast").rerank("q", ["a"]);
    } finally {
      globalThis.fetch = blocked;
      setUsageSink(null);
    }
    expect(
      records.map(({ role, provider, model, costUsd }) => [role, provider, model, costUsd]),
    ).toEqual([
      ["rerank", "openrouter", "cohere/rerank-4-fast", 0.002],
      ["rerank", "cohere", "rerank-v4.0-fast", 0.002],
    ]);
  });

  test("namedReranker takes the key the local app saved in OpenRouter's account", () => {
    const credentials = join(dataHome(), "credentials.json");
    mkdirSync(dataHome(), { recursive: true });
    writeFileSync(
      credentials,
      JSON.stringify({ accounts: { openrouter: { provider: "openrouter", apiKey: "or-saved" } } }),
      { mode: 0o600 },
    );
    installSettings();
    try {
      expect(namedReranker("m").modelName).toBe("m");
    } finally {
      rmSync(credentials, { force: true });
      resetSettings();
    }
  });
});
