// Compares e2e-call.ts reports of two engines, or two deployments: a baseline's runs against a
// candidate's, mode by mode and turn by turn. It diffs their checks, their RTVI event sequences,
// stagesMs, latencyMs and audible spans, then holds the candidate to the native engine's pass bar
// (docs/voice-engine.md, "Parity tests"). Reads reports only, so it scores recorded ones too.
import { resolve } from "node:path";
import { pacingByTurn, type TimelineEntry, type Turn } from "./e2e/turns.ts";

/** How much worse than the baseline a candidate's median may be. */
const SLACK_MS = 100;
/** How long after her last audible audio bot-stopped-speaking may come. */
const STOPPED_AFTER_AUDIO_MS = 500;

const USAGE = `usage: bun apps/bot/scripts/e2e-compare.ts <baseline.json> <candidate.json>
       bun apps/bot/scripts/e2e-compare.ts <baseline.json>... --vs <candidate.json>...

  Reports of the same mode are compared: medians across each side's runs, and the event sequence
  of each side's first run. The candidate passes when every check of every run passes, I1-I10
  hold, its median question end -> first reply audio, TTS start -> bot-started-speaking and gap
  between sentences are each no more than the baseline's + ${SLACK_MS} ms, bot-stopped-speaking lands
  within ${STOPPED_AFTER_AUDIO_MS} ms of its last audible audio, and bot-tts-stopped comes in every turn.

  --json <file>   also write the comparison as JSON
  exit status     0 the candidate passes, 1 it doesn't, 2 bad arguments`;

class UsageError extends Error {}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

interface Stage {
  stage: string;
  t: number;
  deltaMs: number;
}

/** What this script reads of an e2e-call.ts report. */
interface Report {
  harness: { mode: string; engine?: string | null; baseUrl: string; startedAt: string };
  checks: Check[];
  latencyMs: Record<string, number | null>;
  stagesMs: Record<string, Stage[]>;
  invariants?: { id: string; index: number; detail: string }[];
  audibleSpans: { bot: [number, number][]; mic: [number, number][] };
  timeline: TimelineEntry[];
}

interface Side {
  label: string;
  files: string[];
  reports: Report[];
}

