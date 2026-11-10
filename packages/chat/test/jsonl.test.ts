import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatStoreContract } from "../src/contract.ts";
import { CHAT_FORMAT, type ChatEvent, type ChatHeader } from "../src/index.ts";
import { JsonlChatStore } from "../src/jsonl.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eidolon-chats-"));
  roots.push(root);
  return join(root, "chats");
}

function quietStore(root: string, log: string[] = []): JsonlChatStore {
  return new JsonlChatStore(root, { log: (message) => log.push(message) });
}

runChatStoreContract({ describe, test, expect }, async () => quietStore(await freshRoot()), {
  tearLastLine: (id, store) => appendFile(join(store.root, id, "chat.jsonl"), '{"seq":3,"at":10'),
});

function header(createdAt = 1000): ChatHeader {
  return {
    format: CHAT_FORMAT,
    id: Bun.randomUUIDv7(),
    createdAt,
    participants: ["milky-green"],
  };
}

function said(seq: number, text: string): ChatEvent {
  return { seq, at: 1000 + seq, type: "message", id: `m${seq}`, speaker: { kind: "user" }, text };
}

async function code(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return "resolved";
  } catch (e) {
    return (e as { code?: unknown }).code ?? e;
  }
}

async function chatWith(events: ChatEvent[]): Promise<{
  root: string;
  chat: ChatHeader;
  log: string;
}> {
  const root = await freshRoot();
  const chat = header();
  const store = quietStore(root);
  await store.create(chat);
  await store.append(chat.id, events);
  return { root, chat, log: join(root, chat.id, "chat.jsonl") };
}

describe("JsonlChatStore's files", () => {
  test("chat.jsonl is the header then one event per line; meta.json its summary", async () => {
    const events = [said(1, "第一行\n第二行"), said(2, "two")];
    const { root, chat, log } = await chatWith(events);
    const text = await readFile(log, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([chat, ...events]);
    const meta = JSON.parse(await readFile(join(root, chat.id, "meta.json"), "utf8"));
    expect(meta).toEqual({
      id: chat.id,
      title: null,
      participants: ["milky-green"],
      createdAt: 1000,
      updatedAt: 1002,
      lastText: "two",
      lastSeq: 2,
      logBytes: (await stat(log)).size,
    });
    expect((await readdir(join(root, chat.id))).sort()).toEqual(["chat.jsonl", "meta.json"]);
  });

  test("a new store over the same folder sees the same chats", async () => {
    const { root, chat } = await chatWith([said(1, "hello")]);
    const before = await quietStore(root).list();
    const again = quietStore(root);
    expect(await again.list()).toEqual(before);
    expect((await again.read(chat.id)).events).toEqual([said(1, "hello")]);
    await again.append(chat.id, [said(2, "after a restart")]);
    expect((await quietStore(root).read(chat.id)).events.map((event) => event.seq)).toEqual([1, 2]);
  });

  test("meta.json is rebuilt when missing, unparsable or behind the log", async () => {
    const { root, chat } = await chatWith([said(1, "one")]);
    const meta = join(root, chat.id, "meta.json");
    const stale = await readFile(meta, "utf8");
    await quietStore(root).append(chat.id, [said(2, "two")]);
    const expected = await quietStore(root).list();
    expect(expected[0]?.lastSeq).toBe(2);
    for (const broken of [null, "{not json", stale, JSON.stringify({ id: chat.id })]) {
      if (broken === null) await rm(meta);
      else await writeFile(meta, broken);
      expect(await quietStore(root).list()).toEqual(expected);
      expect(JSON.parse(await readFile(meta, "utf8")).lastSeq).toBe(2);
    }
  });

  test("a torn last line is dropped once reported, then truncated by the next append", async () => {
    for (const torn of ['{"seq":2,"at":1', '{"seq":2,"at":1002,"type":"title","title":"x"}']) {
      const { root, chat, log } = await chatWith([said(1, "one")]);
      const whole = await readFile(log, "utf8");
      await appendFile(log, torn);
      const reports: string[] = [];
      const store = quietStore(root, reports);
      expect((await store.read(chat.id)).events).toEqual([said(1, "one")]);
      expect((await store.read(chat.id)).events).toEqual([said(1, "one")]);
      expect((await store.list())[0]?.lastSeq).toBe(1);
      expect(reports).toEqual([
        `Chat ${chat.id}: dropping a torn last line (${Buffer.byteLength(torn)} bytes) from chat.jsonl`,
      ]);
      await store.append(chat.id, [said(2, "two")]);
      expect(await readFile(log, "utf8")).toBe(`${whole}${JSON.stringify(said(2, "two"))}\n`);
      expect(reports.length).toBe(1);
    }
  });

  test("an unparsable last line that ends in a newline is torn too", async () => {
    const { root, chat, log } = await chatWith([said(1, "one")]);
    await appendFile(log, '{"seq":2,\n');
    const store = quietStore(root);
    expect((await store.read(chat.id)).events).toEqual([said(1, "one")]);
    await store.append(chat.id, [said(2, "two")]);
    expect((await quietStore(root).read(chat.id)).events).toEqual([said(1, "one"), said(2, "two")]);
  });

  test("a bad line before the last fails the read, and list skips the chat", async () => {
    const { root, chat, log } = await chatWith([said(1, "one")]);
    const other = header(5000);
    const store = quietStore(root);
    await store.create(other);
    await appendFile(log, `garbage\n${JSON.stringify(said(2, "two"))}\n`);
    const reports: string[] = [];
    const fresh = quietStore(root, reports);
    expect(String(await code(fresh.read(chat.id)))).toContain("line 3 is not JSON");
    expect((await fresh.list()).map((summary) => summary.id)).toEqual([other.id]);
    expect(reports.some((report) => report.startsWith(`Chat ${chat.id} skipped:`))).toBe(true);
  });

  test("list ignores entries that aren't chats", async () => {
    const { root, chat } = await chatWith([]);
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "README"), "hi");
    await mkdir(join(root, Bun.randomUUIDv7()));
    const reports: string[] = [];
    expect((await quietStore(root, reports).list()).map((summary) => summary.id)).toEqual([
      chat.id,
    ]);
    expect(reports.length).toBe(1);
  });

  test("an empty root, or none, lists nothing", async () => {
    expect(await quietStore(await freshRoot()).list()).toEqual([]);
  });

  test("remove deletes only that chat's folder", async () => {
    const { root, chat } = await chatWith([said(1, "one")]);
    const kept = header(2000);
    await quietStore(root).create(kept);
    await writeFile(join(root, "README"), "hi");
    await quietStore(root).remove(chat.id);
    expect((await readdir(root)).sort()).toEqual(["README", kept.id].sort());
  });

  test("what it makes is private to this user", async () => {
    const { root, chat } = await chatWith([said(1, "one")]);
    const store = quietStore(root);
    const file = await store.saveFile(chat.id, new Uint8Array([1, 2]), "image/png");
    const dir = join(root, chat.id);
    const modes = await Promise.all(
      [root, dir, join(dir, "files")].map(async (path) => (await stat(path)).mode & 0o777),
    );
    const files = await Promise.all(
      ["chat.jsonl", "meta.json", `files/${file.name}`].map(
        async (name) => (await stat(join(dir, name))).mode & 0o777,
      ),
    );
    expect([modes, files]).toEqual([
      [0o700, 0o700, 0o700],
      [0o600, 0o600, 0o600],
    ]);
  });
});

