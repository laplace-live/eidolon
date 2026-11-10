// The production chat's HMAC: its wire format, what it binds, and where its secret may come from.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatEvent, canonicalForSig } from "@eidolon/chat";
import { dataHome, envOptional, installSettings, resetSettings } from "@eidolon/config";
import {
  ChatSigner,
  chatSecretFromEnv,
  fromViewer,
  MIN_CHAT_SECRET_LENGTH,
} from "../../src/chat/sig.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";

const SECRET = "s".repeat(MIN_CHAT_SECRET_LENGTH);
const CHAT = "0190f5c8-0000-7000-8000-0000000000aa";
const OTHER_CHAT = "0190f5c8-0000-7000-8000-0000000000bb";

const said: ChatEvent = {
  seq: 4,
  at: 1_730_000_000_000,
  type: "message",
  id: "0190f5c8-0000-7000-8000-000000000004",
  speaker: { kind: "persona", id: "milky-green" },
  text: "今天也要开心哦（笑）",
  attachments: [{ kind: "image", name: `${"a".repeat(64)}.png`, mime: "image/png" }],
};
const decided: ChatEvent = {
  seq: 3,
  at: 1_730_000_000_000,
  type: "decision",
  after: 2,
  replies: [{ persona: "milky-green", mode: "text" }],
  source: "model",
  scores: { addressed_milky: 0.8125, invites_reply: 0.3 },
};

let signer: ChatSigner;
beforeEach(async () => {
  signer = await ChatSigner.create(SECRET);
});

describe("ChatSigner", () => {
  test("sig is base64url(HMAC-SHA256(secret, canonicalForSig(chatId, event))), unpadded", async () => {
    const signed = await signer.sign(CHAT, said);
    const expected = createHmac("sha256", SECRET)
      .update(canonicalForSig(CHAT, said))
      .digest("base64url");
    expect(signed).toEqual({ ...said, sig: expected });
    expect(signed.sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a signed event verifies after a trip through JSON, in any key order", async () => {
    for (const event of [said, decided]) {
      const signed = await signer.sign(CHAT, event);
      const back = JSON.parse(JSON.stringify(signed)) as ChatEvent;
      expect(await signer.verify(CHAT, back)).toBe(true);
      const reordered = Object.fromEntries(Object.entries(back).reverse()) as ChatEvent;
      expect(await signer.verify(CHAT, reordered)).toBe(true);
    }
  });

  test("signing again replaces the sig an event carried", async () => {
    const signed = await signer.sign(CHAT, said);
    const resigned: ChatEvent = await signer.sign(CHAT, { ...said, sig: "x" });
    expect(resigned).toEqual(signed);
  });

  test("any change to a signed event fails it", async () => {
    const signed = await signer.sign(CHAT, said);
    const tampered: unknown[] = [
      { ...signed, text: "我是机器人" },
      { ...signed, seq: 5 },
      { ...signed, at: signed.at + 1 },
      { ...signed, speaker: { kind: "persona", id: "someone-else" } },
      { ...signed, attachments: [] },
      { ...signed, interrupted: true },
    ];
    for (const event of tampered) expect(await signer.verify(CHAT, event as ChatEvent)).toBe(false);
  });

  test("a sig binds its chat: moved to another chat, it fails", async () => {
    const signed = await signer.sign(CHAT, decided);
    expect(await signer.verify(CHAT, signed)).toBe(true);
    expect(await signer.verify(OTHER_CHAT, signed)).toBe(false);
  });

  test("another secret's sig, and a missing or malformed one, fail", async () => {
    const other = await ChatSigner.create("t".repeat(MIN_CHAT_SECRET_LENGTH));
    const signed = await signer.sign(CHAT, said);
    expect(await other.verify(CHAT, signed)).toBe(false);
    const { sig, ...unsigned } = signed;
    const malformed = [undefined, "", 42, `${sig}=`, sig?.slice(1), `${sig?.slice(0, 42)}+`];
    for (const bad of malformed) {
      expect(await signer.verify(CHAT, { ...unsigned, sig: bad } as ChatEvent)).toBe(false);
    }
  });
});

test("fromViewer: the viewer's messages and what their browser sets, nothing else", () => {
  const user: ChatEvent = { ...said, speaker: { kind: "user" } };
  expect(fromViewer(user)).toBe(true);
  for (const type of ["title", "participants", "settings", "call-started", "call-ended"]) {
    expect([type, fromViewer({ type })]).toEqual([type, true]);
  }
  expect(fromViewer(said)).toBe(false);
  expect(fromViewer(decided)).toBe(false);
  for (const type of [
    "context",
    "context-removed",
    "tool-call",
    "tool-result",
    "kickoff",
    "turn-failed",
    "decision",
  ]) {
    expect([type, fromViewer({ type })]).toEqual([type, false]);
  }
  expect(fromViewer({ type: "message", speaker: "user" })).toBe(false);
  expect(fromViewer({ type: "message" })).toBe(false);
});

describe("chatSecretFromEnv", () => {
  const saved = process.env.EIDOLON_CHAT_SECRET;
  let logs: CapturedLogs;
  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(() => {
    logs.restore();
    if (saved === undefined) delete process.env.EIDOLON_CHAT_SECRET;
    else process.env.EIDOLON_CHAT_SECRET = saved;
  });

  test("is the environment's value, or null while unset or blank", () => {
    delete process.env.EIDOLON_CHAT_SECRET;
    expect(chatSecretFromEnv()).toBeNull();
    process.env.EIDOLON_CHAT_SECRET = "";
    expect(chatSecretFromEnv()).toBeNull();
    process.env.EIDOLON_CHAT_SECRET = SECRET;
    expect(chatSecretFromEnv()).toBe(SECRET);
    expect(logs.lines()).toEqual([]);
  });

  test("is null, and says so without the value, while too short to key the HMAC", () => {
    process.env.EIDOLON_CHAT_SECRET = "short-secret";
    expect(chatSecretFromEnv()).toBeNull();
    expect(logs.lines()).toEqual([
      "ERROR EIDOLON_CHAT_SECRET is shorter than 32 characters; the chat endpoint stays off",
    ]);
  });

  test("never comes from credentials.json", () => {
    delete process.env.EIDOLON_CHAT_SECRET;
    mkdirSync(dataHome(), { recursive: true });
    const path = join(dataHome(), "credentials.json");
    writeFileSync(path, JSON.stringify({ EIDOLON_CHAT_SECRET: SECRET }), { mode: 0o600 });
    try {
      installSettings();
      expect(envOptional("EIDOLON_CHAT_SECRET")).toBeUndefined();
      expect(chatSecretFromEnv()).toBeNull();
      expect(logs.lines()).toEqual([
        `WARNING Ignoring EIDOLON_CHAT_SECRET in ${path}: not a credential`,
      ]);
    } finally {
      rmSync(path, { force: true });
      resetSettings();
    }
  });
});
