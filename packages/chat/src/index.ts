// The chat log's format, browser-safe: apps/web and laplace's client import it, so nothing here
// imports Bun, Node or another workspace package. The local store is `@eidolon/chat/jsonl`.
export {
  type Attachment,
  attachmentExtension,
  attachmentKind,
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
  isReplyMode,
  MAX_CHAIN_LIMIT,
  MAX_PARTICIPANTS,
  type ParticipantId,
  REPLY_MODES,
  type ReplyMode,
  type Speaker,
  stampEvents,
} from "./format.ts";
export { type MentionTarget, parseMentions } from "./mentions.ts";
export { canonicalForSig } from "./sig.ts";
export { chainLimitOf, replyModeOf, summarize } from "./summary.ts";
export {
  CHAT_WINDOW_MESSAGES,
  toolCallMessages,
  type ViewMessage,
  type ViewOptions,
  type ViewToolCall,
  viewOf,
  viewWithBlocks,
} from "./view.ts";
