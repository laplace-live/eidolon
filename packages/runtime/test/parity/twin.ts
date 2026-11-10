import "../../../config/test/isolated-guard.ts";
// The twin harness: one scripted call run on each engine against the same wire-level fakes (a
// chat completions API, Fish's live socket, Soniox's real-time socket) by a real werift caller,
// and what each sent compared: the RTVI messages, the providers' requests, the usage ledger and
// what she would see next. Every difference must be one allowed.ts explains, and invariants.ts
// holds on every run. docs/voice-engine.md, "Parity tests".
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AllowedOffer } from "@eidolon/access";
import { CHAT_WINDOW_MESSAGES, viewOf } from "@eidolon/chat";
import {
  activePersona,
  dataHome,
  type LogRecord,
  readPersonaIdentity,
  resetSettings,
} from "@eidolon/config";
import { setUsageSink, type UsageRecord } from "@eidolon/providers";
import { type CallLog, memoryCallLog } from "@eidolon/voice";
import { type Frame, LLMContextFrame } from "@pipedog/core/frames/frames";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FrameDirection } from "@pipedog/core/processors/frame_processor";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { productionCallDeps } from "../../src/native/deps.ts";
import { runNativeSafely, sessionStarter, type VoiceEngine } from "../../src/native/engine.ts";
import { pipedogCallTransport } from "../../src/native/transport_pipedog.ts";
import { productionSessionDeps } from "../../src/session/defaults.ts";
import { createLlm, createStt, createTts } from "../../src/session/services.ts";
import { runSessionSafely, type SessionDeps } from "../../src/session/session.ts";
import { createSignallingServerWith } from "../../src/webrtc/signalling.ts";
import { captureLogs, PASS_THROUGH_RULES } from "../support.ts";
import { ALLOWED, type Allowance } from "./allowed.ts";
import { FakeFish, type FishOptions, type FishSession } from "./fakes/fish.ts";
import { FakeMind, type MindReply, type MindRequest } from "./fakes/mind.ts";
import { type Received, TwinPeer } from "./fakes/peer.ts";
import { FakeSoniox, type SonioxConnection } from "./fakes/soniox.ts";
import { checkInvariants, type Violation } from "./invariants.ts";

export type { VoiceEngine as Engine };

export interface Fakes {
  readonly mind: FakeMind;
  readonly fish: FakeFish;
  readonly soniox: FakeSoniox;
}

/** What the caller does once the call is up; the call ends, the caller hanging up, when it returns. */
export interface Scenario {
  readonly name: string;
  /** Each mind request's reply, in order. */
  readonly mind?: readonly MindReply[];
  /** What each of the recognizer's `finalize`s hears, in order. */
  readonly heard?: readonly string[];
  readonly fish?: FishOptions;
  /** Variables the persona's settings read, beside the fakes' accounts. */
  readonly env?: Readonly<Record<string, string>>;
  /** The roles whose account has no API key. */
  readonly keyless?: readonly (keyof typeof ACCOUNTS)[];
  /** The call can't start: the caller's offer is answered, and nothing waits for it to connect. */
  readonly failsToStart?: boolean;
  run(call: TwinCall): Promise<void>;
}

export interface TwinCall {
  readonly engine: VoiceEngine;
  readonly peer: TwinPeer;
  readonly fakes: Fakes;
}

/** Everything one engine's run of a scenario sent, and what she would see next. */
export interface Capture {
  readonly engine: VoiceEngine;
  /** What reached the caller over the data channel, RTVI and signalling. */
  readonly received: readonly Received[];
  /** [start, end] ms of the bot's audible audio. */
  readonly audible: readonly (readonly [number, number])[];
  readonly mind: readonly MindRequest[];
  readonly fish: readonly FishSession[];
  readonly soniox: readonly SonioxConnection[];
  readonly usage: readonly UsageRecord[];
  /** pipedog: its context's messages at the end; native: viewOf its log at the end. */
  readonly conversation: readonly unknown[];
  readonly logs: readonly LogRecord[];
  /** The call ended once the caller's connection closed. */
  readonly ended: boolean;
  /** Why the caller's script failed: what it waited for never came. */
  readonly failed: string | null;
}

