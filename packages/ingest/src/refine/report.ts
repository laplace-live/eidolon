// What laplace-refine prints, as text for the caller to print, and what a run would cost.
import {
  cpLen,
  cpSlice,
  isPlainObject,
  PyFloat,
  pyFixed,
  pyPathName,
  pyRepr,
} from "@eidolon/config";
import { loadSidecar, type ParsedStream, type StreamChunk } from "../streams.ts";
import type { StreamResult } from "./run.ts";
import { fmtCost, PRICING_USD_PER_1M, Usage } from "./usage.ts";
import { isV2Refinement } from "./validate.ts";

/** f-string `{s:<width}`, by code point. */
function ljust(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cpLen(text)));
}

/** f-string `{s:>width}`, by code point. */
function rjust(text: string | number, width: number): string {
  const s = String(text);
  return " ".repeat(Math.max(0, width - cpLen(s))) + s;
}

/** f-string `{n:,}` for an int. */
function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const lines = (rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

/** `print_run_summary`: the per-file table and the run's totals. */
export function formatRunSummary(
  results: readonly StreamResult[],
  model: string,
  totalDuration: number,
): string {
  const overall = new Usage();
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const rows = [
    "",
    "=".repeat(72),
    "Refinement Summary",
    "=".repeat(72),
    `${ljust("File", 40)} ${rjust("New", 5)} ${rjust("Skip", 5)} ${rjust("Fail", 5)} ` +
      `${rjust("Tokens", 14)} ${rjust("Cost", 10)}`,
    "-".repeat(72),
  ];
  for (const result of results) {
    overall.add(result.usage);
    succeeded += result.chunksSucceeded;
    failed += result.chunksFailed;
    skipped += result.chunksSkipped;
    const { usage } = result;
    const tokens = `${rjust(usage.promptTokens, 6)}/${rjust(usage.completionTokens, 6)}`;
    const cost = usage.costUsd ? `$${pyFixed(usage.costUsd, 4)}` : "—";
    let name = pyPathName(result.parsed.mdPath);
    if (cpLen(name) > 40) name = `${cpSlice(name, 0, 37)}...`;
    rows.push(
      `${ljust(name, 40)} ${rjust(result.chunksSucceeded, 5)} ${rjust(result.chunksSkipped, 5)} ` +
        `${rjust(result.chunksFailed, 5)} ${rjust(tokens, 14)} ${rjust(cost, 10)}`,
    );
  }
  const tokens = `${rjust(overall.promptTokens, 6)}/${rjust(overall.completionTokens, 6)}`;
  rows.push(
    "-".repeat(72),
    `${ljust("TOTAL", 40)} ${rjust(succeeded, 5)} ${rjust(skipped, 5)} ${rjust(failed, 5)} ` +
      `${rjust(tokens, 14)} ${rjust(fmtCost(overall), 10)}`,
    "=".repeat(72),
    `Model:    ${model}`,
    `Duration: ${pyFixed(totalDuration, 1)}s`,
  );
  if (succeeded) {
    const avgCost = overall.costUsd ? overall.costUsd / succeeded : 0;
    const avgTime = pyFixed(totalDuration / succeeded, 2);
    rows.push(
      avgCost
        ? `Per chunk: ${avgTime}s avg, $${pyFixed(avgCost, 6)} avg`
        : `Per chunk: ${avgTime}s avg`,
    );
  }
  if (failed) {
    rows.push(
      "",
      `⚠  ${failed} chunks failed and stay unrefined — re-run the same command to retry just ` +
        "the failures.",
    );
  }
  // Also when nothing was refined: every result's usage is then still "unknown".
  if (overall.costSource === "unknown") {
    rows.push(
      "",
      "⚠  Cost is 0 because the model isn't in the local price table and OpenRouter didn't " +
        "return cost. Tokens are accurate.",
    );
  } else if (overall.costSource !== "openrouter") {
    rows.push(
      "",
      `ℹ  Cost source: ${overall.costSource}. OpenRouter didn't surface per-call cost for ` +
        "some/all calls; fell back to local price table.",
    );
  }
  rows.push("");
  return lines(rows);
}

/** The chunks a run would refine: no record yet, or a v1 one. --force would redo the rest too. */
function pendingChunks(parsed: ParsedStream, sidecar: unknown): StreamChunk[] {
  const chunks = isPlainObject(sidecar) && isPlainObject(sidecar.chunks) ? sidecar.chunks : {};
  return parsed.chunks.filter(
    (chunk) => !Object.hasOwn(chunks, chunk.id) || !isV2Refinement(chunks[chunk.id]),
  );
}

/** The characters the dry run counts per chunk: its text and its heading. */
function charsOf(chunks: readonly StreamChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + cpLen(chunk.text) + cpLen(chunk.heading), 0);
}

/**
 * The dry run's token guess for `chunks` chunks holding `chars` characters, at 2 characters a
 * token: an upper bound across languages (Chinese runs ~1.5 tokens a character, English ~0.25),
 * so real runs land at 70-90%.
 */
function guessTokens(chunks: number, chars: number): { tokensIn: number; tokensOut: number } {
  return {
    tokensIn: 600 * chunks + Math.floor(chars / 2) + 1100 * chunks,
    tokensOut: 600 * chunks + 800 * chunks,
  };
}

function priceOf(model: string, tokensIn: number, tokensOut: number): number | null {
  const pricing = PRICING_USD_PER_1M.get(model);
  return pricing === undefined
    ? null
    : (tokensIn * pricing[0] + tokensOut * pricing[1]) / 1_000_000;
}

