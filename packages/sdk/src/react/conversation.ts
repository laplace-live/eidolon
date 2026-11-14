import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BotOutputData,
  EidolonServerMessage,
  LLMFunctionCallInProgressData,
  LLMFunctionCallStartedData,
  LLMFunctionCallStoppedData,
  SendTextOptions,
  TranscriptData,
  UserInputData,
} from "../call/types.ts";
import { isJsonObject, separator } from "../chat/parse.ts";
import { snapPastMarkupSpan } from "../markup.ts";
import { useEidolonClient } from "./provider.tsx";

export interface BotOutputText {
  readonly spoken: string;
  readonly unspoken: string;
}

export function isBotOutputText(value: unknown): value is BotOutputText {
  return (
    isJsonObject(value) && typeof value.spoken === "string" && typeof value.unspoken === "string"
  );
}

export interface FunctionCallData {
  readonly function_name?: string;
  readonly tool_call_id?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  readonly cancelled?: boolean;
  readonly status: "started" | "in_progress" | "completed";
}

export type SentTextStatus = "sent" | "received" | "failed";

export interface ConversationMessagePart {
  readonly text: ReactNode | BotOutputText;
  readonly final: boolean;
  readonly createdAt: string;
  readonly segmentId?: number;
}

export interface ConversationMessage {
  readonly role: "user" | "assistant" | "system" | "function_call";
  readonly parts: readonly ConversationMessagePart[];
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly final?: boolean;
  readonly functionCall?: FunctionCallData;
  readonly msgId?: string;
  readonly status?: SentTextStatus;
}

export interface InjectConversationMessageInput {
  readonly role: "user" | "assistant" | "system";
  readonly parts: readonly ConversationMessagePart[];
}

export interface UseEidolonConversationOptions {
  readonly onMessageCreated?: (message: ConversationMessage) => void;
  readonly onMessageUpdated?: (message: ConversationMessage) => void;
}

export interface EidolonConversationControls {
  readonly messages: readonly ConversationMessage[];
  readonly injectMessage: (message: InjectConversationMessageInput) => void;
  readonly sendText: (content: string, options?: SendTextOptions) => Promise<string>;
  readonly clearMessages: () => void;
}

interface SegmentMeta {
  readonly prefix: "" | " ";
  readonly rawText: string;
}

export interface ConversationState {
  readonly messages: readonly ConversationMessage[];
  readonly userInputSeen: boolean;
  readonly segments: ReadonlyMap<string, SegmentMeta>;
  readonly receivedChatIds: ReadonlySet<string>;
}

export const EMPTY_CONVERSATION_STATE: ConversationState = {
  messages: [],
  userInputSeen: false,
  segments: new Map(),
  receivedChatIds: new Set(),
};

export type ConversationEffect =
  | { readonly kind: "created"; readonly message: ConversationMessage }
  | { readonly kind: "updated"; readonly message: ConversationMessage };

export interface ConversationStep {
  readonly state: ConversationState;
  readonly effects: readonly ConversationEffect[];
}

export type ConversationAction =
  | { readonly type: "reset" }
  | { readonly type: "disconnected"; readonly now: string }
  | { readonly type: "user-started-speaking"; readonly now: string }
  | { readonly type: "user-stopped-timeout"; readonly now: string }
  | {
      readonly type: "user-transcription";
      readonly text: string;
      readonly final: boolean;
      readonly fromUserInput: boolean;
      readonly now: string;
    }
  | {
      readonly type: "user-chat-echo";
      readonly text: string;
      readonly msgId?: string;
      readonly runImmediately?: boolean;
      readonly now: string;
    }
  | {
      readonly type: "send-text-resolved";
      readonly text: string;
      readonly msgId: string;
      readonly runImmediately?: boolean;
      readonly now: string;
    }
  | {
      readonly type: "send-text-rejected";
      readonly text: string;
      readonly now: string;
    }
  | { readonly type: "bot-output"; readonly data: BotOutputData; readonly now: string }
  | { readonly type: "bot-interrupted"; readonly now: string }
  | { readonly type: "bot-stopped-timeout"; readonly now: string }
  | {
      readonly type: "function-call-started";
      readonly data: LLMFunctionCallStartedData;
      readonly now: string;
    }
  | {
      readonly type: "function-call-in-progress";
      readonly data: LLMFunctionCallInProgressData;
      readonly now: string;
    }
  | {
      readonly type: "function-call-stopped";
      readonly data: LLMFunctionCallStoppedData;
      readonly now: string;
    }
  | {
      readonly type: "inject";
      readonly message: InjectConversationMessageInput;
      readonly now: string;
    };

const BOT_STOPPED_FINALIZE_DELAY_MS = 2500;
const USER_STOPPED_FINALIZE_DELAY_MS = 3000;

const IGNORED_BOT_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "word",
  "token",
  "backchannel",
  "expression_sound",
  "expression_pause",
]);

