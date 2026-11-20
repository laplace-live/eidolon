// What laplace-discover finds for a persona: her official channels' streams, others' full
// recordings of the days those miss, and clips, less what her lists hold already; saved, one new
// batch lists them, official first.
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { errorText, isPlainObject, logger, zonedClock } from "@eidolon/config";
import { addDays } from "@eidolon/retrieval";
import { knownIds, localIsoSeconds, writeBatch } from "../download/batches.ts";
import { type ExpandOptions, expandPlaylist } from "../download/playlist.ts";
import type { RunOptions } from "../progress.ts";
import { transcriptPaths } from "../streams.ts";
import {
  BilibiliClient,
  type BilibiliOptions,
  type BilibiliVideo,
  type NamedList,
} from "./bilibili.ts";
import {
  type BilibiliList,
  batchHeader,
  batchSources,
  type Channel,
  listUrl,
  parseChannel,
  spaceUrl,
  videoKey,
  youtubeVideoId,
  youtubeVideoUrl,
} from "./channels.ts";

/** The shortest full stream, in minutes, unless the caller names another. */
export const DEFAULT_MIN_MINUTES = 60;
/** Bilibili search pages read, 20 videos each, unless the caller names another count. */
export const DEFAULT_PAGES = 5;
/** A space's lists that hold its streams: Bilibili's own 直播回放 series, or a 录播 list. */
const REPLAY_LIST = /回放|录播/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Where an official channel came from: `--channel`, or a batch's `# Source:` line. */
type From = "argument" | "batch";

export interface DiscoverOptions {
  readonly persona: { readonly id: string; readonly name: string; readonly shortName: string };
  readonly listsDir: string;
  /** Her transcripts: a day they hold a full stream of counts as covered. */
  readonly streamsDir: string;
  /** Her downloads, whose `<id>.info.json` titles date the transcripts of videos no channel lists. */
  readonly vodsDir: string;
  /** Her time zone, where a video's upload time falls on a day. */
  readonly timeZone: string;
  /** Official channels given, before those her batches' `# Source:` lines name. */
  readonly channels?: readonly string[];
  /** List clips, and save them with the rest. */
  readonly clips?: boolean;
  /** Videos to leave out of every tier and the batch, as `videoKey` reads them. */
  readonly skip?: readonly string[];
  readonly minMinutes?: number;
  readonly pages?: number;
  /** Write a batch of what is new. */
  readonly save?: boolean;
  readonly now?: () => Date;
  readonly bilibili?: Omit<BilibiliOptions, "signal">;
  readonly expand?: Omit<ExpandOptions, keyof RunOptions>;
  readonly signal?: AbortSignal;
}

export interface DiscoveredVideo {
  readonly url: string;
  readonly title: string;
  /** The stream's day: from its title, else its upload's in her time zone; null when unknown. */
  readonly date: string | null;
  readonly minutes: number;
  readonly uploader: string;
}

export interface Tier {
  /** The new videos'. */
  readonly count: number;
  readonly hours: number;
  readonly videos: readonly DiscoveredVideo[];
}

/**
 * What the run listed of an official channel: a Bilibili list (a space given whole stands for its
 * replay lists, each its own entry), a space without one, or a YouTube channel.
 */
export interface DiscoveredChannel {
  /** A Bilibili list as `listUrl` writes it, the space's page, or the YouTube channel's. */
  readonly url: string;
  readonly site: "bilibili" | "youtube";
  readonly from: From;
  /** The account's name. */
  readonly name?: string;
  /** A Bilibili list's own name, such as 直播回放. */
  readonly list?: string;
  /** The videos it listed, those her lists hold included. */
  readonly videos?: number;
  readonly error?: string;
}

/** A space's list of her streams, by its URL (`listUrl`), name and count of videos. */
export interface ReplayList {
  readonly url: string;
  readonly name: string;
  readonly videos: number;
}

