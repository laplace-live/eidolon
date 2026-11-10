// The production chat's signatures: an HMAC-SHA256 over @eidolon/chat's canonicalForSig, keyed by
// EIDOLON_CHAT_SECRET, which only the server holds, so the browser that keeps a chat can't put
// words in a persona's mouth or move her lines to another chat.
import { type ChatEvent, canonicalForSig } from "@eidolon/chat";
import { envVariable, isJsonObject, logger } from "@eidolon/config";

/** Shorter, and one signed event would let anyone guess the secret offline. */
export const MIN_CHAT_SECRET_LENGTH = 32;

/**
 * EIDOLON_CHAT_SECRET from the environment alone: settings.yaml and credentials.json never carry
 * it. Null while it is unset, or too short to key the HMAC, which logs why.
 */
export function chatSecretFromEnv(): string | null {
  const secret = envVariable("EIDOLON_CHAT_SECRET");
  if (secret === undefined) return null;
  if (secret.length < MIN_CHAT_SECRET_LENGTH) {
    logger.error(
      `EIDOLON_CHAT_SECRET is shorter than ${MIN_CHAT_SECRET_LENGTH} characters; ` +
        "the chat endpoint stays off",
    );
    return null;
  }
  return secret;
}

/**
 * The viewer's own: their messages, and the title, participants, settings and call marks their
 * browser writes. These are never signed; everything else in a chat is the server's, and is.
 */
export function fromViewer(event: {
  readonly type?: unknown;
  readonly speaker?: unknown;
}): boolean {
  if (event.type === "message") return isJsonObject(event.speaker) && event.speaker.kind === "user";
  return VIEWERS_TYPES.has(event.type);
}

// A call's ends are the browser's: the server can't sign call-ended once the call's peer is gone.
const VIEWERS_TYPES = new Set<unknown>([
  "title",
  "participants",
  "settings",
  "call-started",
  "call-ended",
]);

const encoder = new TextEncoder();
/** 32 bytes of base64url, unpadded. */
const SIG = /^[A-Za-z0-9_-]{43}$/;

export class ChatSigner {
  readonly #key: CryptoKey;

  private constructor(key: CryptoKey) {
    this.#key = key;
  }

  static async create(secret: string): Promise<ChatSigner> {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return new ChatSigner(key);
  }

  /** `event` with its `sig` in chat `chatId`, replacing any it had. */
  async sign<E extends ChatEvent>(chatId: string, event: E): Promise<E> {
    const mac = await crypto.subtle.sign(
      "HMAC",
      this.#key,
      encoder.encode(canonicalForSig(chatId, event)),
    );
    return { ...event, sig: Buffer.from(mac).toString("base64url") };
  }

  /** Whether `event`, as a browser sent it back, carries the `sig` this server gave it in `chatId`. */
  async verify(chatId: string, event: ChatEvent): Promise<boolean> {
    const { sig } = event;
    if (typeof sig !== "string" || !SIG.test(sig)) return false;
    return crypto.subtle.verify(
      "HMAC",
      this.#key,
      Buffer.from(sig, "base64url"),
      encoder.encode(canonicalForSig(chatId, event)),
    );
  }
}
