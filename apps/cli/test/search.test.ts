import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger } from "@eidolon/config";
import type { Retriever, SearchOptions, SearchRow } from "@eidolon/retrieval";
import { searchMain } from "../src/index.ts";
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
  hits: string[];
  has_table: boolean;
  code: number;
  stdout: string;
  stderr: string;
  opened: [string, string][];
  calls: Record<string, unknown>[];
}

const HITS: SearchRow[] = (await Bun.file(`${FIX}/search_hits.json`).json()).hits;
const PATHS = { "<FIX>": FIX };
const goldens = await golden<Case[]>("search.json");

let restoreEnv = () => {};
let logs!: ReturnType<typeof captureLogs>;
beforeEach(() => {
  // Python's default --db-path, which the goldens were recorded with.
  restoreEnv = setEnv({
    STREAM_ARCHIVE_CANDIDATES: undefined,
    PERSONA_TIMEZONE: undefined,
    LANCEDB_PATH: "data/lancedb",
  });
  logs = captureLogs();
});
afterEach(() => {
  logs.stop();
  restoreEnv();
});

/** A retriever that answers with fixed hits and records each search. */
function fakeRetriever(hits: readonly SearchRow[], hasTable: boolean) {
  const calls: Record<string, unknown>[] = [];
  const retriever: Retriever = {
    hasTable,
    rowCount: async () => (hasTable ? 44339 : 0),
    search: async (query: string, options: SearchOptions) => {
      calls.push({
        query,
        candidates: options.candidates,
        top_k: options.topK,
        date_prefilter: options.datePrefilter ?? true,
        where: options.where ?? null,
      });
      return hasTable ? structuredClone([...hits]) : [];
    },
  };
  return { retriever, calls };
}

async function run(c: Case) {
  const hits = c.hits.map((id) => HITS.find((hit) => String(hit.id ?? "?") === id) as SearchRow);
  const { retriever, calls } = fakeRetriever(hits, c.has_table);
  const opened: [string, string][] = [];
  const out = captureIo();
  const code = await searchMain(
    c.argv.map((arg) => substitute(arg, PATHS)),
    {
      ...out.io,
      openRetriever: async (dbPath, table) => {
        opened.push([placehold(dbPath, PATHS), table]);
        return retriever;
      },
    },
  );
  return { code, stdout: out.stdout(), stderr: out.stderr(), opened, calls };
}

describe("laplace-search matches the Python CLI", () => {
  for (const c of goldens) {
    test(c.argv.join(" "), async () => {
      expect(await run(c)).toEqual({
        code: c.code,
        stdout: c.stdout,
        stderr: c.stderr,
        opened: c.opened,
        calls: c.calls,
      });
    });
  }
});

test("STREAM_ARCHIVE_CANDIDATES sizes the search pool", async () => {
  process.env.STREAM_ARCHIVE_CANDIDATES = "40";
  const { retriever, calls } = fakeRetriever([], true);
  const code = await searchMain(["q"], { ...captureIo().io, openRetriever: async () => retriever });
  expect(code).toBe(0);
  expect(calls).toEqual([
    { query: "q", candidates: 40, top_k: 5, date_prefilter: true, where: null },
  ]);
});

test("--today without --recall is a usage error, before any table opens", async () => {
  const out = captureIo();
  let opened = false;
  const code = await searchMain(["q", "--today", "2026-09-09"], {
    ...out.io,
    openRetriever: async () => {
      opened = true;
      throw new Error("unreachable");
    },
  });
  expect(code).toBe(2);
  expect(opened).toBe(false);
  expect(out.stderr()).toEndWith("laplace-search: error: --today requires --recall\n");
});

test("log lines below WARNING stay out of the output", async () => {
  const { retriever } = fakeRetriever([], false);
  await searchMain(["q"], { ...captureIo().io, openRetriever: async () => retriever });
  logger.info("hidden");
  logger.warning("shown");
  expect(logs.records).toEqual([["WARNING", "shown"]]);
});
