// Who has the floor in a call, and what the client is told about it: the caller's turns, her
// replies and their speech, her tools, and the call's end, as docs/voice-engine.md's state table
// numbers its rows. `handle` takes the mailbox's events one at a time and never awaits: a reply
// runs as a task that posts its lines back, and so do her speech and the Speaker.
import type { ChatEventDraft, ParticipantId } from "@eidolon/chat";
import { errorText, logger } from "@eidolon/config";
import type { CallChatOutput, CallTurnRequest } from "@eidolon/engine";
import type { SpeechNote, SpokenReply } from "../output/mouth.ts";
import type { RtviInbound } from "../rtvi/codec.ts";
import type { RtviEmitter } from "../rtvi/emitter.ts";
import type { CallPlan, CloseReason, CursorEvent, EarEvent, Speaker } from "../types.ts";
import type { CallKit, Effect, Heard, LoopEvent } from "./kit.ts";

/** pipedog's `BOT_VAD_STOP_FALLBACK_SECS`: the Speaker drained mid-reply this long has stopped. */
const DRAIN_FALLBACK_MS = 3_000;
/** How long `disconnect-bot` lets her audio play out. */
const DISCONNECT_DRAIN_MS = 10_000;
/** How long the call's end waits for her interrupted reply to store what was heard. */
const END_WAIT_MS = 2_000;

export interface FloorOptions {
  readonly plan: CallPlan;
  readonly kit: CallKit;
  readonly emitter: RtviEmitter;
  readonly speaker: Speaker;
  /** The host's Mouth. */
  readonly mouth: { begin(reply: string, options?: { readonly audio?: boolean }): SpokenReply };
  /** Her turn (`runTurn` on the call's engine), its lines read as they come. */
  readonly turn: (request: CallTurnRequest) => AsyncIterable<CallChatOutput>;
  /** What an empty turn that cut her off asks her: `INTERRUPTED_EMPTY_TURN_PROMPT`. */
  readonly nudge: string;
  readonly newId: () => string;
  /** The call is ending: stop hearing, and close its streams, which flushes their meters. */
  readonly onEnding: (reason: CloseReason) => void;
}

interface StartOptions {
  readonly kickoff?: boolean;
  readonly nudge?: string;
  /** `send-text`'s `audio_response`: false answers in text alone. */
  readonly speech?: boolean;
}

interface Reply {
  readonly id: string;
  readonly persona: ParticipantId;
  readonly abort: AbortController;
  readonly speech: SpokenReply;
  readonly startedAt: number;
  /** `bot-llm-started` went out without its `bot-llm-stopped`. */
  mindOpen: boolean;
  /** Tool calls whose `llm-function-call-in-progress` waits for the round's `bot-llm-stopped`. */
  readonly inProgress: string[];
  /** `bot-tts-started` went out without its `bot-tts-stopped`. */
  ttsOpen: boolean;
  /** All her speech's audio has come, or her voice failed: once it plays out, she is done. */
  spoken: boolean;
  /** Her voice failed: the reply goes on in text. */
  silenced: boolean;
  /** Barged in on, or the call ended: it says nothing more, and only its end is awaited. */
  cut: boolean;
  /** The ttfb stages already logged. */
  readonly timed: Set<string>;
}

export class Floor {
  readonly #o: FloorOptions;
  #call: "connecting" | "live" | "ended" = "connecting";
  /** USER: null while quiet. */
  #user: { readonly interruptedBot: boolean } | null = null;
  /** BOT: idle while null, else thinking, or speaking with `#speaking`. */
  #reply: Reply | null = null;
  #speaking = false;
  /** Every reply whose turn hasn't ended, by id. */
  readonly #replies = new Map<string, Reply>();
  /** The Speaker's cursor last said it drained. */
  #drained = true;
  /** Consecutive empty-turn recoveries. */
  #recoveries = 0;
  #syncToolsRunning = 0;
  #followUpOwed = false;
  /** A reply to start once the cut one has ended. */
  #startOwed: StartOptions | null = null;
  /** Lines that go after the cut reply's own message, which its end stores. */
  readonly #deferred: (readonly ChatEventDraft[])[] = [];
  /** `disconnect-bot`: no more replies, and the call ends once her audio has played. */
  #closing = false;
  #ending: CloseReason | null = null;
  #finished: CloseReason | null = null;
  /** Her async tools, which outlive their turns but not the call. */
  readonly #asyncTools = new AbortController();