// Pipecat's turn-completion processors prefix bot-output text with ✓ / ○ / ◐ markers.
const TURN_MARKERS: ReadonlySet<string> = new Set(["\u2713", "\u25CB", "\u25D0"]);

function isIgnoredBotOutput(data: BotOutputData): boolean {
  const outputType = data.output_type ?? data.text_type ?? data.aggregated_by;
  return outputType !== undefined && IGNORED_BOT_OUTPUT_TYPES.has(outputType);
}

function stripTurnMarker(text: string): string {
  const first = text[0];
  if (first === undefined || !TURN_MARKERS.has(first)) return text;
  return text[1] === " " ? text.slice(2) : text.slice(1);
}

function isMessageEmpty(message: ConversationMessage): boolean {
  if (message.role === "function_call") return false;
  if (message.parts.length === 0) return true;
  return message.parts.every((part) => {
    if (typeof part.text === "string") return part.text.trim().length === 0;
    if (isBotOutputText(part.text)) {
      return part.text.spoken.trim().length === 0 && part.text.unspoken.trim().length === 0;
    }
    return false;
  });
}

function plainTextOfPart(part: ConversationMessagePart | undefined): string {
  if (!part) return "";
  if (typeof part.text === "string") return part.text;
  if (isBotOutputText(part.text)) return part.text.spoken + part.text.unspoken;
  return "";
}

/**
 * How a closed turn's parts end: all final, her unspoken words snapped to spoken, or as they are.
 * A caller's turn closed while its transcript is still interim keeps that part interim, so the
 * final transcript that comes after her reply starts can still replace it.
 */
type PartsOnClose = "final" | "snap" | "keep";

function finalizeRole(
  messages: readonly ConversationMessage[],
  role: "user" | "assistant",
  now: string,
  partsOnClose: PartsOnClose,
): { messages: readonly ConversationMessage[]; updated?: ConversationMessage } {
  const idx = messages.findLastIndex(
    (msg) => msg.role === role && msg.status === undefined && msg.final !== true,
  );
  if (idx === -1) return { messages };
  const target = messages[idx];
  if (!target) return { messages };
  const next = [...messages];
  if (isMessageEmpty(target)) {
    next.splice(idx, 1);
    return { messages: next };
  }
  const parts =
    partsOnClose === "keep"
      ? target.parts
      : target.parts.map((part) => {
          if (partsOnClose === "snap" && isBotOutputText(part.text)) {
            return {
              ...part,
              text: { spoken: part.text.spoken + part.text.unspoken, unspoken: "" },
              final: true,
            };
          }
          return part.final ? part : { ...part, final: true };
        });
  const updated: ConversationMessage = { ...target, parts, final: true, updatedAt: now };
  next[idx] = updated;
  return { messages: next, updated };
}

interface Turns {
  readonly messages: readonly ConversationMessage[];
  readonly segments: ReadonlyMap<string, SegmentMeta>;
}

function closeTurn(
  turns: Turns,
  role: "user" | "assistant",
  now: string,
  effects: ConversationEffect[],
  partsOnClose: PartsOnClose = "final",
): Turns {
  const closed = finalizeRole(turns.messages, role, now, partsOnClose);
  if (closed.messages === turns.messages) return turns;
  if (closed.updated) effects.push({ kind: "updated", message: closed.updated });
  return {
    messages: closed.messages,
    segments: role === "assistant" ? EMPTY_CONVERSATION_STATE.segments : turns.segments,
  };
}

function finalizeStep(
  state: ConversationState,
  role: "user" | "assistant",
  now: string,
  partsOnClose: PartsOnClose,
): ConversationStep {
  const effects: ConversationEffect[] = [];
  const closed = closeTurn(state, role, now, effects, partsOnClose);
  return closed === state ? { state, effects } : { state: { ...state, ...closed }, effects };
}

function closeOpenTurns(
  state: ConversationState,
  now: string,
  userParts: PartsOnClose,
): Turns & { effects: ConversationEffect[] } {
  const effects: ConversationEffect[] = [];
  const userClosed = closeTurn(state, "user", now, effects, userParts);
  const closed = closeTurn(userClosed, "assistant", now, effects);
  return { messages: closed.messages, segments: closed.segments, effects };
}

/** Finalizes the interim parts closed caller turns still hold, once no late transcript can land. */
function settleInterims(
  messages: readonly ConversationMessage[],
  now: string,
  effects: ConversationEffect[],
): readonly ConversationMessage[] {
  let next = messages;
  messages.forEach((msg, i) => {
    if (msg.role !== "user" || msg.final !== true || msg.parts.every((part) => part.final)) return;
    const parts = msg.parts.map((part) => (part.final ? part : { ...part, final: true }));
    const updated: ConversationMessage = { ...msg, parts, updatedAt: now };
    if (next === messages) next = [...messages];
    (next as ConversationMessage[])[i] = updated;
    effects.push({ kind: "updated", message: updated });
  });
  return next;
}