export interface DryRunReport {
  /** `_dry_run_report`'s text. */
  readonly text: string;
  readonly streams: number;
  /** Chunks the run would refine, and those it would skip. */
  readonly chunks: number;
  readonly skipped: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Null when the price table doesn't list the model; the text then says $0. */
  readonly costUsd: number | null;
}

/** `_dry_run_report`: what refining `streams` with `model` would take, without spending any. */
export function dryRun(streams: readonly ParsedStream[], model: string): DryRunReport {
  const rows = [
    "",
    `Dry run — model: ${model}  (two-pass: extract → synthesize)`,
    "(estimates based on char count; actual cost is usually a bit lower)",
    "",
  ];
  let chunks = 0;
  let skipped = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const parsed of streams) {
    const pending = pendingChunks(parsed, loadSidecar(parsed));
    skipped += parsed.chunks.length - pending.length;
    const name = pyPathName(parsed.mdPath);
    if (pending.length === 0) {
      rows.push(`  ${name}: 0 new chunks`);
      continue;
    }
    const guess = guessTokens(pending.length, charsOf(pending));
    const cost = priceOf(model, guess.tokensIn, guess.tokensOut) ?? 0;
    rows.push(
      `  ${name}: ${pending.length} chunks × 2 passes, ~${thousands(guess.tokensIn)} in / ` +
        `~${thousands(guess.tokensOut)} out → ~$${pyFixed(cost, 4)}`,
    );
    chunks += pending.length;
    tokensIn += guess.tokensIn;
    tokensOut += guess.tokensOut;
  }
  const costUsd = priceOf(model, tokensIn, tokensOut);
  rows.push(
    "",
    `Estimated total: ${chunks} chunks (2 passes each), ~${thousands(tokensIn)} in / ` +
      `~${thousands(tokensOut)} out → ~$${pyFixed(costUsd ?? 0, 4)}`,
  );
  if (costUsd === null) {
    rows.push(`(model ${pyRepr(model)} not in local price table; estimate is $0)`);
  }
  rows.push("");
  return {
    text: lines(rows),
    streams: streams.length,
    chunks,
    skipped,
    tokensIn,
    tokensOut,
    costUsd,
  };
}

/** What a persona's finished runs with one model cost per refined chunk. */
export interface RefineHistory {
  readonly model: string;
  readonly usdPerChunk: number;
  /** The sidecars and chunks it averages over. */
  readonly sidecars: number;
  readonly chunks: number;
}

/**
 * Σ `stats.cost_usd` / Σ `stats.chunks_refined` over the sidecars whose last run used `model` and
 * was priced, or null with none. `stats` describes only a stream's last run while
 * `chunks_refined` counts every run's records, so a stream refined across several runs pulls the
 * mean down.
 */
export function refineHistory(sidecars: Iterable<unknown>, model: string): RefineHistory | null {
  let cost = 0;
  let chunks = 0;
  let count = 0;
  for (const sidecar of sidecars) {
    const stats = isPlainObject(sidecar) ? sidecar.stats : undefined;
    if (!isPlainObject(stats) || stats.model !== model || stats.cost_source === "unknown") continue;
    const usd = numberOf(stats.cost_usd);
    const refined = numberOf(stats.chunks_refined);
    if (usd === null || refined === null || refined <= 0) continue;
    cost += usd;
    chunks += refined;
    count++;
  }
  return chunks > 0 ? { model, usdPerChunk: cost / chunks, sidecars: count, chunks } : null;
}

function numberOf(value: unknown): number | null {
  if (value instanceof PyFloat) return value.value;
  return typeof value === "number" ? value : null;
}

/** What refining some chunks would cost, and on what basis. */
export interface RefineCost {
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Absent when unpriced. */
  readonly costUsd?: number;
  readonly basis: "history" | "price-table" | "unpriced";
}

/**
 * The dry run's arithmetic for `chunks` chunks of `chars` characters (text and heading), priced
 * by `history` when it holds the same model, else by the price table. For a video not yet
 * transcribed, guess both from its duration.
 */
export function refineCost(
  model: string,
  chunks: number,
  chars: number,
  history: RefineHistory | null = null,
): RefineCost {
  const guess = guessTokens(chunks, chars);
  if (history !== null && history.model === model) {
    return { ...guess, costUsd: chunks * history.usdPerChunk, basis: "history" };
  }
  const price = priceOf(model, guess.tokensIn, guess.tokensOut);
  return price === null
    ? { ...guess, basis: "unpriced" }
    : { ...guess, costUsd: price, basis: "price-table" };
}

/** One stream's refine work for the pipeline's plan. */
export interface RefineEstimate extends RefineCost {
  /** Every chunk of the transcript. */
  readonly chunks: number;
  /** Chunks with a v2 record; the dry run counts the rest as new. */
  readonly done: number;
}

/** `refineCost` for the chunks of `parsed` a run would refine. Pass `sidecar` if it is loaded. */
export function estimateRefine(
  parsed: ParsedStream,
  model: string,
  options: { readonly sidecar?: unknown; readonly history?: RefineHistory | null } = {},
): RefineEstimate {
  const sidecar = options.sidecar === undefined ? loadSidecar(parsed) : options.sidecar;
  const pending = pendingChunks(parsed, sidecar);
  return {
    chunks: parsed.chunks.length,
    done: parsed.chunks.length - pending.length,
    ...refineCost(model, pending.length, charsOf(pending), options.history ?? null),
  };
}