export interface Twin {
  readonly pipedog: Capture;
  readonly native: Capture;
}

const ACCOUNTS = { hearing: "soniox-twin", voice: "fish-twin", mind: "openrouter-twin" } as const;

/**
 * The persona's roles filled by accounts at the fakes, in credentials.json, which every other
 * variable a call reads leaves alone. Returns what puts things back.
 */
function useFakes(fakes: Fakes, scenario: Pick<Scenario, "env" | "keyless">): () => void {
  const path = join(dataHome(), "credentials.json");
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const key = (role: keyof typeof ACCOUNTS) =>
    scenario.keyless?.includes(role) ? {} : { apiKey: "twin-key" };
  mkdirSync(dataHome(), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({
      accounts: {
        [ACCOUNTS.hearing]: { provider: "soniox", ...key("hearing"), baseUrl: fakes.soniox.base },
        [ACCOUNTS.voice]: { provider: "fish", ...key("voice"), baseUrl: fakes.fish.base },
        [ACCOUNTS.mind]: { provider: "openrouter", ...key("mind"), baseUrl: fakes.mind.base },
      },
    }),
    { mode: 0o600 },
  );
  const vars: Record<string, string> = {
    STT_PROVIDER: ACCOUNTS.hearing,
    TTS_PROVIDER: ACCOUNTS.voice,
    LLM_PROVIDER: ACCOUNTS.mind,
    LLM_MODEL: "twin/mind-1",
    TTS_VOICE_ID: "twin-voice",
    ...scenario.env,
  };
  const saved = Object.keys(vars).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  resetSettings();
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (before === null) rmSync(path, { force: true });
    else writeFileSync(path, before, { mode: 0o600 });
    resetSettings();
  };
}

/** pipedog's session on the fakes: production's services, dialling the fakes' sockets. */
function pipedogDeps(fakes: Fakes, seen: { context: LLMContext | null }): SessionDeps {
  return {
    ...productionSessionDeps,
    createStt() {
      const stt = createStt();
      // SonioxSTTService's `url` option, set after production built it.
      (stt as unknown as { _url: string })._url = fakes.soniox.url;
      return stt;
    },
    createTts() {
      const tts = createTts();
      (tts as unknown as { _baseUrl: string })._baseUrl = fakes.fish.url;
      return tts;
    },
    createLlm(systemInstruction) {
      const llm = createLlm(systemInstruction);
      const process = llm.processFrame.bind(llm);
      llm.processFrame = (frame: Frame, direction: FrameDirection) => {
        if (frame instanceof LLMContextFrame) seen.context = frame.context as LLMContext;
        return process(frame, direction);
      };
      return llm;
    },
  };
}

/** What she would see next: viewOf the native call's log as it ended. */
function nativeConversation(log: CallLog | null): unknown[] {
  if (log === null) return [];
  const { header, events } = log.snapshot();
  return viewOf(header, events, activePersona().id, {
    windowMessages: CHAT_WINDOW_MESSAGES,
    nameOf: (id) => readPersonaIdentity(id).name,
    viewerName: "",
  });
}

