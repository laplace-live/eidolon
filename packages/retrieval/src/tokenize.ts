// LanceDB ships no CJK tokenizer; pre-tokenizing at both ingest and query time is the official
// workaround. https://github.com/lancedb/lancedb/issues/2168
import { isPySpace } from "@eidolon/config";
import { JiebaTokenizer } from "./jieba.ts";

// Filtered out of FTS QUERIES only, never the index, or BM25 collapses onto
// them: "你怕什么" tokenizes to 你 / 怕 / 什么, where 你 and 什么 appear in tens
// of thousands of facts and 怕 in maybe 200. BM25 rewards the common tokens
// and swamps the rare meaningful one, so the top hits become unrelated
// chatter. Hand-rolled rather than HIT/hanlp: those strip negators ("不",
// "没") and adverbs ("很", "都") that carry the whole meaning of a short
// query. Content words ("人", "事", "话") stay for the same reason — they can
// be the point of the query ("我跟谁聊过").
export const ZH_QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "你",
  "我",
  "他",
  "她",
  "它",
  "您",
  "你们",
  "我们",
  "他们",
  "她们",
  "自己",
  "大家",
  "这",
  "那",
  "什么",
  "哪",
  "哪个",
  "哪里",
  "哪些",
  "怎么",
  "怎样",
  "怎么样",
  "为什么",
  "为何",
  "为啥",
  "谁",
  "几",
  "多少",
  "的",
  "地",
  "得",
  "了",
  "着",
  "过",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "嘛",
  "哦",
  "哈",
  "嗯",
  "是",
  "在",
  "有",
  "把",
  "被",
  "让",
  "和",
  "跟",
  "与",
  "或",
  "而",
  "但",
  "也",
  "都",
  "就",
  "还",
  "因为",
  "所以",
  "如果",
  "虽然",
  "但是",
  "啥",
  "要",
  "想",
  "会",
  "能",
  "可以",
  "应该",
  "需要",
  // Time stems jieba splits out of date phrases. The numbers stay;
  // the 年/月/日/号 markers are noise once the date pre-filter has
  // had its turn.
  "年",
  "月",
  "日",
  "号",
  "周",
  "天",
  " ",
  "\t",
]);

/**
 * Builds jieba's prefix dict now. The first cut otherwise pays a one-shot ~180 ms dictionary
 * build, and on the event loop that stalls every call's audio, so boot calls this before serving.
 */
export function warmTokenizer(): void {
  JiebaTokenizer.default().initialize();
}

/** Python `w.strip()` is truthy. */
function hasText(word: string): boolean {
  for (const ch of word) if (!isPySpace(ch)) return true;
  return false;
}

function searchTokens(text: string): string[] {
  return JiebaTokenizer.default().cutForSearch(text).filter(hasText);
}

/**
 * The ingest-side tokenizer that populated the `tokens` column. `cut_for_search` emits short
 * sub-tokens alongside long words ("包租婆" → `包租 包租婆`) so a partial query still matches, and
 * leaves English alphanumerics whole, so a BV-ID stays findable.
 */
export function tokenizeZh(text: string): string {
  if (!text) return "";
  return searchTokens(text).join(" ");
}

/**
 * `tokenizeZh` minus the stopwords, for the FTS leg of a query. A query that is all stopwords
 * ("嗯吗") falls back to the unfiltered tokens: over-matching beats silently no-opping the leg.
 */
export function tokenizeZhQuery(text: string): string {
  if (!text) return "";
  const tokens = searchTokens(text);
  const filtered = tokens.filter((w) => !ZH_QUERY_STOPWORDS.has(w));
  return (filtered.length > 0 ? filtered : tokens).join(" ");
}
