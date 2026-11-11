// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/openai/src/realtime/llm.ts@ce8f8bc and packages/xai/src/realtime/llm.ts@ce8f8bc
// The tolerant parse and the null-usage guard are 34d7530's, ported by hand.
//
// One realtime socket and the bookkeeping both dialects share: when the session is ready, whether
// a response is running or owed, and which function calls the model waits on.
import { AsyncQueue, errorText, isPlainObject, logger, pyJsonDumps } from "@eidolon/config";
import { Meter } from "../meter.ts";
import { priceOf } from "../pricing.ts";
import type { Selection } from "../resolve.ts";
import { PcmBytes } from "../speech/pcm.ts";
import { pcmBase64, textOf } from "../stt/stream.ts";
import { reportUsage } from "../usage.ts";
import { connectWs, type WsConnection, type WsData } from "../ws.ts";
import type { RealtimeEvent, RealtimeOptions, RealtimeSession } from "./index.ts";
import { OPENAI } from "./openai.ts";
import { type Dialect, type Json, num, obj, str, type Tokens } from "./wire.ts";
import { XAI } from "./xai.ts";

const DIALECTS: Readonly<Record<string, Dialect>> = { openai: OPENAI, xai: XAI };

/** The id pipedog gave the items it created. */
function itemId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function isRefusal(error: Json): boolean {
  return (
    error.code === "conversation_already_has_active_response" ||
    (str(error.message) ?? "").toLowerCase().includes("already has an active response")
  );
}

interface Held {
  readonly message: string;
  readonly sent?: () => void;
}

class Session implements RealtimeSession {
  readonly inputRate: number;
  readonly outputRate = 24000;
  readonly events: AsyncIterable<RealtimeEvent>;
  readonly #socket: WsConnection;
  readonly #selection: Selection;
  readonly #dialect: Dialect;
  readonly #options: RealtimeOptions;
  readonly #queue = new AsyncQueue<RealtimeEvent>();
  /** Audio seconds, for a model priced by the hour; else each response's tokens are reported. */
  readonly #meter: Meter | null;
  readonly #loop: Promise<void>;
  readonly #detach: () => void;
  #closing = false;
  #closed: Promise<void> | null = null;
  #droppedAudioLogged = false;

  #ready = false;
  #createWhenReady = false;
  /** Sent while the session isn't ready, in order, once it is. */
  #held: Held[] = [];
  #responseActive = false;
  #responseCreateOwed = false;
  /** Something was delivered that no response has taken in yet. */
  #resultsAwaitingResponse = false;
  /** Our `response.create`s the server has yet to answer with `response.created`. */
  #createsInFlight = 0;
  #currentResponse = "";
  /** Function calls by call id, with the name their item gave, until their arguments are done. */
  readonly #pendingCalls = new Map<string, string | null>();
  /** Calls the model waits on: only these can be answered with a `function_call_output`. */
  readonly #openCalls = new Set<string>();
  /** Each user item's transcript so far. */
  readonly #heard = new Map<string, string>();
  readonly #pcm = new Map<string, PcmBytes>();

  constructor(
    socket: WsConnection,
    selection: Selection,
    dialect: Dialect,
    options: RealtimeOptions,
  ) {
    this.#socket = socket;
    this.#selection = selection;
    this.#dialect = dialect;
    this.#options = options;
    this.inputRate = dialect.inputRate;
    this.events = this.#queue;
    const price = priceOf(selection.provider.id, "realtime", selection.model);
    this.#meter = price?.unit === "audio-hours" ? new Meter(selection) : null;
    const onAbort = () => void this.close();
    options.signal.addEventListener("abort", onAbort, { once: true });
    this.#detach = () => options.signal.removeEventListener("abort", onAbort);
    this.#loop = this.#read();
  }

