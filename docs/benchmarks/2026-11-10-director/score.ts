// Scores the group-chat director on lines.json as a chat asks it: the director's own state,
// questions and rules, on the gate role's model. Writes decisions.json, with each question's scores
// by label and the threshold they suggest. --check exits 1 when a line is decided wrong; --cached
// re-decides the stored scores instead of asking Jev. About $0.003 of Jev calls.

// Must stay the first import: the .env and settings files, as the laplace-* commands load them.
import "../../../apps/cli/src/load-env.ts";
import { join } from "node:path";
import { parseMentions } from "../../../packages/chat/src/index.ts";
import { extractCostUsd, setLogLevel } from "../../../packages/config/src/index.ts";
import {
  ADDRESSED_THRESHOLD,
  DIRECTOR_TIMEOUT_SEC,
  Director,
  type DirectorDecision,
  type DirectorInput,
  type DirectorLine,
  type DirectorParticipant,
  gateRoleDecisions,
  HOP_STEP,
  INTEREST_THRESHOLD,
  INVITES_THRESHOLD,
  JUST_SPOKE_PENALTY,
  MAX_REPLIES_TO_USER,
} from "../../../packages/context/src/index.ts";

const VIEWER = "viewer";

/** A speaker (a persona id, or "viewer") and her text. */
type Said = readonly [speaker: string, text: string];

interface Persona {
  readonly name: string;
  readonly shortName: string;
  readonly summary: string;
  readonly interests: readonly string[];
  readonly talkativeness: number;
}

interface Line {
  readonly id: string;
  readonly kind: string;
  readonly participants: readonly string[];
  readonly history?: readonly Said[];
  readonly latest: Said;
  /** Absent when the line speaks to the room, or nobody can tell. */
  readonly addressed?: readonly string[];
  readonly interested: readonly string[];
  readonly responders: readonly string[];
  readonly maybe?: readonly string[];
  readonly invites_reply: boolean;
  /** How many persona lines after the viewer's last answer it, as one decision; absent is 1. */
  readonly viewer_replies?: number;
  readonly note?: string;
}

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly hop: number;
  readonly latest: string;
  readonly mentions: readonly string[];
  readonly responders: readonly string[];
  readonly maybe: readonly string[];
  readonly decided: readonly string[];
  readonly source: DirectorDecision["source"];
  readonly right: boolean;
  readonly scores: Readonly<Record<string, number>>;
  readonly ms: number;
  readonly model: string;
}

interface Point {
  readonly id: string;
  readonly persona: string | null;
  readonly score: number;
  readonly positive: boolean;
}

const here = import.meta.dir;
const argv = Bun.argv.slice(2);
const check = argv.includes("--check");
const cached = argv.includes("--cached");
setLogLevel("WARNING");

const { personas, lines } = (await Bun.file(join(here, "lines.json")).json()) as {
  personas: Record<string, Persona>;
  lines: Line[];
};

const candidatesOf = (line: Line) => line.participants.filter((id) => id !== line.latest[0]);
const saidOf = (line: Line): Said[] => [...(line.history ?? []), line.latest];
const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** Persona lines since the viewer's last, the latest included. */
function spokenOf(said: readonly Said[]): number {
  let spoken = 0;
  for (let i = said.length - 1; i >= 0 && said[i]?.[0] !== VIEWER; i--) spoken++;
  return spoken;
}

/**
 * `DirectorInput.hop` as runChat counts it, one a decision: 0 for the viewer's line, 1 for the last
 * of its replies, then one more for each persona line after them.
 */
function hopOf(line: Line): number {
  const spoken = spokenOf(saidOf(line));
  return spoken === 0 ? 0 : spoken - (line.viewer_replies ?? 1) + 1;
}

/** Whoever spoke the persona line before the latest, the one the just-spoke penalty falls on. */
function spokeBefore(said: readonly Said[]): string | undefined {
  return said.slice(0, -1).findLast(([speaker]) => speaker !== VIEWER)?.[0];
}