/** Runs `scenario` on `engine` against fresh fakes, to the end of the call. */
export async function runOn(engine: VoiceEngine, scenario: Scenario): Promise<Capture> {
  const fakes: Fakes = {
    mind: new FakeMind(scenario.mind ?? []),
    fish: new FakeFish(scenario.fish),
    soniox: new FakeSoniox(scenario.heard ?? []),
  };
  const logs = captureLogs();
  const usage: UsageRecord[] = [];
  setUsageSink((record) => usage.push(record));
  const restore = useFakes(fakes, scenario);
  const pipedogSeen: { context: LLMContext | null } = { context: null };
  let nativeLog: CallLog | null = null;
  const sessions: Promise<void>[] = [];
  const start = sessionStarter<SmallWebRTCConnection>(engine, {
    pipedog: (connection, admission) =>
      runSessionSafely(connection, admission, pipedogDeps(fakes, pipedogSeen)),
    native: (connection, admission) =>
      runNativeSafely(pipedogCallTransport(connection), admission, productionCallDeps, (header) => {
        nativeLog = memoryCallLog(header);
        return nativeLog;
      }),
  });
  const server = createSignallingServerWith(
    { ice: { serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }) } },
    {
      startSession: (connection: SmallWebRTCConnection, admission: AllowedOffer) => {
        const session = start(connection, admission);
        sessions.push(session);
        return session;
      },
      candidates: PASS_THROUGH_RULES,
    },
  );
  const peer = new TwinPeer();
  let ended = false;
  let failed: string | null = null;
  try {
    if (scenario.failsToStart) await peer.offer(server);
    else await peer.dial(server);
    await scenario.run({ engine, peer, fakes });
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  } finally {
    // The caller hangs up as the server sees a tab close: its connection closes.
    await server.close();
    ended = await within(Promise.all(sessions), 10_000, `${engine}'s session to end`).then(
      () => true,
      () => false,
    );
    await peer.close();
    restore();
    setUsageSink(null);
    logs.restore();
    fakes.mind.stop();
    fakes.fish.stop();
    fakes.soniox.stop();
  }
  return {
    engine,
    received: peer.received,
    audible: peer.audible,
    mind: fakes.mind.requests,
    fish: fakes.fish.sessions,
    soniox: fakes.soniox.connections,
    usage,
    conversation:
      engine === "pipedog"
        ? (pipedogSeen.context?.getMessages() ?? [])
        : nativeConversation(nativeLog),
    logs: logs.records,
    ended,
    failed,
  };
}

async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The scenario on pipedog, then on the native engine. */
export async function runTwin(scenario: Scenario): Promise<Twin> {
  return { pipedog: await runOn("pipedog", scenario), native: await runOn("native", scenario) };
}

/** An RTVI message with what may differ between runs taken out, and its text for comparing. */
export interface Normalized {
  readonly type: string;
  readonly data?: unknown;
  readonly key: string;
}

function withoutTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimestamps);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "timestamp")
      .map(([key, field]) => [key, withoutTimestamps(field)]),
  );
}

/** A normalized message's text, "" for none. */
function textOf(message: Normalized | undefined): string {
  const data = message?.data as { readonly text?: unknown } | undefined;
  return typeof data?.text === "string" ? data.text : "";
}

function normalized(type: string, data: unknown): Normalized {
  return {
    type,
    ...(data === undefined ? {} : { data }),
    key: data === undefined ? type : `${type} ${JSON.stringify(data)}`,
  };
}

/**
 * The RTVI messages the caller got, without ids, timestamps or metric values, segment ids as
 * ordinals, and a mind round's bot-llm-text as one message where its first was. How a round's
 * deltas are cut, and where bot-transcription falls among them, follows the provider's chunking
 * and each engine's segmenter (D7); its text, and its place between bot-llm-started and
 * bot-llm-stopped, are what clients read.
 */
export function normalizeRtvi(received: readonly Received[]): Normalized[] {
  const segments = new Map<unknown, number>();
  const out: Normalized[] = [];
  let round: number | null = null;
  for (const { message } of received) {
    if (message.label !== "rtvi-ai") continue;
    const type = String(message.type);
    let data = withoutTimestamps(message.data) as Record<string, unknown> | undefined;
    if (type === "metrics") data = undefined;
    if (type === "bot-output" && data !== undefined) {
      if (!segments.has(data.segment_id)) segments.set(data.segment_id, segments.size + 1);
      data = { ...data, segment_id: segments.get(data.segment_id) };
    }
    if (type === "bot-llm-started" || type === "bot-llm-stopped" || type === "bot-interrupted") {
      round = null;
    }
    if (type === "bot-llm-text") {
      if (round !== null) {
        const text = `${textOf(out[round])}${String(data?.text ?? "")}`;
        out[round] = normalized(type, { text });
        continue;
      }
      round = out.length;
    }
    out.push(normalized(type, data));
  }
  return out;
}

