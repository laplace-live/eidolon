// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/openai/src/open_ai_realtime_adapter.ts@ce8f8bc and packages/xai/src/grok_realtime_adapter.ts@ce8f8bc
//
// A call on a realtime model, which hears, thinks and speaks in one session: the server's VAD in
// place of the Ear, her audio straight onto the Speaker in place of the Mouth. The session's events
// reach the call's mailbox, and the realtime floor tells the client what they mean, keeps the
// call's log, and runs her recall and tools through the engine. docs/voice-engine.md, "Realtime".
import {
  type ChatEvent,
  type ChatEventDraft,
  cancelledEnvelope,
  finalEnvelope,
  startedEnvelope,
} from "@eidolon/chat";
import { errorText, logger, pyJsonDumps, pyTruthy, withPersona } from "@eidolon/config";
import type { ConversationContext, LlmTool, ToolEffects, ToolResult } from "@eidolon/core";
import {
  callInstruction,
  callSeed,
  isAsyncTool,
  type PersonaParts,
  prepareTurn,
  runTool,
} from "@eidolon/engine";
import { realtimeVoiceOf, selectRequired } from "@eidolon/providers";
import type { RealtimeEvent, RealtimeOptions, RealtimeSession } from "@eidolon/providers/realtime";
import { spokenLanguage } from "@eidolon/providers/stt";
import { sttSender } from "../input/ear.ts";
import { Segmenter } from "../output/segmenter.ts";
import type { RtviInbound } from "../rtvi/codec.ts";
import { RtviEmitter } from "../rtvi/emitter.ts";
import type {
  CallDeps,
  CallPlan,
  CallTransport,
  Clock,
  CloseReason,
  CursorEvent,
  Pcm,
  Speaker,
  Tag,
} from "../types.ts";
import {
  type CallKit,
  DISCONNECT_DRAIN_MS,
  DRAIN_FALLBACK_MS,
  type LoopEvent,
  runCall,
} from "./kit.ts";

/** The model OpenAI's realtime sessions transcribe the caller with, as pipedog's call asks. */
const TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
/** How long her bot-output and stored line wait for the caller's final transcript (E4). */
const TRANSCRIPT_HOLD_MS = 1_000;

/** What reaches a realtime call's mailbox besides what every call gets. */
export type RealtimeInput =
  | { readonly kind: "server"; readonly event: RealtimeEvent }
  /** The recall of turn `prep`; `events` null when it failed. */
  | {
      readonly kind: "prepared";
      readonly prep: number;
      readonly greeting: boolean;
      readonly events: readonly ChatEventDraft[] | null;
      readonly context: ConversationContext | null;
    }
  /** A tool her model called settled: null when it timed out. */
  | { readonly kind: "tool"; readonly callId: string; readonly result: ToolResult | null }
  /** An async tool settled after its call was answered: null when it was cancelled. */
  | { readonly kind: "async-result"; readonly callId: string; readonly result: ToolResult | null }
  | { readonly kind: "server-message"; readonly data: Readonly<Record<string, unknown>> }
  /** The hold on her bot-output for the caller's transcript ran out. */
  | { readonly kind: "hold"; readonly token: number };

type Dialect = "openai" | "xai";

/** The intro pipedog's adapters open a packed history with. */
const PACKED_INTRO = `
        This is a previously saved conversation. Please treat this conversation history as a
        starting point for the current conversation.`;

/** The trailing text pipedog's adapters close a packed history with, each its own. */
const PACKED_TRAILING: Readonly<Record<Dialect, string>> = {
  openai: `
        This is the end of the previously saved conversation. Please continue the conversation
        from here. If the last message is a user instruction or question, act on that instruction
        or answer the question. If the last message is an assistant response, simple say that you
        are ready to continue the conversation.`,
  xai: `
        This is the end of the previously saved conversation. Please continue the conversation
        from here. If the last message is a user instruction or question, act on that instruction
        or answer the question. If the last message is an assistant response, simply say that you
        are ready to continue the conversation.`,
};

type Message = Record<string, unknown>;

/** A user message's text, its content parts joined as the dialect's adapter joins them. */
function userText(content: unknown, dialect: Dialect): string {
  if (!Array.isArray(content)) return String(content ?? "");
  const texts: string[] = [];
  for (const part of content as Message[]) {
    if (part.type === "text") texts.push(String(part.text ?? ""));
    else logger.error(`Unhandled content type in context message: ${String(part.type)}`);
  }
  return dialect === "xai"
    ? texts
        .filter((text) => text !== "")
        .join(" ")
        .trim()
    : texts.map((text) => ` ${text}`).join("");
}

