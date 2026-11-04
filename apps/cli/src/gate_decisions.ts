// Scores the retrieval gate on labeled turns exactly as the bot asks Jev, through the gate's own
// state builder, questions, model and threshold, into decisions.json. About $0.002 of Jev calls.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  envOptional,
  httpxStatusMessage,
  isPlainObject,
  openrouterHeaders,
  PROJECT_ROOT,
  PyFloat,
  pyError,
  pyFixed,
  pyJsonDumps,
  pyRepr,
  sortedPy,
} from "@eidolon/config";
import {
  DEFAULT_GATE_MODEL,
  GATE_THRESHOLD,
  GATE_URL,
  gateQuestions,
  gateState,
} from "@eidolon/context";
import { type CliIo, printer, resolveIo } from "./io.ts";
import { ljust, loadsPy, median, numOf, type PyNumber, pyRound, quantilesExclusive } from "./py.ts";

export const BENCHMARK_DIR = join(PROJECT_ROOT, "docs/benchmarks/2026-09-19-retrieval-gate");
const TIMEOUT_MS = 20_000;
const SETS = ["dev", "heldout", "fresh"] as const;

export interface GateTurnSpec {
  readonly set?: string;
  readonly text: string;
  /** true needs recall, false is chit-chat, absent is borderline. */
  readonly recall?: boolean;
  /** Earlier lines, alternating viewer and streamer, oldest first. */
  readonly before?: readonly string[];
}

export interface GateRow {
  readonly set: string | null;
  readonly text: string;
  readonly recall: boolean | null;
  readonly score: PyNumber;
  readonly nouls: Readonly<Record<string, PyNumber>>;
  readonly ms: number;
  readonly model: string;
}

export interface GateSummary {
  readonly recall_kept: string;
  readonly chit_chat_skipped: string;
  readonly lowest_recall_score: PyNumber | null;
  readonly highest_chit_chat_score: PyNumber | null;
}

/** The context the bot would hold: `before` alternating user/assistant, then the turn itself. */
export function turnMessages(
  turn: GateTurnSpec,
): { role: "user" | "assistant"; content: string }[] {
  return [
    ...(turn.before ?? []).map((content, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content,
    })),
    { role: "user", content: turn.text },
  ];
}

// Python's min()/max() keep the first of equal values.
function extreme(values: readonly PyNumber[], better: (a: number, b: number) => boolean) {
  let best: PyNumber | null = null;
  for (const value of values) if (best === null || better(numOf(value), numOf(best))) best = value;
  return best;
}

export function summarize(rows: readonly GateRow[]): GateSummary {
  const recall = rows.filter((r) => r.recall === true);
  const chat = rows.filter((r) => r.recall === false);
  const kept = recall.filter((r) => numOf(r.score) >= GATE_THRESHOLD).length;
  const skipped = chat.filter((r) => numOf(r.score) < GATE_THRESHOLD).length;
  return {
    recall_kept: `${kept}/${recall.length}`,
    chit_chat_skipped: `${skipped}/${chat.length}`,
    lowest_recall_score: extreme(
      recall.map((r) => r.score),
      (a, b) => a < b,
    ),
    highest_chit_chat_score: extreme(
      chat.map((r) => r.score),
      (a, b) => a > b,
    ),
  };
}

/** `statistics.median` of ints: the middle int, or a float mean of the middle two. */
function medianPy(data: readonly number[]): PyNumber {
  const m = median(data);
  return data.length % 2 === 0 ? new PyFloat(m) : m;
}

/** `statistics.quantiles(data, n=10)[-1]`: interpolated floats, or the lone int repeated. */
function p90Py(data: readonly number[]): PyNumber {
  const q = quantilesExclusive(data, 10).at(-1) as number;
  return data.length < 2 ? q : new PyFloat(q);
}

function subscript(container: unknown, key: string): unknown {
  if (!isPlainObject(container)) throw pyError("TypeError", "object is not subscriptable");
  if (!(key in container)) throw pyError("KeyError", `'${key}'`);
  return container[key];
}

function asNumber(value: unknown): PyNumber {
  if (typeof value === "number" || value instanceof PyFloat) return value;
  throw pyError("TypeError", `noul is not a number: ${pyRepr(value)}`);
}