/** What one side has that the other doesn't, or has elsewhere. */
export type Change = "pipedog-only" | "native-only" | "moved" | "changed";

export type Difference =
  | {
      readonly kind: "rtvi";
      readonly change: Change;
      readonly message: Normalized;
      /** Native's version, for `changed`. */
      readonly other?: Normalized;
      /** Its index in each side's normalized sequence; null on the side without it. */
      readonly pipedog: number | null;
      readonly native: number | null;
    }
  | {
      /** A message in a mind request (`request` its index), or in what she would see next. */
      readonly kind: "mind" | "conversation";
      readonly request: number;
      readonly change: Change;
      readonly pipedog: unknown;
      readonly native: unknown;
    }
  | {
      /** A request field other than the messages, a Fish start or text, the Soniox config. */
      readonly kind: "request";
      readonly what: string;
      readonly pipedog: unknown;
      readonly native: unknown;
    }
  | {
      readonly kind: "usage";
      readonly change: "pipedog-only" | "native-only";
      readonly record: string;
    };

interface Op<T> {
  readonly change: "same" | "pipedog-only" | "native-only";
  readonly item: T;
  readonly pipedog: number | null;
  readonly native: number | null;
}

/** The longest-common-subsequence alignment of two sequences, compared by `key`. */
export function align<T>(a: readonly T[], b: readonly T[], key: (item: T) => string): Op<T>[] {
  const ka = a.map(key);
  const kb = b.map(key);
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i] as Uint32Array;
      row[j] =
        ka[i] === kb[j]
          ? (table[i + 1] as Uint32Array)[j + 1]! + 1
          : Math.max((table[i + 1] as Uint32Array)[j]!, row[j + 1]!);
    }
  }
  const ops: Op<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && ka[i] === kb[j]) {
      ops.push({ change: "same", item: a[i] as T, pipedog: i++, native: j++ });
    } else if (
      j >= b.length ||
      (i < a.length && (table[i + 1] as Uint32Array)[j]! >= (table[i] as Uint32Array)[j + 1]!)
    ) {
      ops.push({ change: "pipedog-only", item: a[i] as T, pipedog: i++, native: null });
    } else {
      ops.push({ change: "native-only", item: b[j] as T, pipedog: null, native: j++ });
    }
  }
  return ops;
}

/**
 * The unmatched items of an alignment: one on each side with the same key is `moved`; within a
 * run of unmatched items, a pipedog item and a native one of the same kind (`kindOf`) are one
 * item `changed`.
 */
function changes<T>(
  ops: readonly Op<T>[],
  key: (item: T) => string,
  kindOf: (item: T) => string,
): { change: Change; item: T; other?: T; pipedog: number | null; native: number | null }[] {
  const left = ops.filter((op) => op.change === "pipedog-only");
  const right = ops.filter((op) => op.change === "native-only");
  const out: ReturnType<typeof changes<T>> = [];
  const used = new Set<Op<T>>();
  for (const op of left) {
    const twin = right.find((other) => !used.has(other) && key(other.item) === key(op.item));
    if (twin === undefined) continue;
    used.add(op).add(twin);
    out.push({ change: "moved", item: op.item, pipedog: op.pipedog, native: twin.native });
  }
  let gap: Op<T>[] = [];
  const pair = () => {
    for (const op of gap) {
      if (op.change !== "pipedog-only" || used.has(op)) continue;
      const other = gap.find(
        (o) => o.change === "native-only" && !used.has(o) && kindOf(o.item) === kindOf(op.item),
      );
      if (other === undefined) continue;
      used.add(op).add(other);
      out.push({
        change: "changed",
        item: op.item,
        other: other.item,
        pipedog: op.pipedog,
        native: other.native,
      });
    }
    gap = [];
  };
  for (const op of ops) {
    if (op.change === "same") pair();
    else gap.push(op);
  }
  pair();
  for (const op of ops) {
    if (op.change === "same" || used.has(op)) continue;
    out.push({ change: op.change, item: op.item, pipedog: op.pipedog, native: op.native });
  }
  return out;
}

