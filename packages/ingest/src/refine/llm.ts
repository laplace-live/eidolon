// One chat completion that must come back as JSON, with refine.py's one retry: a response cut off
// at max_tokens is asked again with double the budget.
import {
  cpLen,
  cpSlice,
  errorText,
  isPlainObject,
  type JsonPoster,
  logger,
  pyError,
  pyGet,
  pyRepr,
  pyStr,
  pyStrRepr,
  pyTruthy,
  pyTypeName,
} from "@eidolon/config";
import { parseJsonLenient } from "./lenient_json.ts";
import { extractUsage, Usage } from "./usage.ts";

const MAX_TOKENS_CEILING = 16_384;

// What OpenAIClient throws once retries are spent or for a status it never retries; anything else
// (an aborted run, a 200 that isn't JSON) is not an API error.
const API_ERRORS: ReadonlySet<string> = new Set([
  "APIConnectionError",
  "APITimeoutError",
  "APIStatusError",
  "BadRequestError",
  "AuthenticationError",
  "PermissionDeniedError",
  "NotFoundError",
  "ConflictError",
  "UnprocessableEntityError",
  "RateLimitError",
  "InternalServerError",
]);

export function isApiError(error: unknown): boolean {
  return error instanceof Error && API_ERRORS.has(error.name);
}

export interface LlmCall {
  readonly system: string;
  readonly user: string;
  readonly temperature: number;
  readonly maxTokens: number;
  /** A `json_schema` block; null asks for any JSON object. */
  readonly responseFormat: Readonly<Record<string, unknown>> | null;
}

/** The first choice's content and finish reason, read as the SDK's response model reads them. */
function firstChoice(response: unknown): { content: unknown; finishReason: unknown } {
  const choices = isPlainObject(response) ? response.choices : undefined;
  if (!pyTruthy(choices)) return { content: "", finishReason: null };
  const choice = (choices as unknown[])[0];
  return {
    content: pyGet(pyGet(choice, "message"), "content"),
    finishReason: pyGet(choice, "finish_reason"),
  };
}

/**
 * `_call_llm_json`: the parsed JSON and what the calls cost, or null and the cost when the call
 * failed or its body wouldn't parse. API errors are logged and give null, the error third; any
 * other error, an aborted run's included, propagates.
 */
export async function callLlmJson(
  client: JsonPoster,
  model: string,
  call: LlmCall,
): Promise<[unknown, Usage, unknown?]> {
  const responseFormat = call.responseFormat ?? { type: "json_object" };
  // `usage.include` makes OpenRouter return the cost in USD; `provider.require_parameters` makes
  // it skip providers that would silently drop the schema and hand back free-form JSON.
  const extra: Record<string, unknown> = { usage: { include: true } };
  if (responseFormat.type === "json_schema") extra.provider = { require_parameters: true };

  let maxTokens = call.maxTokens;
  const usage = new Usage();
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: unknown;
    try {
      // The OpenAI SDK's key order, so the body is byte for byte what refine.py sends.
      response = await client.post("chat/completions", {
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
        model,
        max_tokens: maxTokens,
        response_format: responseFormat,
        temperature: call.temperature,
        ...extra,
      });
    } catch (error) {
      if (!isApiError(error)) throw error;
      logger.error(`  API error: ${errorText(error)}`);
      return [null, usage, error];
    }

    // Before any content check, so a body that won't parse still counts its cost.
    usage.add(extractUsage(response, model));
    const { content, finishReason } = firstChoice(response);
    const reason = pyRepr(finishReason);

    if (!pyTruthy(content)) {
      // An empty body cut off at max_tokens means the prompt itself blew the budget, so a bigger
      // budget won't help.
      logger.error(`  empty response (finish_reason=${reason}, max_tokens=${maxTokens})`);
      return [null, usage];
    }
    if (typeof content !== "string") {
      throw pyError(
        "TypeError",
        `the JSON object must be str, bytes or bytearray, not ${pyTypeName(content)}`,
      );
    }

    const [parsed, note] = parseJsonLenient(content);
    const bodyLen = cpLen(content);
    if (parsed !== null) {
      if (note) {
        logger.warning(
          `  recovered malformed JSON via ${note} (finish_reason=${reason}, body_len=${bodyLen})`,
        );
      }
      return [parsed, usage];
    }

    if (finishReason === "length" && attempt === 0) {
      maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
      logger.warning(
        `  truncated response (finish_reason=length, body_len=${bodyLen}); ` +
          `retrying with max_tokens=${maxTokens}`,
      );
      continue;
    }

    const head = cpSlice(content, 0, 600);
    const tail = bodyLen > 1000 ? cpSlice(content, -400) : "";
    logger.error(
      `  invalid JSON (${pyStr(note)}); finish_reason=${reason}, body_len=${bodyLen}, ` +
        `head=${pyStrRepr(head)}${tail ? `, tail=${pyStrRepr(tail)}` : ""}`,
    );
    return [null, usage];
  }
  return [null, usage];
}
