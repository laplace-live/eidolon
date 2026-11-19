// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/test/content.test.ts@ac78a60, packages/mcp/test/input-schema.test.ts@ac78a60 and packages/mcp/test/output-limit.test.ts@ac78a60
//
// pi's cases for content blocks, input schemas and the output limit. The limit here takes the
// result's text alone, since the worker can't view images, and saves nothing: the cut text says to
// ask again for less.
import { describe, expect, it } from "bun:test";
import { normalizeMcpInputSchema } from "../src/mcp/input-schema.ts";
import { limitMcpText, MCP_OUTPUT_MAX_BYTES } from "../src/mcp/output-limit.ts";
import { type ContentBlock, toLlmContent } from "../src/mcp/protocol/content.ts";

describe("toLlmContent", () => {
  it("passes text and images through and replaces other blocks with text", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hello", annotations: { priority: 1 } },
      { type: "image", data: "aW1n", mimeType: "image/png", _meta: { x: 1 } },
      { type: "audio", data: "YXVk", mimeType: "audio/wav" },
      { type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
      { type: "resource", resource: { uri: "file:///b.txt", text: "inline" } },
      { type: "resource", resource: { uri: "file:///c.png", mimeType: "image/png", blob: "Yw==" } },
      { type: "resource", resource: { uri: "file:///d.bin", blob: "ZA==" } },
    ];
    expect(toLlmContent({ content: blocks })).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
      { type: "text", text: "[audio audio/wav omitted]" },
      { type: "text", text: "a.txt: file:///a.txt" },
      { type: "text", text: "inline" },
      { type: "image", data: "Yw==", mimeType: "image/png" },
      { type: "text", text: "[binary resource file:///d.bin (unknown type) omitted]" },
    ]);
  });

  it("falls back to the structured content as JSON when there are no blocks", () => {
    // #10416: structured content may be any JSON value.
    expect(toLlmContent({ content: [], structuredContent: [1, 2] })).toEqual([
      { type: "text", text: "[\n  1,\n  2\n]" },
    ]);
    expect(toLlmContent({ content: [], structuredContent: null })).toEqual([
      { type: "text", text: "null" },
    ]);
    expect(toLlmContent({ content: [], structuredContent: { n: 1 } })).toEqual([
      { type: "text", text: '{\n  "n": 1\n}' },
    ]);
    expect(
      toLlmContent({ content: [{ type: "text", text: "n=1" }], structuredContent: { n: 1 } }),
    ).toEqual([{ type: "text", text: "n=1" }]);
  });
});

describe("normalizeMcpInputSchema", () => {
  it("adds type object and empty properties when missing", () => {
    expect(normalizeMcpInputSchema({})).toEqual({ type: "object", properties: {} });
    expect(normalizeMcpInputSchema({ type: "object" })).toEqual({ type: "object", properties: {} });
  });

  it("keeps the schema's own keywords", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };
    expect(normalizeMcpInputSchema(schema)).toEqual(schema);
    expect(normalizeMcpInputSchema({ properties: { a: {} }, $defs: { x: {} } })).toEqual({
      type: "object",
      properties: { a: {} },
      $defs: { x: {} },
    });
  });
});

describe("limitMcpText", () => {
  it("returns text within the limit as it is", () => {
    const text = "x".repeat(MCP_OUTPUT_MAX_BYTES);
    expect(limitMcpText(text)).toEqual({ text });
  });

  it("cuts the middle of longer text and says to ask again for less", () => {
    const full = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n");
    const limited = limitMcpText(full);
    expect(limited.truncated).toEqual({ totalBytes: full.length, totalLines: 3000 });
    expect(limited.text).toMatch(
      new RegExp(
        `^Warning: truncated output \\(original token count: ${Math.ceil(full.length / 4)}\\)\nTotal output lines: 3000\nThe middle was cut\\. To see it, call the tool again asking for less: a narrower query, a smaller page or a filter\\.\n\nline 1\nline 2\n`,
      ),
    );
    expect(limited.text).toMatch(/…\d+ chars truncated…/);
    expect(limited.text.endsWith("line 3000")).toBe(true);
    expect(Buffer.byteLength(limited.text)).toBeLessThan(MCP_OUTPUT_MAX_BYTES + 1024);
  });

  it("cuts multi-byte text only at character boundaries", () => {
    // After the one-byte prefix, characters start at odd bytes, and both cuts (byte 10240 and byte
    // 40004 - 10240) are even: each lands inside a two-byte character.
    const text = `a${"é".repeat(20_000)}end`;
    const limited = limitMcpText(text).text;
    expect(limited).not.toContain("\uFFFD");
    expect(limited.endsWith("end")).toBe(true);
    const marker = /…(\d+) chars truncated…/.exec(limited);
    if (!marker) throw new Error("expected the truncation marker");
    const [head = "", tail = ""] = limited.slice(limited.indexOf("\n\n") + 2).split(marker[0]);
    expect(Buffer.byteLength(head)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES / 2);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES / 2);
    expect(Array.from(head).length + Array.from(tail).length + Number(marker[1])).toBe(
      Array.from(text).length,
    );
  });
});