/** A Bilibili user whose name matches hers, when no official channel is known. */
export interface Candidate {
  readonly url: string;
  readonly name: string;
  readonly fans: number;
  readonly videos: number;
  readonly verified?: string;
  readonly liveRoom?: number;
  /** Its space's 直播回放 and 录播 lists, which only a streamer's own account has. */
  readonly replayLists?: readonly ReplayList[];
}

export interface DiscoverResult {
  readonly persona: { readonly id: string; readonly name: string };
  readonly channels: readonly DiscoveredChannel[];
  readonly candidates: readonly Candidate[];
  readonly official: Tier;
  readonly recordings: Tier;
  /** Its videos are listed only when clips are asked for. */
  readonly clips: Tier;
  /** The videos her lists and batches hold. */
  readonly known: number;
  /** The batch written; null when none was. */
  readonly batch: string | null;
  readonly warnings: readonly string[];
}

/** A video found, before its tier is settled. */
interface Found {
  /** As a list keys it: a BV id, or a YouTube video's URL. */
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly durationSec: number;
  /** Unix seconds; 0 where unknown. */
  readonly pubdate: number;
  readonly date: string | null;
  /** The date came from the title, not from the upload. */
  readonly titled: boolean;
  /** A Bilibili uploader, whose name may come from another answer. */
  readonly mid?: string;
  readonly uploader?: string;
}

function isoDate(year: number, month: number, day: number): string | null {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000 ||
    year > 2100 ||
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() !== month - 1 ||
    at.getUTCDate() !== day
  ) {
    return null;
  }
  return at.toISOString().slice(0, 10);
}

const TITLE_DATES = [
  /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
  /(?<!\d)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/g,
  /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g,
];

/**
 * The day a title names: `2026年11月19日`, `2026-11-19`, `2026.11.19`, `2026/11/19`, or
 * `20261119` standing alone; null for none.
 */
export function titleDate(title: string): string | null {
  for (const pattern of TITLE_DATES) {
    for (const match of title.matchAll(pattern)) {
      const date = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
      if (date !== null) return date;
    }
  }
  return null;
}

/** A transcript's head, which holds its frontmatter's `duration_min`. */
function head(path: string): string {
  const buffer = Buffer.alloc(1024);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The title in `<vodsDir>/<stem>.info.json`; "" when there is none. */
function infoTitle(vodsDir: string, stem: string): string {
  try {
    const info: unknown = JSON.parse(readFileSync(join(vodsDir, `${stem}.info.json`), "utf8"));
    return isPlainObject(info) && typeof info.title === "string" ? info.title : "";
  } catch {
    return "";
  }
}

/**
 * The days her transcripts in `streamsDir` cover: those of the videos whose parts run `minSec`
 * together. A transcript is named `<upload date>-<stem>.md` by yt-dlp's upload date, in UTC, which
 * can be the day after the stream; so one of a video `official` holds covers no day of its own, the
 * video's day standing for it, and another's day is its info.json title's, else that upload date.
 * A transcribed clip doesn't cover its day's stream, nor do two; one that doesn't say how long it
 * runs does.
 */
function transcriptDates(
  streamsDir: string,
  vodsDir: string,
  official: ReadonlyMap<string, Found>,
  minSec: number,
): string[] {
  const videos = new Map<string, { readonly day: string; seconds: number }>();
  for (const path of transcriptPaths(streamsDir)) {
    const name = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(basename(path));
    if (name === null) continue;
    const stem = name[2] as string;
    // A video's parts are `<id>_p<n>`; `official` keys a YouTube video by its URL.
    const id = stem.replace(/_p\d+$/, "");
    if (official.has(id) || official.has(youtubeVideoUrl(id))) continue;
    const minutes = /^duration_min:\s*(\d+(?:\.\d+)?)\s*$/m.exec(head(path))?.[1];
    const length = minutes === undefined ? Number.POSITIVE_INFINITY : Number(minutes) * 60;
    const video = videos.get(id);
    if (video !== undefined) video.seconds += length;
    else
      videos.set(id, {
        day: titleDate(infoTitle(vodsDir, stem)) ?? (name[1] as string),
        seconds: length,
      });
  }
  return [...videos.values()].flatMap(({ day, seconds }) => (seconds >= minSec ? [day] : []));
}

function bilibiliFound(video: BilibiliVideo, timeZone: string, mid?: string): Found {
  const fromTitle = titleDate(video.title);
  const uploaded =
    video.pubdate > 0 ? zonedClock(timeZone, new Date(video.pubdate * 1000)).isoDate : null;
  const owner = mid ?? video.mid;
  return {
    key: video.bvid,
    url: `https://www.bilibili.com/video/${video.bvid}`,
    title: video.title,
    durationSec: video.durationSec,
    pubdate: video.pubdate,
    date: fromTitle ?? uploaded,
    titled: fromTitle !== null,
    ...(owner ? { mid: owner } : {}),
    ...(video.author ? { uploader: video.author } : {}),
  };
}

/** An official replay's title, `…2026年11月19日19点场`, which a copy of the replay keeps. */
const REPLAY_TITLE = /\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}点场/;