  constructor(options: FloorOptions) {
    this.#o = options;
  }

  /** Why the call ended, once it is over and only closing is left. */
  get finished(): CloseReason | null {
    return this.#finished;
  }

  handle(event: LoopEvent): void {
    switch (event.source) {
      case "rtvi":
        this.#rtvi(event.message);
        return;
      case "ear":
        this.#ear(event.event);
        return;
      case "reply":
        this.#replyLine(event.reply, event.out);
        return;
      case "heard":
        this.#heard(event.reply, event.answer);
        return;
      case "effect":
        this.#effect(event.reply, event.effect);
        return;
      case "mouth": {
        const reply = this.#replies.get(event.event.reply);
        if (reply !== undefined) this.#notes(reply);
        return;
      }
      case "speaker":
        this.#cursor(event.event);
        return;
      case "async-result":
        this.#asyncResult(event.drafts);
        return;
      case "timer":
        this.#timer(event);
        return;
      case "transport":
        this.#end("client");
        return;
      case "shutdown":
        this.#end("shutdown");
        return;
    }
  }

  #rtvi(message: RtviInbound): void {
    if (this.#call === "ended") return;
    const { emitter } = this.#o;
    switch (message.type) {
      case "client-ready":
        if (message.versionError !== null) emitter.errorResponse(message.id, message.versionError);
        emitter.botReady(message.id);
        if (this.#call === "connecting") {
          this.#call = "live";
          if (this.#o.plan.greet) this.#start({ kickoff: true });
        }
        return;
      case "send-text":
        this.#sendText(message);
        return;
      case "disconnect-bot":
        this.#disconnect();
        return;
      case "client-message":
        logger.debug(`[voice] Client message ${message.t} ignored`);
        return;
      case "rejected":
        emitter.errorResponse(message.id, message.error);
        return;
      case "malformed":
        emitter.error(message.error);
        return;
      case "foreign":
        logger.debug("[voice] A data channel message that isn't RTVI was dropped");
        return;
    }
  }

  #sendText(message: Extract<RtviInbound, { type: "send-text" }>): void {
    const { emitter } = this.#o;
    const line = this.#userLine(message.content, "text");
    if (message.runImmediately) {
      emitter.botInterrupted();
      if (this.#reply !== null) this.#bargeIn(true);
      emitter.userTyped(message.content, message.id);
      emitter.userLlmText(message.content);
      this.#append(line);
      this.#start({ speech: message.audioResponse });
      return;
    }
    emitter.userTyped(message.content, message.id);
    this.#append(line);
    if (this.#idle()) this.#start();
    else this.#followUpOwed = true;
  }

  /** Row 27: no more replies; the call ends once her audio has played, 10 s at most. */
  #disconnect(): void {
    this.#closing = true;
    this.#startOwed = null;
    this.#followUpOwed = false;
    if (this.#speaking) this.#o.kit.arm("disconnect", DISCONNECT_DRAIN_MS);
    else this.#end("bot");
  }

  #ear(event: EarEvent): void {
    if (this.#call === "ended") return;
    const { emitter, kit } = this.#o;
    switch (event.type) {
      case "user-started":
        this.#userStarted();
        return;
      case "user-speaking":
        kit.active();
        return;
      case "interim":
      case "final":
        emitter.userTranscription(event.text, event.type === "final");
        kit.active();
        return;
      case "user-stopped":
        this.#userStopped(event.text);
        return;
      case "stt-error":
        emitter.error(event.message);
        if (event.fatal) this.#end("error");
        return;
    }
  }

  #userStarted(): void {
    if (this.#user !== null) return;
    const { emitter, kit } = this.#o;
    emitter.userStartedSpeaking();
    emitter.botInterrupted();
    const interruptedBot = this.#reply !== null || this.#syncToolsRunning > 0;
    if (this.#reply !== null) this.#bargeIn(true);
    this.#user = { interruptedBot };
    kit.active();
  }

  #userStopped(text: string | null): void {
    const user = this.#user;
    if (user === null) return;
    const { emitter } = this.#o;
    this.#user = null;
    // pipedog starts her reply on the final transcript, then ends the turn: its user-llm-text
    // comes first.
    if (text !== null) emitter.userLlmText(text);
    emitter.userStoppedSpeaking();
    if (text !== null) {
      this.#append(this.#userLine(text, "call"));
      this.#recoveries = 0;
      this.#start();
    } else if (user.interruptedBot && this.#recoveries < 1 && this.#syncToolsRunning === 0) {
      this.#recoveries++;
      this.#start({ nudge: this.#o.nudge });
    } else if (this.#followUpOwed && this.#idle()) {
      // An async result that came while the caller spoke, which a turn of words would have taken.
      this.#start();
    }
  }

  #userLine(text: string, modality: "call" | "text"): ChatEventDraft {
    const id = this.#o.newId();
    return { type: "message", id, speaker: { kind: "user" }, text, modality };
  }

  /** USER quiet and BOT idle: pipedog's `waitingForUser`. */
  #idle(): boolean {
    return this.#user === null && this.#reply === null;
  }