function validate(): void {
  const seen = new Set<string>();
  for (const line of lines) {
    const fail = (problem: string) => {
      throw new Error(`lines.json ${line.id}: ${problem}`);
    };
    if (seen.has(line.id)) fail("a second line with this id");
    seen.add(line.id);
    if (line.participants.length < 2) fail("a group needs two or more personas");
    for (const id of line.participants) if (!(id in personas)) fail(`no persona ${id}`);
    for (const [speaker] of saidOf(line)) {
      if (speaker !== VIEWER && !line.participants.includes(speaker)) fail(`${speaker} isn't here`);
    }
    const replies = line.viewer_replies;
    if (replies !== undefined && replies > Math.min(spokenOf(saidOf(line)), MAX_REPLIES_TO_USER)) {
      fail(`viewer_replies ${replies}: more than the lines since hers, or than a decision chooses`);
    }
    const candidates = candidatesOf(line);
    const labels = [
      ...(line.addressed ?? []),
      ...line.interested,
      ...line.responders,
      ...(line.maybe ?? []),
    ];
    for (const id of labels) if (!candidates.includes(id)) fail(`${id} can't answer this line`);
    if (line.responders.some((id) => line.maybe?.includes(id))) fail("a responder is also maybe");
  }
}

function participantOf(id: string): DirectorParticipant {
  const { name, shortName, summary, interests, talkativeness } = personas[id] as Persona;
  return { id, name, shortName, summary, interests, talkativeness };
}

/** Each question's answer from a stored row, as the Decisions API shapes it. */
function replaying(row: Row): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const missing = Object.keys(questions).filter((key) => !(key in row.scores));
    if (missing.length > 0) {
      throw new Error(`${row.id} has no stored ${missing.join(", ")}: score it without --cached`);
    }
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: "noul", noul: row.scores[key] }]),
    );
    return Response.json({ model: row.model, answers });
  }) as unknown as typeof fetch;
}

let answered: { ms: number; model: string; costUsd: number | null } | null = null;

/** The real fetch, noting how long Jev took and what the answer cost. */
const recording = (async (url: string, init: RequestInit) => {
  const started = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  let body: { model?: unknown; usage?: unknown } = {};
  try {
    body = JSON.parse(text);
  } catch {}
  answered = {
    ms: Math.round(performance.now() - started),
    model: typeof body.model === "string" ? body.model : "",
    costUsd: extractCostUsd(body.usage),
  };
  return new Response(text, { status: response.status, statusText: response.statusText });
}) as unknown as typeof fetch;

function liveDirector(): Director {
  const options = gateRoleDecisions((error) => {
    throw error;
  });
  if (options === null) {
    throw new Error("the gate role has no key: set OPENROUTER_API_KEY, or its account's key");
  }
  // The bot gives up after DIRECTOR_TIMEOUT_SEC; a benchmark waits, and counts the slow answers.
  return new Director({ ...options, fetch: recording, timeoutSec: 30 });
}

function inputOf(line: Line): DirectorInput {
  const participants = line.participants.map(participantOf);
  const said = saidOf(line);
  return {
    participants,
    lines: said.map(
      ([speaker, text]): DirectorLine =>
        speaker === VIEWER
          ? { speaker: { kind: "user" }, text }
          : { speaker: { kind: "persona", id: speaker }, text },
    ),
    hop: hopOf(line),
    mentions: parseMentions(line.latest[1], participants),
  };
}

async function decide(director: Director, line: Line): Promise<DirectorDecision> {
  const decision = await director.decide(inputOf(line));
  // A benchmark must not fail open: the director's warning above says why it fell back.
  if (decision.source === "fallback") throw new Error(`${line.id}: the director fell back`);
  return decision;
}

function rowOf(line: Line, decision: DirectorDecision, ms: number, model: string): Row {
  const { hop, mentions = [] } = inputOf(line);
  const decided = decision.replies.map(({ persona }) => persona);
  const maybe = line.maybe ?? [];
  const [speaker, text] = line.latest;
  return {
    id: line.id,
    kind: line.kind,
    hop,
    latest: `${speaker === VIEWER ? VIEWER : personas[speaker]?.shortName}：${text}`,
    mentions,
    responders: line.responders,
    maybe,
    decided,
    source: decision.source,
    right:
      line.responders.every((id) => decided.includes(id)) &&
      decided.every((id) => line.responders.includes(id) || maybe.includes(id)),
    scores: decision.scores,
    ms,
    model,
  };
}

