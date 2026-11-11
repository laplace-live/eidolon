// The local chat store, one folder per chat under `root`: chat.jsonl (the header line, then one
// event per line), meta.json (its ChatSummary and the log's length when written, rebuilt from the
// log whenever that length disagrees) and files/ (attachments, named by content). What it creates
// is private to this user: folders 0700, files 0600.
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Attachment,
  attachmentExtension,
  attachmentKind,
  attachmentMime,
  CHAT_FORMAT,
  type ChatEvent,
  type ChatHeader,
  type ChatStore,
  ChatStoreError,
  type ChatSummary,
  isChatId,
} from "./format.ts";
import { advanceSummary, summarize } from "./summary.ts";

const LOG = "chat.jsonl";
const META = "meta.json";
const FILES = "files";

interface Meta extends ChatSummary {
  readonly logBytes: number;
}

/** A log as this store last read or wrote it whole. */
interface Known {
  /** Its length up to the end of its last whole line. */
  readonly size: number;
  readonly summary: ChatSummary;
}

interface Parsed {
  readonly header: ChatHeader;
  readonly events: ChatEvent[];
  readonly size: number;
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function isHeader(value: unknown, id: string): value is ChatHeader {
  const header = value as Partial<ChatHeader> | null;
  return (
    typeof header === "object" &&
    header !== null &&
    header.format === CHAT_FORMAT &&
    header.id === id &&
    typeof header.createdAt === "number" &&
    Array.isArray(header.participants)
  );
}

function isMeta(value: unknown, id: string): value is Meta {
  const meta = value as Partial<Meta> | null;
  return (
    typeof meta === "object" &&
    meta !== null &&
    meta.id === id &&
    (meta.title === null || typeof meta.title === "string") &&
    Array.isArray(meta.participants) &&
    typeof meta.createdAt === "number" &&
    typeof meta.updatedAt === "number" &&
    (meta.lastText === null || typeof meta.lastText === "string") &&
    typeof meta.lastSeq === "number" &&
    typeof meta.logBytes === "number"
  );
}

/**
 * The log in `bytes`, without a torn last line: one with no newline after it, or whose JSON
 * doesn't parse, as a crash mid-append leaves.
 */
function parseLog(bytes: Buffer, id: string, path: string): Parsed {
  let size = bytes.lastIndexOf(0x0a) + 1;
  const lines = bytes.subarray(0, size).toString("utf8").split("\n");
  lines.pop();
  const values: unknown[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line));
    } catch {
      if (i < lines.length - 1) throw new Error(`${path}: line ${i + 1} is not JSON`);
      size -= Buffer.byteLength(line) + 1;
    }
  }
  const [header, ...events] = values;
  if (!isHeader(header, id)) throw new Error(`${path}: no chat header for ${id}`);
  return { header, events: events as ChatEvent[], size };
}

function checkSeqs(lastSeq: number, events: readonly ChatEvent[]): void {
  for (const [i, event] of events.entries()) {
    if (event.seq !== lastSeq + 1 + i) {
      throw new ChatStoreError(
        "seq-gap",
        `Event seq ${event.seq} doesn't follow ${lastSeq + i}: the log stays as it was`,
      );
    }
  }
}

export interface JsonlChatStoreOptions {
  /** Where a repaired log is reported; console.warn by default. */
  readonly log?: (message: string) => void;
}

/**
 * Chats as append-only JSONL under `root`. One process writes them: every operation on a chat
 * waits for the one before it.
 */
export class JsonlChatStore implements ChatStore {
  readonly root: string;
  readonly #log: (message: string) => void;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #known = new Map<string, Known>();
  /** The torn tails already reported, as `<id>:<log length>`. */
  readonly #reported = new Set<string>();

  constructor(root: string, options: JsonlChatStoreOptions = {}) {
    this.root = root;
    this.#log = options.log ?? ((message) => console.warn(message));
  }

  async list(): Promise<ChatSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const summaries = await Promise.all(
      names.filter(isChatId).map((id) =>
        this.summary(id).catch((e: unknown) => {
          this.#log(`Chat ${id} skipped: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }),
      ),
    );
    return summaries
      .filter((summary): summary is ChatSummary => summary !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  /** Chat `id`'s summary, without reading its log while meta.json still matches it. */
  summary(id: string): Promise<ChatSummary> {
    this.#check(id);
    return this.#serial(id, () => this.#summary(id));
  }

  async create(header: ChatHeader): Promise<void> {
    this.#check(header.id);
    if (!isHeader(header, header.id)) {
      throw new ChatStoreError("invalid", `Not a format ${CHAT_FORMAT} chat header`);
    }
    return this.#serial(header.id, async () => {
      const dir = this.#dir(header.id);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (e) {
        if ((e as { code?: unknown }).code === "EEXIST") {
          throw new ChatStoreError("exists", `Chat ${header.id} exists`);
        }
        throw e;
      }
      const line = `${JSON.stringify(header)}\n`;
      const handle = await open(join(dir, LOG), "wx", 0o600);
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const summary = summarize(header, []);
      const size = Buffer.byteLength(line);
      this.#known.set(header.id, { size, summary });
      await this.#writeMeta(header.id, summary, size);
    });
  }