/**
 * `_fromUniversalContextMessages`: the conversation a session opens on, as the texts of the user
 * items that carry it. A long history can't be loaded item by item (the API forgets it can speak
 * after a series of `conversation.item.create`s), so everything goes into one user item, unless it
 * is a single user message. A system message opening it gives way to the session's instructions.
 */
export function packHistory(messages: readonly unknown[], dialect: Dialect): string[] {
  const list = messages.map((message) => structuredClone(message) as Message);
  if (list.length === 0) return [];
  if (list[0]?.role === "system") {
    list.shift();
    if (list.length === 0) return [];
  }
  for (const message of list) {
    if (message.role === "system" || message.role === "developer") message.role = "user";
  }
  const [only] = list;
  if (list.length === 1 && only?.role === "user") return [userText(only.content, dialect)];
  return [[PACKED_INTRO, JSON.stringify(list, null, 2), PACKED_TRAILING[dialect]].join("\n\n")];
}

/** pipedog's content for a tool's result, as an output or an envelope: `COMPLETED` when empty. */
function resultContent(result: ToolResult): string {
  return pyTruthy(result) ? pyJsonDumps(result, { ensureAscii: false }) : "COMPLETED";
}

/** A context for her tools before her first recall has made one. */
function emptyContext(): ConversationContext {
  let messages: unknown[] = [];
  return {
    getMessages: () => [...messages],
    setMessages: (next) => {
      messages = [...next];
    },
    setHiddenTools: () => {},
  };
}

interface ToolCallState {
  /** Cancels a sync tool when the caller cuts her off. */
  readonly abort: AbortController | null;
  /** What answers the call, once it settled. */
  output: string | null;
}

interface Delta {
  readonly itemId: string;
  /** Ms of the item's audio queued when it came: heard once the cursor passed it. */
  readonly atMs: number;
  readonly text: string;
}

/** One response of the model's, as the call follows it. */
interface Reply {
  /** The `turn` her log events carry. */
  readonly turn: string;
  llmOpen: boolean;
  ttsOpen: boolean;
  /** The caller cut it off, or the call ended: what follows of it is dropped. */
  cut: boolean;
  /** Its `response-done` came: all of its audio is in. */
  done: boolean;
  /** Its line is in the log, or there was none to store. */
  stored: boolean;
  readonly deltas: Delta[];
  readonly segmenter: Segmenter;
  /** Sentences whose end waits for its first audio. */
  readonly pending: string[];
  /** The item its latest audio came in, and the content index it named. */
  last: { readonly itemId: string; readonly contentIndex: number } | null;
  readonly queued: Map<string, number>;
  readonly calls: Map<string, ToolCallState>;
}

interface RealtimeFloorOptions {
  readonly plan: CallPlan;
  readonly kit: CallKit;
  readonly emitter: RtviEmitter;
  readonly speaker: Speaker;
  readonly session: RealtimeSession;
  readonly dialect: Dialect;
  readonly parts: PersonaParts;
  readonly engine: CallDeps["engine"];
  readonly newId: () => string;
  /** The call is ending: stop listening, and close the session, which flushes its meter. */
  readonly onEnding: (reason: CloseReason) => void;
}

/**
 * Who has the floor on a realtime call: the server decides when the caller speaks and answers on
 * its own, so this follows its events (§9 of the voice engine's contract) rather than starting
 * turns. `handle` takes the mailbox's events one at a time and never awaits.
 */
class RealtimeFloor {
  readonly #o: RealtimeFloorOptions;
  #call: "connecting" | "live" | "ended" = "connecting";
  /** The caller is speaking, by the server's VAD. */
  #userSpeaking = false;
  /** The response the server is running. */
  #active: Reply | null = null;
  /** The reply whose audio plays, or played last. */
  #playing: Reply | null = null;
  /** The responses under way, by id. */
  readonly #replies = new Map<string, Reply>();
  /** A response has started. */
  #responded = false;
  /** Each tool call's `turn`, for its late result. */
  readonly #callTurns = new Map<string, string>();
  #speaking = false;
  #drained = true;
  /** Her tool calls' answers wait for their reply to end, play out, and the floor to free. */
  readonly #toolReplies = new Set<Reply>();
  /** A late async result came while the floor was taken: a reply is owed once it frees. */
  #followUpOwed = false;
  #closing = false;
  #finished: CloseReason | null = null;
  /** The conversation so far went to the session: what the log held then reached the model in it. */
  #setUp = false;
  /** Her recall's latest view, which her tools read. */
  #context: ConversationContext = emptyContext();
  #prep = 0;
  /** The caller's latest turn's recall, which the next speech-started stops. */
  #prepAbort: AbortController | null = null;
  /** The greeting's, which only the call's end stops: the conversation waits for it. */
  readonly #greetAbort = new AbortController();
  /** Her async tools, which outlive their replies but not the call. */
  readonly #asyncTools = new AbortController();
  /** The item each mirrored context block went in as, by its seq. */
  readonly #blockItems = new Map<number, Promise<string>>();
  /** The caller stopped and her final transcript hasn't come: E4's hold. */
  #awaiting: { readonly token: number; readonly cancel: () => void } | null = null;
  #holdToken = 0;
  readonly #held: Tag[] = [];
  readonly #deferred: (readonly ChatEventDraft[])[] = [];
  #nextSeg = 1;
  /** The caller's lines whose user-llm-text waits for the reply to them to end. */
  readonly #linesOwed: string[] = [];