validate();
const rows: Row[] = [];
let costUsd: number | null = 0;
if (cached) {
  const stored = new Map(
    ((await Bun.file(join(here, "decisions.json")).json()) as { lines: Row[] }).lines.map((row) => [
      row.id,
      row,
    ]),
  );
  for (const line of lines) {
    const row = stored.get(line.id);
    if (row === undefined)
      throw new Error(`${line.id} has no stored scores: score it without --cached`);
    const director = new Director({ apiKey: "cached", fetch: replaying(row) });
    rows.push(rowOf(line, await decide(director, line), row.ms, row.model));
  }
  costUsd = null;
} else {
  const director = liveDirector();
  // Opens the connection, as a chat's first line has.
  await decide(director, {
    id: "warm-up",
    kind: "warm-up",
    participants: Object.keys(personas).slice(0, 2),
    latest: [VIEWER, "你好"],
    interested: [],
    responders: [],
    invites_reply: true,
  });
  for (const line of lines) {
    answered = null;
    const decision = await decide(director, line);
    const call = answered as { ms: number; model: string; costUsd: number | null } | null;
    if (call === null) throw new Error(`${line.id}: no request reached Jev`);
    costUsd = costUsd === null || call.costUsd === null ? null : costUsd + call.costUsd;
    rows.push(rowOf(line, decision, call.ms, call.model));
  }
}

/** The nearest-rank quantile; null for no values. */
function quantile(values: readonly number[], q: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
}

function stats(values: readonly number[]) {
  const at = (q: number) => quantile(values, q);
  return { n: values.length, min: at(0), median: at(0.5), max: at(1) };
}

/** The bar (in hundredths) that misplaces fewest points; the middle of the widest such range. */
function suggest(points: readonly Point[]) {
  const positives = points.filter((p) => p.positive);
  const negatives = points.filter((p) => !p.positive);
  if (positives.length === 0 || negatives.length === 0) return null;
  const errorsAt = (cents: number) =>
    positives.filter((p) => p.score < cents / 100).length +
    negatives.filter((p) => p.score >= cents / 100).length;
  const errors = Array.from({ length: 101 }, (_, cents) => errorsAt(cents));
  const fewest = Math.min(...errors);
  let best = { from: 0, to: -1 };
  for (let from = 0; from <= 100; from++) {
    if (errors[from] !== fewest || errors[from - 1] === fewest) continue;
    let to = from;
    while (errors[to + 1] === fewest) to++;
    if (to - from > best.to - best.from) best = { from, to };
  }
  return {
    threshold: Math.round((best.from + best.to) / 2) / 100,
    wrong: fewest,
    range: [best.from / 100, best.to / 100],
  };
}

function question(points: readonly Point[], threshold: number | null) {
  const wrong =
    threshold === null
      ? []
      : points.filter((p) => p.positive !== round(p.score) >= round(threshold));
  return {
    threshold,
    labelled_yes: stats(points.filter((p) => p.positive).map((p) => p.score)),
    labelled_no: stats(points.filter((p) => !p.positive).map((p) => p.score)),
    wrong: threshold === null ? null : wrong.length,
    suggests: suggest(points),
    wrong_points: wrong,
  };
}

const lineOf = new Map(lines.map((line) => [line.id, line]));
const raiseOf = (row: Row) => HOP_STEP * row.hop;
const addressed: Point[] = [];
const interested: Point[] = [];
const keen: Point[] = [];
const invitesAfterPersona: Point[] = [];
const invitesAfterViewer: Point[] = [];
for (const row of rows) {
  const line = lineOf.get(row.id) as Line;
  const candidates = candidatesOf(line);
  const raise = raiseOf(row);
  const last = spokeBefore(saidOf(line));
  for (const persona of candidates) {
    const interest = row.scores[`interested_${persona}`] as number;
    interested.push({
      id: row.id,
      persona,
      score: interest,
      positive: line.interested.includes(persona),
    });
    if (line.addressed !== undefined) {
      addressed.push({
        id: row.id,
        persona,
        score: round((row.scores[`addressed_${persona}`] as number) - raise),
        positive: line.addressed.includes(persona),
      });
    }
    // Interest decides only where no one is mentioned or addressed. A responder it carries should
    // clear the bar, and nobody it doesn't touch should.
    if (line.addressed?.length !== 0 || row.mentions.length > 0) continue;
    const answers = line.responders.includes(persona);
    if (answers !== line.interested.includes(persona)) continue;
    const { talkativeness } = personas[persona] as Persona;
    const penalty = persona === last ? JUST_SPOKE_PENALTY : 0;
    keen.push({
      id: row.id,
      persona,
      score: round(interest * talkativeness - penalty - raise),
      positive: answers,
    });
  }
  const invites = row.scores.invites_reply as number;
  if (row.hop > 0) {
    invitesAfterPersona.push({
      id: row.id,
      persona: null,
      score: round(invites - raise),
      positive: line.invites_reply,
    });
  } else {
    invitesAfterViewer.push({
      id: row.id,
      persona: null,
      score: invites,
      positive: line.invites_reply,
    });
  }
}

