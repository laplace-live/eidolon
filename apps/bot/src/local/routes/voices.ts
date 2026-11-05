// GET /api/local/voices/search: Fish Audio's public voice library. Searched without the key, so a
// search never spends one of the account's TTS slots during a call; covers and samples come back as
// absolute https URLs.
import { isPlainObject } from "@eidolon/config";
import type { Voice, VoiceSample, VoiceSearchResponse } from "../api.ts";
import { localError, localJson } from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";

const SEARCH_URL = "https://api.fish.audio/model";
const COVER_BASE = "https://public-platform.r2.fish.audio/";
export const PAGE_SIZE = 20;
/** Fish answers nothing past the 1000th result. */
const MAX_OFFSET = 1000;
const LANGUAGES = new Set(["zh", "en", "ja"]);
const QUERY_MAX_CHARS = 100;
const TIMEOUT_MS = 10_000;

const VOICE_ID = /^[0-9a-f]{32}$/;
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
  };
}

export interface VoicesDeps {
  readonly fetch: typeof fetch;
}

export function voicesRoutes(_app: LocalApp, deps: VoicesDeps = { fetch }): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/voices/search",
      async handler(_request, { url }) {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q.length > QUERY_MAX_CHARS || /\p{Cc}/u.test(q)) {
          return localError(400, "bad-request", "A search is one short line of text");
        }
        const language = url.searchParams.get("language") ?? "";
        if (language !== "" && !LANGUAGES.has(language)) {
          return localError(400, "bad-request", "The language is zh, en or ja");
        }
        const rawPage = url.searchParams.get("page") ?? "1";
        const page = /^\d{1,4}$/.test(rawPage) ? Number(rawPage) : 0;
        if (page < 1 || (page - 1) * PAGE_SIZE >= MAX_OFFSET) {
          return localError(400, "bad-request", "The page is out of range");
        }

        const search = new URL(SEARCH_URL);
        search.searchParams.set("page_size", String(PAGE_SIZE));
        search.searchParams.set("page_number", String(page));
        if (q !== "") search.searchParams.set("title", q);
        if (language !== "") search.searchParams.set("language", language);
        let response: Response;
        try {
          // No Authorization: the public library needs none.
          response = await deps.fetch(search, {
            redirect: "manual",
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch {
          return localError(503, "unavailable", "Fish Audio didn't answer");
        }
        if (response.status !== 200) {
          return localError(502, "upstream-failed", `Fish Audio answered ${response.status}`);
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return localError(502, "upstream-failed", "Fish Audio's answer wasn't JSON");
        }
        if (!isPlainObject(body)) {
          return localError(502, "upstream-failed", "Fish Audio's answer had no results");
        }
        const items = (Array.isArray(body.items) ? body.items : [])
          .map(voiceOf)
          .filter((voice): voice is Voice => voice !== null);
        const result: VoiceSearchResponse = {
          total: count(body.total),
          totalIsExact: body.total_is_exact !== false,
          hasMore: body.has_more === true && page * PAGE_SIZE < MAX_OFFSET,
          items,
        };
        return localJson(200, result);
      },
    },
  ];
}