function parseArgs(argv: string[]): {
  baseline: string[];
  candidate: string[];
  json: string | null;
} {
  let json: string | null = null;
  const files: string[] = [];
  let split = -1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--json needs a file");
      json = resolve(value);
    } else if (arg === "--vs") {
      if (split !== -1) throw new UsageError("--vs comes once");
      split = files.length;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown argument: ${arg}`);
    } else {
      files.push(resolve(arg));
    }
  }
  if (split === -1) {
    if (files.length !== 2) throw new UsageError("give two reports, or use --vs");
    split = 1;
  }
  const baseline = files.slice(0, split);
  const candidate = files.slice(split);
  if (baseline.length === 0 || candidate.length === 0) {
    throw new UsageError("each side needs at least one report");
  }
  return { baseline, candidate, json };
}

async function load(files: string[], fallback: string): Promise<Side> {
  const reports = await Promise.all(
    files.map(async (file) => (await Bun.file(file).json()) as Report),
  );
  const engines = [...new Set(reports.map((r) => r.harness.engine).filter(Boolean))];
  return { label: engines.length === 1 ? String(engines[0]) : fallback, files, reports };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const numbers = (values: readonly (number | null | undefined)[]) =>
  values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

function endOf(report: Report): number {
  return Math.max(0, ...report.timeline.map((e) => e.t));
}

function pacingOf(report: Report) {
  return pacingByTurn(report.timeline, report.audibleSpans.bot, endOf(report));
}

// What a client sees of her turn-taking: the RTVI events client-js raises, without transport and
// media noise, and each run of botLlmText as one.
const SEQUENCE = /^(bot|user|llm|serverMessage|error)/;
const NOISE = new Set(["botLlmSearchResponse", "metrics"]);

function sequence(report: Report): string[] {
  const out: string[] = [];
  for (const entry of report.timeline) {
    if (entry.source !== "rtvi" || !SEQUENCE.test(entry.event) || NOISE.has(entry.event)) continue;
    if (entry.event === "botLlmText" && out.at(-1) === "botLlmText") continue;
    out.push(entry.event);
  }
  return out;
}

/** The longest-common-subsequence diff of two event sequences, as `  x`, `- x` and `+ x` lines. */
function diffLines(a: readonly string[], b: readonly string[]): string[] {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i] as number[];
      row[j] =
        a[i] === b[j]
          ? (table[i + 1] as number[])[j + 1]! + 1
          : Math.max((table[i + 1] as number[])[j]!, row[j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(`    ${a[i++]}`);
      j++;
    } else if (j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      lines.push(`  - ${a[i++]}`);
    } else {
      lines.push(`  + ${b[j++]}`);
    }
  }
  return lines;
}

interface Row {
  what: string;
  baseline: number | null;
  candidate: number | null;
}

const delta = (row: Row) =>
  row.baseline === null || row.candidate === null ? null : row.candidate - row.baseline;

function stageRows(base: Report[], cand: Report[]): Row[] {
  const rows: Row[] = [];
  const turns = new Set([...base, ...cand].flatMap((r) => Object.keys(r.stagesMs)));
  for (const turn of turns) {
    const stages = new Set(
      [...base, ...cand].flatMap((r) => (r.stagesMs[turn] ?? []).map((s) => s.stage)),
    );
    for (const stage of stages) {
      const of = (reports: Report[]) =>
        median(
          numbers(reports.map((r) => r.stagesMs[turn]?.find((s) => s.stage === stage)?.deltaMs)),
        );
      rows.push({ what: `${turn}: ${stage}`, baseline: of(base), candidate: of(cand) });
    }
  }
  return rows;
}

function latencyRows(base: Report[], cand: Report[]): Row[] {
  const keys = new Set([...base, ...cand].flatMap((r) => Object.keys(r.latencyMs)));
  return [...keys].map((key) => ({
    what: key,
    baseline: median(numbers(base.map((r) => r.latencyMs[key]))),
    candidate: median(numbers(cand.map((r) => r.latencyMs[key]))),
  }));
}

function spanRows(base: Report[], cand: Report[]): Row[] {
  const rows: Row[] = [];
  const turns: Turn[] = ["greeting", "reply", "barge-in"];
  for (const turn of turns) {
    const stat = (reports: Report[], pick: (r: Report) => number | null) =>
      median(numbers(reports.map(pick)));
    const spansIn = (r: Report) => {
      const p = pacingOf(r)[turn];
      return p === undefined ? null : p.gapsMs.length + 1;
    };
    const gaps = (r: Report) => median(pacingOf(r)[turn]?.gapsMs ?? []);
    const stopped = (r: Report) => pacingOf(r)[turn]?.stoppedAfterAudioMs ?? null;
    const tts = (r: Report) => pacingOf(r)[turn]?.ttsToSpeakingMs ?? null;
    if (![...base, ...cand].some((r) => pacingOf(r)[turn] !== undefined)) continue;
    rows.push(
      {
        what: `${turn}: audible spans`,
        baseline: stat(base, spansIn),
        candidate: stat(cand, spansIn),
      },
      {
        what: `${turn}: gap between spans`,
        baseline: stat(base, gaps),
        candidate: stat(cand, gaps),
      },
      { what: `${turn}: tts -> speaking`, baseline: stat(base, tts), candidate: stat(cand, tts) },
      {
        what: `${turn}: stopped after audio`,
        baseline: stat(base, stopped),
        candidate: stat(cand, stopped),
      },
    );
  }
  return rows;
}

/** The native engine's pass bar, for the candidate's runs of one mode. */
function passBar(base: Report[], cand: Report[]): Check[] {
  const bar: Check[] = [];
  const failing = cand.flatMap((r, i) =>
    r.checks.filter((c) => !c.pass).map((c) => `run ${i + 1} ${c.name}: ${c.detail}`),
  );
  bar.push({
    name: "every check passes",
    pass: failing.length === 0,
    detail: failing.length === 0 ? `${cand.length} runs` : failing.slice(0, 3).join("; "),
  });
  const broken = cand.flatMap((r, i) =>
    r.invariants === undefined
      ? [`run ${i + 1}: no invariants in the report`]
      : r.invariants.map((v) => `run ${i + 1} ${v.id}: ${v.detail}`),
  );
  bar.push({
    name: "I1-I10 hold",
    pass: broken.length === 0,
    detail: broken.length === 0 ? "every run" : broken.slice(0, 3).join("; "),
  });
  const noWorse = (name: string, pick: (r: Report) => number[]) => {
    const b = median(base.flatMap(pick));
    const c = median(cand.flatMap(pick));
    bar.push({
      name,
      pass: b !== null && c !== null && c <= b + SLACK_MS,
      detail: `median ${c ?? "n/a"} ms against ${b ?? "n/a"} ms (+${SLACK_MS} allowed)`,
    });
  };
  noWorse("question end -> reply audio", (r) => numbers([r.latencyMs.questionEndToReplyAudio]));
  noWorse("tts start -> speaking", (r) =>
    numbers(Object.values(pacingOf(r)).map((p) => p?.ttsToSpeakingMs)),
  );
  noWorse("gap between sentences", (r) =>
    Object.values(pacingOf(r)).flatMap((p) => p?.gapsMs ?? []),
  );
  // A turn cut by a barge-in stops on the barge-in, not at its audio's end.
  const settled = (r: Report) =>
    Object.entries(pacingOf(r)).filter(
      ([turn]) => !(turn === "reply" && r.harness.mode === "barge-in"),
    );
  const late = cand.flatMap((r, i) =>
    settled(r)
      .filter(
        ([, p]) =>
          p !== undefined &&
          (p.stoppedAfterAudioMs === null || p.stoppedAfterAudioMs > STOPPED_AFTER_AUDIO_MS),
      )
      .map(([turn, p]) => `run ${i + 1} ${turn}: ${p?.stoppedAfterAudioMs ?? "never"}`),
  );
  bar.push({
    name: "stopped speaking on time",
    pass: late.length === 0,
    detail:
      late.length === 0
        ? `within ${STOPPED_AFTER_AUDIO_MS} ms of her audio`
        : late.slice(0, 3).join("; "),
  });
  const silent = cand.flatMap((r, i) =>
    Object.entries(pacingOf(r))
      .filter(([, p]) => p !== undefined && !p.ttsStopped)
      .map(([turn]) => `run ${i + 1} ${turn}`),
  );
  bar.push({
    name: "bot-tts-stopped",
    pass: silent.length === 0,
    detail: silent.length === 0 ? "in every turn" : `missing: ${silent.slice(0, 4).join(", ")}`,
  });
  return bar;
}

function table(title: string, rows: Row[], base: string, cand: string): string[] {
  const lines = [
    `${title}`,
    `  ${"".padEnd(36)} ${base.padStart(10)} ${cand.padStart(10)}   delta`,
  ];
  const cell = (v: number | null) => (v === null ? "n/a" : String(Math.round(v))).padStart(10);
  for (const row of rows) {
    const d = delta(row);
    const shown = d === null ? "" : `${d > 0 ? "+" : ""}${Math.round(d)}`;
    lines.push(`  ${row.what.padEnd(36)} ${cell(row.baseline)} ${cell(row.candidate)}   ${shown}`);
  }
  return lines;
}

function checkRows(base: Report[], cand: Report[]): string[] {
  const names = new Set([...base, ...cand].flatMap((r) => r.checks.map((c) => c.name)));
  const passed = (reports: Report[], name: string) => {
    const runs = reports.filter((r) => r.checks.some((c) => c.name === name));
    const ok = runs.filter((r) => r.checks.find((c) => c.name === name)?.pass).length;
    return runs.length === 0 ? "n/a" : `${ok}/${runs.length}`;
  };
  return [
    "checks (passed/runs)",
    ...[...names].map(
      (name) =>
        `  ${name.padEnd(36)} ${passed(base, name).padStart(10)} ${passed(cand, name).padStart(10)}`,
    ),
  ];
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const baseline = await load(args.baseline, "baseline");
  const candidate = await load(args.candidate, "candidate");
  const modes = [...new Set(candidate.reports.map((r) => r.harness.mode))];
  const out: Record<string, unknown> = {};
  let pass = true;
  for (const mode of modes) {
    const base = baseline.reports.filter((r) => r.harness.mode === mode);
    const cand = candidate.reports.filter((r) => r.harness.mode === mode);
    console.log(
      `\n── ${mode}: ${baseline.label} ×${base.length} vs ${candidate.label} ×${cand.length}`,
    );
    if (base.length === 0) {
      console.log(`  no ${baseline.label} report in this mode`);
      pass = false;
      continue;
    }
    for (const line of checkRows(base, cand)) console.log(line);
    console.log(`events (first run of each: - ${baseline.label} only, + ${candidate.label} only)`);
    for (const line of diffLines(sequence(base[0] as Report), sequence(cand[0] as Report))) {
      console.log(line);
    }
    const stages = stageRows(base, cand);
    const latency = latencyRows(base, cand);
    const spans = spanRows(base, cand);
    for (const line of table("stagesMs (median delta)", stages, baseline.label, candidate.label)) {
      console.log(line);
    }
    for (const line of table("latencyMs (median)", latency, baseline.label, candidate.label)) {
      console.log(line);
    }
    for (const line of table("audible spans (median)", spans, baseline.label, candidate.label)) {
      console.log(line);
    }
    const bar = passBar(base, cand);
    console.log("pass bar");
    for (const check of bar) {
      console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name.padEnd(28)} ${check.detail}`);
    }
    pass &&= bar.every((check) => check.pass);
    out[mode] = { baseline: base.length, candidate: cand.length, stages, latency, spans, bar };
  }
  if (args.json !== null) {
    await Bun.write(
      args.json,
      `${JSON.stringify({ baseline: baseline.files, candidate: candidate.files, pass, modes: out }, null, 2)}\n`,
    );
  }
  console.log(pass ? "\nPASS" : "\nFAIL");
  return pass ? 0 : 1;
}

process.exit(
  await main().catch((error) => {
    console.error(error);
    return 2;
  }),
);