const json = (value: unknown) => JSON.stringify(value);

/** JSON with every object's keys sorted: the order of a request's keys means nothing to an API. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const keys = Object.keys(value).sort();
  const fields = keys.map(
    (k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
  );
  return `{${fields.join(",")}}`;
}

/** The persona prefix's clock line, which moves between the runs. */
const CLOCK = /现在是 \d+年\d+月\d+日 \S+ \d{2}:\d{2}。/g;

function withoutClock(value: unknown): unknown {
  if (typeof value === "string") return value.replace(CLOCK, "现在是 <now>。");
  if (Array.isArray(value)) return value.map(withoutClock);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutClock(v)]));
}

function compareMessages(
  kind: "mind" | "conversation",
  request: number,
  pipedog: readonly unknown[],
  native: readonly unknown[],
): Difference[] {
  const role = (message: unknown) => String((message as { role?: unknown } | null)?.role ?? "");
  return changes(align(pipedog, native, canonical), canonical, role).map((c) => ({
    kind,
    request,
    change: c.change,
    pipedog: c.change === "native-only" ? null : c.item,
    native: c.change === "changed" ? c.other : c.change === "pipedog-only" ? null : c.item,
  }));
}

/** How a usage record compares: the audio a recognizer heard follows the call's length. */
function usageKey(record: UsageRecord): string {
  const { audioSeconds, ...units } = record.units as Record<string, unknown>;
  const heard = audioSeconds === undefined ? {} : { audioSeconds: Number(audioSeconds) > 0 };
  return json([record.role, record.provider, record.model, record.source, { ...units, ...heard }]);
}

/** Every difference between the two runs. */
export function differences(twin: Twin): Difference[] {
  const { pipedog, native } = twin;
  const found: Difference[] = [];

  const rtvi = { pipedog: normalizeRtvi(pipedog.received), native: normalizeRtvi(native.received) };
  const key = (m: Normalized) => m.key;
  for (const c of changes(align(rtvi.pipedog, rtvi.native, key), key, (m) => m.type)) {
    found.push({
      kind: "rtvi",
      change: c.change,
      message: c.item,
      ...(c.other === undefined ? {} : { other: c.other }),
      pipedog: c.pipedog,
      native: c.native,
    });
  }

  const requests = Math.max(pipedog.mind.length, native.mind.length);
  for (let i = 0; i < requests; i++) {
    const a = withoutClock(pipedog.mind[i]?.body ?? {}) as Record<string, unknown>;
    const b = withoutClock(native.mind[i]?.body ?? {}) as Record<string, unknown>;
    const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
    fields.delete("messages");
    for (const field of fields) {
      if (canonical(a[field]) !== canonical(b[field])) {
        found.push({
          kind: "request",
          what: `mind ${i} ${field}`,
          pipedog: a[field],
          native: b[field],
        });
      }
    }
    const messages = (body: Record<string, unknown>) =>
      Array.isArray(body.messages) ? body.messages : [];
    found.push(...compareMessages("mind", i, messages(a), messages(b)));
  }
  found.push(
    ...compareMessages(
      "conversation",
      -1,
      withoutClock(pipedog.conversation) as unknown[],
      withoutClock(native.conversation) as unknown[],
    ),
  );

  // Fish: the same handshakes and start messages, each voice's in the order first used, and the
  // same texts spoken in the same order. Native opens a session per utterance, pipedog one per voice.
  const starts = (c: Capture) => [
    ...new Set(
      c.fish
        .filter((session) => session.start !== null)
        .map((s) =>
          json([s.path, s.authorization, s.model, Buffer.from(s.start!).toString("hex")]),
        ),
    ),
  ];
  if (json(starts(pipedog)) !== json(starts(native))) {
    found.push({
      kind: "request",
      what: "fish start",
      pipedog: starts(pipedog),
      native: starts(native),
    });
  }
  const spoken = (c: Capture) => c.fish.flatMap((session) => session.flushed);
  if (json(spoken(pipedog)) !== json(spoken(native))) {
    found.push({
      kind: "request",
      what: "fish text",
      pipedog: spoken(pipedog),
      native: spoken(native),
    });
  }

  // Soniox: the handshake and the config every connection opens with.
  const config = (c: Capture) => c.soniox.map((s) => [s.path, s.authorization, s.config]);
  if (json(config(pipedog)) !== json(config(native))) {
    found.push({
      kind: "request",
      what: "soniox config",
      pipedog: config(pipedog),
      native: config(native),
    });
  }

  const usage = {
    pipedog: pipedog.usage.map(usageKey).sort(),
    native: native.usage.map(usageKey).sort(),
  };
  for (const op of align(usage.pipedog, usage.native, (k) => k)) {
    if (op.change !== "same") found.push({ kind: "usage", change: op.change, record: op.item });
  }
  return found;
}

