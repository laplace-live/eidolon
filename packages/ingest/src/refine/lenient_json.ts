// refine.py's last resort for a response body that strict `json.loads` refuses. Its error texts
// reach the logs, and a parsed float keeps Python's `str()` (1.0), so this parses with the Python
// scanner port rather than JSON.parse.
import { pyJsonLoads, pyLstrip, pyRawDecode } from "@eidolon/config";

const STRICT = { strict: true, floats: true } as const;

function isJsonDecodeError(error: unknown): error is Error {
  return error instanceof Error && error.name === "JSONDecodeError";
}

/**
 * Escapes raw control characters inside JSON string literals. Gemini's JSON mode emits literal
 * newlines inside string values, which strict parsing rejects; a whole-body rewrite would also hit
 * the newlines pretty-printed JSON puts between tokens.
 */
export function sanitizeJsonText(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      out += ch;
      inString = false;
    } else {
      const cp = ch.codePointAt(0) as number;
      if (cp >= 0x20) out += ch;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += `\\u${cp.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/** The first complete JSON value after leading whitespace, whatever follows it. */
export function parseFirstJsonValue(text: string): unknown {
  return pyRawDecode(pyLstrip(text), 0, STRICT)[0];
}

/**
 * `_parse_json_lenient`: a strict parse, then each repair in turn. Returns the value and the
 * repair that worked (null for a clean parse), or null and the strict pass's error, which is the
 * one that points at the fault.
 */
export function parseJsonLenient(content: string): [unknown, string | null] {
  let strictError: Error;
  try {
    return [pyJsonLoads(content, STRICT), null];
  } catch (error) {
    if (!isJsonDecodeError(error)) throw error;
    strictError = error;
  }
  const sanitized = sanitizeJsonText(content);
  const repairs: [() => unknown, string][] = [
    [() => pyJsonLoads(sanitized, STRICT), "sanitized"],
    [() => parseFirstJsonValue(content), "truncated_trailing"],
    [() => parseFirstJsonValue(sanitized), "sanitized+truncated"],
  ];
  for (const [attempt, note] of repairs) {
    try {
      return [attempt(), note];
    } catch (error) {
      if (!isJsonDecodeError(error)) throw error;
    }
  }
  return [null, strictError.message];
}
