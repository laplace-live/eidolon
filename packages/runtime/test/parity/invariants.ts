// What every client may count on in a call's RTVI messages, on either engine: I1–I10 of
// docs/voice-engine.md, "RTVI". The twin harness checks them on every run, and
// apps/bot/scripts/e2e-call.ts on every real call's timeline, so this file imports nothing.

/** One RTVI message as it crossed the wire: its type and data. */
export interface WireMessage {
  readonly type: string;
  readonly data?: unknown;
}

export interface Violation {
  readonly id: `I${number}`;
  /** The offending message's index in the sequence checked. */
  readonly index: number;
  readonly detail: string;
}

export interface InvariantOptions {
  /** I6 holds on the native engine only: pipedog's Fish service never stops its audio context. */
  readonly native: boolean;
  /**
   * A realtime model's call: its server ends the caller's turn on its own VAD and answers it
   * before transcribing it, so a turn's final transcript comes after its user-stopped-speaking
   * (I2 holds as "after its user-started-speaking"), and I9 has no transcript to wait for.
   */
  readonly realtime?: boolean;
}

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

const isTranscription = (m: WireMessage) =>
  (m.type === "user-input" && field(m.data, "input_type") === "transcription") ||
  m.type === "user-transcription";

const isFinalTranscription = (m: WireMessage) =>
  isTranscription(m) && field(m.data, "final") === true;

