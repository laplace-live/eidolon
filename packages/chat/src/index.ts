// The chat log's format, browser-safe: apps/web and laplace's client import it, so nothing here
// imports Bun, Node or another workspace package. The local store is `@eidolon/chat/jsonl`.
export {
  type Attachment,
  attachmentExtension,
  attachmentMime,
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatEventOf,
  type ChatHeader,
  type ChatStore,
  ChatStoreError,
  type ChatStoreErrorCode,
  type ChatStreamLine,
  type ChatSummary,
  type CutOff,
  DEFAULT_CHAIN_LIMIT,
  isChatId,
  MAX_CHAIN_LIMIT,
  MAX_PARTICIPANTS,
  type ParticipantId,
  type Speaker,
  stampEvents,
} from "./format.ts";
export { type MentionTarget, parseMentions } from "./mentions.ts";
export { canonicalForSig } from "./sig.ts";
export { chainLimitOf, summarize } from "./summary.ts";
export {
  CHAT_WINDOW_MESSAGES,
  toolCallMessages,
  type ViewMessage,
  type ViewOptions,
  type ViewToolCall,
  viewerLabel,
  viewOf,
  viewWithBlocks,
} from "./view.ts";
