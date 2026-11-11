// The production chat's attachments, a persona's selfies and voice replies: kept in memory for
// SELFIE_TTL_SECONDS, as /api/selfie keeps a selfie, for the browser to download into its own store.
// A file is named by its content's hash, as the local store names it, so a name is unguessable
// without the bytes it serves: it needs no session of its own.
import { createHash } from "node:crypto";
import {
  type Attachment,
  attachmentExtension,
  attachmentKind,
  attachmentMime,
} from "@eidolon/chat";
import { envInt } from "@eidolon/config";

export const CHAT_FILES_PATH = "/api/chat/files";

/** take_selfie's default lifetime for SELFIE_TTL_SECONDS. */
const DEFAULT_TTL_SECONDS = 600;

/** `bytes` as an attachment of type `mime`, named `<sha256>.<ext>`; a type not taken throws. */
export function attachmentOf(bytes: Uint8Array, mime: string): Attachment {
  const ext = attachmentExtension(mime);
  if (ext === null) throw new TypeError(`A chat attachment can't be ${mime}`);
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
  const type = attachmentMime(name) as string;
  return attachmentKind(type) === "audio"
    ? { kind: "audio", name, mime: type }
    : { kind: "image", name, mime: type };
}

interface Entry {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly expiresAt: number;
}

export class ChatFiles {
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  /** `now` is monotonic seconds. */
  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => performance.now() / 1000);
  }

  /**
   * Keeps `bytes` for `ttlSeconds`, by default the SELFIE_TTL_SECONDS of the persona whose scope it
   * runs in. Expired files are swept here and on a lookup that finds them, nowhere else.
   */
  save(
    bytes: Uint8Array,
    mime: string,
    ttlSeconds = envInt("SELFIE_TTL_SECONDS", DEFAULT_TTL_SECONDS),
  ): Attachment {
    const attachment = attachmentOf(bytes, mime);
    const now = this.#now();
    for (const [name, entry] of this.#entries)
      if (entry.expiresAt <= now) this.#entries.delete(name);
    this.#entries.set(attachment.name, {
      bytes,
      mime: attachment.mime,
      expiresAt: now + ttlSeconds,
    });
    return attachment;
  }

  /** The file named `name`, or null when unknown or expired. */
  lookup(name: string): { readonly bytes: Uint8Array; readonly mime: string } | null {
    const entry = this.#entries.get(name);
    if (entry === undefined || entry.expiresAt <= this.#now()) {
      this.#entries.delete(name);
      return null;
    }
    return entry;
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** The process's files, which every chat request saves into and `/api/chat/files` serves. */
export const chatFiles: ChatFiles = new ChatFiles();

/**
 * `GET /api/chat/files/:name`: the bytes, of their type and never sniffed, or the selfie route's
 * empty 404 once they are gone.
 */
export function chatFileResponse(name: string, files: ChatFiles): Response {
  const file = files.lookup(name);
  if (file === null) return new Response(null, { status: 404 });
  return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": file.mime,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // A name is its content's hash, so what it serves never changes.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
