// A persona's official channels: the URLs naming them, as `--channel` gives them and her batches'
// `# Source:` lines remember them, and the video ids that tell a YouTube video's URLs apart.
import { readFileSync } from "node:fs";
import { BV_ID, batchLists, listKey } from "../download/batches.ts";

/** A Bilibili space's list: a 系列 (series) or a 合集 (season). */
export interface BilibiliList {
  readonly type: "series" | "season";
  readonly id: string;
}

export type Channel =
  | {
      readonly site: "bilibili";
      /** Normalized: the space, or the list in it. */
      readonly url: string;
      readonly mid: string;
      /** The list the URL names; null for the space as a whole. */
      readonly list: BilibiliList | null;
    }
  | {
      readonly site: "youtube";
      /** Normalized: the channel's own page, whose /streams tab lists her past live streams. */
      readonly url: string;
      /** How the URL names the channel: `@handle`, or the channel id. */
      readonly name: string;
    };

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const DIGITS = /^\d{1,20}$/;

function parsed(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Space `mid`'s page. */
export function spaceUrl(mid: string): string {
  return `https://space.bilibili.com/${mid}`;
}

/**
 * List `list` of space `mid` as the space links it, the form a channel is printed and remembered
 * in: `https://space.bilibili.com/2132180406/lists/2484684?type=series`, 明前奶绿's 直播回放.
 */
export function listUrl(mid: string, list: BilibiliList): string {
  return `${spaceUrl(mid)}/lists/${list.id}?type=${list.type}`;
}

function bilibiliChannel(url: URL): Channel | null {
  const [mid, tab, id] = url.pathname.split("/").filter(Boolean);
  if (mid === undefined || !DIGITS.test(mid)) return null;
  let list: BilibiliList | null = null;
  if (tab === "lists" && id !== undefined && DIGITS.test(id)) {
    list = { type: url.searchParams.get("type") === "series" ? "series" : "season", id };
  } else if (tab === "channel" && (id === "seriesdetail" || id === "collectiondetail")) {
    const sid = url.searchParams.get("sid") ?? "";
    if (!DIGITS.test(sid)) return null;
    list = { type: id === "seriesdetail" ? "series" : "season", id: sid };
  }
  return {
    site: "bilibili",
    url: list === null ? spaceUrl(mid) : listUrl(mid, list),
    mid,
    list,
  };
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function youtubeChannel(url: URL): Channel | null {
  const [first, second] = url.pathname.split("/").filter(Boolean);
  if (first === undefined) return null;
  let path: string;
  let name: string;
  if (first.startsWith("@") && first.length > 1) {
    path = first;
    name = decoded(first);
  } else if ((first === "channel" || first === "c" || first === "user") && second !== undefined) {
    path = `${first}/${second}`;
    name = decoded(second);
  } else {
    return null;
  }
  return { site: "youtube", url: `https://www.youtube.com/${path}`, name };
}

/**
 * The official channel `text` names: a Bilibili space (any tab of it) or one of its lists
 * (`/lists/<id>?type=series|season`, or the older `/channel/seriesdetail?sid=` and
 * `/channel/collectiondetail?sid=`), or a YouTube channel (`/@handle`, `/channel/<id>`, `/c/…`,
 * `/user/…`, any tab of it); null for anything else.
 */
export function parseChannel(text: string): Channel | null {
  const url = parsed(text);
  if (url === null) return null;
  const host = url.hostname.toLowerCase();
  if (host === "space.bilibili.com") return bilibiliChannel(url);
  if (YOUTUBE_HOSTS.has(host)) return youtubeChannel(url);
  return null;
}

/** The values of the `# Source:` lines of the batches under `listsDir`, oldest batch first. */
export function batchSources(listsDir: string): string[] {
  const sources: string[] = [];
  for (const path of batchLists(listsDir)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^#\s*Source:\s*(.+?)\s*$/.exec(line);
      if (match !== null) sources.push(match[1] as string);
    }
  }
  return sources;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The id of the YouTube video `text` links to (watch?v=, youtu.be/, /live/, /shorts/); else null. */
export function youtubeVideoId(text: string): string | null {
  const url = parsed(text);
  if (url === null) return null;
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host) || host === "music.youtube.com") {
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (first === "watch") id = url.searchParams.get("v");
    else if (first === "live" || first === "shorts" || first === "embed") id = second ?? null;
  }
  return id !== null && VIDEO_ID.test(id) ? id : null;
}

/** A YouTube video's URL as a batch lists it. */
export function youtubeVideoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * The video `text` names, as discover keys it: a BV id, from itself or its video URL, or a YouTube
 * video's URL; null for anything else.
 */
export function videoKey(text: string): string | null {
  const trimmed = text.trim();
  const youtube = youtubeVideoId(trimmed);
  if (youtube !== null) return youtubeVideoUrl(youtube);
  const key = listKey(trimmed);
  return key !== null && BV_ID.test(key) ? key : null;
}