/** Adds a transcript to a caller's message: an interim or final replaces its trailing interim. */
function withTranscript(
  message: ConversationMessage,
  text: string,
  final: boolean,
  now: string,
): ConversationMessage {
  const parts = [...message.parts];
  const lastPart = parts[parts.length - 1];
  const appending = !lastPart || lastPart.final;
  const prevText = plainTextOfPart(appending ? lastPart : parts[parts.length - 2]);
  const joined = separator(prevText, text) + text;
  if (appending) parts.push({ text: joined, final, createdAt: now });
  else parts[parts.length - 1] = { ...lastPart, text: joined, final };
  return { ...message, parts, updatedAt: now };
}

/**
 * Where a transcript that lands while her reply is open goes: the caller's message of the turn
 * she's answering, or `-1` with the index a new one is inserted at, the start of that turn.
 */
function lateTranscriptTarget(
  messages: readonly ConversationMessage[],
  openAssistantIdx: number,
): { readonly index: number; readonly insertAt: number } {
  for (let i = openAssistantIdx - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") return { index: -1, insertAt: i + 1 };
    if (msg?.role === "user" && msg.status === undefined) return { index: i, insertAt: i };
  }
  return { index: -1, insertAt: 0 };
}

function insertBeforeOpenAssistant(
  messages: readonly ConversationMessage[],
  created: ConversationMessage,
): ConversationMessage[] {
  const next = [...messages];
  const openAssistantIdx = next.findLastIndex(
    (msg) => msg.role === "assistant" && msg.final !== true,
  );
  if (openAssistantIdx !== -1) next.splice(openAssistantIdx, 0, created);
  else next.push(created);
  return next;
}

/**
 * A typed line that interrupts her goes last, but her reply stays open: what the server sent
 * before it read the line is still arriving, and its bot-interrupted, always ahead of the echo,
 * closes her reply.
 */
function placeTypedUserTurn(
  state: ConversationState,
  created: ConversationMessage,
  now: string,
  runImmediately: boolean,
): Turns & { effects: ConversationEffect[] } {
  const effects: ConversationEffect[] = [];
  const userClosed = closeTurn(state, "user", now, effects, "keep");
  effects.push({ kind: "created", message: created });
  return {
    messages: runImmediately
      ? [...userClosed.messages, created]
      : insertBeforeOpenAssistant(userClosed.messages, created),
    segments: state.segments,
    effects,
  };
}

// RTVI's llm-function-call-started omits tool_call_id; pair anonymous starts FIFO with in-progress.
function findStartedFunctionCallIndex(messages: readonly ConversationMessage[]): number {
  return messages.findIndex(
    (msg) =>
      msg.role === "function_call" &&
      msg.functionCall?.status === "started" &&
      msg.functionCall.tool_call_id === undefined,
  );
}

function findFunctionCallByIdIndex(
  messages: readonly ConversationMessage[],
  toolCallId: string,
): number {
  return messages.findLastIndex(
    (msg) => msg.role === "function_call" && msg.functionCall?.tool_call_id === toolCallId,
  );
}

function segmentKey(messageCreatedAt: string, partIndex: number): string {
  return `${messageCreatedAt}#${partIndex}`;
}

function spokenLengthOf(rawText: string, accumulated: string): number {
  const stripped = stripTurnMarker(accumulated);
  if (rawText.startsWith(stripped)) return stripped.length;
  const said = stripped.trim();
  const at = said === "" ? -1 : rawText.indexOf(said);
  return at === -1 ? 0 : at + said.length;
}

function safeSplitIndex(text: string, index: number): number {
  let clamped = Math.max(0, Math.min(index, text.length));
  if (clamped === 0 || clamped === text.length) return clamped;
  const prev = text.charCodeAt(clamped - 1);
  const next = text.charCodeAt(clamped);
  if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    clamped++;
  }
  if (clamped >= text.length) return text.length;
  return snapPastMarkupSpan(text, clamped);
}

function splitSpokenText(meta: SegmentMeta, spokenLength: number): BotOutputText {
  const clamped = safeSplitIndex(meta.rawText, spokenLength);
  if (clamped === 0) {
    return { spoken: "", unspoken: meta.prefix + meta.rawText };
  }
  return {
    spoken: meta.prefix + meta.rawText.slice(0, clamped),
    unspoken: meta.rawText.slice(clamped),
  };
}

