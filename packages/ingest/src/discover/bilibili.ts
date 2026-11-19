// Bilibili's web API, as the site's own pages call it without a login: a space's lists and their
// videos, a video's uploader, and the video and user searches. Without the homepage's buvid3
// cookie the lists and the searches answer -352 or HTTP 412, and without a search page's Referer
// the searches answer 412 too.
import { abortableSleep, isPlainObject } from "@eidolon/config";
import { type BilibiliList, spaceUrl } from "./channels.ts";

const HOME = "https://www.bilibili.com/";
const API = "https://api.bilibili.com";
const SEARCH_PAGE = "https://search.bilibili.com/all";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";
/** The least time between two requests, so a run never looks like a crawler. */
export const BILIBILI_PAUSE_MS = 300;
const TIMEOUT_MS = 20_000;
/** A list's pages read at most, 100 videos each. */
const MAX_LIST_PAGES = 50;
const LIST_PAGE_SIZE = 100;
/** A space's pages of lists read at most, 20 lists each. */
const MAX_SPACE_PAGES = 10;
const SPACE_PAGE_SIZE = 20;

export interface BilibiliVideo {
  readonly bvid: string;
  readonly title: string;
  readonly durationSec: number;
  /** Unix seconds. */
  readonly pubdate: number;
  /** The uploader's mid and name, where the answer carries them. */
  readonly mid?: string;
  readonly author?: string;
}

export interface NamedList extends BilibiliList {
  readonly name: string;
  readonly total: number;
}

export interface BilibiliUser {
  readonly mid: string;
  readonly name: string;
  readonly fans: number;
  readonly videos: number;
  /** official_verify's description, such as bilibili独家高能主播; empty for none. */
  readonly verified: string;
  /** The live room's id; 0 for none. */
  readonly liveRoom: number;
}

export interface BilibiliOptions {
  readonly fetch?: typeof fetch;
  /** BILIBILI_PAUSE_MS by default. */
  readonly pauseMs?: number;
  readonly signal?: AbortSignal;
}

type Json = Readonly<Record<string, unknown>>;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * `html`'s text outside its `<…>` tags, a `<` with no `>` after it kept as text. A scan, since
 * CodeQL flags a regex that strips tags (js/incomplete-multi-character-sanitization).
 */
function textOutsideTags(html: string): string {
  let text = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<", at);
    const close = open === -1 ? -1 : html.indexOf(">", open);
    if (close === -1) return text + html.slice(at);
    text += html.slice(at, open);
    at = close + 1;
  }
}

/** A search result's title as text: its `<em class="keyword">` marks gone, its entities read. */
export function cleanTitle(html: string): string {
  return textOutsideTags(html)
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number(name.slice(1));
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .trim();
}

/** A search result's duration, `M:S` or `H:M:S` (minutes past 59, seconds unpadded), in seconds. */
export function searchDuration(text: unknown): number {
  if (typeof text !== "string" || !/^\d+(?::\d+){1,2}$/.test(text)) return 0;
  return text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function archiveVideo(item: Json): BilibiliVideo | null {
  const bvid = text(item.bvid);
  if (bvid === "") return null;
  return {
    bvid,
    title: text(item.title),
    durationSec: count(item.duration),
    pubdate: count(item.pubdate),
  };
}

/** The buvid3 (and b_nut) cookies the homepage sets, as a Cookie header; empty when none came. */
function homeCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]?.trim() ?? "")
    .filter((pair) => /^(buvid3|b_nut)=/.test(pair))
    .join("; ");
}

export class BilibiliClient {
  readonly #fetch: typeof fetch;
  readonly #pauseMs: number;
  readonly #signal: AbortSignal | undefined;
  #cookie: Promise<string> | null = null;
  #last = 0;

  constructor(options: BilibiliOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#pauseMs = options.pauseMs ?? BILIBILI_PAUSE_MS;
    this.#signal = options.signal;
  }