  appendAudio(pcm: Int16Array): void {
    if (this.#closing) return;
    this.#meter?.add({ audioSeconds: pcm.length / this.inputRate });
    if (pcm.length === 0) return;
    if (!this.#ready && !this.#dialect.audioBeforeReady) {
      if (!this.#droppedAudioLogged) {
        this.#droppedAudioLogged = true;
        logger.debug(
          `${this.#dialect.label} Dropping user audio; realtime session is not ready yet ` +
            "(waiting for session.updated)",
        );
      }
      return;
    }
    this.#sendNow("input_audio_buffer.append", { audio: pcmBase64(pcm) });
  }

  addItem(item: { readonly role: "user" | "system"; readonly text: string }): Promise<string> {
    const id = itemId();
    const role = item.role === "system" ? this.#dialect.systemRole : "user";
    this.#resultsAwaitingResponse = true;
    const { promise, resolve } = Promise.withResolvers<string>();
    this.#send(
      "conversation.item.create",
      { item: { id, type: "message", role, content: [{ type: "input_text", text: item.text }] } },
      () => resolve(id),
    );
    return promise;
  }

  deleteItem(itemId: string): void {
    this.#send("conversation.item.delete", { item_id: itemId });
  }

  createResponse(): void {
    if (this.#closing) return;
    if (!this.#ready) {
      this.#createWhenReady = true;
      return;
    }
    if (this.#responseActive) {
      // The API refuses a second response while one is running.
      logger.debug("Response already active — holding the next one until it is done");
      this.#responseCreateOwed = true;
      return;
    }
    // Active from the moment the create is sent, not from response.created: a second create in
    // between would be refused. It takes in everything sent before it.
    this.#responseActive = true;
    this.#resultsAwaitingResponse = false;
    this.#createsInFlight++;
    this.#sendNow("response.create", { response: this.#dialect.response });
  }

  cancelResponse(): void {
    this.#responseCreateOwed = false;
    this.#send("response.cancel", {});
  }

  truncate(itemId: string, contentIndex: number, audioEndMs: number): void {
    this.#send("conversation.item.truncate", {
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: Math.max(0, Math.trunc(audioEndMs)),
    });
  }

  sendToolOutput(callId: string, output: string): void {
    if (!this.#openCalls.delete(callId)) {
      logger.warning(`${this.#dialect.label} is not waiting on call_id ${callId}; output dropped`);
      return;
    }
    logger.debug(`Sending tool result to ${this.#dialect.name} for tool_call_id=${callId}`);
    this.#send("conversation.item.create", {
      item: { id: itemId(), type: "function_call_output", call_id: callId, output },
    });
    this.#resultsAwaitingResponse = true;
  }

  close(): Promise<void> {
    this.#closed ??= this.#shutdown();
    return this.#closed;
  }

  async #shutdown(): Promise<void> {
    this.#closing = true;
    await this.#socket.close();
    await this.#loop;
  }

  #message(type: string, fields: Json): string {
    return pyJsonDumps({ event_id: crypto.randomUUID(), type, ...fields });
  }

  #sendNow(type: string, fields: Json): void {
    this.#socket.send(this.#message(type, fields));
  }

  /** Sent now once the session is ready, else held until it is; never once it is closing. */
  #send(type: string, fields: Json, sent?: () => void): void {
    if (this.#closing) {
      sent?.();
      return;
    }
    const message = this.#message(type, fields);
    if (!this.#ready) {
      this.#held.push({ message, sent });
      return;
    }
    this.#socket.send(message);
    sent?.();
  }

  #emit(event: RealtimeEvent): void {
    this.#queue.push(event);
  }

  async #read(): Promise<void> {
    let failed = false;
    for await (const data of this.#socket.messages) {
      const event = parse(data);
      if (event === null) continue;
      if (!this.#handle(event)) {
        failed = true;
        void this.#socket.close();
        break;
      }
    }
    if (!failed && !this.#closing) {
      const message = this.#lost();
      logger.error(message);
      this.#emit({ type: "error", message, fatal: true });
    }
    this.#finish();
  }

  #lost(): string {
    const { name } = this.#dialect;
    const code = this.#socket.closeCode;
    if (code === null || code === 1000 || code === 1001) {
      return `${name} connection closed by the server`;
    }
    const detail =
      code === 1005 || code === 1006
        ? "no close frame received or sent"
        : `${code} ${this.#socket.closeReason}`.trim();
    return `${name} connection closed, but with an error: ${detail}`;
  }

  #finish(): void {
    this.#closing = true;
    this.#detach();
    this.#meter?.flush();
    for (const held of this.#held) held.sent?.();
    this.#held = [];
    this.#queue.close();
  }

  /** False: the event was fatal, and the session reads no more. */
  #handle(event: Json): boolean {
    const dialect = this.#dialect;
    switch (event.type) {
      case dialect.configureOn:
        this.#sendNow("session.update", {
          session: dialect.session(this.#options, this.#selection),
        });
        break;
      case "session.updated":
        this.#onReady();
        break;
      case "input_audio_buffer.speech_started":
        // The user's turn makes a response of its own.
        this.#responseCreateOwed = false;
        this.#emit({ type: "speech-started" });
        break;
      case "input_audio_buffer.speech_stopped":
        this.#emit({ type: "speech-stopped" });
        break;
      case "conversation.item.input_audio_transcription.delta":
        this.#transcript(event, false, false);
        break;
      case "conversation.item.input_audio_transcription.updated":
        this.#transcript(event, true, false);
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.#transcript(event, true, true);
        break;
      case "response.created":
        this.#onResponseCreated(event);
        break;
      case "response.output_audio.delta":
        this.#onAudio(event);
        break;
      case "response.output_audio_transcript.delta": {
        const text = str(event.delta) ?? "";
        if (text === "") break;
        this.#emit({
          type: "transcript-delta",
          responseId: str(event.response_id) ?? this.#currentResponse,
          itemId: str(event.item_id) ?? "",
          text,
        });
        break;
      }
      case "conversation.item.added":
      case "response.output_item.added":
        this.#track(obj(event.item));
        break;
      case "response.function_call_arguments.done":
        this.#onArguments(event);
        break;
      case "response.done":
        this.#onResponseDone(event);
        break;
      case "error": {
        const error = obj(event.error);
        if (dialect.benign(error)) {
          // A refused create never gets its response.created.
          if (isRefusal(error)) this.#createsInFlight = Math.max(0, this.#createsInFlight - 1);
          logger.debug(`${dialect.label} ${str(error.message) ?? ""}`);
          break;
        }
        const message = dialect.fatal(event);
        logger.error(message);
        this.#emit({ type: "error", message, fatal: true });
        return false;
      }
    }
    return true;
  }

  #onReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    const held = this.#held;
    this.#held = [];
    for (const { message, sent } of held) {
      this.#socket.send(message);
      sent?.();
    }
    if (this.#createWhenReady) {
      this.#createWhenReady = false;
      this.createResponse();
    }
  }

  #transcript(event: Json, whole: boolean, final: boolean): void {
    const itemId = str(event.item_id);
    if (itemId === null) return;
    const raw = str(whole ? event.transcript : event.delta) ?? "";
    const text = this.#dialect.trimTranscripts ? raw.trim() : raw;
    if (final) {
      this.#heard.delete(itemId);
      if (text === "" && this.#dialect.trimTranscripts) return;
      this.#emit({ type: "user-transcript", itemId, text, final: true });
      return;
    }
    if (text === "") return;
    const heard = whole ? text : (this.#heard.get(itemId) ?? "") + text;
    this.#heard.set(itemId, heard);
    this.#emit({ type: "user-transcript", itemId, text: heard, final: false });
  }

  #onResponseCreated(event: Json): void {
    this.#currentResponse = str(obj(event.response).id) ?? "";
    this.#responseActive = true;
    // A response the server started on its own takes in everything delivered before it; one we
    // asked for took in what was sent before the create, which cleared the flag then.
    if (this.#createsInFlight > 0) this.#createsInFlight--;
    else this.#resultsAwaitingResponse = false;
    this.#emit({ type: "response-started", responseId: this.#currentResponse });
  }

  #onAudio(event: Json): void {
    const itemId = str(event.item_id);
    const delta = str(event.delta);
    if (itemId === null || delta === null || delta === "") return;
    let bytes = this.#pcm.get(itemId);
    if (bytes === undefined) {
      bytes = new PcmBytes();
      this.#pcm.set(itemId, bytes);
    }
    const pcm = bytes.push(Buffer.from(delta, "base64"));
    if (pcm.length === 0) return;
    this.#emit({
      type: "audio",
      responseId: str(event.response_id) ?? this.#currentResponse,
      itemId,
      contentIndex: num(event.content_index) ?? 0,
      pcm,
    });
  }

  #track(item: Json): void {
    if (item.type !== "function_call") return;
    const callId = str(item.call_id);
    if (callId === null) return;
    if (this.#pendingCalls.has(callId) || this.#openCalls.has(callId)) {
      // Announced again: as a response output item and as a conversation item.
      logger.debug(`Function call ${callId} already tracked, skipping`);
      return;
    }
    this.#pendingCalls.set(callId, str(item.name));
  }

  #onArguments(event: Json): void {
    const callId = str(event.call_id);
    if (callId === null) return;
    let args: unknown;
    try {
      args = JSON.parse(str(event.arguments) ?? "");
    } catch (error) {
      logger.error(`Failed to process function call arguments: ${errorText(error)}`);
      return;
    }
    if (!this.#pendingCalls.has(callId)) {
      logger.warning(`No tracked function call found for call_id: ${callId}`);
      return;
    }
    const name = this.#pendingCalls.get(callId) ?? str(event.name);
    this.#pendingCalls.delete(callId);
    if (name === null) {
      logger.warning(`Function call ${callId} has no name`);
      return;
    }
    this.#openCalls.add(callId);
    this.#emit({
      type: "tool-call",
      callId,
      name,
      arguments: isPlainObject(args) ? args : {},
    });
  }

  #onResponseDone(event: Json): void {
    const response = obj(event.response);
    if (this.#meter === null) {
      const tokens = this.#dialect.tokens(event);
      if (tokens !== null) this.#report(tokens);
    }
    const responseId = str(response.id) ?? this.#currentResponse;
    const failed = response.status === "failed";
    this.#emit(
      failed
        ? { type: "response-done", responseId, error: this.#dialect.failure(response) }
        : { type: "response-done", responseId },
    );
    this.#pcm.clear();
    this.#responseActive = false;
    // A response asked for while this one ran is owed now, unless this one took in what it was for.
    if (this.#responseCreateOwed) {
      this.#responseCreateOwed = false;
      if (this.#resultsAwaitingResponse) this.createResponse();
    }
  }

  #report(tokens: Tokens): void {
    const { provider, model } = this.#selection;
    reportUsage({
      role: "realtime",
      provider: provider.id,
      model,
      units: {
        inputTokens: Math.max(0, tokens.input - tokens.cached),
        cachedTokens: tokens.cached,
        outputTokens: tokens.output,
      },
    });
  }
}

function parse(data: WsData): Json | null {
  try {
    const event: unknown = JSON.parse(textOf(data));
    if (isPlainObject(event) && typeof event.type === "string") return event;
    logger.warning("Failed to parse server event: no event type");
  } catch (error) {
    logger.warning(`Failed to parse server event: ${errorText(error)}`);
  }
  return null;
}

/** A session with the realtime model `selection` names, which must have its key. */
export async function openRealtimeSession(
  selection: Selection,
  options: RealtimeOptions,
): Promise<RealtimeSession> {
  const dialect = DIALECTS[selection.provider.id];
  if (dialect === undefined) {
    throw new Error(`${selection.provider.name} has no realtime voice model in Eidolon yet`);
  }
  options.signal.throwIfAborted();
  let socket: WsConnection;
  try {
    socket = await connectWs(
      dialect.url(selection),
      { Authorization: `Bearer ${selection.apiKey}` },
      options.signal,
    );
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new Error(dialect.connectFailed(errorText(error)));
  }
  return new Session(socket, selection, dialect, options);
}