const questions = {
  addressed: question(addressed, ADDRESSED_THRESHOLD),
  interested: question(interested, null),
  interested_x_talkativeness: question(keen, INTEREST_THRESHOLD),
  invites_reply_after_persona: question(invitesAfterPersona, INVITES_THRESHOLD),
  invites_reply_after_viewer: question(invitesAfterViewer, null),
};

const kinds = [...new Set(rows.map((row) => row.kind))];
const tally = (subset: readonly Row[]) =>
  `${subset.filter((r) => r.right).length}/${subset.length}`;
const ms = rows.map((row) => row.ms);
const latency = { p50: quantile(ms, 0.5), p90: quantile(ms, 0.9), max: quantile(ms, 1) };
const result = {
  model: [...new Set(rows.map((row) => row.model))].sort(),
  thresholds: {
    addressed: ADDRESSED_THRESHOLD,
    interest: INTEREST_THRESHOLD,
    invites: INVITES_THRESHOLD,
    hop_step: HOP_STEP,
    just_spoke_penalty: JUST_SPOKE_PENALTY,
  },
  latency_ms: {
    ...latency,
    over_timeout: ms.filter((value) => value > DIRECTOR_TIMEOUT_SEC * 1000).length,
  },
  decided_right: {
    all: tally(rows),
    ...Object.fromEntries(kinds.map((kind) => [kind, tally(rows.filter((r) => r.kind === kind))])),
  },
  questions: Object.fromEntries(
    Object.entries(questions).map(([name, { wrong_points: _points, ...summary }]) => [
      name,
      summary,
    ]),
  ),
  lines: rows,
};
await Bun.write(join(here, "decisions.json"), `${JSON.stringify(result, null, 1)}\n`);

const fixed = (value: number | null) => (value === null ? "-" : value.toFixed(2));
const range = ({ n, min, median, max }: ReturnType<typeof stats>) =>
  `n=${n} ${fixed(min)}/${fixed(median)}/${fixed(max)}`;
console.log(
  `model ${result.model.join(", ")}; bars addressed ${ADDRESSED_THRESHOLD}, ` +
    `interest ${INTEREST_THRESHOLD}, invites ${INVITES_THRESHOLD}, +${HOP_STEP} a hop`,
);
console.log(
  `latency p50 ${latency.p50} ms, p90 ${latency.p90} ms, max ${latency.max} ms; ` +
    `${result.latency_ms.over_timeout} over the director's ${DIRECTOR_TIMEOUT_SEC} s` +
    (costUsd === null ? "" : `; $${costUsd.toFixed(4)}`),
);
console.log(
  `decided right ${tally(rows)}: ${kinds.map((k) => `${k} ${tally(rows.filter((r) => r.kind === k))}`).join(", ")}`,
);
console.log(
  "question (min/median/max)          yes                    no                     wrong  suggests",
);
for (const [name, q] of Object.entries(questions)) {
  const suggestion =
    q.suggests === null
      ? "-"
      : `${q.suggests.threshold} (${q.suggests.wrong} wrong, ${q.suggests.range.join("–")})`;
  console.log(
    `${name.padEnd(34)} ${range(q.labelled_yes).padEnd(22)} ${range(q.labelled_no).padEnd(22)} ` +
      `${String(q.wrong ?? "-").padEnd(6)} ${suggestion}`,
  );
}
for (const [name, q] of Object.entries(questions)) {
  for (const p of q.wrong_points) {
    console.log(
      `OFF ${name} ${p.id}${p.persona === null ? "" : ` ${p.persona}`} ${fixed(p.score)} ` +
        `(labelled ${p.positive ? "yes" : "no"})`,
    );
  }
}
const wrong = rows.filter((row) => !row.right);
for (const row of wrong) {
  console.log(
    `WRONG ${row.id} decided [${row.decided.join(", ")}] (${row.source}), expected ` +
      `[${row.responders.join(", ")}]${row.maybe.length > 0 ? ` maybe [${row.maybe.join(", ")}]` : ""} ` +
      `${row.latest} ${JSON.stringify(row.scores)}`,
  );
}
process.exitCode = check && wrong.length > 0 ? 1 : 0;