/**
 * Whether recording `a` beats `b`, of the same day: a copy titled as the official replay is, the
 * one stream as it was, where a longer upload may carry it twice (弹幕版 beside the plain one);
 * else the longer, as a shorter one may have missed part of it.
 */
function preferred(a: Found, b: Found): boolean {
  const copyA = REPLAY_TITLE.test(a.title);
  const copyB = REPLAY_TITLE.test(b.title);
  return copyA !== copyB ? copyA : a.durationSec > b.durationSec;
}

/** Newest first: by day, then by upload; a video of unknown day keeps its place, after the rest. */
function newestFirst(a: Found, b: Found): number {
  const day = (b.date ?? "").localeCompare(a.date ?? "");
  return day !== 0 ? day : b.pubdate - a.pubdate;
}

/**
 * The days a recording may be of: its title's, else its upload's and the day before, as a stream
 * ends after midnight at times; none when its day is unknown.
 */
function daysOf(found: Found): string[] {
  const { date } = found;
  if (date === null) return [];
  return found.titled ? [date] : [date, addDays(date, -1)];
}

/**
 * One of `recordings` a day, for the days `covered` lacks, those whose title dates them first,
 * and every one of unknown day. A pick takes every day it may be of, so of two dated by their
 * uploads a day apart, which may hold the same stream, only one is picked.
 */
function oneADay(recordings: readonly Found[], covered: ReadonlySet<string>): Found[] {
  const byDate = new Map<string, Found>();
  /** The days the picks may be of. */
  const taken = new Set<string>();
  const undated: Found[] = [];
  for (const titled of [true, false]) {
    for (const found of recordings.filter((each) => each.titled === titled)) {
      const { date } = found;
      if (date === null) {
        undated.push(found);
        continue;
      }
      const other = byDate.get(date);
      if (other?.titled === titled) {
        if (preferred(found, other)) byDate.set(date, found);
        continue;
      }
      const days = daysOf(found);
      if (days.some((day) => covered.has(day) || taken.has(day))) continue;
      byDate.set(date, found);
      for (const day of days) taken.add(day);
    }
  }
  return [...byDate.values(), ...undated];
}

/**
 * Finds persona `options.persona`'s videos that no list of hers has: her official channels' streams
 * (the channels given, then those her batches' `# Source:` lines name), others' full recordings of
 * the days those don't cover, and clips, but those `skip` names; with `save`, writes them into a
 * new batch. A channel that can't be listed, or a search that fails, is a warning, and the run
 * goes on without it. Throws when her lists can't be read or the batch can't be written.
 */
