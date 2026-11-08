// Scores the gate's timeline questions on turns.toml, exactly as the bot asks Jev: the gate's own
// state builder, questions, model and threshold. Writes results.json and exits 1 when any labeled
// turn lands on the wrong side of the threshold. About $0.001 of Jev calls.
//
//   bun docs/benchmarks/2026-11-07-timeline-question/score.ts
import { join } from "node:path";
import {
  findDotenv,
  installSettings,
  loadDotenv,
  logToStderr,
  openrouterHeaders,
} from "../../../packages/config/src/index.ts";
import {
  DEFAULT_GATE_MODEL,
  GATE_QUESTIONS,
  GATE_THRESHOLD,
  GATE_URL,
  gateQuestions,
  gateState,
  TIMELINE_QUESTIONS,
  TIMELINE_THRESHOLD,
} from "../../../packages/context/src/index.ts";

interface Turn {
  readonly set: "dev" | "heldout";
  readonly text: string;
  readonly timeline?: boolean;
  readonly before?: readonly string[];
}

interface Row {
  readonly set: string;
  readonly text: string;
  readonly timeline: boolean | null;
  readonly score: number;
  readonly retrieve: boolean;
  readonly nouls: Record<string, number>;
  readonly ms: number;
  readonly model: string;
}

logToStderr();
loadDotenv(findDotenv(import.meta.dir), { override: true });
installSettings();
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
const model = process.env.RETRIEVAL_GATE_MODEL || DEFAULT_GATE_MODEL;
const headers = {
  ...openrouterHeaders(),
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

async function ask(turn: Pick<Turn, "text" | "before">): Promise<Omit<Row, "set" | "timeline">> {
  const history = (turn.before ?? []).map((content, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content,
  }));
  const started = performance.now();
  const response = await fetch(GATE_URL, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model,
      state: gateState([...history, { role: "user", content: turn.text }]),
      questions: { ...gateQuestions(), ...TIMELINE_QUESTIONS },
    }),
  });
  const ms = Math.round(performance.now() - started);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const body = (await response.json()) as { model: string; answers: Record<string, { noul: number }> };
  const nouls = Object.fromEntries(Object.entries(body.answers).map(([k, v]) => [k, v.noul]));
  const max = (keys: string[]) => Math.max(...keys.map((key) => nouls[key] as number));
  return {
    text: (turn.before ? "…" : "") + turn.text,
    score: max(Object.keys(TIMELINE_QUESTIONS)),
    retrieve: max(Object.keys(GATE_QUESTIONS)) >= GATE_THRESHOLD,
    nouls,
    ms,
    model: body.model,
  };
}

function summarize(rows: readonly Row[]) {
  const timeline = rows.filter((r) => r.timeline === true);
  const other = rows.filter((r) => r.timeline === false);
  return {
    timeline_kept: `${timeline.filter((r) => r.score >= TIMELINE_THRESHOLD).length}/${timeline.length}`,
    other_below: `${other.filter((r) => r.score < TIMELINE_THRESHOLD).length}/${other.length}`,
    lowest_timeline_score: Math.min(...timeline.map((r) => r.score)),
    highest_other_score: Math.max(...other.map((r) => r.score)),
    timeline_turns_retrieved: `${timeline.filter((r) => r.retrieve).length}/${timeline.length}`,
  };
}

const here = import.meta.dir;
const { turn: turns } = Bun.TOML.parse(await Bun.file(join(here, "turns.toml")).text()) as {
  turn: Turn[];
};
await ask({ text: "你好" }); // opens the connection, as a live session has
const rows: Row[] = [];
for (const turn of turns) {
  rows.push({ set: turn.set, timeline: turn.timeline ?? null, ...(await ask(turn)) });
}

const latency = rows.map((r) => r.ms).sort((a, b) => a - b);
const result = {
  model: [...new Set(rows.map((r) => r.model))].sort(),
  threshold: TIMELINE_THRESHOLD,
  latency_ms: { p50: latency[Math.floor(latency.length / 2)], max: latency.at(-1) },
  sets: {
    dev: summarize(rows.filter((r) => r.set === "dev")),
    heldout: summarize(rows.filter((r) => r.set === "heldout")),
    all: summarize(rows),
  },
  turns: rows.map(({ ms: _ms, model: _model, ...row }) => row),
};
await Bun.write(join(here, "results.json"), `${JSON.stringify(result, null, 1)}\n`);

console.log(`model ${result.model.join(", ")}, threshold ${TIMELINE_THRESHOLD}`);
for (const [name, summary] of Object.entries(result.sets)) console.log(name, summary);
for (const r of rows.filter((row) => row.timeline === null)) {
  console.log(`borderline ${r.score.toFixed(2)} ${r.text}`);
}
const wrong = rows.filter(
  (r) => r.timeline !== null && r.timeline !== r.score >= TIMELINE_THRESHOLD,
);
for (const r of wrong) {
  console.log(`WRONG ${r.timeline ? "missed" : "fired"} ${r.score.toFixed(2)} ${r.text}`);
}
process.exit(wrong.length > 0 ? 1 : 0);