/** A difference, and the allowed.ts rule that explains it, if one does. */
export interface Judged {
  readonly difference: Difference;
  readonly rule: Allowance | null;
}

export function judge(twin: Twin): Judged[] {
  return differences(twin).map((difference) => ({
    difference,
    rule: ALLOWED.find((rule) => rule.matches(difference, twin)) ?? null,
  }));
}

/** The invariants each run broke. */
export function violations(twin: Twin): Record<VoiceEngine, Violation[]> {
  const wire = (c: Capture) =>
    c.received
      .filter((r) => r.message.label === "rtvi-ai")
      .map((r) => ({ type: String(r.message.type), data: r.message.data }));
  return {
    pipedog: checkInvariants(wire(twin.pipedog), { native: false }),
    native: checkInvariants(wire(twin.native), { native: true }),
  };
}

/** A readable account of a twin run: each side's messages, and every difference with its rule. */
export function report(twin: Twin): string {
  const lines: string[] = [];
  for (const engine of ["pipedog", "native"] as const) {
    const { ended, failed } = twin[engine];
    lines.push(
      `── ${engine}${ended ? "" : " (did not end when the caller left)"}${failed === null ? "" : ` (the caller failed: ${failed})`}`,
    );
    for (const [i, m] of normalizeRtvi(twin[engine].received).entries()) {
      lines.push(`  ${String(i).padStart(3)} ${m.key.slice(0, 160)}`);
    }
  }
  lines.push("── differences");
  for (const { difference, rule } of judge(twin)) {
    lines.push(
      `  ${rule === null ? "UNEXPLAINED" : rule.id.padEnd(11)} ${json(difference).slice(0, 400)}`,
    );
  }
  for (const [engine, broken] of Object.entries(violations(twin))) {
    for (const v of broken) lines.push(`  ${engine} broke ${v.id} at ${v.index}: ${v.detail}`);
  }
  return lines.join("\n");
}

/**
 * Throws, with the report, unless every difference has its rule, both runs keep the invariants,
 * and both calls ended when the caller left.
 */
export function assertParity(twin: Twin): void {
  const unexplained = judge(twin).filter((judged) => judged.rule === null);
  const broken = violations(twin);
  const ended = twin.pipedog.ended && twin.native.ended;
  const failed = twin.pipedog.failed !== null || twin.native.failed !== null;
  if (
    failed ||
    unexplained.length > 0 ||
    broken.pipedog.length > 0 ||
    broken.native.length > 0 ||
    !ended
  ) {
    throw new Error(`the engines differ beyond allowed.ts:\n${report(twin)}`);
  }
}

/** The allowed.ts rules a run's differences used, for a scenario written to trigger one. */
export function rulesUsed(twin: Twin): Set<string> {
  return new Set(judge(twin).flatMap((judged) => (judged.rule === null ? [] : [judged.rule.id])));
}
