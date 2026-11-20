import { describe, expect, test } from "vitest";
import { newId } from "../../config/src/ids.ts";
import {
  attachmentExtension,
  attachmentKind,
  attachmentMime,
  CHAT_FORMAT,
  type ChatEvent,
  type ChatHeader,
  canonicalForSig,
  chainLimitOf,
  DEFAULT_CHAIN_LIMIT,
  displayOf,
  isChatDisplay,
  isChatId,
  isPermissionLevel,
  isReplyMode,
  lineFilesOf,
  lineFileType,
  MAX_IMAGE_BYTES,
  PERMISSION_LEVELS,
  permissionsOf,
  replyModeOf,
  sendableImageType,
  sendableText,
  sentFilename,
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

describe("chainLimitOf", () => {
  test("is the last settings event's, else the default", () => {
    expect(chainLimitOf([])).toBe(DEFAULT_CHAIN_LIMIT);
    const events: ChatEvent[] = [
      { type: "settings", seq: 1, at: 1, chainLimit: 0 },
      { type: "settings", seq: 2, at: 2, replyMode: "text" },
    ];
    expect(chainLimitOf(events)).toBe(0);
    expect(chainLimitOf([...events, { type: "settings", seq: 3, at: 3, chainLimit: 5 }])).toBe(5);
  });
});

describe("replyModeOf", () => {
  test("is the last settings event's, else null: the personas' own then apply", () => {
    expect(replyModeOf([])).toBeNull();
    const events: ChatEvent[] = [
      { type: "settings", seq: 1, at: 1, replyMode: "voice" },
      { type: "settings", seq: 2, at: 2, chainLimit: 1 },
    ];
    expect(replyModeOf(events)).toBe("voice");
    expect(replyModeOf([...events, { type: "settings", seq: 3, at: 3, replyMode: "auto" }])).toBe(
      "auto",
    );
  });

  test("isReplyMode takes the three modes only", () => {
    expect(["auto", "text", "voice"].every(isReplyMode)).toBe(true);
    expect([" auto", "Voice", "audio", null, 1].some(isReplyMode)).toBe(false);
  });
});

describe("displayOf", () => {
  test("is the last settings event that sets one, else null: the app's display then applies", () => {
    expect(displayOf([])).toBeNull();
    const events: ChatEvent[] = [
      { type: "settings", seq: 1, at: 1, replyMode: "voice" },
      { type: "settings", seq: 2, at: 2, display: "focus" },
    ];
    expect(displayOf(events.slice(0, 1))).toBeNull();
    expect(displayOf(events)).toBe("focus");
    expect(displayOf([...events, { type: "settings", seq: 3, at: 3, display: "verbose" }])).toBe(
      "verbose",
    );
  });

  test("a later reply-mode or chain-limit change keeps the chat's display", () => {
    const events: ChatEvent[] = [
      { type: "settings", seq: 1, at: 1, display: "verbose" },
      { type: "settings", seq: 2, at: 2, replyMode: "text" },
      { type: "settings", seq: 3, at: 3, chainLimit: 0 },
    ];
    expect(displayOf(events)).toBe("verbose");
    expect([replyModeOf(events), chainLimitOf(events)]).toEqual(["text", 0]);
  });

  test("isChatDisplay takes the three displays only", () => {
    expect(["focus", "normal", "verbose"].every(isChatDisplay)).toBe(true);
    expect([" focus", "Verbose", "quiet", "", null, 1].some(isChatDisplay)).toBe(false);
  });
});

describe("permissionsOf", () => {
  test("is the last settings event that sets one, else null: the app's level then applies", () => {
    expect(permissionsOf([])).toBeNull();
    const events: ChatEvent[] = [
      { type: "settings", seq: 1, at: 1, display: "focus" },
      { type: "settings", seq: 2, at: 2, permissions: "full" },
      { type: "settings", seq: 3, at: 3, replyMode: "text" },
    ];
    expect(permissionsOf(events.slice(0, 1))).toBeNull();
    expect(permissionsOf(events)).toBe("full");
    expect(
      permissionsOf([...events, { type: "settings", seq: 4, at: 4, permissions: "ask" }]),
    ).toBe("ask");
  });

  test("a value that is no level reads as ask, never as the app's level", () => {
    const events = [
      { type: "settings", seq: 1, at: 1, permissions: "auto" },
      { type: "settings", seq: 2, at: 2, permissions: "everything" },
    ] as unknown as ChatEvent[];
    expect(permissionsOf(events)).toBe("ask");
    expect(permissionsOf(events.slice(0, 1))).toBe("auto");
  });

  test("isPermissionLevel takes the three levels only", () => {
    expect(PERMISSION_LEVELS.every(isPermissionLevel)).toBe(true);
    expect([" ask", "Full", "yolo", "", null, 1].some(isPermissionLevel)).toBe(false);
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
    expect(isChatId(newId())).toBe(true);
    expect(isChatId(crypto.randomUUID())).toBe(true);
    expect(isChatId(newId().toUpperCase())).toBe(false);
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

  test("audio is what browsers record and TTS providers send, its codecs aside", () => {
    expect(attachmentExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(attachmentExtension("audio/mp4")).toBe("m4a");
    expect(attachmentExtension("audio/ogg; codecs=opus")).toBe("ogg");
    expect(attachmentExtension("audio/mpeg")).toBe("mp3");
    expect(attachmentExtension("audio/wav")).toBeNull();
    expect(attachmentExtension("constructor")).toBeNull();
    const sha = "0123456789abcdef".repeat(4);
    expect(attachmentMime(`${sha}.m4a`)).toBe("audio/mp4");
    expect(attachmentMime(`${sha}.mp3`)).toBe("audio/mpeg");
    expect(attachmentKind("audio/webm;codecs=opus")).toBe("audio");
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("video/webm")).toBeNull();
  });
});

describe("the files the viewer sends", () => {
  test("an image is a PNG, JPEG or WebP by its signature, whatever it is called", () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
    expect(sendableImageType(bytes(0x89, ...ascii("PNG\r\n\x1a\n"), 0))).toBe("image/png");
    expect(sendableImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sendableImageType(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")))).toBe(
      "image/webp",
    );
    expect(sendableImageType(bytes(...ascii("GIF89a")))).toBeNull();
    expect(sendableImageType(bytes(...ascii("<svg xmlns")))).toBeNull();
    expect(sendableImageType(bytes())).toBeNull();
  });

  test("a text file is UTF-8 with no NUL, and is kept as text/plain", () => {
    expect(sendableText(new TextEncoder().encode("第一章\n从前"))).toBe("第一章\n从前");
    expect(sendableText(new Uint8Array([0xe7, 0xac]))).toBeNull();
    expect(sendableText(new Uint8Array([0x61, 0, 0x62]))).toBeNull();
    expect(attachmentKind("text/plain; charset=utf-8")).toBe("file");
    expect(attachmentExtension("text/plain")).toBe("txt");
    expect(attachmentMime(`${"a".repeat(64)}.txt`)).toBe("text/plain");
  });
});

describe("a line's files", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const named = (ext: string) => `${"e".repeat(64)}.${ext}`;

  test("lineFileType keeps a PNG, JPEG or WebP sent as an image and UTF-8 sent as text", () => {
    expect(lineFileType("image/png", png)).toEqual({ mime: "image/png" });
    expect(lineFileType("image/jpeg", png)).toEqual({ mime: "image/png" });
    expect(lineFileType("text/markdown; charset=utf-8", new TextEncoder().encode("嗯"))).toEqual({
      mime: "text/plain",
    });
    expect(lineFileType("text/plain", png)).toEqual({ refused: "unsupported" });
    expect(lineFileType("application/pdf", png)).toEqual({ refused: "unsupported" });
    expect(lineFileType("image/png", new Uint8Array())).toEqual({ refused: "empty" });
    expect(lineFileType("image/png", new Uint8Array(MAX_IMAGE_BYTES + 1))).toEqual({
      refused: "too-large",
    });
  });

  test("lineFilesOf rebuilds a line's files from their names, or refuses the list", () => {
    expect(
      lineFilesOf([{ name: named("webp") }, { name: named("txt"), filename: "a/b\u0007.md" }]),
    ).toEqual([
      { kind: "image", name: named("webp"), mime: "image/webp" },
      { kind: "file", name: named("txt"), mime: "text/plain", filename: "b.md" },
    ]);
    expect(lineFilesOf([{ name: named("mp3") }])).toBeNull();
    expect(lineFilesOf([{ name: named("png") }, { name: named("png") }])).toBeNull();
    expect(
      lineFilesOf(Array.from({ length: 9 }, (_, i) => ({ name: `${String(i).repeat(64)}.png` }))),
    ).toBeNull();
    expect(lineFilesOf("x")).toBeNull();
    expect(sentFilename("  ")).toBeNull();
  });
});
