// Fish Audio's voices for the picker. GET voices/search is the public library, searched without the
// key, so a search never spends one of the account's TTS slots during a call; GET accounts/:id/voices
// is a Fish account's own, private ones included, which only its key lists. Covers and samples come
// back as absolute https URLs.
import { isAccountId, isPlainObject, logger } from "@eidolon/config";
import { accountOf } from "@eidolon/providers";
import {
  type AccountVoicesResponse,
  VOICE_VISIBILITIES,
  type Voice,
  type VoiceSample,
  type VoiceSearchResponse,
  type VoiceVisibility,
} from "../api.ts";
import { ask } from "../checks.ts";
import { localError, localFailure, localJson } from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";

const SEARCH_URL = "https://api.fish.audio/model";
const COVER_BASE = "https://public-platform.r2.fish.audio/";
export const PAGE_SIZE = 20;
/** Fish answers nothing past the 1000th result of a public search. */
const MAX_OFFSET = 1000;
/** Nor past the 10,000th of an account's own voices. */
const OWN_MAX_OFFSET = 10_000;
const LANGUAGES = new Set(["zh", "en", "ja"]);
const VISIBILITIES: ReadonlySet<string> = new Set(VOICE_VISIBILITIES);
const QUERY_MAX_CHARS = 100;

/** A Fish voice id. */
export const VOICE_ID = /^[0-9a-f]{32}$/;
// A relative key such as coverimage/<id>.
const COVER_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function coverUrl(key: unknown): string | null {
  return typeof key === "string" && COVER_KEY.test(key) && !key.includes("..")
    ? `${COVER_BASE}${key}`
    : null;
}

/** One search result as the picker shows it; null for one no call could use. */
export function voiceOf(item: unknown): Voice | null {
  if (!isPlainObject(item) || typeof item._id !== "string" || !VOICE_ID.test(item._id)) {
    return null;
  }
  if ((typeof item.type === "string" && item.type !== "tts") || item.dmca_taken_down === true) {
    return null;
  }
  const samples: VoiceSample[] = [];
  for (const sample of Array.isArray(item.samples) ? item.samples : []) {
    const audioUrl = httpsUrl(isPlainObject(sample) ? sample.audio : null);
    if (isPlainObject(sample) && audioUrl !== null) {
      samples.push({ title: str(sample.title), text: str(sample.text), audioUrl });
    }
  }
  const visibility = str(item.visibility);
  const created = str(item.created_at);
  return {
    id: item._id,
    title: str(item.title),
    description: str(item.description),
    coverUrl: coverUrl(item.cover_image),
    languages: strings(item.languages),
    tags: strings(item.tags),
    samples,
    author: isPlainObject(item.author) ? str(item.author.nickname) : "",
    likeCount: count(item.like_count),
    taskCount: count(item.task_count),
    visibility: VISIBILITIES.has(visibility) ? (visibility as VoiceVisibility) : "public",
    createdAt: Number.isNaN(Date.parse(created)) ? null : created,
  };
}

/** A search Fish failed: 503 for no answer, else 502, with what Fish sent in the log. */
function searchFailed(status: 502 | 503, detail: string): Response {
  const unanswered = status === 503;
  return localFailure(
    status,
    unanswered ? "unavailable" : "upstream-failed",
    unanswered ? "Fish Audio didn't answer" : "Fish Audio failed the search",
    (id) => logger.warning(`[voices] A voice search failed (error ${id}): ${detail}`),
  );
}

interface Listing {
  readonly q: string;
  readonly page: number;
  /** Whether it is the last page Fish answers. */
  readonly last: boolean;
}

/** The search text and page a request asks for, or the 400 for ones Fish can't be sent. */
function listingOf(url: URL, maxOffset: number): Listing | Response {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length > QUERY_MAX_CHARS || /\p{Cc}/u.test(q)) {
    return localError(400, "bad-request", "A search is one short line of text");
  }
  const rawPage = url.searchParams.get("page") ?? "1";
  const page = /^\d{1,4}$/.test(rawPage) ? Number(rawPage) : 0;
  if (page < 1 || (page - 1) * PAGE_SIZE >= maxOffset) {
    return localError(400, "bad-request", "The page is out of range");
  }
  return { q, page, last: page * PAGE_SIZE >= maxOffset };
}

/** Fish's model list for `listing`, with `filters` added; an empty value is left out. */
function modelsUrl({ q, page }: Listing, filters: Readonly<Record<string, string>>): string {
  const search = new URL(SEARCH_URL);
  const params = { page_size: String(PAGE_SIZE), page_number: String(page), title: q, ...filters };
  for (const [name, value] of Object.entries(params)) {
    if (value !== "") search.searchParams.set(name, value);
  }
  return search.href;
}

/** Fish's answer as a page of voices, or the failure it is. */
function pageOf(
  { status, body }: { readonly status: number; readonly body: unknown },
  listing: Listing,
): VoiceSearchResponse | Response {
  if (status === 0) return searchFailed(503, "no answer");
  if (status !== 200) return searchFailed(502, `HTTP ${status}`);
  if (body === null) return searchFailed(502, "an answer that isn't JSON");
  if (!isPlainObject(body)) return searchFailed(502, "an answer without results");
  const items = (Array.isArray(body.items) ? body.items : [])
    .map(voiceOf)
    .filter((voice): voice is Voice => voice !== null);
  return {
    total: count(body.total),
    totalIsExact: body.total_is_exact !== false,
    hasMore: body.has_more === true && !listing.last,
    items,
  };
}

function noVoices(status: "no-key" | "refused"): Response {
  return localJson(200, {
    status,
    total: 0,
    totalIsExact: true,
    hasMore: false,
    items: [],
  } satisfies AccountVoicesResponse);
}

export interface VoicesDeps {
  readonly fetch: typeof fetch;
}

export function voicesRoutes(_app: LocalApp, deps: VoicesDeps = { fetch }): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/voices/search",
      async handler(_request, { url }) {
        const listing = listingOf(url, MAX_OFFSET);
        if (listing instanceof Response) return listing;
        const language = url.searchParams.get("language") ?? "";
        if (language !== "" && !LANGUAGES.has(language)) {
          return localError(400, "bad-request", "The language is zh, en or ja");
        }
        // No key: the public library needs none.
        const answer = await ask(deps, modelsUrl(listing, { language }));
        const result = pageOf(answer, listing);
        return result instanceof Response ? result : localJson(200, result);
      },
    },
    {
      route: "GET /api/local/accounts/:id/voices",
      async handler(_request, { params, url }) {
        const id = params.id as string;
        const account = isAccountId(id) ? accountOf(id) : undefined;
        if (account === undefined) return localError(404, "unknown-account", "No such account");
        if (account.provider.id !== "fish") {
          return localError(400, "bad-request", "Only a Fish Audio account has voices of its own");
        }
        const listing = listingOf(url, OWN_MAX_OFFSET);
        if (listing instanceof Response) return listing;
        const visibility = url.searchParams.get("visibility") ?? "";
        if (visibility !== "" && !VISIBILITIES.has(visibility)) {
          return localError(400, "bad-request", "The visibility is public, unlist or private");
        }
        if (account.apiKey === undefined) return noVoices("no-key");
        const filters = { self: "true", sort_by: "created_at", visibility };
        const answer = await ask(deps, modelsUrl(listing, filters), { key: account.apiKey });
        if (answer.status === 401) return noVoices("refused");
        const result = pageOf(answer, listing);
        if (result instanceof Response) return result;
        return localJson(200, { status: "ok", ...result } satisfies AccountVoicesResponse);
      },
    },
  ];
}