  #start(options: StartOptions = {}): void {
    if (this.#call === "ended" || this.#closing) return;
    // The reply still open stores what was heard of it first.
    if (this.#reply !== null) {
      this.#startOwed = options;
      return;
    }
    this.#followUpOwed = false;
    const { plan, kit, mouth, newId } = this.#o;
    const id = newId();
    const persona = plan.host;
    const reply: Reply = {
      id,
      persona,
      abort: new AbortController(),
      speech: mouth.begin(id, { audio: options.speech ?? true }),
      startedAt: kit.clock.now(),
      mindOpen: false,
      inProgress: [],
      ttsOpen: false,
      spoken: false,
      silenced: false,
      cut: false,
      timed: new Set(),
    };
    this.#reply = reply;
    this.#replies.set(id, reply);
    this.#speaking = false;
    const { post } = kit;
    const request: CallTurnRequest = {
      chat: plan.log.snapshot(),
      persona,
      viewer: plan.viewer,
      ...(options.kickoff ? { kickoff: true } : {}),
      ...(options.nudge === undefined ? {} : { nudge: options.nudge }),
      signal: reply.abort.signal,
      mode: "call",
      effects: {
        switchVoice: async (voice) =>
          post({ source: "effect", reply: id, effect: { type: "voice", voice } }),
        sendServerMessage: async (data) =>
          post({ source: "effect", reply: id, effect: { type: "server-message", data } }),
      },
      // Through the mailbox, behind the lines it has yet to speak; once the call has stopped
      // reading, her speech was cancelled and answers at once.
      heard: () =>
        kit.stopped
          ? reply.speech.heard()
          : new Promise<Heard>((answer) => post({ source: "heard", reply: id, answer })),
      onAsyncResult: (drafts) => post({ source: "async-result", persona, drafts }),
      asyncSignal: this.#asyncTools.signal,
      usage: { source: "call", session: plan.id },
    };
    void this.#run(id, request);
  }

