// A file on disk answered in the byte ranges a media player asks for: Safari plays audio only from
// a server that takes ranges.
import { openAsBlob } from "node:fs";

/** `bytes=first-last`, `bytes=first-` or `bytes=-length`; a list of several doesn't match. */
const ONE_RANGE = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i;

/**
 * The one range `header` asks of `size` bytes, as [first, last]: "unsatisfiable" when it starts at
 * or past the end, or asks for the last 0 bytes; null to send the whole file, for no header,
 * several ranges, or one that doesn't parse (RFC 9110 has a server ignore those).
 */
function byteRange(
  header: string | null,
  size: number,
): readonly [number, number] | "unsatisfiable" | null {
  const match = header === null ? null : ONE_RANGE.exec(header);
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "") {
    if (last === "") return null;
    const length = Number(last);
    if (length === 0) return "unsatisfiable";
    return size === 0 ? null : [Math.max(0, size - length), size - 1];
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) return "unsatisfiable";
  return [start, last === "" ? size - 1 : Math.min(Number(last), size - 1)];
}

/**
 * The file at `path` as the answer to `request`, with `headers`: the one range a GET asks for
 * (206), 416 for a range past its end, else the whole file (200).
 */
export async function fileResponse(
  request: Request,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  const file = await openAsBlob(path);
  const size = file.size;
  // Only a GET is answered in part, and never under If-Range: no validator is sent for it to match.
  const range =
    request.method === "GET" && !request.headers.has("if-range")
      ? byteRange(request.headers.get("range"), size)
      : null;
  const common = { ...headers, "accept-ranges": "bytes" };
  if (range === null) {
    return new Response(file, { headers: { ...common, "content-length": String(size) } });
  }
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...common, "content-range": `bytes */${size}` },
    });
  }
  const [first, last] = range;
  return new Response(file.slice(first, last + 1), {
    status: 206,
    headers: {
      ...common,
      "content-range": `bytes ${first}-${last}/${size}`,
      "content-length": String(last - first + 1),
    },
  });
}
