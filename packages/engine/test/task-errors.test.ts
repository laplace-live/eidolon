// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/ai/test/overflow.test.ts@ac78a60 and packages/ai/test/retry.test.ts@ac78a60
//
// pi's provider messages, as @eidolon/providers surfaces them: a ProviderHttpError with a status.
import { ProviderHttpError } from "@eidolon/providers";
import { describe, expect, test } from "vitest";
import { isContextOverflow, isTransient, overflowTokens } from "../src/task/errors.ts";

const http = (status: number, message: string) =>
  new ProviderHttpError("provider", status, message);

describe("isContextOverflow", () => {
  test.each([
    "prompt is too long: 213462 tokens > 200000 maximum",
    '{"code":"1261","message":"Prompt too long"}',
    '{"code":"1261","message":"Prompt exceeds max length"}',
    "`prompt too long; exceeded max context length by 100918 tokens`",
    "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
    "Requested token count exceeds the model's maximum context length of 131072 tokens.",
    "litellm.ContextWindowExceededError: Context Window exceeded for given call.",
    "Input length (265330) exceeds model's maximum context length (262144).",
    "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
    "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
    "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens",
    "Your input exceeds the context window of this model",
  ])("detects %s", (message) => {
    expect(isContextOverflow(http(400, message))).toBe(true);
  });

  test("takes any 413 for a request too large", () => {
    expect(isContextOverflow(http(413, "Payload Too Large"))).toBe(true);
    expect(isContextOverflow(http(400, "failed to parse request: invalid value 413"))).toBe(false);
  });

  test.each([
    "Throttling error: Too many tokens, please wait before trying again.",
    "Rate limit exceeded, please retry after 30 seconds.",
    "Too many requests. Please slow down.",
    "`model runner crashed unexpectedly`",
    "Tokens per minute limit exceeded - too many tokens processed.",
  ])("doesn't mistake %s for an overflow", (message) => {
    expect(isContextOverflow(http(429, message))).toBe(false);
  });

  test("needs a provider's answer", () => {
    expect(isContextOverflow(new Error("prompt is too long"))).toBe(false);
  });
});

describe("overflowTokens", () => {
  test.each([
    ["prompt is too long: 213462 tokens > 200000 maximum", 200_000],
    [
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      262_144,
    ],
    ["Requested token count exceeds the model's maximum context length of 131072 tokens.", 131_072],
    ["Input length (265330) exceeds model's maximum context length (262144).", 262_144],
    ["Input length 131393 exceeds the maximum allowed input length of 131040 tokens.", 131_040],
    ["Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens", 256_000],
    [
      "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens",
      131_072,
    ],
    ["input token count (1,200,000) exceeds the maximum allowed (1,048,576)", 1_048_576],
    ["maximum prompt length is 131072", 131_072],
    ["exceeds the limit of 200000 tokens", 200_000],
    ["prompt token count exceeds the limit of 128000", 128_000],
    ["input exceeds the limit of 128,000 tokens", 128_000],
    [
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048576).",
      1_048_576,
    ],
    ["too large for model with 131072 maximum context length", 131_072],
  ])("extracts %s -> %s", (message, expected) => {
    expect(overflowTokens(http(400, message))).toBe(expected);
  });

  test("returns null when the message names only excess tokens, byte/size limits, generic 413, or non-overflow errors", () => {
    expect(
      overflowTokens(http(400, "`prompt too long; exceeded max context length by 100918 tokens`")),
    ).toBeNull();
    expect(overflowTokens(http(413, "Payload Too Large"))).toBeNull();
    expect(overflowTokens(http(413, "request exceeds the limit of 10485760 bytes"))).toBeNull();
    expect(overflowTokens(http(413, "request body exceeds the limit of 10485760"))).toBeNull();
    expect(
      overflowTokens(http(413, "request size exceeds the maximum allowed (10485760)")),
    ).toBeNull();
    expect(overflowTokens(http(429, "maximum context length is 131072 tokens"))).toBeNull();
    expect(
      overflowTokens(new Error("prompt is too long: 213462 tokens > 200000 maximum")),
    ).toBeNull();
  });
});

describe("isTransient", () => {
  test("retries a 429 and a 5xx", () => {
    expect(isTransient(http(429, "Too many requests"))).toBe(true);
    for (const status of [500, 502, 503, 504, 520, 524, 529]) {
      expect(isTransient(http(status, "status code (no body)"))).toBe(true);
    }
  });

  test("retries an error with no HTTP answer: a network error", () => {
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(
      isTransient(
        new Error(
          "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        ),
      ),
    ).toBe(true);
  });

  test.each([
    "overloaded_error",
    '{"type":"error","error":{"type":"api_error","message":"Connection closed."}}',
    "upstream_stream_read_error: Upstream response stream was interrupted",
    "The service is temporarily unavailable. Please retry later.",
    "Provider disconnected unexpectedly",
  ])("retries an error event mid-stream that says %s", (message) => {
    expect(isTransient(http(200, message))).toBe(true);
  });

  test.each([
    "429 quota exceeded",
    '{"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit reached."}',
    "You exceeded your current quota: insufficient_quota",
  ])("keeps the provider limit %s from retrying", (message) => {
    expect(isTransient(http(429, message))).toBe(false);
  });

  test("doesn't retry a request the provider refused", () => {
    expect(
      isTransient(
        http(
          401,
          '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CU503xyz"}',
        ),
      ),
    ).toBe(false);
    expect(
      isTransient(http(400, "image exceeds 5 MB maximum: 5316784 bytes > 5242880 bytes")),
    ).toBe(false);
    expect(isTransient(http(200, "a stream event that isn't JSON: <html>"))).toBe(false);
  });
});
