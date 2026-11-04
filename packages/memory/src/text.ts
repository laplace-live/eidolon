// mem0's text plumbing around the extraction call: the transcript it embeds and sends, and how
// it digs JSON out of the model's reply.
import { createHash } from "node:crypto";
import { logger, pyStr, pyStrip } from "@eidolon/config";
import { errorText, isPlainObject, pyError, pyGet, pyTypeName } from "./errors.ts";
import { pyJsonLoads } from "./py-json.ts";

/** mem0 `parse_messages`: one `role: content` line per system/user/assistant message. */
export function parseMessages(messages: readonly Readonly<Record<string, unknown>>[]): string {
  let out = "";
  for (const message of messages) {
    const content = message.content;
    if (content === null || content === undefined) continue;
    const role = message.role;
    if (role === "system" || role === "user" || role === "assistant") {
      out += `${role}: ${pyStr(content)}\n`;
    }
  }
  return out;
}

const FENCED = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/;
const THINK = /<think>[\s\S]*?<\/think>/g;
// Python's `\s`: str.isspace(), which differs from JS `\s` on U+001C–U+001F, U+0085 and U+FEFF.
const PY_SPACE =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const JSON_FENCE = new RegExp(`\`\`\`(?:json)?${PY_SPACE}*([\\s\\S]*?)${PY_SPACE}*\`\`\``);

/** mem0 `remove_code_blocks`: unwrap one enclosing code fence and drop `<think>` blocks. */
export function removeCodeBlocks(content: unknown): string {
  let text = content;
  if (Array.isArray(content)) {
    const parts: unknown[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (isPlainObject(block)) parts.push(pyGet(block, "text", ""));
    }
    parts.forEach((part, i) => {
      if (typeof part !== "string") {
        throw pyError(
          "TypeError",
          `sequence item ${i}: expected str instance, ${pyTypeName(part)} found`,
        );
      }
    });
    text = parts.join("");
  }
  if (typeof text !== "string") return "";
  const stripped = pyStrip(text);
  const fenced = FENCED.exec(stripped);
  const inner = fenced ? pyStrip(fenced[1] as string) : stripped;
  return pyStrip(inner.replace(THINK, ""));
}

/** mem0 `extract_json`: a fenced block's body, else the outermost `{...}`, else the text. */
export function extractJson(text: string): string {
  const stripped = pyStrip(text);
  const fenced = JSON_FENCE.exec(stripped);
  if (fenced) return fenced[1] as string;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  return start !== -1 && end !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
}

/**
 * The extraction's `memory` value, exactly as mem0 reads it: any JSON value, `[]` when the reply is
 * empty or unparseable (logged). Callers must iterate it the way Python would.
 */
export function parseExtraction(content: unknown): unknown {
  try {
    const text = removeCodeBlocks(content);
    if (!text || !pyStrip(text)) return [];
    let parsed: unknown;
    try {
      parsed = pyJsonLoads(text);
    } catch (error) {
      if (!(error instanceof Error && error.name === "JSONDecodeError")) throw error;
      parsed = pyJsonLoads(extractJson(text));
    }
    return pyGet(parsed, "memory", []);
  } catch (error) {
    logger.error(`Error parsing extraction response: ${errorText(error)}`);
    return [];
  }
}

/** `hashlib.md5(text.encode()).hexdigest()`. */
export function md5Hex(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}
