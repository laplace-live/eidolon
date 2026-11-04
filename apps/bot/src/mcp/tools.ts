// The two search tools: what tools/list advertises and what a tools/call runs.
import type { SlidingWindowQuota } from "@eidolon/access";
import { logger, pyStrip, pyStrRepr } from "@eidolon/config";
import { decodeTopics, type Retriever, type SearchRow, scoreOf } from "@eidolon/retrieval";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { envelopeText, type LineError, validationErrorText } from "./pydantic.ts";

export const SEARCH_PERSONA_FACTS = "search_persona_facts";
export const SEARCH_STREAMS = "search_streams";

// Shipped to the model verbatim as the tool descriptions; editing one changes runtime behavior.
export const SEARCH_PERSONA_FACTS_DESCRIPTION =
  "Search hand-compiled facts about the streamer 明前奶绿 — biography,\n" +
  "character settings, preferences, recurring bits. Returns the most\n" +
  "relevant facts with their source dates. Use for stable facts about who\n" +
  "she is, not for recalling specific stream moments.";
export const SEARCH_STREAMS_DESCRIPTION =
  "Search transcripts of 明前奶绿's past live streams. Returns the most\n" +
  "relevant ~5-minute stream segments with their broadcast dates and\n" +
  "topics. Use to recall what she said or did on a stream.";

export const FACTS_INDEX_MISSING_NOTE = "Persona-facts index is not built on this server.";
export const STREAMS_INDEX_MISSING_NOTE = "Stream-archive index is not built on this server.";

function definition(name: string, description: string): Tool {
  return {
    description,
    inputSchema: {
      properties: { query: { title: "Query", type: "string" } },
      required: ["query"],
      type: "object",
      title: `${name}Arguments`,
    },
    name,
    outputSchema: { type: "object", additionalProperties: true, title: `${name}DictOutput` },
  };
}

/** The Python server's tools/list, in its registration order. */
export const TOOL_DEFINITIONS: readonly Tool[] = [
  definition(SEARCH_PERSONA_FACTS, SEARCH_PERSONA_FACTS_DESCRIPTION),
  definition(SEARCH_STREAMS, SEARCH_STREAMS_DESCRIPTION),
];

export type FactResult = { text: string; date: string | null; score: number | null };
export type ChunkResult = {
  stream_date: string | null;
  content: string;
  topics: string[];
  score: number | null;
};
type SearchEnvelope = {
  count: number;
  results: (FactResult | ChunkResult)[];
  note?: string;
};

/** Python `row.get(key) or ""` for a string column. */
function text(row: SearchRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

export function projectFact(hit: SearchRow): FactResult {
  return { text: pyStrip(text(hit, "text")), date: text(hit, "date") || null, score: scoreOf(hit) };
}

/**
 * Prefers the refined `details` over the v1 `summary` over the raw `text`, the same priority
 * context's StreamArchive renders for the bot. The first non-empty one wins before stripping.
 */
export function projectChunk(hit: SearchRow): ChunkResult {
  return {
    stream_date: text(hit, "stream_date") || null,
    content: pyStrip(text(hit, "details") || text(hit, "summary") || text(hit, "text")),
    topics: decodeTopics(hit),
    score: scoreOf(hit),
  };
}

export interface CallerTier {
  readonly quota: SlidingWindowQuota;
  readonly key: string;
  readonly name: "anonymous" | "authenticated";
}

export interface SearchTool {
  readonly retriever: Pick<Retriever, "hasTable" | "search">;
  readonly params: { readonly candidates: number; readonly topK: number };
  readonly missingNote: string;
  readonly project: (hit: SearchRow) => FactResult | ChunkResult;
}

/** An anticipated failure: its message reaches the model after "Error executing tool <name>: ". */
class ToolError extends Error {}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// The repr keeps peer-supplied text on one log line, as the Python SDK's %r does.
function failed(name: string, message: string): CallToolResult {
  logger.info(`[mcp] Tool ${pyStrRepr(name)} failed: ${pyStrRepr(message)}`);
  return errorResult(message);
}

/** pydantic's error for the `<name>Arguments` model of a tool whose one field is `query: str`. */
function argumentsError(name: string, args: Readonly<Record<string, unknown>>): string {
  const error: LineError = Object.hasOwn(args, "query")
    ? {
        loc: "query",
        type: "string_type",
        message: "Input should be a valid string",
        input: args.query,
      }
    : { loc: "query", type: "missing", message: "Field required", input: args };
  return validationErrorText(`${name}Arguments`, [error]);
}

async function search(tool: SearchTool, query: string, tier: CallerTier): Promise<SearchEnvelope> {
  // Charge the quota before the embedding call — the quota exists to cap that spend.
  const quota = tier.quota.tryConsume(tier.key);
  if (!quota.allowed) {
    throw new ToolError(
      `Rate limit exceeded for ${tier.name} access. Retry after ${quota.retryAfterSeconds} seconds.`,
    );
  }
  if (!tool.retriever.hasTable) return { count: 0, results: [], note: tool.missingNote };
  const results = (await tool.retriever.search(query, tool.params)).map((hit) => tool.project(hit));
  return { count: results.length, results };
}

/** The Python SDK's tools/call: unknown tool, argument validation, then the tool body. */
export async function callTool(
  tools: ReadonlyMap<string, SearchTool>,
  name: string,
  args: Readonly<Record<string, unknown>>,
  tier: CallerTier,
): Promise<CallToolResult> {
  const tool = tools.get(name);
  if (tool === undefined) return failed(name, `Unknown tool: ${name}`);
  if (typeof args.query !== "string") {
    logger.info(`[mcp] Tool ${pyStrRepr(name)} rejected arguments: ['query']`);
    return errorResult(`Error executing tool ${name}: ${argumentsError(name, args)}`);
  }
  try {
    const envelope = await search(tool, args.query, tier);
    return {
      content: [{ type: "text", text: envelopeText(envelope) }],
      isError: false,
      structuredContent: envelope,
    };
  } catch (error) {
    if (error instanceof ToolError) {
      return failed(name, `Error executing tool ${name}: ${error.message}`);
    }
    // The client sees only the generic text; the cause stays in the log.
    logger.exception(`[mcp] Tool ${pyStrRepr(name)} raised an unexpected exception`, error);
    return errorResult(`Error executing tool ${name}`);
  }
}
