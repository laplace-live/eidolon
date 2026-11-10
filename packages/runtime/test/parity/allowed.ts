// The differences between the engines that are allowed, D1–D16 of docs/voice-engine.md: each with
// its id, what it allows, the input that triggers it, and a predicate narrow enough that nothing
// else passes as it. The twin harness fails on any difference no rule here matches. The user
// reviews this file; a rule is added only with a trigger, never to quiet a failing scenario. A rule
// whose predicate is `() => false` names a difference no scenario here can produce (another
// provider, a reconnect, a later phase): it allows nothing until a scenario triggers it.
import { CHAT_WINDOW_MESSAGES } from "@eidolon/chat";
import { INTERRUPTED_EMPTY_TURN_PROMPT } from "@eidolon/context";
import type { Capture, Difference, Normalized, Twin } from "./twin.ts";
import { canonical, differences, normalizeRtvi } from "./twin.ts";

export interface Allowance {
  readonly id: `D${number}`;
  readonly difference: string;
  /** The input that produces it, or why it is allowed. */
  readonly trigger: string;
  matches(difference: Difference, twin: Twin): boolean;
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
      // Her texts with the recovery's taken out are native's.
      const extra = [...(d.pipedog as string[])];
      for (const said of d.native as string[]) {
        const at = extra.indexOf(said);
        if (at === -1) return false;
        extra.splice(0, at + 1);
      }
      return true;
    }
    case "usage": {
      const own = usageOf(d.record);
      if (own.role === "mind") return d.change === "pipedog-only";
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
      "an interrupted message keeps the text heard: per utterance for Fish (until G5), per " +
      "segment for the others",
    trigger: "a barge-in",
    matches: () => false,
  },
  {
    id: "D12",
    difference: "Fish's completed bot-output spread across her audio",
    trigger: "any Fish reply of several sentences, from G5: not allowed yet",
    matches: () => false,
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
];