  async #request(url: string, referer: string, cookie: string): Promise<Response> {
    const wait = this.#last + this.#pauseMs - Date.now();
    if (wait > 0) await abortableSleep(wait, this.#signal);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      return await this.#fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: referer,
          ...(cookie === "" ? {} : { Cookie: cookie }),
        },
        signal: this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout,
      });
    } finally {
      this.#last = Date.now();
    }
  }

  /** The homepage's cookies, fetched once; none when the homepage fails, so the API says why. */
  #cookies(): Promise<string> {
    this.#cookie ??= this.#request(HOME, HOME, "").then(
      async (response) => {
        await response.body?.cancel();
        return homeCookies(response);
      },
      (error: unknown) => {
        if (this.#signal?.aborted) throw error;
        return "";
      },
    );
    return this.#cookie;
  }

  /** `data` of the API's answer at `path`; throws for an HTTP failure or a `code`. */
  async #api(path: string, query: Record<string, string | number>, referer: string) {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const response = await this.#request(url.href, referer, await this.#cookies());
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} from ${url.pathname}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${url.pathname} didn't answer JSON`);
    }
    if (!isPlainObject(body)) throw new Error(`${url.pathname} didn't answer an object`);
    const code = typeof body.code === "number" ? body.code : Number.NaN;
    if (code !== 0) {
      const message = text(body.message);
      throw new Error(
        `${url.pathname} answered code ${Number.isNaN(code) ? "?" : code}` +
          (message !== "" && message !== String(code) ? ` (${message})` : ""),
      );
    }
    return isPlainObject(body.data) ? body.data : {};
  }

  /**
   * The series and seasons of space `mid`, with their names and totals, series first: as many
   * pages as its total of lists takes, 10 at most.
   */
  async spaceLists(mid: string): Promise<NamedList[]> {
    const series: NamedList[] = [];
    const seasons: NamedList[] = [];
    for (let page = 1; page <= MAX_SPACE_PAGES; page++) {
      const data = await this.#api(
        "/x/polymer/web-space/seasons_series_list",
        { mid, page_num: page, page_size: SPACE_PAGE_SIZE },
        spaceUrl(mid),
      );
      const lists = isPlainObject(data.items_lists) ? data.items_lists : {};
      const take = (into: NamedList[], key: string, type: NamedList["type"], idKey: string) => {
        const items = records(lists[key]);
        for (const item of items) {
          const meta = isPlainObject(item.meta) ? item.meta : {};
          const id = text(meta[idKey]);
          if (id !== "") into.push({ type, id, name: text(meta.name), total: count(meta.total) });
        }
        return items.length;
      };
      const onPage =
        take(series, "series_list", "series", "series_id") +
        take(seasons, "seasons_list", "season", "season_id");
      const total = isPlainObject(lists.page) ? count(lists.page.total) : 0;
      if (onPage < SPACE_PAGE_SIZE || page * SPACE_PAGE_SIZE >= total) break;
    }
    return [...series, ...seasons];
  }

  /** Every video of list `list` in space `mid`, as many pages as it takes, 50 at most. */
  async listVideos(mid: string, list: BilibiliList): Promise<BilibiliVideo[]> {
    const referer = spaceUrl(mid);
    const videos: BilibiliVideo[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const data =
        list.type === "series"
          ? await this.#api(
              "/x/series/archives",
              { mid, series_id: list.id, pn: page, ps: LIST_PAGE_SIZE, sort: "desc" },
              referer,
            )
          : await this.#api(
              "/x/polymer/web-space/seasons_archives_list",
              { mid, season_id: list.id, page_num: page, page_size: LIST_PAGE_SIZE },
              referer,
            );
      const archives = records(data.archives);
      for (const item of archives) {
        const video = archiveVideo(item);
        if (video !== null) videos.push(video);
      }
      const total = isPlainObject(data.page) ? count(data.page.total) : 0;
      if (archives.length < LIST_PAGE_SIZE || page * LIST_PAGE_SIZE >= total) break;
    }
    return videos;
  }

  /** Video `bvid`'s uploader. */
  async owner(bvid: string): Promise<{ readonly mid: string; readonly name: string }> {
    const data = await this.#api("/x/web-interface/view", { bvid }, HOME);
    const owner = isPlainObject(data.owner) ? data.owner : {};
    return { mid: text(owner.mid), name: text(owner.name) };
  }

  /**
   * Page `page` of the videos matching `keyword`, newest first, and how many pages there are;
   * `overAnHour`, only those longer than an hour.
   */
  async searchVideos(
    keyword: string,
    page: number,
    overAnHour = false,
  ): Promise<{ readonly videos: BilibiliVideo[]; readonly pages: number }> {
    const data = await this.#api(
      "/x/web-interface/search/type",
      {
        search_type: "video",
        keyword,
        page,
        order: "pubdate",
        // The search's duration filter: 4 is over 60 minutes.
        ...(overAnHour ? { duration: 4 } : {}),
      },
      SEARCH_PAGE,
    );
    const videos = records(data.result).flatMap((item): BilibiliVideo[] => {
      const bvid = text(item.bvid);
      if (bvid === "") return [];
      return [
        {
          bvid,
          title: cleanTitle(text(item.title)),
          durationSec: searchDuration(item.duration),
          pubdate: count(item.pubdate),
          mid: text(item.mid),
          author: text(item.author),
        },
      ];
    });
    return { videos, pages: count(data.numPages) };
  }

  /** The users matching `keyword`, as the search ranks them. */
  async searchUsers(keyword: string): Promise<BilibiliUser[]> {
    const data = await this.#api(
      "/x/web-interface/search/type",
      { search_type: "bili_user", keyword, page: 1 },
      SEARCH_PAGE,
    );
    return records(data.result).flatMap((item): BilibiliUser[] => {
      const mid = text(item.mid);
      if (mid === "") return [];
      const verify = isPlainObject(item.official_verify) ? item.official_verify : {};
      return [
        {
          mid,
          name: cleanTitle(text(item.uname)),
          fans: count(item.fans),
          videos: count(item.videos),
          verified: text(verify.desc),
          liveRoom: count(item.room_id),
        },
      ];
    });
  }
}
