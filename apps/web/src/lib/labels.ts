// The labels more than one feature shows: roles, API errors, and how a list is joined.
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { ApiError, type ClientErrorCode, type ErrorCode } from "@/lib/api";
import type { Category, RoleId } from "@/lib/providers";

export const ROLE_LABELS: Readonly<Record<RoleId, MessageDescriptor>> = {
  hearing: msg`Speech Recognition`,
  mind: msg`Chat`,
  voice: msg`Voice`,
  realtime: msg`Realtime Voice`,
  gate: msg`Retrieval Gate`,
  rerank: msg`Reranking`,
  memory: msg`Memory`,
  selfie: msg`Selfies`,
  transcription: msg`Transcription`,
  refine: msg`Transcript Refinement`,
  embeddings: msg`Embeddings`,
};

/** The kinds of model a provider offers. */
export const CATEGORY_LABELS: Readonly<Record<Category, MessageDescriptor>> = {
  llm: msg`Chat`,
  stt: msg`Speech Recognition`,
  tts: msg`Voice`,
  realtime: msg`Realtime Voice`,
  embedding: msg`Embeddings`,
  rerank: msg`Reranking`,
  decision: msg`Decision Models`,
  image: msg`Images`,
  transcription: msg`Transcription`,
};

/** A provider's own account settings, by field key. */
export const ACCOUNT_FIELD_LABELS: Readonly<Record<string, MessageDescriptor>> = {
  groupId: msg`Group ID`,
};

/** What a provider's key needs besides itself, for the providers a call needs by default. */
export const KEY_NOTES: Readonly<Record<string, MessageDescriptor>> = {
  soniox: msg`Needs credit on the account; calls and transcription bill per minute of audio.`,
  openrouter: msg`Needs prepaid credit.`,
  fish: msg`Needs API credit, which is separate from a fish.audio membership; new accounts start at $0.`,
};

const ERRORS: Readonly<Record<ErrorCode | ClientErrorCode | "unknown", MessageDescriptor>> = {
  unreachable: msg`Can't reach Eidolon. Check that it's still running in the terminal.`,
  "bad-response": msg`Eidolon sent a reply this page couldn't read.`,
  unknown: msg`Something went wrong.`,
  "bad-json": msg`The request wasn't valid JSON.`,
  "bad-request": msg`The request wasn't valid.`,
  unauthorized: msg`This page isn't signed in. Open the link from the terminal.`,
  "link-expired": msg`That link has expired. Run the same command again for a fresh one.`,
  "proof-missing": msg`This page's sign-in isn't complete. Open the link from the terminal.`,
  forbidden: msg`The request was refused.`,
  misdirected: msg`Eidolon answers only at localhost or 127.0.0.1. Open it at one of those.`,
  "not-found": msg`That doesn't exist.`,
  "method-not-allowed": msg`That action isn't supported here.`,
  conflict: msg`That conflicts with what changed meanwhile. Reload and try again.`,
  "payload-too-large": msg`The file is too large.`,
  "unsupported-media-type": msg`That file type isn't supported.`,
  unavailable: msg`That service isn't available right now.`,
  "upstream-failed": msg`A service Eidolon relies on failed. Try again later.`,
  internal: msg`Eidolon hit an internal error. The terminal has the details.`,
  "invalid-persona-id": msg`A persona id uses lowercase letters, digits, - and _, and starts with a letter or digit.`,
  "unknown-persona": msg`There is no persona with that id.`,
  "persona-exists": msg`A persona with that id already exists.`,
  "call-active": msg`A call is in progress. Hang up first.`,
  "unknown-setting": msg`That setting doesn't exist.`,
  "invalid-setting": msg`That value isn't valid for this setting.`,
  "read-only-setting": msg`This setting can't be changed here.`,
  "invalid-path": msg`A path must be relative and stay inside the persona's folder.`,
  "unknown-credential": msg`Eidolon doesn't use that key.`,
  "unknown-account": msg`Eidolon has no such provider account.`,
  "account-in-use": msg`An account a persona uses can't be removed: pick another for her first.`,
  "invalid-file-name": msg`That file name isn't allowed.`,
  "template-file": msg`This file ships with Eidolon and can't be changed or deleted.`,
  "invalid-toml": msg`The glossary isn't valid TOML.`,
  "invalid-url": msg`Each link must be a full http or https URL.`,
  "unknown-command": msg`That job doesn't exist.`,
  "invalid-option": msg`A job option isn't valid.`,
  "unknown-job": msg`There is no such job.`,
  "job-not-running": msg`That job isn't running.`,
  "job-not-resumable": msg`That job can't be resumed.`,
  "unknown-chat": msg`There is no such chat.`,
  "missing-key": msg`Her chat model has no key yet. Add one in Settings.`,
  "chat-in-call": msg`This chat is in a call. Hang up first.`,
};

/** What an error says to the viewer: its code's sentence, else a general one. */
export function errorMessage(error: unknown): MessageDescriptor {
  return error instanceof ApiError ? (ERRORS[error.code] ?? ERRORS.unknown) : ERRORS.unknown;
}

/** `items` as one list in the active language: "a, b" or "a、b". */
export function listOf(items: readonly string[]): string {
  return items.join(t({ message: ", ", context: "list separator" }));
}