interface AskOptions {
  readonly model: string;
  readonly headers: Record<string, string>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

/** One Jev call for one turn; any failure raises, since a benchmark must not fail open. */
export async function ask(turn: GateTurnSpec, options: AskOptions): Promise<GateRow> {
  if (!("text" in turn)) throw pyError("KeyError", "'text'");
  if (typeof turn.text !== "string") throw pyError("TypeError", "turn text is not a str");
  const history = turn.before ?? [];
  const started = options.now();
  const response = await options.fetch(GATE_URL, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify({
      model: options.model,
      state: gateState(turnMessages(turn)),
      questions: gateQuestions(),
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  const ms = options.now() - started;
  if (!response.ok) {
    throw pyError("HTTPStatusError", httpxStatusMessage(response, GATE_URL));
  }
  const body = loadsPy(text);
  const answers = subscript(body, "answers");
  if (!isPlainObject(answers)) throw pyError("AttributeError", "object has no attribute 'items'");
  const nouls: Record<string, PyNumber> = {};
  for (const [name, answer] of Object.entries(answers)) {
    nouls[name] = asNumber(subscript(answer, "noul"));
  }
  const score = extreme(Object.values(nouls), (a, b) => a > b);
  if (score === null) throw pyError("ValueError", "max() iterable argument is empty");
  const model = subscript(body, "model");
  if (typeof model !== "string") throw pyError("TypeError", "model is not a string");
  return {
    set: turn.set ?? null,
    text: (history.length > 0 ? "…" : "") + turn.text,
    recall: turn.recall ?? null,
    score,
    nouls,
    ms: pyRound(ms),
    model,
  };
}

export interface GateDecisionsOptions extends Partial<CliIo> {
  readonly turnsPath?: string;
  readonly outPath?: string;
  readonly fetch?: typeof fetch;
  /** Milliseconds; performance.now by default. */
  readonly now?: () => number;
}

/** The decisions.json document, keys in Python's order. */
export function decisionsResult(rows: readonly GateRow[]): Record<string, unknown> {
  const latency = rows.map((r) => r.ms);
  if (latency.length === 0) throw pyError("StatisticsError", "no median for empty data");
  const sets: Record<string, GateSummary> = {};
  for (const name of SETS) sets[name] = summarize(rows.filter((r) => r.set === name));
  sets.all = summarize(rows);
  return {
    model: sortedPy(new Set(rows.map((r) => r.model))),
    threshold: GATE_THRESHOLD,
    latency_ms: { p50: medianPy(latency), p90: p90Py(latency), max: Math.max(...latency) },
    sets,
    turns: rows.map(({ set, text, recall, score, nouls }) => ({ set, text, recall, score, nouls })),
  };
}

/** The benchmark run; resolves to the exit code: 1 when a turn that needs recall scored too low. */
export async function runGateDecisions(options: GateDecisionsOptions = {}): Promise<number> {
  const io = resolveIo(options);
  const print = printer(io.stdout);
  const turnsPath = options.turnsPath ?? join(BENCHMARK_DIR, "turns.toml");
  const outPath = options.outPath ?? join(BENCHMARK_DIR, "decisions.json");
  const parsed = Bun.TOML.parse(readFileSync(turnsPath, "utf8")) as Record<string, unknown>;
  const turns = subscript(parsed, "turn") as GateTurnSpec[];
  const model = envOptional("RETRIEVAL_GATE_MODEL") ?? DEFAULT_GATE_MODEL;
  const apiKey = envOptional("OPENROUTER_API_KEY");
  if (apiKey === undefined) throw pyError("KeyError", "'OPENROUTER_API_KEY'");
  const askTurn = (turn: GateTurnSpec) =>
    ask(turn, {
      model,
      headers: {
        ...openrouterHeaders(),
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      fetch: options.fetch ?? fetch,
      now: options.now ?? (() => performance.now()),
    });
  // Opens the connection, as a live session has.
  await askTurn({ text: "你好" });
  const rows: GateRow[] = [];
  for (const turn of turns) rows.push(await askTurn(turn));

  const result = decisionsResult(rows);
  writeFileSync(outPath, `${pyJsonDumps(result, { ensureAscii: false, indent: 1 })}\n`, "utf8");

  print(
    `model ${pyRepr(result.model)}, threshold ${pyRepr(result.threshold)}, ` +
      `latency ${pyRepr(result.latency_ms)}`,
  );
  for (const [name, summary] of Object.entries(result.sets as Record<string, GateSummary>)) {
    print(`${ljust(name, 8)} ${pyRepr(summary)}`);
  }
  for (const r of rows) {
    if (r.recall === null) print(`borderline ${pyFixed(numOf(r.score), 2)} ${r.text}`);
  }
  const missed = rows.filter((r) => r.recall === true && numOf(r.score) < GATE_THRESHOLD);
  for (const r of missed) {
    print(`MISSED ${pyFixed(numOf(r.score), 2)} ${r.text} ${pyRepr(r.nouls)}`);
  }
  return missed.length > 0 ? 1 : 0;
}

/** The `gate-decisions` command. decisions.py takes no arguments and ignores any it is given. */
export function gateDecisionsMain(
  _argv: readonly string[],
  options: GateDecisionsOptions = {},
): Promise<number> {
  return runGateDecisions(options);
}