/** Pure state transition for RTVI call transcripts, spoken/unspoken segments, and tool notices. */
export function stepConversation(
  state: ConversationState,
  action: ConversationAction,
): ConversationStep {
  switch (action.type) {
    case "reset":
      return { state: EMPTY_CONVERSATION_STATE, effects: [] };

    case "disconnected": {
      const closed = closeOpenTurns(state, action.now, "final");
      const settled = settleInterims(closed.messages, action.now, closed.effects);
      let messages = settled;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg?.role === "function_call" && msg.final !== true && msg.functionCall) {
          const updated: ConversationMessage = {
            ...msg,
            final: true,
            updatedAt: action.now,
            functionCall: {
              ...msg.functionCall,
              cancelled: msg.functionCall.cancelled ?? true,
              status: "completed",
            },
          };
          if (messages === settled) messages = [...settled];
          (messages as ConversationMessage[])[i] = updated;
          closed.effects.push({ kind: "updated", message: updated });
        }
      }
      if (messages === state.messages && closed.effects.length === 0) {
        return { state, effects: [] };
      }
      return { state: { ...state, messages, segments: closed.segments }, effects: closed.effects };
    }

    case "user-started-speaking": {
      // New speech: a closed turn's late transcript can no longer be told apart from this one's.
      const effects: ConversationEffect[] = [];
      let turns = closeTurn(state, "assistant", action.now, effects);
      const lastUserIdx = turns.messages.findLastIndex(
        (msg) => msg.role === "user" && msg.status === undefined,
      );
      const lastUser = lastUserIdx === -1 ? undefined : turns.messages[lastUserIdx];
      if (
        lastUser &&
        lastUser.final !== true &&
        turns.messages.slice(lastUserIdx + 1).some((msg) => msg.role === "assistant")
      ) {
        turns = closeTurn(turns, "user", action.now, effects);
      }
      const settled = settleInterims(turns.messages, action.now, effects);
      if (settled !== turns.messages) turns = { messages: settled, segments: turns.segments };
      return turns === state ? { state, effects } : { state: { ...state, ...turns }, effects };
    }

    case "user-stopped-timeout":
      return finalizeStep(state, "user", action.now, "keep");

    case "user-transcription": {
      // RTVI 1.2+ emits both user-input and legacy user-transcription for speech; drop legacy copies once user-input arrives.
      if (!action.fromUserInput && state.userInputSeen) return { state, effects: [] };
      const userInputSeen = state.userInputSeen || action.fromUserInput;
      if (action.text === "" && !action.final) {
        return {
          state: userInputSeen === state.userInputSeen ? state : { ...state, userInputSeen },
          effects: [],
        };
      }
      const { messages } = state;
      // While her reply is open the transcript is a late one for the turn she's answering:
      // user-started-speaking closes her reply before any new speech.
      const openIdx = messages.findLastIndex(
        (msg) => msg.role === "assistant" && msg.final !== true,
      );
      let target: { readonly index: number; readonly insertAt: number };
      if (openIdx !== -1) {
        target = lateTranscriptTarget(messages, openIdx);
      } else {
        const lastUserIdx = messages.findLastIndex(
          (msg) => msg.role === "user" && msg.status === undefined,
        );
        const lastUser = messages[lastUserIdx];
        const takesIt =
          lastUser !== undefined &&
          (lastUser.final !== true || lastUser.parts.at(-1)?.final === false);
        target = { index: takesIt ? lastUserIdx : -1, insertAt: messages.length };
      }

      const existing = messages[target.index];
      if (existing) {
        const updated = withTranscript(existing, action.text, action.final, action.now);
        const next = [...messages];
        next[target.index] = updated;
        return {
          state: { ...state, messages: next, userInputSeen },
          effects: [{ kind: "updated", message: updated }],
        };
      }
      if (action.text.trim() === "") {
        return {
          state: userInputSeen === state.userInputSeen ? state : { ...state, userInputSeen },
          effects: [],
        };
      }
      const created: ConversationMessage = {
        role: "user",
        final: openIdx !== -1,
        parts: [{ text: action.text, final: action.final, createdAt: action.now }],
        createdAt: action.now,
        updatedAt: action.now,
      };
      const next = [...messages];
      next.splice(target.insertAt, 0, created);
      return {
        state: { ...state, messages: next, userInputSeen },
        effects: [{ kind: "created", message: created }],
      };
    }

    case "user-chat-echo": {
      if (action.msgId !== undefined) {
        const idx = state.messages.findLastIndex(
          (msg) => msg.role === "user" && msg.msgId === action.msgId,
        );
        if (idx !== -1) {
          const existing = state.messages[idx];
          if (!existing || existing.status === "received") return { state, effects: [] };
          const updated: ConversationMessage = {
            ...existing,
            status: "received",
            updatedAt: action.now,
          };
          const messages = [...state.messages];
          messages[idx] = updated;
          return {
            state: { ...state, messages },
            effects: [{ kind: "updated", message: updated }],
          };
        }
      }
      if (action.text.trim() === "") {
        if (action.msgId === undefined) return { state, effects: [] };
        const receivedChatIds = new Set(state.receivedChatIds);
        receivedChatIds.add(action.msgId);
        return { state: { ...state, receivedChatIds }, effects: [] };
      }
      const created: ConversationMessage = {
        role: "user",
        final: true,
        ...(action.msgId === undefined ? {} : { msgId: action.msgId, status: "received" }),
        parts: [{ text: action.text, final: true, createdAt: action.now }],
        createdAt: action.now,
        updatedAt: action.now,
      };
      const placed = placeTypedUserTurn(
        state,
        created,
        action.now,
        action.runImmediately !== false,
      );
      return {
        state: { ...state, messages: placed.messages, segments: placed.segments },
        effects: placed.effects,
      };
    }

    case "send-text-resolved": {
      const existingIdx = state.messages.findLastIndex(
        (msg) => msg.role === "user" && msg.msgId === action.msgId,
      );
      if (existingIdx !== -1) {
        if (!state.receivedChatIds.has(action.msgId)) return { state, effects: [] };
        const receivedChatIds = new Set(state.receivedChatIds);
        receivedChatIds.delete(action.msgId);
        return { state: { ...state, receivedChatIds }, effects: [] };
      }
      const alreadyAcked = state.receivedChatIds.has(action.msgId);
      const receivedChatIds = new Set(state.receivedChatIds);
      receivedChatIds.delete(action.msgId);
      const created: ConversationMessage = {
        role: "user",
        final: true,
        msgId: action.msgId,
        status: alreadyAcked ? "received" : "sent",
        parts: [{ text: action.text, final: true, createdAt: action.now }],
        createdAt: action.now,
        updatedAt: action.now,
      };
      const placed = placeTypedUserTurn(
        state,
        created,
        action.now,
        action.runImmediately !== false,
      );
      return {
        state: {
          ...state,
          messages: placed.messages,
          segments: placed.segments,
          receivedChatIds,
        },
        effects: placed.effects,
      };
    }

    case "send-text-rejected": {
      const created: ConversationMessage = {
        role: "user",
        final: true,
        status: "failed",
        parts: [{ text: action.text, final: true, createdAt: action.now }],
        createdAt: action.now,
        updatedAt: action.now,
      };
      return {
        state: { ...state, messages: [...state.messages, created] },
        effects: [{ kind: "created", message: created }],
      };
    }

    case "bot-output": {
      if (isIgnoredBotOutput(action.data)) {
        return { state, effects: [] };
      }
      const rawText = stripTurnMarker(action.data.text);
      const status = action.data.spoken_status;
      const isProgress = status === "in-progress" || status === "completed";
      if (!isProgress && rawText.length === 0) return { state, effects: [] };

      const effects: ConversationEffect[] = [];
      const userClosed = closeTurn(state, "user", action.now, effects, "keep");
      const unchangedOrUserClosed = (): ConversationStep =>
        userClosed === state ? { state, effects } : { state: { ...state, ...userClosed }, effects };

      const assistantIdx = userClosed.messages.findLastIndex(
        (msg) => msg.role === "assistant" && msg.final !== true,
      );
      if (isProgress && assistantIdx === -1) return unchangedOrUserClosed();

      if (assistantIdx === -1) {
        const meta: SegmentMeta = { prefix: "", rawText };
        const willBeSpoken = action.data.will_be_spoken !== false;
        const textValue = willBeSpoken
          ? splitSpokenText(meta, 0)
          : { spoken: rawText, unspoken: "" };
        const created: ConversationMessage = {
          role: "assistant",
          final: false,
          parts: [
            {
              text: textValue,
              final: !willBeSpoken,
              createdAt: action.now,
              ...(action.data.segment_id === undefined
                ? {}
                : { segmentId: action.data.segment_id }),
            },
          ],
          createdAt: action.now,
          updatedAt: action.now,
        };
        const segments = new Map<string, SegmentMeta>([[segmentKey(action.now, 0), meta]]);
        effects.push({ kind: "created", message: created });
        return {
          state: { ...state, messages: [...userClosed.messages, created], segments },
          effects,
        };
      }

      const current = userClosed.messages[assistantIdx];
      if (!current) return unchangedOrUserClosed();
      let segments = state.segments;
      let parts: ConversationMessagePart[];

      if (!isProgress) {
        const prevPartIndex = current.parts.length - 1;
        const prevMeta =
          prevPartIndex >= 0
            ? segments.get(segmentKey(current.createdAt, prevPartIndex))
            : undefined;
        const prevRaw = prevMeta?.rawText ?? plainTextOfPart(current.parts[prevPartIndex]);
        const prefix = separator(prevRaw, rawText);
        const meta: SegmentMeta = { prefix, rawText };
        const willBeSpoken = action.data.will_be_spoken !== false;
        const textValue = willBeSpoken
          ? splitSpokenText(meta, 0)
          : { spoken: prefix + rawText, unspoken: "" };
        const partIndex = current.parts.length;
        parts = [
          ...current.parts,
          {
            text: textValue,
            final: !willBeSpoken,
            createdAt: action.now,
            ...(action.data.segment_id === undefined ? {} : { segmentId: action.data.segment_id }),
          },
        ];
        const nextSegments = new Map(segments);
        nextSegments.set(segmentKey(current.createdAt, partIndex), meta);
        segments = nextSegments;
      } else {
        const segmentId = action.data.segment_id;
        const targetIndex =
          segmentId !== undefined
            ? current.parts.findIndex((part) => part.segmentId === segmentId)
            : current.parts.findIndex((part) => !part.final && isBotOutputText(part.text));
        if (targetIndex === -1) return unchangedOrUserClosed();
        const targetPart = current.parts[targetIndex];
        if (!targetPart) return unchangedOrUserClosed();
        const meta = segments.get(segmentKey(current.createdAt, targetIndex)) ?? {
          prefix: "",
          rawText: plainTextOfPart(targetPart),
        };
        const prevSpoken = isBotOutputText(targetPart.text)
          ? Math.max(0, targetPart.text.spoken.length - meta.prefix.length)
          : 0;
        const accumulated = action.data.spoken_progress?.accumulated_text ?? "";
        const rawSpoken =
          status === "completed" ? meta.rawText.length : spokenLengthOf(meta.rawText, accumulated);
        const spokenLen = Math.max(prevSpoken, rawSpoken);
        const nextText = splitSpokenText(meta, spokenLen);
        const completed = status === "completed" || nextText.unspoken.length === 0;
        if (
          targetPart.final === completed &&
          isBotOutputText(targetPart.text) &&
          targetPart.text.spoken === nextText.spoken &&
          targetPart.text.unspoken === nextText.unspoken
        ) {
          return unchangedOrUserClosed();
        }
        parts = [...current.parts];
        parts[targetIndex] = {
          ...targetPart,
          text: nextText,
          final: completed,
        };
      }

      const updated: ConversationMessage = { ...current, parts, updatedAt: action.now };
      const messages = [...userClosed.messages];
      messages[assistantIdx] = updated;
      effects.push({ kind: "updated", message: updated });
      return { state: { ...state, messages, segments }, effects };
    }

    case "bot-interrupted":
      return finalizeStep(state, "assistant", action.now, "final");

    case "bot-stopped-timeout":
      return finalizeStep(state, "assistant", action.now, "snap");

    case "function-call-started": {
      const created: ConversationMessage = {
        role: "function_call",
        final: false,
        parts: [],
        createdAt: action.now,
        updatedAt: action.now,
        functionCall: {
          ...(action.data.function_name === undefined
            ? {}
            : { function_name: action.data.function_name }),
          status: "started",
        },
      };
      return {
        state: { ...state, messages: insertBeforeOpenAssistant(state.messages, created) },
        effects: [{ kind: "created", message: created }],
      };
    }

    case "function-call-in-progress": {
      const byStarted = findStartedFunctionCallIndex(state.messages);
      const byId =
        byStarted !== -1
          ? byStarted
          : findFunctionCallByIdIndex(state.messages, action.data.tool_call_id);
      const patch: FunctionCallData = {
        tool_call_id: action.data.tool_call_id,
        ...(action.data.function_name === undefined
          ? {}
          : { function_name: action.data.function_name }),
        ...(action.data.arguments === undefined ? {} : { args: action.data.arguments }),
        status: "in_progress",
      };
      if (byId !== -1) {
        const existing = state.messages[byId];
        if (!existing?.functionCall) return { state, effects: [] };
        const updated: ConversationMessage = {
          ...existing,
          updatedAt: action.now,
          functionCall: { ...existing.functionCall, ...patch },
        };
        const messages = [...state.messages];
        messages[byId] = updated;
        return {
          state: { ...state, messages },
          effects: [{ kind: "updated", message: updated }],
        };
      }
      const created: ConversationMessage = {
        role: "function_call",
        final: false,
        parts: [],
        createdAt: action.now,
        updatedAt: action.now,
        functionCall: patch,
      };
      return {
        state: { ...state, messages: [...state.messages, created] },
        effects: [{ kind: "created", message: created }],
      };
    }

    case "function-call-stopped": {
      const byId = findFunctionCallByIdIndex(state.messages, action.data.tool_call_id);
      const targetIdx = byId !== -1 ? byId : findStartedFunctionCallIndex(state.messages);
      if (targetIdx === -1) return { state, effects: [] };
      const existing = state.messages[targetIdx];
      if (!existing?.functionCall) return { state, effects: [] };
      const updated: ConversationMessage = {
        ...existing,
        final: true,
        updatedAt: action.now,
        functionCall: {
          ...existing.functionCall,
          tool_call_id: action.data.tool_call_id,
          ...(action.data.function_name === undefined
            ? {}
            : { function_name: action.data.function_name }),
          ...(action.data.result === undefined ? {} : { result: action.data.result }),
          ...(action.data.cancelled === undefined ? {} : { cancelled: action.data.cancelled }),
          status: "completed",
        },
      };
      const messages = [...state.messages];
      messages[targetIdx] = updated;
      return {
        state: { ...state, messages },
        effects: [{ kind: "updated", message: updated }],
      };
    }

    case "inject": {
      const created: ConversationMessage = {
        role: action.message.role,
        final: true,
        parts: [...action.message.parts],
        createdAt: action.now,
        updatedAt: action.now,
      };
      if (action.message.role === "system") {
        return {
          state: { ...state, messages: insertBeforeOpenAssistant(state.messages, created) },
          effects: [{ kind: "created", message: created }],
        };
      }
      const closed = closeOpenTurns(state, action.now, "keep");
      closed.effects.push({ kind: "created", message: created });
      return {
        state: { ...state, messages: [...closed.messages, created], segments: closed.segments },
        effects: closed.effects,
      };
    }
  }
}

