// The differences between the engines that are allowed, D1–D16 and E1–E8 of docs/voice-engine.md:
// each with its id, what it allows, the input that triggers it, and a predicate narrow enough that
// nothing else passes as it. The twin harness fails on any difference no rule here matches. The user
// reviews this file; a rule is added only with a trigger, never to quiet a failing scenario. A rule
// whose predicate is `() => false` names a difference no scenario here can produce (another
// provider, a reconnect, a later phase): it allows nothing until a scenario triggers it.
import { CHAT_WINDOW_MESSAGES } from "@eidolon/chat";
import { INTERRUPTED_EMPTY_TURN_PROMPT } from "@eidolon/context";
import type { Violation } from "./invariants.ts";
import type { Capture, Difference, Engine, Normalized, Twin } from "./twin.ts";
import {
  align,
  canonical,
  differences,
  normalizeRealtime,
  normalizeRtvi,
  usageKey,
} from "./twin.ts";

export interface Allowance {
  /** D: the cascade's differences; E: a realtime call's (§9 of the contract). */
  readonly id: `D${number}` | `E${number}`;
  readonly difference: string;
  /** The input that produces it, or why it is allowed. */
  readonly trigger: string;
  matches(difference: Difference, twin: Twin): boolean;
  /** An invariant pipedog breaks that this rule's fix is for: the twin doesn't fail on it. */
  excuses?(violation: Violation, engine: Engine, twin: Twin): boolean;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const text = (value: unknown): string => String(field(value, "text") ?? "");

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_PUNCTUATION = /[　-〿＀-￯]/u;
const cjk = (c: string | undefined) => c !== undefined && (CJK.test(c) || CJK_PUNCTUATION.test(c));

/** `value` with the spaces pipedog joins CJK segments with taken out: what joinSegments makes. */
function cjkJoined(value: string): string {
  const chars = [...value];
  return chars.filter((c, i) => c !== " " || !(cjk(chars[i - 1]) || cjk(chars[i + 1]))).join("");
}

/** `value` without whitespace, which a TTS segment may trim from the reply's text. */
const unspaced = (value: string): string => value.replace(/\s+/g, "");

/** A message's text content, when it is one. */
function contentOf(message: unknown): string | null {
  const content = field(message, "content");
  return typeof content === "string" ? content : null;
}

function sameRole(a: unknown, b: unknown): boolean {
  return field(a, "role") === field(b, "role");
}

/** The side's normalized RTVI messages. */
function rtvi(twin: Twin, side: "pipedog" | "native"): Normalized[] {
  return normalizeRtvi(twin[side].received);
}

/** How many messages of `type` come before `index` in `seq`. */
function before(seq: readonly Normalized[], index: number | null, type: string): number {
  if (index === null) return 0;
  return seq.slice(0, index).filter((m) => m.type === type).length;
}

/** Whether the mind round around `index` has ended there: its bot-llm-stopped came first. */
function afterRound(seq: readonly Normalized[], index: number | null): boolean {
  if (index === null) return false;
  for (let i = index - 1; i >= 0; i--) {
    const type = seq[i]?.type;
    if (type === "bot-llm-stopped") return true;
    if (type === "bot-llm-started") return false;
  }
  return false;
}

/** What opens the caller's turn: around it, pipedog's late bot-stopped-speaking lands after it. */
const TURN_START = new Set(["user-started-speaking", "bot-interrupted"]);

/** Whether a bot-stopped-speaking follows `index`, past the rest of the turn's start. */
function stopFollows(seq: readonly Normalized[], index: number | null): boolean {
  if (index === null) return false;
  let i = index + 1;
  while (TURN_START.has(seq[i]?.type ?? "")) i++;
  return seq[i]?.type === "bot-stopped-speaking";
}

/** Whether a bot-stopped-speaking precedes `index`, past its bot-tts-stopped and the turn's start. */
function stopPrecedes(seq: readonly Normalized[], index: number | null): boolean {
  if (index === null) return false;
  let i = index - 1;
  while (TURN_START.has(seq[i]?.type ?? "") || seq[i]?.type === "bot-tts-stopped") i--;
  return seq[i]?.type === "bot-stopped-speaking";
}

/** What the caller said or typed, as the native engine heard it: the lines she answers. */
function callerLines(twin: Twin): Set<string> {
  return new Set(
    rtvi(twin, "native")
      .filter(
        (m) =>
          (m.type === "user-input" && field(m.data, "final") === true) ||
          m.type === "user-llm-text",
      )
      .map((m) => text(m.data)),
  );
}

const lastContent = (body: Readonly<Record<string, unknown>>): string | null =>
  Array.isArray(body.messages) ? contentOf(body.messages.at(-1)) : null;

/** pipedog's recovery reply to an empty turn that native didn't count as cutting her off. */
interface Recovery {
  /** Its mind request, by index among pipedog's. */
  readonly request: number;
  /** Its messages in pipedog's normalized RTVI, [from, to). */
  readonly from: number;
  readonly to: number;
  /** What she said in it. */
  readonly text: string;
}

/**
 * The replies pipedog ran on INTERRUPTED_EMPTY_TURN_PROMPT that native has no request for: the
 * k-th mind request is the k-th bot-llm-started, and the reply runs to the caller's next turn or
 * her next request.
 */
function recoveries(twin: Twin): Recovery[] {
  const nudged = (c: Twin["pipedog"]) =>
    c.mind.flatMap((r, i) => (lastContent(r.body) === INTERRUPTED_EMPTY_TURN_PROMPT ? [i] : []));
  const native = new Set(nudged(twin.native));
  const seq = rtvi(twin, "pipedog");
  const starts = seq.flatMap((m, i) => (m.type === "bot-llm-started" ? [i] : []));
  return nudged(twin.pipedog)
    .filter((request) => !native.has(request) && twin.native.mind.length <= request)
    .flatMap((request) => {
      const from = starts[request];
      if (from === undefined) return [];
      const next = seq.findIndex(
        (m, i) => i > from && (m.type === "bot-llm-started" || m.type === "user-started-speaking"),
      );
      const to = next === -1 ? seq.length : next;
      const said = seq.slice(from, to).filter((m) => m.type === "bot-llm-text");
      return [{ request, from, to, text: said.map((m) => text(m.data)).join("") }];
    });
}

/** A usage record's role and characters, from the key twin.ts compares them by. */
function usageOf(record: string): { role: string; characters: number | null } {
  const [role, , , , units] = JSON.parse(record) as [string, string, string, string, unknown];
  const characters = field(units, "characters");
  return { role, characters: typeof characters === "number" ? characters : null };
}

/** A mind request's messages, or what she would see next, on one side, without the system's. */
function messagesOf(kind: "mind" | "conversation", request: number, capture: Capture): unknown[] {
  const body = capture.mind[request]?.body;
  const list = kind === "conversation" ? capture.conversation : body?.messages;
  return Array.isArray(list) ? list.filter((m) => field(m, "role") !== "system") : [];
}

const isLine = (m: unknown) =>
  (field(m, "role") === "user" || field(m, "role") === "assistant") && contentOf(m) !== null;

/**
 * Whether `d` is a message pipedog still sends that fell out of native's window: pipedog's list
 * holds more than CHAT_WINDOW_MESSAGES lines, and it comes before the first message native kept.
 */
function outsideWindow(d: Difference, twin: Twin): boolean {
  if ((d.kind !== "mind" && d.kind !== "conversation") || d.change !== "pipedog-only") return false;
  const pipedog = messagesOf(d.kind, d.request, twin.pipedog);
  if (pipedog.filter(isLine).length <= CHAT_WINDOW_MESSAGES) return false;
  const kept = messagesOf(d.kind, d.request, twin.native)[0];
  if (kept === undefined) return false;
  const start = pipedog.findIndex((m) => canonical(m) === canonical(kept));
  const at = pipedog.findIndex((m) => canonical(m) === canonical(d.pipedog));
  return start > 0 && at !== -1 && at < start;
}

/** Whether `d` is part of a recovery reply only pipedog ran. */
function partOfRecovery(d: Difference, twin: Twin): boolean {
  const found = recoveries(twin);
  if (found.length === 0) return false;
  const spoken = found.map((r) => r.text);
  switch (d.kind) {
    case "rtvi":
      return (
        d.change === "pipedog-only" &&
        found.some((r) => d.pipedog !== null && d.pipedog >= r.from && d.pipedog < r.to)
      );
    case "mind":
      return d.change === "pipedog-only" && found.some((r) => r.request === d.request);
    case "conversation": {
      if (d.change !== "pipedog-only") return false;
      const content = contentOf(d.pipedog);
      return (
        content === INTERRUPTED_EMPTY_TURN_PROMPT ||
        (field(d.pipedog, "role") === "assistant" &&
          content !== null &&
          spoken.includes(cjkJoined(content)))
      );
    }
    case "request": {
      const asked = /^mind (\d+) /.exec(d.what);
      if (asked !== null) {
        return d.native === undefined && found.some((r) => r.request === Number(asked[1]));
      }
      if (d.what !== "fish text" || !Array.isArray(d.pipedog) || !Array.isArray(d.native)) {
        return false;
      }
      // Native's texts are pipedog's in order, and what they leave out is what the recovery said.
      const pipedog = d.pipedog as string[];
      const omitted: string[] = [];
      let from = 0;
      for (const said of d.native as string[]) {
        const at = pipedog.indexOf(said, from);
        if (at === -1) return false;
        omitted.push(...pipedog.slice(from, at));
        from = at + 1;
      }
      omitted.push(...pipedog.slice(from));
      return unspaced(omitted.join("")) === unspaced(spoken.join(""));
    }
    case "realtime":
      return false;
    case "usage": {
      const own = usageOf(d.record);
      if (own.role === "mind") {
        // One record per recovery request at most, each the usage native's requests report: the
        // twin's mind reports the same for every request.
        if (d.change !== "pipedog-only") return false;
        const records = differences(twin).filter(
          (u) =>
            u.kind === "usage" && u.change === "pipedog-only" && usageOf(u.record).role === "mind",
        );
        return (
          records.length <= found.length && twin.native.usage.some((r) => usageKey(r) === d.record)
        );
      }
      if (own.role !== "voice" || own.characters === null) return false;
      // The call's one batched voice record: pipedog's counts what the recovery said too.
      const extra = spoken.reduce((n, s) => n + [...s].length, 0);
      const other = d.change === "pipedog-only" ? "native-only" : "pipedog-only";
      return differences(twin).some((u) => {
        if (u.kind !== "usage" || u.change !== other) return false;
        const theirs = usageOf(u.record);
        if (theirs.role !== "voice" || theirs.characters === null) return false;
        const pipedog = d.change === "pipedog-only" ? own.characters : theirs.characters;
        const native = d.change === "pipedog-only" ? theirs.characters : own.characters;
        return pipedog !== null && native !== null && pipedog - native === extra;
      });
    }
  }
}

/** Both runs talked to a realtime model. */
const realtime = (twin: Twin): boolean =>
  twin.pipedog.realtime.length > 0 && twin.native.realtime.length > 0;

/** The text of a realtime item's `input_text`, when it is a message carrying one. */
function itemText(message: Normalized | undefined): string | null {
  const content = field(field(message?.data, "item"), "content");
  if (!Array.isArray(content)) return null;
  const text = field(content[0], "text");
  return typeof text === "string" ? text : null;
}

/** The lines the caller typed that pipedog never gave its realtime model, by their text. */
function unanswered(twin: Twin): Set<string> {
  if (!realtime(twin)) return new Set();
  const sent = new Set(
    normalizeRealtime(twin.pipedog.realtime)
      .map(itemText)
      .filter((text) => text !== null),
  );
  return new Set(
    rtvi(twin, "native")
      .filter((m) => m.type === "user-input" && field(m.data, "input_type") === "chat")
      .map((m) => text(m.data))
      .filter((line) => !sent.has(line)),
  );
}

/**
 * Whether native's message `index` belongs to its answer to a typed line pipedog left unanswered:
 * from that line's user-input to the caller's next turn or typed line.
 */
function inTypedReply(twin: Twin, index: number | null): boolean {
  if (index === null) return false;
  const lines = unanswered(twin);
  const seq = rtvi(twin, "native");
  for (let i = index - 1; i >= 0; i--) {
    const m = seq[i] as Normalized;
    if (m.type === "user-started-speaking") return false;
    if (m.type === "user-input" && field(m.data, "input_type") === "chat") {
      return lines.has(text(m.data));
    }
  }
  return false;
}

/**
 * Whether pipedog's message `index` is part of how it took a typed line it never sent its model:
 * from the bot-interrupted the line caused (no user-started-speaking before it) to the line's
 * user-input, the response it had going ran on.
 */
function inTypedCut(twin: Twin, index: number | null): boolean {
  if (index === null) return false;
  const lines = unanswered(twin);
  const seq = rtvi(twin, "pipedog");
  const typed = seq.findIndex(
    (m, i) =>
      i >= index &&
      m.type === "user-input" &&
      field(m.data, "input_type") === "chat" &&
      lines.has(text(m.data)),
  );
  if (typed === -1) return false;
  for (let i = index; i >= 0; i--) {
    const m = seq[i] as Normalized;
    if (m.type === "user-started-speaking" || m.type === "user-input") return false;
    if (m.type === "bot-interrupted") return seq[i - 1]?.type !== "user-started-speaking";
  }
  return false;
}

/** Whether pipedog's message `index` is a bot-llm-started inside a round already started. */
function secondStart(seq: readonly Normalized[], index: number | null): boolean {
  return (
    seq[index ?? -1]?.type === "bot-llm-started" &&
    !afterRound(seq, index) &&
    seq.slice(0, index ?? 0).some((m) => m.type === "bot-llm-started")
  );
}

/** pipedog's bot-output for a realtime transcript delta: "new", spoken, never to be spoken. */
function deltaOutput(m: Normalized | undefined): boolean {
  return (
    m?.type === "bot-output" &&
    field(m.data, "spoken") === true &&
    field(m.data, "will_be_spoken") === false &&
    field(m.data, "spoken_status") === "new"
  );
}

/** A sentence native's segmenter made of her realtime transcript: its bot-transcription. */
function nativeSentence(twin: Twin, value: string): boolean {
  return rtvi(twin, "native").some((m) => m.type === "bot-transcription" && text(m.data) === value);
}

/** Native's bot-output or bot-tts-text for one of her sentences, as the cursor passed it. */
function sentenceOutput(twin: Twin, m: Normalized | undefined): boolean {
  if (m === undefined || !nativeSentence(twin, text(m.data))) return false;
  if (m.type === "bot-tts-text") return true;
  return (
    m.type === "bot-output" &&
    field(m.data, "will_be_spoken") === true &&
    ["new", "completed"].includes(String(field(m.data, "spoken_status")))
  );
}

/** pipedog's bot-tts-text for a transcript delta: right after that delta's bot-output. */
function deltaText(twin: Twin, m: Normalized | undefined, index: number | null): boolean {
  if (m?.type !== "bot-tts-text" || index === null) return false;
  const seq = rtvi(twin, "pipedog")
    .slice(0, index)
    .filter((x) => x.type !== "metrics");
  const before = seq.at(-1);
  return deltaOutput(before) && text(before?.data) === text(m.data);
}

/** The pipedog interims of `type` in the caller's turn up to `index`, joined. */
function interimsSoFar(seq: readonly Normalized[], index: number, type: string): string {
  let joined = "";
  for (let i = index; i >= 0; i--) {
    const m = seq[i] as Normalized;
    if (m.type === "user-started-speaking") break;
    if (m.type === type && field(m.data, "final") === false) joined = text(m.data) + joined;
  }
  return joined;
}

/** Both runs spoke through Fish: a cascade call, not a realtime one. */
const fishCall = (twin: Twin): boolean =>
  twin.pipedog.fish.length > 0 && twin.native.fish.length > 0 && !realtime(twin);

/** What the cursor reports of a sentence she speaks as it passes: its bot-output or bot-tts-text. */
function spokenReport(m: Normalized | undefined): boolean {
  if (m?.type === "bot-tts-text") return true;
  return m?.type === "bot-output" && field(m.data, "will_be_spoken") === true;
}

/** A bot-output's key without its segment ordinal. */
function unnumbered(m: Normalized): string {
  return `${m.type} ${JSON.stringify({ ...(m.data as object), segment_id: null })}`;
}

/** Which of her speaking spans each message falls in: how many bot-started-speaking came by it. */
function spans(seq: readonly Normalized[]): number[] {
  let k = 0;
  return seq.map((m) => (m.type === "bot-started-speaking" ? ++k : k));
}

/** The spoken reports of span `k`, by index. */
function reportsIn(seq: readonly Normalized[], k: number): number[] {
  const span = spans(seq);
  return seq.flatMap((m, i) => (spokenReport(m) && span[i] === k ? [i] : []));
}

/** The spans native's caller cut off: a bot-interrupted came while she was speaking. */
function cutSpans(seq: readonly Normalized[]): Set<number> {
  const cut = new Set<number>();
  let span = 0;
  let speaking = false;
  for (const m of seq) {
    if (m.type === "bot-started-speaking") {
      span++;
      speaking = true;
    } else if (m.type === "bot-stopped-speaking") {
      speaking = false;
    } else if (m.type === "bot-interrupted" && speaking) {
      cut.add(span);
    }
  }
  return cut;
}

/**
 * pipedog's reports of sentences native's cursor never passed, by index: in a span native's caller
 * cut off, those past as many as native sent there. Any of native's own that differ from the
 * first of pipedog's are differences of their own, which nothing here allows.
 */
function unheardReports(twin: Twin): Set<number> {
  const pipedog = rtvi(twin, "pipedog");
  const native = rtvi(twin, "native");
  const unheard = new Set<number>();
  for (const k of cutSpans(native)) {
    for (const i of reportsIn(pipedog, k).slice(reportsIn(native, k).length)) unheard.add(i);
  }
  return unheard;
}

/**
 * Whether pipedog's bot-output `p` and native's `n` are one report numbered apart only by the
 * sentences pipedog reported that native never did: normalizeRtvi numbers segments as they first
 * appear, so each unheard sentence before it moves pipedog's ordinals one on.
 */
function renumbered(twin: Twin, p: number, n: number): boolean {
  const pipedog = rtvi(twin, "pipedog");
  const native = rtvi(twin, "native");
  const a = pipedog[p];
  const b = native[n];
  if (a?.type !== "bot-output" || b?.type !== "bot-output" || unnumbered(a) !== unnumbered(b)) {
    return false;
  }
  const unheard = unheardReports(twin);
  const ordinals = new Map<unknown, boolean>();
  for (const [i, m] of pipedog.entries()) {
    if (m.type !== "bot-output") continue;
    const ordinal = field(m.data, "segment_id");
    ordinals.set(ordinal, (ordinals.get(ordinal) ?? true) && unheard.has(i));
  }
  const ordinal = Number(field(a.data, "segment_id"));
  const missing = [...ordinals].filter(([o, gone]) => gone && Number(o) < ordinal).length;
  return missing > 0 && ordinal - Number(field(b.data, "segment_id")) === missing;
}

/**
 * Whether the messages at `p` and `n` line up once every spoken report is set aside: they moved
 * only past reports that native sent later.
 */
function besideReports(twin: Twin, p: number, n: number): boolean {
  const pipedog = rtvi(twin, "pipedog");
  const native = rtvi(twin, "native");
  const kept = (seq: readonly Normalized[]) => seq.flatMap((m, i) => (spokenReport(m) ? [] : [i]));
  const keptP = kept(pipedog);
  const keptN = kept(native);
  const ops = align(
    keptP.map((i) => pipedog[i] as Normalized),
    keptN.map((i) => native[i] as Normalized),
    (m) => m.key,
  ).filter((op) => op.change === "same");
  return (
    ops.some((op) => keptP[op.pipedog as number] === p) &&
    ops.some((op) => keptN[op.native as number] === n)
  );
}

/**
 * D12: native reports each Fish sentence "new" as its audio starts, and "completed" with its
 * bot-tts-text as its audio ends; pipedog reported every sentence said at her first audio.
 */
function spreadReports(d: Difference, twin: Twin): boolean {
  if (d.kind !== "rtvi" || !fishCall(twin)) return false;
  const pipedog = rtvi(twin, "pipedog");
  const native = rtvi(twin, "native");
  switch (d.change) {
    case "moved": {
      if (d.pipedog === null || d.native === null) return false;
      if (!spokenReport(d.message)) return besideReports(twin, d.pipedog, d.native);
      const span = spans(pipedog)[d.pipedog] as number;
      return span > 0 && span === spans(native)[d.native];
    }
    case "changed":
      return d.pipedog !== null && d.native !== null && renumbered(twin, d.pipedog, d.native);
    case "pipedog-only": {
      const p = d.pipedog;
      if (p === null) return false;
      return unheardReports(twin).has(p) || native.some((_, n) => renumbered(twin, p, n));
    }
    case "native-only": {
      const n = d.native;
      return n !== null && pipedog.some((_, p) => renumbered(twin, p, n));
    }
  }
}

/** On native, the sentences she said in each reply the caller cut off while she spoke. */
function cutSentences(seq: readonly Normalized[]): string[][] {
  const cut: string[][] = [];
  let said: string[] = [];
  let speaking = false;
  for (const m of seq) {
    if (m.type === "bot-transcription") said.push(text(m.data));
    else if (m.type === "bot-started-speaking") speaking = true;
    else if (m.type === "bot-stopped-speaking") speaking = false;
    else if (m.type === "bot-interrupted") {
      if (speaking) cut.push(said);
      said = [];
    }
  }
  return cut;
}

/**
 * D11: her interrupted message as each engine keeps it. pipedog's holds every sentence said
 * before the cut, native's those whose audio played whole: fewer of the same sentences, or none.
 */
function heardOfCut(d: Difference, twin: Twin): boolean {
  if ((d.kind !== "mind" && d.kind !== "conversation") || !fishCall(twin)) return false;
  if (d.change !== "pipedog-only" && d.change !== "changed") return false;
  if (field(d.pipedog, "role") !== "assistant") return false;
  const whole = contentOf(d.pipedog);
  const kept =
    d.change === "pipedog-only" ? "" : sameRole(d.pipedog, d.native) ? contentOf(d.native) : null;
  if (whole === null || kept === null) return false;
  return cutSentences(rtvi(twin, "native")).some((said) => {
    const prefixes = said.map((_, i) => unspaced(said.slice(0, i + 1).join("")));
    const all = ["", ...prefixes];
    const p = all.indexOf(unspaced(whole));
    const n = all.indexOf(unspaced(kept));
    return p > 0 && n >= 0 && n < p;
  });
}

export const ALLOWED: readonly Allowance[] = [
  {
    id: "D1",
    difference: "a call's view is the last 60 messages (CHAT_WINDOW_MESSAGES)",
    trigger: "a call longer than 60 user and assistant messages",
    matches: (d, twin) => outsideWindow(d, twin),
  },
  {
    id: "D2",
    difference: "no user-llm-text for the greeting's kickoff or a follow-up",
    trigger: "every call: today the kickoff prompt reaches the client",
    matches: (d, twin) =>
      d.kind === "rtvi" &&
      d.change === "pipedog-only" &&
      d.message.type === "user-llm-text" &&
      !callerLines(twin).has(text(d.message.data)),
  },
  {
    id: "D3",
    difference: "no metrics messages",
    trigger: "every call: no client reads them",
    matches: (d) =>
      d.kind === "rtvi" && d.change === "pipedog-only" && d.message.type === "metrics",
  },
  {
    id: "D4",
    difference: "bot-tts-stopped for every reply and on a barge-in",
    trigger:
      "every Fish reply: pipedog's waits for the 15 s context timeout, after the call moved on",
    matches: (d) =>
      d.kind === "rtvi" && d.change === "native-only" && d.message.type === "bot-tts-stopped",
  },
  {
    id: "D5",
    difference: "bot-stopped-speaking when her audio ends, not 3 s later",
    trigger: "every Fish reply: pipedog's comes 2.75–3.9 s after the audio",
    matches: (d, twin) => {
      if (d.kind !== "rtvi") return false;
      const pipedog = rtvi(twin, "pipedog");
      if (d.change === "moved" && TURN_START.has(d.message.type)) {
        // The alignment may keep the stop in place and move the turn's start instead.
        return stopFollows(pipedog, d.pipedog) && stopPrecedes(rtvi(twin, "native"), d.native);
      }
      if (d.message.type !== "bot-stopped-speaking") return false;
      if (d.change === "moved") {
        // pipedog's came after a turn that native's came before.
        const native = rtvi(twin, "native");
        return (
          before(pipedog, d.pipedog, "bot-interrupted") >
          before(native, d.native, "bot-interrupted")
        );
      }
      // The call ended inside pipedog's late window: its last reply never stopped speaking.
      const started = pipedog.map((m) => m.type).lastIndexOf("bot-started-speaking");
      return (
        d.change === "native-only" &&
        started !== -1 &&
        !pipedog.slice(started).some((m) => m.type === "bot-stopped-speaking")
      );
    },
  },
  {
    id: "D6",
    difference: "CJK-aware joins of the caller's segments and of hers",
    trigger: "a reply of two or more segments, or a turn heard as two finals",
    matches: (d) => {
      if (d.kind === "mind" || d.kind === "conversation") {
        if (d.change !== "changed" || !sameRole(d.pipedog, d.native)) return false;
        const a = contentOf(d.pipedog);
        const b = contentOf(d.native);
        return a !== null && b !== null && a !== b && cjkJoined(a) === b;
      }
      if (d.kind === "rtvi" && d.change === "changed" && d.other !== undefined) {
        if (d.message.type !== d.other.type) return false;
        if (!["user-input", "user-transcription", "user-llm-text"].includes(d.message.type)) {
          return false;
        }
        const a = text(d.message.data);
        return a !== text(d.other.data) && cjkJoined(a) === text(d.other.data);
      }
      return false;
    },
  },
  {
    id: "D7",
    difference:
      "the native segmenter: closers and repeated end punctuation stay with their sentence, so a " +
      "sentence's end waits for the next character or the round's end; cue-only segments merge " +
      "into the next; nothing splits inside an open [",
    trigger: "every reply: its last segment goes out when the round ends, not at its full stop",
    matches: (d, twin) =>
      d.kind === "rtvi" &&
      d.change === "moved" &&
      d.message.type === "bot-transcription" &&
      afterRound(rtvi(twin, "native"), d.native) &&
      !afterRound(rtvi(twin, "pipedog"), d.pipedog),
  },
  {
    id: "D8",
    difference: "OpenAI's STT interims are cumulative",
    trigger: "an OpenAI hearing role, which the twin, hearing through Soniox, never has",
    matches: () => false,
  },
  {
    id: "D9",
    difference: "an inbound type pipedog accepted and ignored gets error-response",
    trigger: "send-file, raw-audio, dtmf, llm-function-call-result or ui-*: no client sends them",
    matches: (d) =>
      d.kind === "rtvi" &&
      d.change === "native-only" &&
      d.message.type === "error-response" &&
      /^Unsupported type /.test(String(field(d.message.data, "error"))),
  },
  {
    id: "D10",
    difference: "her audio pauses during restart_pc or a lost ping instead of being dropped",
    trigger: "a reconnect mid-sentence; it moves no message, only when her audio plays",
    matches: () => false,
  },
  {
    id: "D11",
    difference:
      "an interrupted message keeps the sentences heard whole; pipedog's Fish kept every " +
      "sentence said once her audio had started",
    trigger: "a barge-in while a Fish reply plays, before its last sentence has played",
    matches: (d, twin) => heardOfCut(d, twin),
  },
  {
    id: "D12",
    difference:
      "Fish's bot-output spread across her audio: each sentence new as its audio starts, " +
      "completed with its bot-tts-text as it ends; pipedog reported all at her first audio, so " +
      "a cut reply reports fewer sentences and the later ones' segment ordinals run behind",
    trigger: "every Fish reply (required from G5): her reports move past what comes meanwhile",
    matches: (d, twin) => spreadReports(d, twin),
  },
  {
    id: "D13",
    difference: "interruptedBot is exact: an empty turn after her audio ended is no interruption",
    trigger: "an empty turn within 3 s after Fish audio ends",
    matches: (d, twin) => partOfRecovery(d, twin),
  },
  {
    id: "D14",
    difference: "no 15 s hold on a second reply in one turn",
    trigger: "a follow-up after a tool call",
    matches: () => false,
  },
  {
    id: "D15",
    difference: "voices other than Fish keep her cues in the stored text",
    trigger: "a non-Fish voice: matches text chats, where pipedog stored CueFilter's output",
    matches: () => false,
  },
  {
    id: "D16",
    difference: "her parts (LanceDB tables, the selfie tool) outlive a call",
    trigger: "every native call; no message shows it within a call",
    matches: () => false,
  },
  {
    id: "E1",
    difference:
      "her recall reaches a realtime model: each block her providers record goes in as an item, " +
      "and one they take out or replace is deleted (pipedog never sent recall after the greeting)",
    trigger:
      "a realtime call with recall, which the twin's persona, with no index or Mem0, never has",
    matches: () => false,
  },
  {
    id: "E2",
    difference:
      "a line typed into a realtime call is answered: it cuts her off, the response included, " +
      "goes in as the caller's item and asks for a response; pipedog never sent it its model, " +
      "and OpenAI's response ran on past the interruption",
    trigger: "send-text on a realtime call",
    matches: (d, twin) => {
      if (unanswered(twin).size === 0) return false;
      if (d.kind === "rtvi") {
        if (d.change === "native-only") return inTypedReply(twin, d.native);
        if (d.change === "pipedog-only") return inTypedCut(twin, d.pipedog);
        if (d.change !== "moved") return false;
        // The line's own echo, which pipedog sent once the response it let run had played.
        if (d.message.type === "user-input" || d.message.type === "user-llm-text") {
          return unanswered(twin).has(text(d.message.data));
        }
        // pipedog's speech of the response it let run, against native's of its answer.
        return inTypedCut(twin, d.pipedog) && inTypedReply(twin, d.native);
      }
      if (d.kind === "usage")
        return d.change === "native-only" && usageOf(d.record).role === "realtime";
      if (d.kind !== "realtime" || d.change !== "native-only" || d.native === null) return false;
      const seq = normalizeRealtime(twin.native.realtime);
      const typed = (at: number) => {
        const m = seq[at];
        const line = itemText(m);
        return (
          m?.type === "conversation.item.create" && line !== null && unanswered(twin).has(line)
        );
      };
      const at = d.native;
      switch (d.message.type) {
        case "conversation.item.create":
          return typed(at);
        case "response.create":
          return typed(at - 1);
        case "response.cancel":
        case "conversation.item.truncate": {
          // The barge-in just before the typed item.
          let next = at + 1;
          while (
            ["response.cancel", "conversation.item.truncate"].includes(seq[next]?.type ?? "")
          ) {
            next++;
          }
          return typed(next);
        }
        default:
          return false;
      }
    },
  },
  {
    id: "E3",
    difference: "OpenAI's realtime interim transcripts are cumulative, as D8 makes its STT's",
    trigger: "a turn OpenAI's realtime transcription reports in more than one delta",
    matches: (d, twin) => {
      if (!realtime(twin) || d.kind !== "rtvi" || d.change !== "changed" || d.pipedog === null) {
        return false;
      }
      const { message, other } = d;
      if (!["user-input", "user-transcription"].includes(message.type)) return false;
      if (other?.type !== message.type) return false;
      if (field(message.data, "final") !== false || field(other.data, "final") !== false) {
        return false;
      }
      const joined = interimsSoFar(rtvi(twin, "pipedog"), d.pipedog, message.type);
      return text(other.data) === joined && joined !== text(message.data);
    },
  },
  {
    id: "E4",
    difference:
      'a realtime reply\'s bot-output is per sentence, "new" then "completed" as the cursor ' +
      "passes the audio queued by its last delta, and held for the caller's final transcript " +
      '(1 s at most); pipedog sent each transcript delta as a "new" never to be spoken',
    trigger: "every realtime reply",
    matches: (d, twin) => {
      if (!realtime(twin) || d.kind !== "rtvi") return false;
      const pipedogSide = (m: Normalized | undefined, at: number | null) =>
        deltaOutput(m) || deltaText(twin, m, at);
      switch (d.change) {
        case "pipedog-only":
          return pipedogSide(d.message, d.pipedog);
        case "native-only":
          return sentenceOutput(twin, d.message);
        case "changed":
          return pipedogSide(d.message, d.pipedog) && sentenceOutput(twin, d.other);
        case "moved":
          return sentenceOutput(twin, d.message);
      }
    },
  },
  {
    id: "E5",
    difference: "one bot-llm-started, and one bot-llm-stopped, per realtime response",
    trigger:
      "every realtime response: pipedog started one as it asked, and again for each item the " +
      "server announced; a cut one it stopped at the cut and again at its response.done",
    matches: (d, twin) => {
      if (!realtime(twin) || d.kind !== "rtvi") return false;
      if (d.change !== "pipedog-only" && d.change !== "moved") return false;
      const seq = rtvi(twin, "pipedog");
      if (secondStart(seq, d.pipedog)) return true;
      // A stop with no round open: the last bot-llm-* before it is a stop too.
      if (d.change !== "pipedog-only" || d.message.type !== "bot-llm-stopped") return false;
      const before = seq.slice(0, d.pipedog ?? 0).filter((m) => m.type.startsWith("bot-llm-"));
      const last = before.filter((m) => m.type !== "bot-llm-text").at(-1);
      return last?.type === "bot-llm-stopped";
    },
    excuses: (v, engine, twin) =>
      engine === "pipedog" &&
      realtime(twin) &&
      v.id === "I5" &&
      v.detail === "a second bot-llm-started before bot-llm-stopped",
  },
  {
    id: "E8",
    difference:
      "a fatal realtime error, or the socket closing, ends the call; pipedog's went on without " +
      "its model",
    trigger: "a realtime server's fatal error",
    matches: (d, twin) => {
      if (!realtime(twin) || d.kind !== "rtvi" || d.change !== "pipedog-only") return false;
      const last = rtvi(twin, "native").at(-1);
      if (last?.type !== "error") return false;
      const failed = rtvi(twin, "pipedog").findIndex((m) => m.key === last.key);
      return failed !== -1 && d.pipedog !== null && d.pipedog > failed;
    },
  },
];
