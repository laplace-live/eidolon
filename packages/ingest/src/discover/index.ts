// laplace-discover's library: a persona's official channels, Bilibili's web API, and the run that
// finds her new videos and sorts them into official streams, others' recordings and clips.
export {
  BILIBILI_PAUSE_MS,
  BilibiliClient,
  type BilibiliOptions,
  type BilibiliUser,
  type BilibiliVideo,
  cleanTitle,
  type NamedList,
  searchDuration,
} from "./bilibili.ts";
export {
  type BilibiliList,
  batchSources,
  type Channel,
  listUrl,
  parseChannel,
  spaceUrl,
  videoKey,
  youtubeVideoId,
  youtubeVideoUrl,
} from "./channels.ts";
export {
  type Candidate,
  DEFAULT_MIN_MINUTES,
  DEFAULT_PAGES,
  type DiscoveredChannel,
  type DiscoveredVideo,
  type DiscoverOptions,
  type DiscoverResult,
  discoverVideos,
  type Tier,
  titleDate,
} from "./run.ts";