/** Every violation of I1–I10 in `messages`, the call's RTVI messages from the bot in order. */
export function checkInvariants(
  messages: readonly WireMessage[],
  options: InvariantOptions,
): Violation[] {
  // pipedog's metrics interleave with everything, and no client reads them (D3).
  const seq = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.type !== "metrics");
  const found: Violation[] = [];
  const violate = (id: Violation["id"], index: number, detail: string) =>
    found.push({ id, index, detail });

  // I1: bot-ready before any other bot-*, user-* or llm-* message.
  for (const { message, index } of seq) {
    if (message.type === "bot-ready") break;
    if (/^(bot|user|llm)-/.test(message.type)) {
      violate("I1", index, `${message.type} before bot-ready`);
    }
  }

  // I3: user-input comes before user-transcription for the same text.
  const inputs: string[] = [];
  for (const { message, index } of seq) {
    const key = `${field(message.data, "final")}\n${field(message.data, "text")}`;
    if (message.type === "user-input" && field(message.data, "input_type") === "transcription") {
      inputs.push(key);
    } else if (message.type === "user-transcription") {
      const at = inputs.indexOf(key);
      if (at === -1) violate("I3", index, "user-transcription with no user-input before it");
      else inputs.splice(at, 1);
    }
  }

  // I4: every user-started-speaking is followed at once by bot-interrupted.
  for (const [at, { message, index }] of seq.entries()) {
    if (message.type !== "user-started-speaking") continue;
    const next = seq[at + 1]?.message.type;
    if (next !== "bot-interrupted") {
      violate("I4", index, `user-started-speaking followed by ${next ?? "nothing"}`);
    }
  }

  // I5: every bot-llm-started has a later bot-llm-stopped, with no start between.
  // I6: every bot-tts-started has a later bot-tts-stopped.
  // I8: every error is fatal: false.
  let llm: number | null = null;
  let tts: number | null = null;
  for (const { message, index } of seq) {
    if (message.type === "bot-llm-started") {
      if (llm !== null) violate("I5", index, "a second bot-llm-started before bot-llm-stopped");
      llm = index;
    } else if (message.type === "bot-llm-stopped") llm = null;
    else if (message.type === "bot-tts-started") {
      if (options.native && tts !== null) {
        violate("I6", index, "a second bot-tts-started before bot-tts-stopped");
      }
      tts = index;
    } else if (message.type === "bot-tts-stopped") tts = null;
    else if (message.type === "error" && field(message.data, "fatal") !== false) {
      violate("I8", index, `error with fatal ${JSON.stringify(field(message.data, "fatal"))}`);
    }
  }
  if (llm !== null) violate("I5", llm, "bot-llm-started never stopped");
  if (options.native && tts !== null) violate("I6", tts, "bot-tts-started never stopped");

  // I7: each segment's "new" comes before its "in-progress" or "completed", and it completes once
  // unless a barge-in cut it or it won't be spoken (`will_be_spoken: false`, its "new" alone).
  const segments = new Map<
    unknown,
    { at: number; completed: number; cut: boolean; spoken: boolean }
  >();
  for (const { message, index } of seq) {
    if (message.type === "bot-interrupted") {
      for (const segment of segments.values()) segment.cut = true;
      continue;
    }
    if (message.type !== "bot-output") continue;
    const id = field(message.data, "segment_id");
    const status = field(message.data, "spoken_status");
    const segment = segments.get(id);
    if (status === "new") {
      if (segment !== undefined) violate("I7", index, `segment ${String(id)} is new twice`);
      const spoken = field(message.data, "will_be_spoken") !== false;
      segments.set(id, { at: index, completed: 0, cut: false, spoken });
    } else if (segment === undefined) {
      violate("I7", index, `segment ${String(id)} is ${String(status)} before it is new`);
    } else if (status === "completed") {
      segment.completed++;
      if (segment.completed > 1) violate("I7", index, `segment ${String(id)} completed twice`);
    }
  }
  for (const [id, segment] of segments) {
    if (segment.completed === 0 && !segment.cut && segment.spoken) {
      violate("I7", segment.at, `segment ${String(id)} never completed`);
    }
  }

  // I2: a turn's final transcripts come before its user-stopped-speaking.
  // I9: a turn with no final transcript starts no mind request unless it interrupted her.
  // I10: after bot-interrupted, no bot-llm-text comes before the next bot-llm-started.
  let turn: { finals: number; interrupted: boolean } | null = null;
  /** Realtime: turns started whose final transcript hasn't come. */
  let untranscribed = 0;
  let quietTurn: number | null = null;
  let llmOpen = false;
  let speaking = false;
  let tools = 0;
  let afterInterruption = false;
  for (const { message, index } of seq) {
    switch (message.type) {
      case "user-started-speaking":
        turn = { finals: 0, interrupted: llmOpen || speaking || tools > 0 };
        quietTurn = null;
        untranscribed++;
        break;
      case "user-stopped-speaking":
        if (turn !== null && turn.finals === 0 && !turn.interrupted && !options.realtime) {
          quietTurn = index;
        }
        turn = null;
        break;
      case "bot-interrupted":
        afterInterruption = true;
        break;
      case "bot-llm-started":
        if (quietTurn !== null) {
          violate("I9", index, `a mind request after the empty turn ending at ${quietTurn}`);
          quietTurn = null;
        }
        llmOpen = true;
        afterInterruption = false;
        break;
      case "bot-llm-stopped":
        llmOpen = false;
        break;
      case "bot-llm-text":
        if (afterInterruption) violate("I10", index, "bot-llm-text after bot-interrupted");
        break;
      case "bot-started-speaking":
        speaking = true;
        break;
      case "bot-stopped-speaking":
        speaking = false;
        break;
      case "llm-function-call-in-progress":
        tools++;
        break;
      case "llm-function-call-stopped":
        tools = Math.max(0, tools - 1);
        // An async result settled: the reply it starts is no empty turn's.
        quietTurn = null;
        break;
      case "user-input":
        // Typed text starts a reply of its own.
        if (field(message.data, "input_type") === "chat") quietTurn = null;
        break;
    }
    if (isFinalTranscription(message)) {
      if (options.realtime) {
        // user-input and user-transcription carry the same final.
        if (message.type === "user-transcription") untranscribed = Math.max(0, untranscribed - 1);
        else if (untranscribed === 0) {
          violate("I2", index, "a final transcript with no turn of the caller's before it");
        }
      } else if (turn === null) {
        violate("I2", index, "a final transcript outside the caller's turn");
      } else {
        turn.finals++;
      }
    }
  }
  return found.sort((a, b) => a.index - b.index);
}
