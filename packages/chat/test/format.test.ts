import { describe, expect, test } from "bun:test";
import {
  attachmentExtension,
  attachmentMime,
  CHAT_FORMAT,
  type ChatEvent,
  type ChatHeader,
  canonicalForSig,
  isChatId,
  stampEvents,
  summarize,
} from "../src/index.ts";

const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-000000000000",
  createdAt: 1000,
  participants: ["milky"],
};

describe("summarize", () => {
  test("a new chat has no title, text or events", () => {
    expect(summarize(HEADER, [])).toEqual({
      id: HEADER.id,
      title: null,
      participants: ["milky"],
      createdAt: 1000,
      updatedAt: 1000,
      lastText: null,
      lastSeq: 0,
    });
  });

  test("takes the last title and message, and applies participant changes in order", () => {
    const events = stampEvents(
      [
        { type: "title", title: "First" },
        { type: "message", id: "m1", speaker: { kind: "user" }, text: "hi" },
        { type: "participants", added: ["ruby", "ken", "ruby"] },
        { type: "title", title: "Second" },
        { type: "message", id: "m2", speaker: { kind: "persona", id: "ruby" }, text: "yo" },
        { type: "participants", added: ["milky"], removed: ["milky", "ken"] },
        { type: "turn-failed", persona: "ruby", turn: "t", error: "boom" },
      ],
      0,
      5000,
    );
    expect(summarize(HEADER, events)).toEqual({
      id: HEADER.id,
      title: "Second",
      participants: ["ruby", "milky"],
      createdAt: 1000,
      updatedAt: 5000,
      lastText: "yo",
      lastSeq: 7,
    });
  });

  test("a message with photos alone keeps the text before it", () => {
    const events = stampEvents(
      [
        { type: "message", id: "m1", speaker: { kind: "persona", id: "milky" }, text: "看我" },
        {
          type: "message",
          id: "m2",
          speaker: { kind: "persona", id: "milky" },
          text: "",
          attachments: [{ kind: "image", name: `${"a".repeat(64)}.png`, mime: "image/png" }],
        },
      ],
      0,
      5000,
    );
    expect(summarize(HEADER, events).lastText).toBe("看我");
  });

  test("updatedAt never runs backwards", () => {
    const events: ChatEvent[] = [
      { seq: 1, at: 3000, type: "title", title: "a" },
      { seq: 2, at: 2000, type: "title", title: "b" },
    ];
    expect(summarize(HEADER, events).updatedAt).toBe(3000);
  });
});

describe("stampEvents", () => {
  test("numbers drafts on from lastSeq, all at one time, fields kept", () => {
    expect(
      stampEvents(
        [
          { type: "title", title: "x" },
          { type: "kickoff", persona: "milky", turn: "t", content: "hello" },
        ],
        7,
        42,
      ),
    ).toEqual([
      { type: "title", title: "x", seq: 8, at: 42 },
      { type: "kickoff", persona: "milky", turn: "t", content: "hello", seq: 9, at: 42 },
    ]);
  });
});

describe("canonicalForSig", () => {
  const event: ChatEvent = {
    type: "tool-call",
    seq: 3,
    at: 10,
    persona: "milky",
    turn: "t",
    callId: "c",
    name: "take_selfie",
    arguments: { z: 1, a: { y: [2, { d: "é", b: null }], x: "\n" } },
    sig: "ignored",
  };

  test("is the chat id, a newline, then the event's JSON with sorted keys and no sig", () => {
    expect(canonicalForSig("chat-1", event)).toBe(
      'chat-1\n{"arguments":{"a":{"x":"\\n","y":[2,{"b":null,"d":"é"}]},"z":1},"at":10,' +
        '"callId":"c","name":"take_selfie","persona":"milky","seq":3,"turn":"t","type":"tool-call"}',
    );
  });

  test("doesn't depend on key order, the signature, or undefined members", () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed);
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, inner]) => [key, reversed(inner)]),
      );
    };
    const { sig: _, ...unsigned } = event;
    expect(canonicalForSig("c", reversed(event) as ChatEvent)).toBe(canonicalForSig("c", event));
    expect(canonicalForSig("c", { ...unsigned, modality: undefined } as unknown as ChatEvent)).toBe(
      canonicalForSig("c", event),
    );
    expect(canonicalForSig("other", event)).not.toBe(canonicalForSig("c", event));
  });
});

describe("ids and attachment names", () => {
  test("a chat id is a lowercase UUID", () => {
    expect(isChatId(Bun.randomUUIDv7())).toBe(true);
    expect(isChatId(crypto.randomUUID())).toBe(true);
    expect(isChatId(Bun.randomUUIDv7().toUpperCase())).toBe(false);
    expect(isChatId("../0190f5c8-0000-7000-8000-000000000000")).toBe(false);
    expect(isChatId("0190f5c8-0000-7000-8000-000000000000\n")).toBe(false);
  });

  test("attachments are the image types a browser shows without running script", () => {
    expect(attachmentExtension("image/png")).toBe("png");
    expect(attachmentExtension("IMAGE/JPEG")).toBe("jpg");
    expect(attachmentExtension("image/svg+xml")).toBeNull();
    expect(attachmentExtension("text/html")).toBeNull();
    const sha = "0123456789abcdef".repeat(4);
    expect(attachmentMime(`${sha}.jpg`)).toBe("image/jpeg");
    expect(attachmentMime(`${sha}.webp`)).toBe("image/webp");
    expect(attachmentMime(`${sha}.svg`)).toBeNull();
    expect(attachmentMime(`${sha.slice(1)}.png`)).toBeNull();
    expect(attachmentMime(`../${sha}.png`)).toBeNull();
  });
});
