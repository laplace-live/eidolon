// The production chat's files: named by their content, typed as the local store types them, and
// gone after their lifetime.
import { afterEach, describe, expect, test } from "bun:test";
import { withPersona } from "@eidolon/config";
import { attachmentOf, ChatFiles, chatFileResponse } from "../../src/chat/files.ts";
import { MILKY } from "./harness.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_NAME = `${new Bun.CryptoHasher("sha256").update(PNG).digest("hex")}.png`;

afterEach(() => {
  delete process.env.SELFIE_TTL_SECONDS;
});

describe("attachmentOf", () => {
  test("names a file by its hash, with the type the local store gives it", () => {
    expect(attachmentOf(PNG, "image/png")).toEqual({
      kind: "image",
      name: PNG_NAME,
      mime: "image/png",
    });
    expect(attachmentOf(PNG, "Audio/WebM; codecs=opus")).toEqual({
      kind: "audio",
      name: PNG_NAME.replace(".png", ".webm"),
      mime: "audio/webm",
    });
  });

  test("refuses a type a chat doesn't take", () => {
    expect(() => attachmentOf(PNG, "image/svg+xml")).toThrow(TypeError);
    expect(() => attachmentOf(PNG, "video/webm")).toThrow(TypeError);
  });
});

describe("ChatFiles", () => {
  test("serves a file until its lifetime is over, then forgets it", () => {
    let now = 100;
    const files = new ChatFiles({ now: () => now });
    const saved = files.save(PNG, "image/png", 60);
    expect(files.lookup(saved.name)).toMatchObject({ bytes: PNG, mime: "image/png" });
    now = 159.9;
    expect(files.lookup(saved.name)?.bytes).toEqual(PNG);
    now = 160;
    expect(files.lookup(saved.name)).toBeNull();
    expect(files.size).toBe(0);
  });

  test("sweeps expired files when another is saved", () => {
    let now = 0;
    const files = new ChatFiles({ now: () => now });
    files.save(PNG, "image/png", 10);
    now = 20;
    files.save(new Uint8Array([1]), "audio/mpeg", 10);
    expect(files.size).toBe(1);
  });

  test("lasts the SELFIE_TTL_SECONDS of the persona it is saved for", () => {
    let now = 0;
    const files = new ChatFiles({ now: () => now });
    process.env.SELFIE_TTL_SECONDS = "30";
    const saved = withPersona(MILKY, () => files.save(PNG, "image/png"));
    now = 29;
    expect(files.lookup(saved.name)).not.toBeNull();
    now = 30;
    expect(files.lookup(saved.name)).toBeNull();
  });
});

describe("chatFileResponse", () => {
  test("serves the bytes as their own type, sandboxed and never sniffed", async () => {
    const files = new ChatFiles();
    const { name } = files.save(PNG, "image/png", 60);
    const response = chatFileResponse(name, files);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  test("answers a name it doesn't have as /api/selfie does: an empty 404", async () => {
    const response = chatFileResponse("../../etc/passwd", new ChatFiles());
    expect([response.status, response.headers.get("content-type"), await response.text()]).toEqual([
      404,
      null,
      "",
    ]);
  });
});