  /** Her turn's lines, posted as they come; a turn that throws still ends. */
  async #run(id: string, request: CallTurnRequest): Promise<void> {
    const { kit, turn } = this.#o;
    try {
      for await (const out of turn(request)) kit.post({ source: "reply", reply: id, out });
    } catch (error) {
      logger.error(`[voice] Reply ${id} failed: ${errorText(error)}`, error);
      kit.post({ source: "reply", reply: id, out: { type: "ended", turn: id } });
    }
  }

  #replyLine(id: string, out: CallChatOutput): void {
    const reply = this.#replies.get(id);
    if (reply === undefined) return;
    const { emitter, plan } = this.#o;
    switch (out.type) {
      case "events":
        // Stored before anything else is done with it.
        plan.log.append(out.events);
        return;
      case "decision":
        plan.log.append([out]);
        return;
      case "started":
        return;
      case "mind":
        if (out.state === "started") {
          if (reply.cut) return;
          reply.mindOpen = true;
          emitter.botLlmStarted();
          this.#timed(reply, "llm");
        } else if (reply.mindOpen) {
          reply.mindOpen = false;
          emitter.botLlmStopped();
          for (const callId of reply.inProgress.splice(0)) emitter.toolInProgress(callId);
          if (out.error !== undefined) emitter.error(out.error);
          reply.speech.flush();
        }
        return;
      case "delta":
        if (reply.cut) return;
        emitter.botLlmText(out.text);
        this.#timed(reply, "text");
        reply.speech.push(out.text);
        return;
      case "tool":
        if (out.state === "running") {
          // pipedog reports a round's calls started as its response ends, and each in progress as
          // it runs, after that response's bot-llm-stopped.
          emitter.toolStarted();
          if (reply.mindOpen) reply.inProgress.push(out.callId);
          else emitter.toolInProgress(out.callId);
          if (!out.async) this.#syncToolsRunning++;
        } else {
          emitter.toolStopped(out.callId, out.state === "cancelled");
          if (!out.async) this.#syncToolsRunning--;
        }
        return;
      case "notice":
        emitter.error(out.text);
        return;
      case "ended":
        this.#replyEnded(reply);
        return;
    }
  }

  #replyEnded(reply: Reply): void {
    this.#replies.delete(reply.id);
    if (this.#reply !== reply) return;
    this.#reply = null;
    this.#speaking = false;
    this.#o.kit.cancel("drain-fallback");
    if (this.#ending !== null) {
      this.#finish();
      return;
    }
    for (const drafts of this.#deferred.splice(0)) this.#o.plan.log.append(drafts);
    if (this.#closing) {
      this.#end("bot");
      return;
    }
    const owed = this.#startOwed;
    this.#startOwed = null;
    if (owed !== null) this.#start(owed);
    else if (this.#followUpOwed && this.#user === null) this.#start();
  }

  /** Her turn is done writing: her speech ends, and `answer` gets what was heard once it played. */
  #heard(id: string, answer: (heard: Heard) => void): void {
    const reply = this.#replies.get(id);
    if (reply !== undefined) void reply.speech.heard().then(answer);
  }

  #effect(id: string, effect: Effect): void {
    if (this.#call === "ended") return;
    if (effect.type === "server-message") {
      this.#o.emitter.serverMessage(effect.data);
      return;
    }
    this.#replies.get(id)?.speech.switchVoice(effect.voice);
  }

  /** Row 23: stored, and answered once the floor is free; a reply started sooner sees it too. */
  #asyncResult(drafts: readonly ChatEventDraft[]): void {
    if (this.#call !== "ended") {
      for (const draft of drafts) {
        if (
          draft.type === "tool-result" &&
          draft.stage !== undefined &&
          draft.stage !== "started"
        ) {
          this.#o.emitter.toolStopped(draft.callId, draft.stage === "cancelled");
        }
      }
    }
    this.#append(...drafts);
    if (this.#call === "ended" || this.#closing) return;
    if (this.#idle()) this.#start();
    else this.#followUpOwed = true;
  }

  /** Appends lines to the log, after her cut reply's message while it has yet to store it. */
  #append(...drafts: ChatEventDraft[]): void {
    if (drafts.length === 0) return;
    if (this.#reply?.cut) this.#deferred.push(drafts);
    else this.#o.plan.log.append(drafts);
  }

  #timed(reply: Reply, stage: "llm" | "text" | "speaking"): void {
    if (reply.timed.has(stage)) return;
    reply.timed.add(stage);
    const ms = Math.round(this.#o.kit.clock.now() - reply.startedAt);
    logger.info(`[voice] ttfb ${stage} ${ms}`);
  }

  #notes(reply: Reply): void {
    for (const note of reply.speech.take()) {
      if (reply.silenced) return;
      this.#note(reply, note);
    }
  }

  #note(reply: Reply, note: SpeechNote): void {
    const { emitter } = this.#o;
    switch (note.type) {
      case "segment":
        emitter.segment(note.tag, note.text);
        return;
      case "tts-started":
        reply.ttsOpen = true;
        emitter.botTtsStarted();
        return;
      case "tts-stopped":
        if (reply.ttsOpen) {
          reply.ttsOpen = false;
          emitter.botTtsStopped();
        }
        reply.spoken = true;
        if (reply === this.#reply && this.#speaking && this.#drained) this.#stoppedSpeaking();
        return;
      case "tts-error":
        this.#ttsError(reply, note.message);
        return;
      case "segment-started":
        emitter.segmentStarted(note.tag);
        return;
      case "segment-progress":
        emitter.segmentProgress(note.tag, note.spokenTo);
        return;
      case "segment-ended":
        emitter.segmentEnded(note.tag);
        return;
    }
  }

  /**
   * Row 25: her voice failed or stalled. What she has queued is dropped, so what was heard is what
   * she keeps, and the reply goes on in text.
   */
  #ttsError(reply: Reply, message: string): void {
    const { emitter, speaker } = this.#o;
    emitter.error(message);
    if (reply === this.#reply) {
      speaker.clear();
      this.#drained = true;
    }
    reply.speech.cancel();
    reply.silenced = true;
    reply.spoken = true;
    if (reply.ttsOpen) {
      reply.ttsOpen = false;
      emitter.botTtsStopped();
    }
    if (reply === this.#reply && this.#speaking) this.#stoppedSpeaking();
  }

  #cursor(event: CursorEvent): void {
    if (this.#call === "ended") return;
    const { kit } = this.#o;
    kit.active();
    switch (event.type) {
      case "reply-start": {
        this.#drained = false;
        kit.cancel("drain-fallback");
        const reply = this.#reply;
        if (reply === null || reply.id !== event.reply || reply.cut || this.#speaking) return;
        this.#speaking = true;
        this.#o.emitter.botStartedSpeaking();
        this.#timed(reply, "speaking");
        return;
      }
      case "drained":
        this.#drained = true;
        if (!this.#speaking) return;
        if (this.#closing) {
          this.#end("bot");
          return;
        }
        if (this.#reply?.spoken) this.#stoppedSpeaking();
        else kit.arm("drain-fallback", DRAIN_FALLBACK_MS);
        return;
      default: {
        const reply = this.#replies.get(event.tag.reply);
        if (reply === undefined || reply.cut) return;
        reply.speech.cursor(event);
        this.#notes(reply);
      }
    }
  }

  #stoppedSpeaking(): void {
    this.#speaking = false;
    this.#o.kit.cancel("drain-fallback");
    this.#o.emitter.botStoppedSpeaking();
  }

  /**
   * A barge-in: her audio stops at once, her speech freezes at what was heard, and her turn is aborted;
   * her async tools run on. With `emit`, what she was doing is closed for the client.
   */
  #bargeIn(emit: boolean): void {
    const reply = this.#reply;
    if (reply === null) return;
    const { emitter, speaker, kit } = this.#o;
    speaker.clear();
    this.#drained = true;
    reply.speech.cancel();
    reply.abort.abort("interrupted");
    this.#startOwed = null;
    if (emit) {
      if (reply.mindOpen) emitter.botLlmStopped();
      if (reply.ttsOpen) emitter.botTtsStopped();
      if (this.#speaking) emitter.botStoppedSpeaking();
    }
    reply.mindOpen = false;
    // Cancelled before they ran: pipedog never reports them in progress.
    reply.inProgress.length = 0;
    reply.ttsOpen = false;
    reply.cut = true;
    this.#speaking = false;
    kit.cancel("drain-fallback");
  }

  #timer(event: Extract<LoopEvent, { source: "timer" }>): void {
    const { kit, speaker } = this.#o;
    if (!kit.fired(event)) return;
    switch (event.timer) {
      case "idle":
        if (this.#call === "ended") return;
        // Her audio playing is activity, as pipedog's BotSpeakingFrame is.
        if (speaker.isSpeaking()) kit.active();
        else if (kit.idle()) this.#end("idle");
        return;
      case "drain-fallback":
        if (this.#speaking && this.#drained) this.#stoppedSpeaking();
        return;
      case "disconnect":
        this.#end("bot");
        return;
      case "end":
        this.#finish();
        return;
    }
  }

  /** Her reply is cut silently, her async tools abort, and the call's streams close. */
  #end(reason: CloseReason): void {
    if (this.#call === "ended") return;
    const { kit } = this.#o;
    this.#call = "ended";
    this.#ending = reason;
    this.#bargeIn(false);
    this.#asyncTools.abort();
    this.#startOwed = null;
    this.#followUpOwed = false;
    kit.cancel("idle");
    kit.cancel("disconnect");
    this.#o.onEnding(reason);
    if (this.#reply === null) this.#finish();
    else kit.arm("end", END_WAIT_MS);
  }

  #finish(): void {
    if (this.#finished !== null) return;
    this.#o.kit.cancel("end");
    for (const drafts of this.#deferred.splice(0)) this.#o.plan.log.append(drafts);
    this.#finished = this.#ending;
  }
}