  async read(
    id: string,
    options: { readonly afterSeq?: number } = {},
  ): Promise<{ header: ChatHeader; events: ChatEvent[] }> {
    this.#check(id);
    return this.#serial(id, async () => {
      const { header, events } = await this.#parse(id);
      const after = options.afterSeq ?? 0;
      return { header, events: after > 0 ? events.filter((event) => event.seq > after) : events };
    });
  }

  async append(id: string, events: readonly ChatEvent[]): Promise<void> {
    this.#check(id);
    return this.#serial(id, async () => {
      const path = join(this.#dir(id), LOG);
      const size = await this.#size(id);
      let known = this.#known.get(id);
      if (known?.size !== size) {
        const parsed = await this.#parse(id);
        known = { size: parsed.size, summary: summarize(parsed.header, parsed.events) };
      }
      if (events.length === 0) return;
      checkSeqs(known.summary.lastSeq, events);
      const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
      const handle = await open(path, "a");
      try {
        if (size > known.size) await handle.truncate(known.size);
        await handle.appendFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const summary = advanceSummary(known.summary, events);
      const written = known.size + Buffer.byteLength(text);
      this.#known.set(id, { size: written, summary });
      await this.#writeMeta(id, summary, written);
    });
  }

  async remove(id: string): Promise<void> {
    this.#check(id);
    return this.#serial(id, async () => {
      this.#known.delete(id);
      try {
        await rm(this.#dir(id), { recursive: true });
      } catch (e) {
        if (isNotFound(e)) throw new ChatStoreError("not-found", `No chat ${id}`);
        throw e;
      }
    });
  }

  /** Stores `bytes` in chat `id`'s files/, once per content, as an attachment of type `mime`. */
  async saveFile(id: string, bytes: Uint8Array, mime: string): Promise<Attachment> {
    this.#check(id);
    const ext = attachmentExtension(mime);
    if (ext === null) throw new ChatStoreError("invalid", `An attachment can't be ${mime}`);
    const name = `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
    const type = attachmentMime(name) as string;
    const kind = attachmentKind(type) === "audio" ? "audio" : "image";
    const attachment: Attachment = { kind, name, mime: type };
    return this.#serial(id, async () => {
      await this.#size(id);
      const dir = join(this.#dir(id), FILES);
      const path = join(dir, name);
      try {
        await stat(path);
        return attachment;
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, bytes, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return attachment;
    });
  }

  /** Where chat `id`'s attachment `name` is; throws `invalid` for a name no attachment has. */
  filePath(id: string, name: string): string {
    this.#check(id);
    if (attachmentMime(name) === null) {
      throw new ChatStoreError("invalid", `Not an attachment name: ${JSON.stringify(name)}`);
    }
    return join(this.#dir(id), FILES, name);
  }

  #check(id: string): void {
    if (!isChatId(id)) throw new ChatStoreError("invalid", `Not a chat id: ${JSON.stringify(id)}`);
  }

  #dir(id: string): string {
    return join(this.root, id);
  }

  #serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(id) ?? Promise.resolve()).then(task);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#queues.set(id, settled);
    void settled.then(() => {
      if (this.#queues.get(id) === settled) this.#queues.delete(id);
    });
    return result;
  }

  /** The log's length on disk; rejects with `not-found` when there is none. */
  async #size(id: string): Promise<number> {
    try {
      return (await stat(join(this.#dir(id), LOG))).size;
    } catch (e) {
      if (isNotFound(e)) throw new ChatStoreError("not-found", `No chat ${id}`);
      throw e;
    }
  }

  async #parse(id: string): Promise<Parsed> {
    const path = join(this.#dir(id), LOG);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (e) {
      if (isNotFound(e)) throw new ChatStoreError("not-found", `No chat ${id}`);
      throw e;
    }
    const parsed = parseLog(bytes, id, path);
    const torn = bytes.length - parsed.size;
    const key = `${id}:${bytes.length}`;
    if (torn > 0 && !this.#reported.has(key)) {
      this.#reported.add(key);
      this.#log(`Chat ${id}: dropping a torn last line (${torn} bytes) from ${LOG}`);
    }
    this.#known.set(id, { size: parsed.size, summary: summarize(parsed.header, parsed.events) });
    return parsed;
  }

  async #summary(id: string): Promise<ChatSummary> {
    const size = await this.#size(id);
    const known = this.#known.get(id);
    if (known?.size === size) return known.summary;
    let meta: unknown = null;
    try {
      meta = JSON.parse(await readFile(join(this.#dir(id), META), "utf8"));
    } catch {}
    if (isMeta(meta, id) && meta.logBytes === size) {
      const { logBytes: _, ...summary } = meta;
      this.#known.set(id, { size, summary });
      return summary;
    }
    await this.#parse(id);
    const rebuilt = this.#known.get(id) as Known;
    await this.#writeMeta(id, rebuilt.summary, rebuilt.size);
    return rebuilt.summary;
  }

  /** Derived, so a failure only costs a rebuild later: the log is already written. */
  async #writeMeta(id: string, summary: ChatSummary, logBytes: number): Promise<void> {
    const path = join(this.#dir(id), META);
    try {
      await writeFile(`${path}.tmp`, JSON.stringify({ ...summary, logBytes } satisfies Meta), {
        mode: 0o600,
      });
      await rename(`${path}.tmp`, path);
    } catch (e) {
      this.#log(`Chat ${id}: ${META} not written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