  constructor(options: RealtimeFloorOptions) {
    this.#o = options;
  }

  /** Why the call ended, once it is over and only closing is left. */
  get finished(): CloseReason | null {
    return this.#finished;
  }

  /** A call that doesn't greet goes to the session as it opens, with its history, if any. */
  start(): void {
    if (!this.#o.plan.greet) this.#setUpConversation();
  }

  handle(event: LoopEvent): void {
    switch (event.source) {
      case "rtvi":
        this.#rtvi(event.message);
        return;
      case "speaker":
        this.#cursor(event.event);
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
      case "realtime":
        this.#input(event.input);
        return;
      default:
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
          // Her greeting: the kickoff and her recall stored, then the conversation and a response.
          if (this.#o.plan.greet) this.#recall(true);
        }
        return;
      case "send-text":
        this.#sendText(message);
        return;
      case "disconnect-bot":
        this.#closing = true;
        if (this.#speaking) this.#o.kit.arm("disconnect", DISCONNECT_DRAIN_MS);
        else this.#end("bot");
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

  /** Typed text cuts her off, and the model answers it as the caller's line (E2). */
  #sendText(message: Extract<RtviInbound, { type: "send-text" }>): void {
    const { emitter, session } = this.#o;
    const line = this.#userLine(message.content, "text");
    if (message.runImmediately) {
      emitter.botInterrupted();
      // xAI's client cancels on every interruption, before it truncates; OpenAI's server cancels
      // only on its own VAD, so a response running now is the client's to cancel.
      const cancel = this.#o.dialect === "xai" || this.#active !== null;
      this.#bargeIn({ emit: true, cancel: cancel ? "first" : "no" });
      this.#flushLines();
      emitter.userTyped(message.content, message.id);
      emitter.userLlmText(message.content);
      this.#append(line);
      void session.addItem({ role: "user", text: message.content });
      session.createResponse();
      return;
    }
    // Delivered for her next response, as pipedog's append without run_llm.
    emitter.userTyped(message.content, message.id);
    this.#append(line);
    void session.addItem({ role: "user", text: message.content });
  }

  #userLine(text: string, modality: "call" | "text"): ChatEventDraft {
    return {
      type: "message",
      id: this.#o.newId(),
      speaker: { kind: "user" },
      text,
      modality,
    };
  }

  /** prepareTurn on the log as it stands; its result posts back. */
  #recall(greeting: boolean): void {
    let signal = this.#greetAbort.signal;
    let prep = 0;
    if (!greeting) {
      this.#prepAbort?.abort("superseded");
      const abort = new AbortController();
      this.#prepAbort = abort;
      signal = abort.signal;
      prep = ++this.#prep;
    }
    const { plan, engine, kit } = this.#o;
    const post = (
      events: readonly ChatEventDraft[] | null,
      context: ConversationContext | null,
    ): void =>
      kit.post({
        source: "realtime",
        input: { kind: "prepared", prep, greeting, events, context },
      });
    prepareTurn(
      {
        chat: plan.log.snapshot(),
        persona: plan.host,
        viewer: plan.viewer,
        ...(greeting ? { kickoff: true } : {}),
        usage: { source: "call", session: plan.id },
        signal,
      },
      engine,
    ).then(
      ({ events, context }) => post(events, context),
      (error: unknown) => {
        if (signal.aborted) return;
        logger.error(`[voice] ${plan.host}'s recall failed: ${errorText(error)}`, error);
        post(null, null);
      },
    );
  }

  #prepared(input: Extract<RealtimeInput, { kind: "prepared" }>): void {
    if (this.#call === "ended") return;
    if (!input.greeting) {
      if (input.prep !== this.#prep) return;
      this.#prepAbort = null;
    }
    if (input.context !== null) this.#context = input.context;
    const stored = input.events === null ? [] : this.#o.plan.log.append(input.events);
    if (input.greeting) {
      // Her kickoff and recall reach the model inside the conversation it opens on; a caller who
      // spoke first has had an answer instead.
      this.#setUpConversation();
      if (!this.#responded && !this.#userSpeaking) this.#o.session.createResponse();
      return;
    }
    if (this.#setUp) this.#mirror(stored);
  }

  /** The conversation so far, packed as pipedog's adapters pack a call's context, once. */
  #setUpConversation(): void {
    if (this.#setUp) return;
    this.#setUp = true;
    const { plan, session, dialect } = this.#o;
    const seed = callSeed(plan.log.snapshot(), plan.host, plan.viewer.uname ?? "");
    for (const text of packHistory(seed, dialect)) void session.addItem({ role: "user", text });
  }

  /**
   * Her recall's blocks go to the session as they change (E1): a block in as an item, a block a
   * provider took out as that item deleted.
   */
  #mirror(events: readonly ChatEvent[]): void {
    const { session } = this.#o;
    for (const event of events) {
      if (event.type === "context") {
        const role = event.role === "user" ? "user" : "system";
        this.#blockItems.set(event.seq, session.addItem({ role, text: event.content }));
      } else if (event.type === "context-removed") {
        for (const seq of event.seqs) {
          const item = this.#blockItems.get(seq);
          this.#blockItems.delete(seq);
          void item?.then((id) => session.deleteItem(id));
        }
      }
    }
  }

  #input(input: RealtimeInput): void {
    switch (input.kind) {
      case "server":
        this.#server(input.event);
        return;
      case "prepared":
        this.#prepared(input);
        return;
      case "tool":
        this.#toolSettled(input.callId, input.result);
        return;
      case "async-result":
        this.#asyncResult(input.callId, input.result);
        return;
      case "server-message":
        if (this.#call !== "ended") this.#o.emitter.serverMessage(input.data);
        return;
      case "hold":
        if (this.#awaiting?.token === input.token) this.#release();
        return;
    }
  }

  #server(event: RealtimeEvent): void {
    if (this.#call === "ended") return;
    const { emitter, kit } = this.#o;
    switch (event.type) {
      case "speech-started":
        this.#speechStarted();
        return;
      case "speech-stopped":
        kit.active();
        this.#userSpeaking = false;
        emitter.userStoppedSpeaking();
        // The server answers the turn itself, and that response reads what was owed one.
        this.#hold();
        return;
      case "user-transcript":
        kit.active();
        emitter.userTranscription(event.text, event.final);
        if (event.final) this.#heardCaller(event.text);
        return;
      case "response-started":
        this.#responseStarted(event.responseId);
        return;
      case "audio":
        this.#audio(event);
        return;
      case "transcript-delta":
        this.#transcript(event);
        return;
      case "tool-call":
        this.#toolCall(event);
        return;
      case "response-done":
        this.#responseDone(event.responseId, event.error ?? null);
        return;
      case "error":
        // The session reads no more: the call can't go on (E8).
        emitter.error(event.message);
        this.#end("error");
        return;
    }
  }

  /** The server heard the caller start: a barge-in, then her turn opens. */
  #speechStarted(): void {
    const { emitter, kit } = this.#o;
    kit.active();
    this.#prepAbort?.abort("interrupted");
    this.#prepAbort = null;
    this.#release();
    // A response the floor owed is the caller's turn's now.
    this.#followUpOwed = false;
    // The server truncates before xAI's client cancels.
    const closes = this.#bargeIn({
      emit: false,
      cancel: this.#o.dialect === "xai" ? "after" : "no",
    });
    this.#userSpeaking = true;
    emitter.userStartedSpeaking();
    emitter.botInterrupted();
    if (closes.llm) emitter.botLlmStopped();
    if (closes.tts) emitter.botTtsStopped();
    if (closes.speaking) emitter.botStoppedSpeaking();
    this.#flushLines();
  }

  /** The caller's final transcript: her line, then her recall for the turn after. */
  #heardCaller(text: string): void {
    this.#release();
    if (text.trim() === "") return;
    this.#linesOwed.push(text);
    if (this.#active === null && !this.#speaking) this.#flushLines();
    this.#o.plan.log.append([this.#userLine(text, "call")]);
    this.#recall(false);
  }

  /**
   * The caller's lines as her context takes them: pipedog writes a realtime turn's line once the
   * reply to it has played out or been cut (its realtime handoff flush), and user-llm-text says so.
   */
  #flushLines(): void {
    for (const text of this.#linesOwed.splice(0)) this.#o.emitter.userLlmText(text);
  }

  /** E4: her bot-output and stored line wait for the caller's transcript, 1 s at most. */
  #hold(): void {
    this.#awaiting?.cancel();
    const token = ++this.#holdToken;
    const cancel = this.#o.kit.clock.setTimer(TRANSCRIPT_HOLD_MS, () =>
      this.#o.kit.post({ source: "realtime", input: { kind: "hold", token } }),
    );
    this.#awaiting = { token, cancel };
  }

  #release(): void {
    const awaiting = this.#awaiting;
    if (awaiting === null) return;
    awaiting.cancel();
    this.#awaiting = null;
    for (const drafts of this.#deferred.splice(0)) this.#o.plan.log.append(drafts);
    for (const tag of this.#held.splice(0)) this.#output(tag);
  }

  #append(...drafts: ChatEventDraft[]): void {
    if (drafts.length === 0) return;
    if (this.#awaiting !== null) this.#deferred.push(drafts);
    else this.#o.plan.log.append(drafts);
  }

  #responseStarted(id: string): void {
    const reply: Reply = {
      turn: this.#o.newId(),
      llmOpen: true,
      ttsOpen: false,
      cut: false,
      done: false,
      stored: false,
      deltas: [],
      segmenter: new Segmenter(),
      pending: [],
      last: null,
      queued: new Map(),
      calls: new Map(),
    };
    this.#replies.set(id, reply);
    this.#responded = true;
    this.#active = reply;
    // Any response takes in what was delivered before it.
    this.#followUpOwed = false;
    // One per response (E5), however many items it speaks through.
    this.#o.emitter.botLlmStarted();
  }

  #replyOf(responseId: string): Reply | null {
    return this.#replies.get(responseId) ?? this.#active;
  }

  #audio(event: Extract<RealtimeEvent, { type: "audio" }>): void {
    const reply = this.#replyOf(event.responseId);
    if (reply === null || reply.cut) return;
    const { emitter, speaker, plan } = this.#o;
    if (reply.last === null) {
      reply.ttsOpen = true;
      emitter.botTtsStarted();
    }
    const before = this.#playing;
    // Queued whole before this audio, it plays out: what came before it was heard.
    if (before !== null && before !== reply && before.done) this.#store(before, true);
    speaker.enqueue({ reply: event.itemId, persona: plan.host, seg: 0 }, event.pcm);
    // Queued, so not drained until the cursor says so.
    this.#drained = false;
    reply.queued.set(event.itemId, (reply.queued.get(event.itemId) ?? 0) + event.pcm.length);
    reply.last = { itemId: event.itemId, contentIndex: event.contentIndex };
    this.#playing = reply;
    for (const text of reply.pending.splice(0)) this.#sentence(reply, text);
  }

  #transcript(event: Extract<RealtimeEvent, { type: "transcript-delta" }>): void {
    const reply = this.#replyOf(event.responseId);
    if (reply === null || reply.cut) return;
    this.#o.emitter.botLlmText(event.text);
    const queued = reply.queued.get(event.itemId) ?? 0;
    reply.deltas.push({
      itemId: event.itemId,
      atMs: Math.floor((queued * 1000) / this.#o.speaker.rate),
      text: event.text,
    });
    for (const sentence of reply.segmenter.push(event.text)) this.#sentence(reply, sentence);
  }

  /**
   * A sentence of her transcript: its bot-transcription now, and its bot-output once the cursor
   * passes the audio queued by its last delta. Before her first audio, it waits for that.
   */
  #sentence(reply: Reply, text: string): void {
    if (reply.last === null) {
      reply.pending.push(text);
      return;
    }
    // Tagged with the item at the queue's end, so passing the mark starts no reply of its own.
    const tag: Tag = { reply: reply.last.itemId, persona: this.#o.plan.host, seg: this.#nextSeg++ };
    this.#o.emitter.segment(tag, text);
    this.#o.speaker.markSegEnd(tag);
  }

  #output(tag: Tag): void {
    const { emitter } = this.#o;
    emitter.segmentStarted(tag);
    emitter.segmentEnded(tag);
  }

  #responseDone(responseId: string, error: string | null): void {
    const reply = this.#replyOf(responseId);
    if (reply === null) return;
    reply.done = true;
    this.#replies.delete(responseId);
    if (this.#active === reply) this.#active = null;
    if (!reply.cut) {
      const { emitter } = this.#o;
      if (reply.ttsOpen) {
        reply.ttsOpen = false;
        emitter.botTtsStopped();
      }
      if (reply.llmOpen) {
        reply.llmOpen = false;
        emitter.botLlmStopped();
      }
      if (error !== null) emitter.error(error);
      // Her last sentence goes out as a cascade reply's does: once the response has ended.
      const rest = reply.segmenter.flush();
      if (rest !== null) this.#sentence(reply, rest);
      this.#maybeFinish(reply);
    }
    this.#answerTools();
    this.#maybeFollowUp();
  }

  /** A reply all of whose audio has come and played: she stops speaking, and her line is stored. */
  #maybeFinish(reply: Reply): void {
    if (!reply.done || reply.cut || reply.stored) return;
    if (reply.last !== null && (this.#playing !== reply || !this.#drained)) return;
    this.#flushLines();
    if (this.#playing === reply && this.#speaking) this.#stoppedSpeaking();
    this.#store(reply, true);
  }

  /** Her line: the transcript, or with `complete` false, the part the cursor passed. */
  #store(reply: Reply, complete: boolean): void {
    if (reply.stored) return;
    reply.stored = true;
    const { speaker, plan, newId } = this.#o;
    const heard = complete
      ? reply.deltas
      : reply.deltas.filter((delta) => {
          const played = speaker.playedMs(delta.itemId);
          return played > 0 && delta.atMs <= played;
        });
    const text = heard.map((delta) => delta.text).join("");
    if (text === "") return;
    this.#append({
      type: "message",
      id: newId(),
      speaker: { kind: "persona", id: plan.host },
      text,
      modality: "call",
      ...(complete ? {} : { interrupted: true }),
    });
  }

  #toolCall(event: Extract<RealtimeEvent, { type: "tool-call" }>): void {
    const reply = this.#active;
    const { emitter, plan, parts, session } = this.#o;
    if (reply === null || reply.cut) {
      // The response the caller cut off called it on its way out: nothing runs.
      session.sendToolOutput(event.callId, "CANCELLED");
      return;
    }
    const call = { id: event.callId, name: event.name, arguments: event.arguments };
    const tool: LlmTool | undefined = parts.tools.find((t) => t.schema.name === call.name);
    const async = tool !== undefined && isAsyncTool(tool);
    emitter.toolStarted();
    emitter.toolInProgress(call.id);
    this.#append({
      type: "tool-call",
      persona: plan.host,
      turn: reply.turn,
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
    });
    this.#toolReplies.add(reply);
    this.#callTurns.set(call.id, reply.turn);
    const effects = this.#effects();
    if (async) {
      // It runs on: the call is answered with the placeholder, and its result comes later.
      const output = startedEnvelope(call.id);
      reply.calls.set(call.id, { abort: null, output });
      this.#append({
        type: "tool-result",
        persona: plan.host,
        turn: reply.turn,
        callId: call.id,
        result: {},
        stage: "started",
      });
      this.#run(call, effects, this.#asyncTools.signal, "async-result");
      return;
    }
    const abort = new AbortController();
    reply.calls.set(call.id, { abort, output: null });
    this.#run(call, effects, AbortSignal.any([abort.signal, this.#asyncTools.signal]), "tool");
  }

  #effects(): ToolEffects {
    const { kit } = this.#o;
    return {
      switchVoice: async () => {
        throw new Error("A realtime model's voice can't change mid-call");
      },
      sendServerMessage: async (data) =>
        kit.post({ source: "realtime", input: { kind: "server-message", data } }),
    };
  }

  /** Runs her tool as her, posting its result back; an aborted one posts nothing. */
  #run(
    call: {
      readonly id: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
    effects: ToolEffects,
    signal: AbortSignal,
    kind: "tool" | "async-result",
  ): void {
    const { plan, parts, kit } = this.#o;
    const context = this.#context;
    withPersona(plan.host, () => runTool(call, parts, effects, signal, context)).then(
      (result) => kit.post({ source: "realtime", input: { kind, callId: call.id, result } }),
      (error: unknown) => {
        if (signal.aborted && kind === "tool") return;
        if (!signal.aborted)
          logger.error(`[voice] ${call.name} failed: ${errorText(error)}`, error);
        kit.post({ source: "realtime", input: { kind, callId: call.id, result: null } });
      },
    );
  }

  #callOf(callId: string): { reply: Reply; state: ToolCallState } | null {
    for (const reply of this.#toolReplies) {
      const state = reply.calls.get(callId);
      if (state !== undefined) return { reply, state };
    }
    return null;
  }

  #toolSettled(callId: string, result: ToolResult | null): void {
    if (this.#call === "ended") return;
    const found = this.#callOf(callId);
    if (found === null || found.state.output !== null) return;
    const { reply, state } = found;
    const { emitter, plan } = this.#o;
    if (result === null) {
      state.output = "CANCELLED";
      emitter.toolStopped(callId, true);
    } else {
      state.output = resultContent(result);
      this.#append({ type: "tool-result", persona: plan.host, turn: reply.turn, callId, result });
      emitter.toolStopped(callId, false);
    }
    this.#answerTools();
  }

  /**
   * Answers each reply whose calls have all settled, once it has ended and played out and no
   * response runs, then asks for the response that reads them.
   */
  #answerTools(): void {
    const { session } = this.#o;
    for (const reply of [...this.#toolReplies]) {
      const states = [...reply.calls.values()];
      if (!reply.done || states.some((state) => state.output === null)) continue;
      if (this.#active !== null || this.#userSpeaking) continue;
      if (this.#playing === reply && !this.#drained) continue;
      this.#toolReplies.delete(reply);
      for (const [callId, state] of reply.calls) session.sendToolOutput(callId, state.output ?? "");
      session.createResponse();
    }
  }

  /** A late async result: stored, and given to the model as a system item carrying it. */
  #asyncResult(callId: string, result: ToolResult | null): void {
    if (this.#call === "ended") return;
    const { emitter, plan, session } = this.#o;
    emitter.toolStopped(callId, result === null);
    this.#append({
      type: "tool-result",
      persona: plan.host,
      turn: this.#callTurns.get(callId) ?? "",
      callId,
      result: result ?? {},
      stage: result === null ? "cancelled" : "final",
    });
    const text =
      result === null ? cancelledEnvelope(callId) : finalEnvelope(callId, resultContent(result));
    void session.addItem({ role: "system", text });
    if (this.#closing) return;
    this.#followUpOwed = true;
    this.#maybeFollowUp();
  }

  /** The reply a late result is owed, once nothing else holds the floor. */
  #maybeFollowUp(): void {
    if (!this.#followUpOwed || this.#closing || this.#call !== "live") return;
    if (this.#active !== null || this.#userSpeaking || this.#toolReplies.size > 0) return;
    // Her audio queued counts, whether or not it has started playing.
    if (!this.#drained) return;
    this.#followUpOwed = false;
    this.#o.session.createResponse();
  }

  #cursor(event: CursorEvent): void {
    if (this.#call === "ended") return;
    const { kit, emitter } = this.#o;
    kit.active();
    switch (event.type) {
      case "reply-start": {
        this.#drained = false;
        kit.cancel("drain-fallback");
        const reply = this.#playing;
        if (reply === null || reply.cut || this.#speaking) return;
        this.#speaking = true;
        emitter.botStartedSpeaking();
        return;
      }
      case "seg-end":
        if (event.tag.seg === 0) return;
        if (this.#awaiting !== null) this.#held.push(event.tag);
        else this.#output(event.tag);
        return;
      case "drained": {
        this.#drained = true;
        if (!this.#speaking) return;
        if (this.#closing) {
          this.#end("bot");
          return;
        }
        const reply = this.#playing;
        if (reply?.done) this.#maybeFinish(reply);
        else kit.arm("drain-fallback", DRAIN_FALLBACK_MS);
        this.#answerTools();
        this.#maybeFollowUp();
        return;
      }
      default:
        return;
    }
  }

  #stoppedSpeaking(): void {
    this.#speaking = false;
    this.#o.kit.cancel("drain-fallback");
    this.#o.emitter.botStoppedSpeaking();
  }

  /**
   * Her audio stops at once and the item it came in is truncated where the cursor stood, the
   * reply's sync tools are cancelled, and what was heard of it is stored. `cancel` cancels the
   * response too, before or after the truncation; with `emit`, what she was doing is closed for
   * the client now, otherwise it is returned for the caller to close after its own messages.
   */
  #bargeIn(o: { readonly emit: boolean; readonly cancel: "first" | "after" | "no" }): {
    llm: boolean;
    tts: boolean;
    speaking: boolean;
  } {
    const { speaker, session, emitter, kit } = this.#o;
    const playing = this.#playing;
    const cleared = speaker.clear();
    this.#drained = true;
    if (o.cancel === "first") session.cancelResponse();
    const audible = playing !== null && !playing.cut && (this.#speaking || cleared.reply !== null);
    if (audible && playing?.last) {
      const itemId = cleared.reply ?? playing.last.itemId;
      const contentIndex = itemId === playing.last.itemId ? playing.last.contentIndex : 0;
      session.truncate(itemId, contentIndex, speaker.playedMs(itemId));
    }
    if (o.cancel === "after") session.cancelResponse();
    const closes = { llm: false, tts: false, speaking: this.#speaking };
    for (const reply of [this.#active, playing]) {
      // A reply heard to its end was stored then, and has nothing left to cut.
      if (reply === null || reply.cut || reply.stored) continue;
      closes.llm ||= reply.llmOpen;
      closes.tts ||= reply.ttsOpen;
      this.#cut(reply);
    }
    this.#speaking = false;
    kit.cancel("drain-fallback");
    if (o.emit) {
      if (closes.llm) emitter.botLlmStopped();
      if (closes.tts) emitter.botTtsStopped();
      if (closes.speaking) emitter.botStoppedSpeaking();
    }
    return closes;
  }

  #cut(reply: Reply): void {
    reply.cut = true;
    reply.llmOpen = false;
    reply.ttsOpen = false;
    reply.pending.length = 0;
    this.#store(reply, false);
    const { session, emitter } = this.#o;
    // Its calls were answered once it left the set.
    const unanswered = this.#toolReplies.delete(reply);
    for (const [callId, state] of reply.calls) {
      if (state.output === null) {
        // pipedog settles a cancelled call so the API isn't left waiting on it.
        state.abort?.abort("interrupted");
        state.output = "CANCELLED";
        emitter.toolStopped(callId, true);
      }
      if (unanswered) session.sendToolOutput(callId, state.output);
    }
  }

  #timer(event: Extract<LoopEvent, { source: "timer" }>): void {
    const { kit, speaker } = this.#o;
    if (!kit.fired(event)) return;
    switch (event.timer) {
      case "idle":
        if (this.#call === "ended") return;
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
        return;
    }
  }

  /** Her reply is cut silently and stored, her tools and recall stop, and the session closes. */
  #end(reason: CloseReason): void {
    if (this.#call === "ended") return;
    const { kit } = this.#o;
    for (const reply of [this.#active, this.#playing]) {
      if (reply !== null && !reply.cut) this.#store(reply, false);
    }
    this.#o.speaker.clear();
    this.#call = "ended";
    this.#asyncTools.abort();
    this.#prepAbort?.abort("ended");
    this.#greetAbort.abort("ended");
    this.#awaiting?.cancel();
    this.#awaiting = null;
    for (const drafts of this.#deferred.splice(0)) this.#o.plan.log.append(drafts);
    kit.cancel("idle");
    kit.cancel("disconnect");
    kit.cancel("drain-fallback");
    this.#o.onEnding(reason);
    this.#finished = reason;
  }
}

/** Sends the transport's 16 kHz frames to the session at its own rate. */
async function feedAudio(
  audio: AsyncIterable<Pcm>,
  session: RealtimeSession,
  clock: Clock,
  signal: AbortSignal,
): Promise<void> {
  const sender = sttSender(
    { inputRate: session.inputRate, send: (pcm) => session.appendAudio(pcm) },
    clock,
  );
  try {
    for await (const pcm of audio) {
      if (signal.aborted) return;
      sender.send(pcm);
    }
  } finally {
    sender.close();
  }
}

/**
 * Runs a realtime persona's call on `transport` until it ends. Rejects when it can't start: a role
 * with no key, a session that can't connect; what it opened is closed by then.
 */
export function runRealtimeCall(
  transport: CallTransport,
  plan: CallPlan,
  deps: CallDeps,
  signal: AbortSignal,
  options: { readonly newId?: () => string } = {},
): Promise<CloseReason> {
  return runCall(
    transport,
    plan,
    deps.clock,
    signal,
    async ({ kit, speaker, listening, close }) => {
      const { session, parts, dialect } = await withPersona(plan.host, async () => {
        const selection = selectRequired("realtime");
        const dialect: Dialect = selection.provider.id === "xai" ? "xai" : "openai";
        const parts = await deps.engine.parts(plan.host, plan.viewer, plan.log.snapshot(), {
          realtime: true,
        });
        const realtime: RealtimeOptions = {
          instructions: callInstruction(parts.systemInstruction, parts.tools),
          tools: parts.tools.map((tool) => tool.schema),
          voice: realtimeVoiceOf(selection) ?? "",
          transcription:
            dialect === "openai"
              ? { model: TRANSCRIPTION_MODEL, language: spokenLanguage() }
              : null,
          signal: listening,
        };
        const session = await deps.openRealtime(realtime);
        kit.own("her realtime model", session);
        return { session, parts, dialect };
      });
      const floor = new RealtimeFloor({
        plan,
        kit,
        emitter: new RtviEmitter((message) => transport.send(message), deps.about),
        speaker,
        session,
        dialect,
        parts,
        engine: deps.engine,
        newId: options.newId ?? (() => Bun.randomUUIDv7()),
        onEnding: () => void close(),
      });
      void (async () => {
        for await (const event of session.events) {
          kit.post({ source: "realtime", input: { kind: "server", event } });
        }
      })().catch((error: unknown) => {
        logger.error(`[voice] The realtime session's events failed: ${errorText(error)}`, error);
      });
      floor.start();
      const listen = (): void => {
        feedAudio(transport.audioIn, session, deps.clock, listening).catch((error: unknown) => {
          logger.error(`[voice] The caller's audio failed: ${errorText(error)}`, error);
        });
      };
      return { floor, listen };
    },
  );
}