export async function discoverVideos(options: DiscoverOptions): Promise<DiscoverResult> {
  const { persona, listsDir, signal, timeZone } = options;
  const minSec = (options.minMinutes ?? DEFAULT_MIN_MINUTES) * 60;
  const known = knownIds(listsDir);
  // Keyed as a found video is, so a YouTube video a list has by another of its URLs is known.
  const knownKeys = new Set([...known].map((key) => videoKey(key) ?? key));
  const isKnown = (found: Found): boolean => knownKeys.has(found.key);
  const skipped = new Set((options.skip ?? []).flatMap((text) => videoKey(text) ?? []));
  /** Neither listed already nor left out. A skipped recording covers no day: it isn't hers. */
  const isNew = (found: Found): boolean => !isKnown(found) && !skipped.has(found.key);
  const warnings: string[] = [];
  const warn = (message: string): void => {
    logger.warning(message);
    warnings.push(message);
  };
  /** `work`'s value, or `fallback` when it fails and the run wasn't stopped; `failed` hears why. */
  const unlessStopped = async <T>(
    work: Promise<T>,
    fallback: T,
    failed?: (why: string) => void,
  ): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      if (signal?.aborted) throw error;
      failed?.(errorText(error));
      return fallback;
    }
  };

  const channels: { channel: Channel; from: From }[] = [];
  const add = (text: string, from: From): void => {
    const channel = parseChannel(text);
    if (channel !== null && !channels.some((each) => each.channel.url === channel.url)) {
      channels.push({ channel, from });
    }
  };
  for (const text of options.channels ?? []) add(text, "argument");
  for (const text of batchSources(listsDir)) add(text, "batch");

  const client = new BilibiliClient({ ...options.bilibili, ...(signal ? { signal } : {}) });
  /** Every video the official channels list, by key, those her lists hold included. */
  const official = new Map<string, Found>();
  const officialMids = new Set<string>();
  /** Bilibili uploaders' names, by mid. */
  const names = new Map<string, string>();
  const nameOf = (mid: string | undefined): string | undefined =>
    mid === undefined ? undefined : names.get(mid);
  /** What was listed, in the order read: a Bilibili one with its space's mid, for its name. */
  const listed: (DiscoveredChannel & { readonly mid?: string })[] = [];
  /** Each space's lists, asked for once. */
  const spaces = new Map<string, Promise<NamedList[]>>();
  const spaceLists = (mid: string): Promise<NamedList[]> => {
    let lists = spaces.get(mid);
    if (lists === undefined) {
      lists = client.spaceLists(mid);
      spaces.set(mid, lists);
    }
    return lists;
  };

  /**
   * A list as given, or a space's replay lists, each listed once and named by `listUrl`, the form
   * the batch remembers; a space without one, by its page.
   */
  const listBilibili = async (channel: Extract<Channel, { site: "bilibili" }>, from: From) => {
    const { mid } = channel;
    let lists: readonly (BilibiliList & { readonly name?: string })[];
    if (channel.list !== null) {
      const given = channel.list;
      // Its name tells a 直播回放 list from another; listing it needs none.
      const inSpace = await unlessStopped(spaceLists(mid), [], (why) =>
        warn(
          `Couldn't read the lists of ${spaceUrl(mid)}, so whether ${channel.url} is a ` +
            `直播回放 list is unknown: ${why}`,
        ),
      );
      const name = inSpace.find((list) => list.type === given.type && list.id === given.id)?.name;
      if (name !== undefined && !REPLAY_LIST.test(name)) {
        warn(
          `${channel.url} is ${name}, no 直播回放 or 录播 list, yet all its videos count as hers`,
        );
      }
      lists = [name === undefined ? given : { ...given, name }];
    } else {
      lists = (await spaceLists(mid)).filter((list) => REPLAY_LIST.test(list.name));
      if (lists.length === 0) {
        warn(`${channel.url} has no 直播回放 or 录播 list; only the search finds its uploads`);
        listed.push({ url: channel.url, site: "bilibili", from, mid, videos: 0 });
        return;
      }
    }
    for (const list of lists) {
      const url = listUrl(mid, list);
      if (listed.some((each) => each.url === url)) continue;
      const named = list.name ? { list: list.name } : {};
      logger.info(`Listing ${list.name || url}`);
      const videos = await unlessStopped(client.listVideos(mid, list), null, (why) => {
        warn(`Couldn't list ${url}: ${why}`);
        listed.push({ url, site: "bilibili", from, mid, ...named, error: why });
      });
      if (videos === null) continue;
      logger.info(`${list.name || url}: ${videos.length} videos`);
      for (const video of videos) {
        if (!official.has(video.bvid)) {
          official.set(video.bvid, bilibiliFound(video, timeZone, mid));
        }
      }
      listed.push({ url, site: "bilibili", from, mid, ...named, videos: videos.length });
      const first = videos[0]?.bvid;
      if (first !== undefined && !names.has(mid)) {
        const owner = await unlessStopped(client.owner(first), { mid, name: "" }, (why) =>
          warn(`Couldn't read who uploaded https://www.bilibili.com/video/${first}: ${why}`),
        );
        if (owner.name !== "") names.set(mid, owner.name);
      }
    }
  };

  const listYoutube = async (channel: Extract<Channel, { site: "youtube" }>, from: From) => {
    logger.info(`Listing ${channel.url}/streams`);
    const entries = await expandPlaylist(`${channel.url}/streams`, {
      ...options.expand,
      ...(signal ? { signal } : {}),
    });
    let count = 0;
    for (const entry of entries) {
      const id = youtubeVideoId(entry.url) ?? entry.id;
      if (entry.liveStatus !== "was_live" || entry.durationSec === undefined) continue;
      count++;
      const url = youtubeVideoUrl(id);
      if (official.has(url)) continue;
      const title = entry.title ?? "";
      // A flat listing carries no upload date.
      const date = titleDate(title);
      official.set(url, {
        key: url,
        url,
        title,
        durationSec: entry.durationSec,
        pubdate: 0,
        date,
        titled: date !== null,
        uploader: channel.name,
      });
    }
    listed.push({ url: channel.url, site: "youtube", from, name: channel.name, videos: count });
  };

  for (const { channel, from } of channels) {
    if (channel.site === "bilibili") officialMids.add(channel.mid);
    const listing =
      channel.site === "bilibili" ? listBilibili(channel, from) : listYoutube(channel, from);
    await unlessStopped(listing, undefined, (why) => {
      warn(`Couldn't list ${channel.url}: ${why}`);
      listed.push({
        url: channel.url,
        site: channel.site,
        from,
        ...(channel.site === "bilibili" ? { mid: channel.mid } : { name: channel.name }),
        error: why,
      });
    });
  }

  const mentions = (title: string): boolean => {
    const folded = title.toLowerCase();
    return [persona.name, persona.shortName].some(
      (name) => name !== "" && folded.includes(name.toLowerCase()),
    );
  };
  const recordings: Found[] = [];
  const clips: Found[] = [];
  const searched = new Set<string>();
  const pages = options.pages ?? DEFAULT_PAGES;
  const search = async (overAnHour: boolean): Promise<void> => {
    const what = overAnHour ? "videos over an hour" : "videos";
    for (let page = 1; page <= pages; page++) {
      logger.info(`Searching Bilibili for ${persona.name}'s ${what}, page ${page}`);
      const result = await unlessStopped(
        client.searchVideos(persona.name, page, overAnHour),
        null,
        (why) => warn(`Bilibili's search for ${what} failed at page ${page}: ${why}`),
      );
      if (result === null) return;
      for (const video of result.videos) {
        const byOfficial = video.mid !== undefined && officialMids.has(video.mid);
        if (byOfficial && video.author && !names.has(video.mid)) {
          names.set(video.mid, video.author);
        }
        if (searched.has(video.bvid) || official.has(video.bvid)) continue;
        searched.add(video.bvid);
        if (!mentions(video.title)) continue;
        const found = bilibiliFound(video, timeZone);
        if (video.durationSec < minSec) clips.push(found);
        else if (byOfficial) official.set(found.key, found);
        else recordings.push(found);
      }
      if (result.videos.length === 0 || page >= result.pages) return;
    }
  };
  // Clips crowd full streams out of the newest results, a few days' worth filling the pages, so
  // the videos over an hour are searched for on their own first, whatever the shortest stream.
  await search(true);
  await search(false);

  const candidates: Candidate[] = [];
  if (channels.length === 0) {
    const users = await unlessStopped(client.searchUsers(persona.name), [], (why) =>
      warn(`Bilibili's user search failed: ${why}`),
    );
    for (const user of users.slice(0, 5)) {
      const lists = await unlessStopped(spaceLists(user.mid), [], (why) =>
        warn(`Couldn't read the lists of ${spaceUrl(user.mid)}: ${why}`),
      );
      const replayLists: ReplayList[] = lists
        .filter((list) => REPLAY_LIST.test(list.name))
        .map((list) => ({ url: listUrl(user.mid, list), name: list.name, videos: list.total }));
      candidates.push({
        url: spaceUrl(user.mid),
        name: user.name,
        fans: user.fans,
        videos: user.videos,
        ...(user.verified === "" ? {} : { verified: user.verified }),
        ...(user.liveRoom === 0 ? {} : { liveRoom: user.liveRoom }),
        ...(replayLists.length === 0 ? {} : { replayLists }),
      });
    }
    // Only a streamer's own space has her 直播回放, which the search may rank below a namesake.
    candidates.sort(
      (a, b) => Number(b.replayLists !== undefined) - Number(a.replayLists !== undefined),
    );
  }

  const covered = new Set(transcriptDates(options.streamsDir, options.vodsDir, official, minSec));
  // A video skipped as none of her streams covers no day.
  for (const found of official.values()) {
    if (found.date !== null && !skipped.has(found.key)) covered.add(found.date);
  }
  // A saved recording's days, which a search may no longer return.
  for (const covers of batchHeader(listsDir, "Covers")) {
    for (const word of covers.split(/\s+/)) if (ISO_DAY.test(word)) covered.add(word);
  }
  for (const found of recordings) {
    if (isKnown(found)) for (const day of daysOf(found)) covered.add(day);
  }

  const fresh = {
    official: [...official.values()].filter(isNew).sort(newestFirst),
    recordings: oneADay(recordings.filter(isNew), covered).sort(newestFirst),
    clips: clips.filter(isNew).sort(newestFirst),
  };
  const uploader = (found: Found): string => found.uploader ?? nameOf(found.mid) ?? "";
  const tier = (found: readonly Found[], shown = true): Tier => ({
    count: found.length,
    hours: Math.round(found.reduce((sum, each) => sum + each.durationSec, 0) / 360) / 10,
    videos: shown
      ? found.map((each) => ({
          url: each.url,
          title: each.title,
          date: each.date,
          minutes: Math.round(each.durationSec / 60),
          uploader: uploader(each),
        }))
      : [],
  });

  const views = listed.map((each): DiscoveredChannel => {
    const name = each.name ?? nameOf(each.mid);
    return {
      url: each.url,
      site: each.site,
      from: each.from,
      ...(name === undefined ? {} : { name }),
      ...(each.list === undefined ? {} : { list: each.list }),
      ...(each.videos === undefined ? {} : { videos: each.videos }),
      ...(each.error === undefined ? {} : { error: each.error }),
    };
  });

  let batch: string | null = null;
  const saving = [...fresh.official, ...fresh.recordings, ...(options.clips ? fresh.clips : [])];
  if (options.save && saving.length > 0) {
    const now = options.now?.() ?? new Date();
    const header = [
      ...views.filter((view) => view.error === undefined).map((view) => `Source: ${view.url}`),
      `Captured: ${localIsoSeconds(now)}`,
      `Official: ${fresh.official.length}; recordings: ${fresh.recordings.length}; ` +
        `clips: ${options.clips ? fresh.clips.length : 0}`,
      ...fresh.recordings.flatMap((found) => {
        const days = daysOf(found);
        return days.length === 0 ? [] : [`Covers: ${days.join(" ")} ${found.url}`];
      }),
    ];
    batch = writeBatch(
      listsDir,
      saving.map((found) => found.key),
      header,
      now,
    );
    logger.info(`Wrote ${saving.length} videos into ${batch}`);
  }

  return {
    persona: { id: persona.id, name: persona.name },
    channels: views,
    candidates,
    official: tier(fresh.official),
    recordings: tier(fresh.recordings),
    clips: tier(fresh.clips, options.clips === true),
    known: known.size,
    batch,
    warnings,
  };
}