export async function dispatchSentText(
  client: { sendText(content: string, options?: SendTextOptions): Promise<string> },
  content: string,
  sendOptions: SendTextOptions | undefined,
  dispatch: (action: ConversationAction) => void,
  isCurrent: () => boolean = () => true,
  now: () => string = () => new Date().toISOString(),
): Promise<string> {
  let msgId: string;
  try {
    msgId = await client.sendText(content, sendOptions);
  } catch (error) {
    if (isCurrent()) {
      dispatch({
        type: "send-text-rejected",
        text: content,
        now: now(),
      });
    }
    throw error;
  }
  if (isCurrent()) {
    dispatch({
      type: "send-text-resolved",
      text: content,
      msgId,
      runImmediately: sendOptions?.run_immediately !== false,
      now: now(),
    });
  }
  return msgId;
}

function openAssistantMessage(state: ConversationState): ConversationMessage | undefined {
  return state.messages.findLast((msg) => msg.role === "assistant" && msg.final !== true);
}

/** Tracks live RTVI call transcripts, spoken/unspoken word progress, typed lines, and tool calls. */
export function useEidolonConversation(
  options: UseEidolonConversationOptions = {},
): EidolonConversationControls {
  const client = useEidolonClient();
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  const stateRef = useRef<ConversationState>(EMPTY_CONVERSATION_STATE);
  const prevClientRef = useRef(client);
  const activeClientRef = useRef<typeof client | null>(client);
  const generationRef = useRef(0);
  const lastSpeakerRef = useRef<string | null>(null);
  const callbacksRef = useRef(options);
  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  const dispatch = useCallback((action: ConversationAction) => {
    if (action.type === "reset") generationRef.current += 1;
    const { state, effects } = stepConversation(stateRef.current, action);
    if (state === stateRef.current && effects.length === 0) return;
    stateRef.current = state;
    setMessages(state.messages);
    for (const effect of effects) {
      if (effect.kind === "created") callbacksRef.current.onMessageCreated?.(effect.message);
      else callbacksRef.current.onMessageUpdated?.(effect.message);
    }
  }, []);

  useEffect(() => {
    activeClientRef.current = client;
    if (prevClientRef.current !== client) {
      prevClientRef.current = client;
      lastSpeakerRef.current = null;
      dispatch({ type: "reset" });
    }

    let botStoppedTimer: ReturnType<typeof setTimeout> | undefined;
    let botTimerSource: "speech-stopped" | "text-only" | undefined;
    let botSpeaking = false;
    let userStoppedTimer: ReturnType<typeof setTimeout> | undefined;

    const cancelBotTimer = () => {
      if (botStoppedTimer !== undefined) {
        clearTimeout(botStoppedTimer);
        botStoppedTimer = undefined;
      }
      botTimerSource = undefined;
    };
    const armBotTimer = (source: "speech-stopped" | "text-only") => {
      cancelBotTimer();
      botTimerSource = source;
      botStoppedTimer = setTimeout(() => {
        botStoppedTimer = undefined;
        botTimerSource = undefined;
        dispatch({ type: "bot-stopped-timeout", now: new Date().toISOString() });
      }, BOT_STOPPED_FINALIZE_DELAY_MS);
    };
    const cancelUserTimer = () => {
      if (userStoppedTimer !== undefined) {
        clearTimeout(userStoppedTimer);
        userStoppedTimer = undefined;
      }
    };

    const unsubs = [
      client.on("connected", () => {
        cancelBotTimer();
        cancelUserTimer();
        lastSpeakerRef.current = null;
        dispatch({ type: "reset" });
      }),
      client.on("disconnected", () => {
        cancelBotTimer();
        cancelUserTimer();
        lastSpeakerRef.current = null;
        dispatch({ type: "disconnected", now: new Date().toISOString() });
      }),
      client.on("serverMessage", (msg: EidolonServerMessage) => {
        if (msg.type !== "speaker") return;
        const prev = lastSpeakerRef.current;
        lastSpeakerRef.current = msg.speaker.persona;
        if (prev !== null && prev !== msg.speaker.persona) {
          cancelBotTimer();
          dispatch({ type: "bot-stopped-timeout", now: new Date().toISOString() });
        }
      }),
      client.on("botOutput", (data: BotOutputData) => {
        if (isIgnoredBotOutput(data)) return;
        dispatch({ type: "bot-output", data, now: new Date().toISOString() });
        const openAssistant = openAssistantMessage(stateRef.current);
        if (!openAssistant) {
          cancelBotTimer();
          return;
        }
        const pendingVoiced = openAssistant.parts.some(
          (part) => !part.final && isBotOutputText(part.text),
        );
        const isNewVoicedSegment =
          data.will_be_spoken !== false &&
          data.spoken_status !== "in-progress" &&
          data.spoken_status !== "completed";
        if (botTimerSource === "speech-stopped") {
          if (pendingVoiced && isNewVoicedSegment) {
            cancelBotTimer();
          } else {
            armBotTimer("speech-stopped");
          }
        } else if (pendingVoiced) {
          cancelBotTimer();
        } else if (!botSpeaking && data.will_be_spoken !== false) {
          // A realtime call releases her held bot-output after bot-stopped-speaking.
          armBotTimer("speech-stopped");
        } else if (botTimerSource === "text-only" || data.will_be_spoken === false) {
          armBotTimer("text-only");
        }
      }),
      client.on("botLlmStarted", cancelBotTimer),
      client.on("botStartedSpeaking", () => {
        botSpeaking = true;
        cancelBotTimer();
      }),
      client.on("botStoppedSpeaking", () => {
        botSpeaking = false;
        armBotTimer("speech-stopped");
      }),
      client.on("botInterrupted", () => {
        cancelBotTimer();
        dispatch({ type: "bot-interrupted", now: new Date().toISOString() });
      }),
      client.on("userStartedSpeaking", () => {
        cancelBotTimer();
        cancelUserTimer();
        dispatch({ type: "user-started-speaking", now: new Date().toISOString() });
      }),
      client.on("userStoppedSpeaking", () => {
        cancelUserTimer();
        userStoppedTimer = setTimeout(() => {
          userStoppedTimer = undefined;
          dispatch({ type: "user-stopped-timeout", now: new Date().toISOString() });
        }, USER_STOPPED_FINALIZE_DELAY_MS);
      }),
      client.on("userInput", (data: UserInputData) => {
        if (data.input_type === "backchannel") return;
        cancelUserTimer();
        const now = new Date().toISOString();
        if (data.input_type === "chat") {
          dispatch({
            type: "user-chat-echo",
            text: data.text,
            ...(data.msg_id === undefined ? {} : { msgId: data.msg_id }),
            runImmediately: client.wasTextSentImmediately(data.msg_id),
            now,
          });
          return;
        }
        dispatch({
          type: "user-transcription",
          text: data.text,
          final: Boolean(data.final),
          fromUserInput: true,
          now,
        });
      }),
      client.on("userTranscript", (data: TranscriptData) => {
        if (stateRef.current.userInputSeen) return;
        cancelUserTimer();
        dispatch({
          type: "user-transcription",
          text: data.text ?? "",
          final: Boolean(data.final),
          fromUserInput: false,
          now: new Date().toISOString(),
        });
      }),
      client.on("llmFunctionCallStarted", (data: LLMFunctionCallStartedData) => {
        dispatch({ type: "function-call-started", data, now: new Date().toISOString() });
      }),
      client.on("llmFunctionCallInProgress", (data: LLMFunctionCallInProgressData) => {
        dispatch({ type: "function-call-in-progress", data, now: new Date().toISOString() });
      }),
      client.on("llmFunctionCallStopped", (data: LLMFunctionCallStoppedData) => {
        dispatch({ type: "function-call-stopped", data, now: new Date().toISOString() });
      }),
    ];

    return () => {
      activeClientRef.current = null;
      generationRef.current += 1;
      cancelBotTimer();
      cancelUserTimer();
      for (const unsub of unsubs) unsub();
    };
  }, [client, dispatch]);

  const injectMessage = useCallback(
    (message: InjectConversationMessageInput) => {
      dispatch({ type: "inject", message, now: new Date().toISOString() });
    },
    [dispatch],
  );

  const sendText = useCallback(
    (content: string, sendOptions?: SendTextOptions): Promise<string> => {
      const generation = generationRef.current;
      return dispatchSentText(
        client,
        content,
        sendOptions,
        dispatch,
        () => generationRef.current === generation && activeClientRef.current === client,
      );
    },
    [client, dispatch],
  );

  const clearMessages = useCallback(() => {
    lastSpeakerRef.current = null;
    dispatch({ type: "reset" });
  }, [dispatch]);

  return useMemo(
    () => ({ messages, injectMessage, sendText, clearMessages }),
    [clearMessages, injectMessage, messages, sendText],
  );
}
