// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/ai/src/utils/overflow.ts@ac78a60 and packages/ai/src/utils/retry.ts@ac78a60
//
// Which failed requests a task outlives: a context overflow compacts and retries, and a
// transient failure waits and retries.
import { ProviderHttpError } from "@eidolon/providers";

/** What each provider says when a request is longer than its model's context. */
const OVERFLOW: readonly RegExp[] = [
  /prompt (?:is )?too long/i, // Anthropic, z.ai
  /prompt exceeds max length/i, // z.ai's CN endpoint
  /request_too_large/i, // Anthropic's request size limit
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies
  /context window exceeded/i, // LiteLLM
  /input token count.*exceeds the maximum/i, // Gemini
  /maximum prompt length is \d+/i, // xAI
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter's Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4
  /model_context_window_exceeded/i, // z.ai
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /range of input length should be/i, // DashScope
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

/** A rate limit can name tokens too: Bedrock's "Throttling error: Too many tokens". */
const THROTTLED = /rate limit|too many requests|throttl/i;

/** Quota and billing limits come as 429s that reset in hours, not seconds. */
const SPENT = /insufficient_quota|quota exceeded|out of budget|billing|usage limit/i;

/**
 * An error event in a stream that had begun answers 200, with no status of its own: Anthropic's
 * overloaded_error, a gateway's dropped upstream (OpenRouter's "Provider disconnected
 * unexpectedly").
 */
const TRANSIENT =
  /overloaded|server_busy|servers are currently busy|high demand|at capacity|rate.?limit|too many requests|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|provider.?returned.?(?:an.?)?error|upstream|stream was interrupted|connection.?(?:error|refused|lost|closed|reset)|disconnected|other side closed|fetch failed/i;

/**
 * A provider refused the request as longer than its model's context: a 413, or one of OVERFLOW in
 * any answer but a 429. A 429 is a rate limit whatever it says, and Cerebras's says "too many
 * tokens processed" (https://github.com/anomalyco/opencode/issues/13015).
 */
export function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.status === 413) return true;
  if (error.status === 429) return false;
  return !THROTTLED.test(error.message) && OVERFLOW.some((pattern) => pattern.test(error.message));
}

/**
 * A failure the same request may not meet again: a 429 or a 5xx, an error event mid-stream that
 * says as much, or one with no HTTP answer at all, a network error.
 */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return true;
  if (SPENT.test(error.message)) return false;
  if (error.status === 429 || error.status >= 500) return true;
  return error.status === 200 && TRANSIENT.test(error.message);
}
