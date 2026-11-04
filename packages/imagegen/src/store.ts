// A rendered selfie runs to ~1 MB, ~1.4 MB once base64'd, past what one SCTP data-channel message
// carries, so the bytes wait here and only a root-relative URL rides the RTVI message. The store is
// process-local: a second worker would 404 on the first one's ids.
import type { GeneratedImage } from "./generate.ts";
import { imageSuffix } from "./mime.ts";
import { pyPathStem } from "./pypath.ts";

export const SELFIE_PATH = "/api/selfie";
export const SELFIE_ID_BYTES = 16;

interface Entry {
  readonly image: GeneratedImage;
  readonly expiresAt: number;
}

/** `secrets.token_urlsafe(16)`: 22 characters of `[A-Za-z0-9_-]`. */
function newSelfieId(): string {
  return crypto
    .getRandomValues(new Uint8Array(SELFIE_ID_BYTES))
    .toBase64({ alphabet: "base64url", omitPadding: true });
}

/** Short-lived in-memory selfies served at `/api/selfie/<id><suffix>`. */
export class SelfieStore {
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #entries = new Map<string, Entry>();

  /** `now` is monotonic seconds. */
  constructor(options: { now?: () => number; newId?: () => string } = {}) {
    this.#now = options.now ?? (() => performance.now() / 1000);
    this.#newId = options.newId ?? newSelfieId;
  }

  /**
   * Stores `image` for `ttlSeconds` and returns its root-relative URL. Expired entries are swept
   * here and on a lookup that finds them, nowhere else.
   */
  publish(image: GeneratedImage, ttlSeconds: number): string {
    const now = this.#now();
    for (const [id, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(id);
    const id = this.#newId();
    this.#entries.set(id, { image, expiresAt: now + ttlSeconds });
    return `${SELFIE_PATH}/${id}${imageSuffix(image.mediaType)}`;
  }

  /** The image for a path segment (one extension stripped), or null when unknown or expired. */
  lookup(segment: string): GeneratedImage | null {
    const id = pyPathStem(segment);
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.expiresAt <= this.#now()) {
      this.#entries.delete(id);
      return null;
    }
    return entry.image;
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** The process-wide store the take_selfie tool publishes to and `/api/selfie` serves. */
export const selfieStore: SelfieStore = new SelfieStore();

/**
 * The `/api/selfie/:id` response for `segment`: the bytes with their media type, or a 404 with an
 * empty body and no content type. The id is the whole authorization: it is unguessable,
 * single-purpose, and expires, so the route needs no session of its own.
 */
export function selfieResponse(segment: string, store: SelfieStore = selfieStore): Response {
  const image = store.lookup(segment);
  if (image === null) return new Response(null, { status: 404 });
  return new Response(image.data as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": image.mediaType },
  });
}