describe("JsonlChatStore's validation", () => {
  test("ids must be lowercase UUIDs before they reach the disk", async () => {
    const root = await freshRoot();
    const store = quietStore(root);
    const upper = Bun.randomUUIDv7().toUpperCase();
    for (const id of ["../escape", "", "chat", upper, `${Bun.randomUUIDv7()}/x`]) {
      expect(await code(store.read(id))).toBe("invalid");
      expect(await code(store.append(id, []))).toBe("invalid");
      expect(await code(store.remove(id))).toBe("invalid");
      expect(await code(store.create({ ...header(), id }))).toBe("invalid");
      expect(await code(store.saveFile(id, new Uint8Array([1]), "image/png"))).toBe("invalid");
    }
    expect(await code(stat(root))).toBe("ENOENT");
  });

  test("a header of another format is refused", async () => {
    const store = quietStore(await freshRoot());
    const wrong = { ...header(), format: 2 } as unknown as ChatHeader;
    expect(await code(store.create(wrong))).toBe("invalid");
  });
});

describe("JsonlChatStore's attachments", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const sha = createHash("sha256").update(png).digest("hex");

  test("are stored once by content as <sha256>.<ext>", async () => {
    const { root, chat } = await chatWith([]);
    const store = quietStore(root);
    const first = await store.saveFile(chat.id, png, "image/png");
    expect(first).toEqual({ kind: "image", name: `${sha}.png`, mime: "image/png" });
    expect(await store.saveFile(chat.id, png, "IMAGE/PNG")).toEqual(first);
    expect(await readdir(join(root, chat.id, "files"))).toEqual([`${sha}.png`]);
    const path = store.filePath(chat.id, first.name);
    expect(path).toBe(join(root, chat.id, "files", `${sha}.png`));
    expect(new Uint8Array(await readFile(path))).toEqual(png);
    const jpeg = await store.saveFile(chat.id, png, "image/jpeg");
    expect(jpeg).toEqual({ kind: "image", name: `${sha}.jpg`, mime: "image/jpeg" });
  });

  test("audio is an audio attachment, with its length when given", async () => {
    const { root, chat } = await chatWith([]);
    const store = quietStore(root);
    expect(await store.saveFile(chat.id, png, "audio/webm;codecs=opus", 2500)).toEqual({
      kind: "audio",
      name: `${sha}.webm`,
      mime: "audio/webm",
      durationMs: 2500,
    });
    expect(await store.saveFile(chat.id, png, "audio/mpeg")).toEqual({
      kind: "audio",
      name: `${sha}.mp3`,
      mime: "audio/mpeg",
    });
    expect((await readdir(join(root, chat.id, "files"))).sort()).toEqual([
      `${sha}.mp3`,
      `${sha}.webm`,
    ]);
  });

  test("refuse a type that could run script, or an unknown chat", async () => {
    const { root, chat } = await chatWith([]);
    const store = quietStore(root);
    for (const mime of ["image/svg+xml", "text/html", "application/octet-stream"]) {
      expect(await code(store.saveFile(chat.id, png, mime))).toBe("invalid");
    }
    expect(await code(store.saveFile(Bun.randomUUIDv7(), png, "image/png"))).toBe("not-found");
    expect((await readdir(root)).sort()).toEqual([chat.id]);
  });

  test("filePath takes only attachment names", async () => {
    const store = quietStore(await freshRoot());
    const id = Bun.randomUUIDv7();
    for (const name of ["../meta.json", "chat.jsonl", `${sha}.svg`, `${sha}.PNG`, `x${sha}.png`]) {
      expect(await code(Promise.resolve().then(() => store.filePath(id, name)))).toBe("invalid");
    }
  });
});
