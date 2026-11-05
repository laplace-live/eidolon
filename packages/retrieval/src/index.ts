// The read side of the two LanceDB tables: jieba tokenization, the date pre-filter, hybrid search
// with RRF or a reranker, the retrievers context and MCP search through, and the stream-time and
// stream-catalog helpers the archive's recall builds on.

export { DEFAULT_EMBED_BASE_URL, DEFAULT_EMBED_MODEL, embedDim } from "@eidolon/config";
export type { Table as LanceTable } from "@lancedb/lancedb";
export {
  addDays,
  DateRangeError,
  diffDays,
  firstOfMonth,
  firstOfNextMonth,
  fromIsoformat,
  type IsoDate,
  isoDate,
  isValidIsoDate,
  parseIsoDate,
  todayIn,
  weekday,
  yearOf,
} from "./civil_date.ts";
export {
  type CostSource,
  defaultEmbeddingClient,
  EMBED_HTTP_MAX_RETRIES,
  EMBED_HTTP_TIMEOUT_SEC,
  EMBED_PRICING_USD_PER_1M,
  EMBED_QUOTA_BACKOFF,
  EMBED_RETRY_BASE_DELAY,
  EmbeddingClient,
  type EmbeddingClientOptions,
  EmbeddingUsage,
  type EmbedOptions,
  embedTexts,
  embedTextsWithUsage,
  isQuotaError,
  MAX_EMBED_DATA_RETRIES,
  MAX_EMBED_QUOTA_RETRIES,
  resetEmbeddingClient,
} from "./embeddings.ts";
export {
  type HybridSearchOptions,
  hybridSearch,
  RRF_K,
  rrfFuse,
  type SearchRow,
  scoreOf,
  vectorSearch,
} from "./hybrid.ts";
export { JiebaTokenizer } from "./jieba.ts";
export { clip, type PyFlags, PyPattern, pyInt, pyRegexSource } from "./py.ts";
export {
  buildQueryText,
  extractDateFilter,
  type MessageLike,
  SHORT_QUERY_CHARS,
} from "./query.ts";
export {
  DEFAULT_RERANK_BASE_URL,
  DEFAULT_RERANK_MODEL,
  makeReranker,
  OpenRouterReranker,
  type OpenRouterRerankerOptions,
  RERANK_MAX_ATTEMPTS,
  RERANK_TIMEOUT_SEC,
  type Reranker,
  type RerankResult,
  resetRerankerCache,
} from "./rerank.ts";
export {
  LanceRetriever,
  type LanceRetrieverOptions,
  openPersonaFactsRetriever,
  openStreamArchiveRetriever,
  type Retriever,
  type RetrieverOpenOptions,
  type SearchOptions,
} from "./retriever.ts";
export {
  type Broadcast,
  type BroadcastScene,
  broadcastFromJson,
  CATALOG_FILENAME,
  CATALOG_VERSION,
  clearCatalogCache,
  compactOverview,
  formatBroadcasts,
  OVERVIEW_MAX_CHARS,
  StreamCatalog,
  TYPE_NAMES,
  warmStreamCatalog,
} from "./stream_catalog.ts";
export {
  hasStreamTimeReference,
  isStreamElaboration,
  isStreamFollowup,
  isStreamOverview,
  isStreamQuery,
  resolveStreamScope,
  type StreamScope,
  streamScope,
} from "./stream_time.ts";
export {
  CLI_LAUNCHER,
  dbPathArgument,
  decodeTopics,
  INDEX_DIR,
  ingestHint,
  listTableNames,
  openTable,
  PERSONA_FACTS,
  PERSONA_FACTS_TABLE,
  personaFactsSearchParams,
  resolveDbPath,
  type SearchParams,
  STREAM_ARCHIVE,
  STREAM_CHUNKS_TABLE,
  scanStreamDates,
  streamArchiveSearchParams,
  type TablePreset,
} from "./tables.ts";
export { tokenizeZh, tokenizeZhQuery, warmTokenizer, ZH_QUERY_STOPWORDS } from "./tokenize.ts";
