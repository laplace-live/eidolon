// Tasks' web search, through OpenRouter's openrouter:web_search server tool. OpenRouter searches
// only inside a model's request, so a small carrier model makes the one search, and the results
// come back as its reply's url_citation annotations: each page's title, URL and Exa's excerpt.
// Measured on chat completions on 2026-11-17: every result comes back as an annotation, the ones
// the reply doesn't cite marked uncited; usage.cost holds the search's $0.007 with the carrier's
// tokens; and told to search once per topic, the carrier asked for three searches, all three
// counted in server_tool_use_details, while the request was billed for one.
import { extractCostUsd, isPlainObject, openrouterHeaders } from "@eidolon/config";
import { OpenAIChatClient, openaiUnits } from "./http/chat.ts";
import { hasKey, type Selection, trySelect } from "./resolve.ts";
import { reportUsage, type UsageSink } from "./usage.ts";

export interface SearchRequest {
  readonly query: string;
  /** How many results, 1 to 10. */
  readonly count: number;
  /** Only results from these sites; none for any site. */
  readonly domains: readonly string[];
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  /** Exa's excerpt of the page, at most EXCERPT_CHARS. */
  readonly excerpt: string;
}

export interface SearchOutcome {
  readonly results: readonly SearchResult[];
  /** The engine that searched: the search role's model. */
  readonly engine: string;
  /** The searches the request was billed for. */
  readonly searches: number;
}

export type Searcher = (request: SearchRequest, signal: AbortSignal) => Promise<SearchOutcome>;

export interface SearcherOptions {
  /** Hears each search's usage record, as the ledger gets it. */
  readonly tap?: UsageSink;
  readonly fetch?: typeof fetch;
}

/** The cheapest model that carries the tool; with reasoning off it only relays. */
const CARRIER = "openai/gpt-6-luna";
const CARRIER_SYSTEM =
  "Search the web once for the user's message with the web search tool. Then list every result " +
  "you got, one per line, as [title](url), and nothing else.";
/** How much of each page Exa's excerpt holds, in characters. */
const EXCERPT_CHARS = 1000;
/** OpenRouter answers any search past this with a message to the carrier, never another search. */
const MAX_USES = 1;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

/** A reply's url_citation annotations as results, in order, one per URL. */
function resultsOf(reply: Readonly<Record<string, unknown>>): SearchResult[] {
  const choice = Array.isArray(reply.choices) ? reply.choices[0] : undefined;
  const message = isPlainObject(choice) && isPlainObject(choice.message) ? choice.message : {};
  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  const byUrl = new Map<string, SearchResult>();
  for (const annotation of annotations) {
    if (!isPlainObject(annotation) || annotation.type !== "url_citation") continue;
    const citation = annotation.url_citation;
    if (!isPlainObject(citation) || typeof citation.url !== "string" || !citation.url) continue;
    const { url } = citation;
    const title = typeof citation.title === "string" ? citation.title.trim() : "";
    const excerpt = typeof citation.content === "string" ? citation.content : "";
    // A reply that cites a page twice brings two annotations for it.
    const seen = byUrl.get(url);
    byUrl.set(
      url,
      seen === undefined
        ? { title, url, excerpt }
        : {
            title: seen.title || title,
            url,
            excerpt: excerpt.length > seen.excerpt.length ? excerpt : seen.excerpt,
          },
    );
  }
  return [...byUrl.values()];
}

/**
 * Searches on `selection`, the search role's OpenRouter account and engine, one search a call.
 * Each call reports its usage as the search role's, `tap` included, and throws a provider's
 * refusal as ProviderHttpError.
 */
export function openRouterSearcher(selection: Selection, options: SearcherOptions = {}): Searcher {
  const engine = selection.model;
  const client = new OpenAIChatClient({
    provider: selection.provider.name,
    baseUrl: selection.baseUrl as string,
    apiKey: selection.apiKey,
    headers: openrouterHeaders(),
    extraBody: { usage: { include: true } },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return async ({ query, count: limit, domains }, signal) => {
    const reply = await client.chat.completions.create(
      {
        model: CARRIER,
        reasoning: { effort: "none" },
        max_tokens: 1024,
        max_tool_calls: 1,
        tool_choice: "required",
        stream: false,
        tools: [
          {
            type: "openrouter:web_search",
            parameters: {
              engine,
              max_results: limit,
              max_total_results: limit,
              max_uses: MAX_USES,
              max_characters: EXCERPT_CHARS,
              ...(domains.length === 0 ? {} : { allowed_domains: domains }),
            },
          },
        ],
        messages: [
          { role: "system", content: CARRIER_SYSTEM },
          { role: "user", content: query },
        ],
      },
      { signal },
    );
    const body = isPlainObject(reply) ? reply : {};
    const usage = isPlainObject(body.usage) ? body.usage : {};
    const counted = isPlainObject(usage.server_tool_use_details)
      ? count(usage.server_tool_use_details.web_search_requests)
      : 0;
    const searches = Math.min(counted, MAX_USES);
    reportUsage(
      {
        role: "search",
        provider: selection.provider.id,
        model: engine,
        units: { ...openaiUnits(usage), searches },
        costUsd: extractCostUsd(usage),
      },
      options.tap,
    );
    if (searches === 0) throw new Error("The search didn't run");
    return { results: resultsOf(body), engine, searches };
  };
}

/** The search role's searcher, as its settings stand: none until it has an account and its key. */
export function roleSearcher(tap: UsageSink): Searcher | undefined {
  const selection = trySelect("search");
  return selection !== null && hasKey(selection)
    ? openRouterSearcher(selection, { tap })
    : undefined;
}
