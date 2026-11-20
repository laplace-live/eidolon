// A file in the byte ranges a media player asks for: one range is a 206, one past the end a 416,
// and no range, several, or one that doesn't parse is the whole file.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fileResponse } from "../../src/local/ranges.ts";

let dir: string;
let ten: string;
let empty: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eidolon-ranges-"));
  ten = join(dir, "ten.webm");
  empty = join(dir, "empty.webm");
  writeFileSync(ten, "0123456789");
  writeFileSync(empty, "");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

async function answer(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Answer> {
  const request = new Request("http://127.0.0.1/file", { method, headers });
  const response = await fileResponse(request, path, { "content-type": "audio/webm" });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    // A server sends a HEAD answer's headers alone.
    body: method === "HEAD" ? null : await response.text(),
  };
}

describe("fileResponse", () => {
  test("one range, from both ends or the end alone, is a 206 of exactly those bytes", async () => {
    for (const [range, first, last] of [
      ["bytes=2-5", 2, 5],
      ["bytes=2-", 2, 9],
      ["bytes=-3", 7, 9],
      ["bytes=9-9", 9, 9],
      ["bytes=0-", 0, 9],
      ["bytes=0-100", 0, 9],
      ["bytes=-100", 0, 9],
      ["BYTES = 2 - 5", 2, 5],
    ] as const) {
      expect([range, await answer(ten, { range })]).toEqual([
        range,
        {
          status: 206,
          headers: {
            "content-type": "audio/webm",
            "accept-ranges": "bytes",
            "content-range": `bytes ${first}-${last}/10`,
            "content-length": String(last - first + 1),
          },
          body: "0123456789".slice(first, last + 1),
        },
      ]);
    }
  });

  test("a range that starts at or past the end, or asks for the last 0 bytes, is a 416", async () => {
    for (const [path, range, size] of [
      [ten, "bytes=10-", 10],
      [ten, "bytes=12-20", 10],
      [ten, "bytes=-0", 10],
      [empty, "bytes=0-", 0],
      [empty, "bytes=2-5", 0],
    ] as const) {
      expect([range, await answer(path, { range })]).toEqual([
        range,
        {
          status: 416,
          headers: {
            "content-type": "audio/webm",
            "accept-ranges": "bytes",
            "content-range": `bytes */${size}`,
          },
          body: "",
        },
      ]);
    }
  });

  test("no range, several, one that doesn't parse, or one under If-Range is the whole file", async () => {
    const cases: [string, string, Record<string, string>][] = [
      ["none", ten, {}],
      ["several", ten, { range: "bytes=0-1,3-4" }],
      ["backwards", ten, { range: "bytes=5-2" }],
      ["another unit", ten, { range: "items=0-1" }],
      ["no numbers", ten, { range: "bytes=-" }],
      ["not a number", ten, { range: "bytes=abc" }],
      ["a sign", ten, { range: "bytes=+2-5" }],
      ["If-Range", ten, { range: "bytes=2-5", "if-range": '"some-etag"' }],
      ["the end of nothing", empty, { range: "bytes=-3" }],
    ];
    for (const [label, path, headers] of cases) {
      const whole = path === ten ? "0123456789" : "";
      expect([label, await answer(path, headers)]).toEqual([
        label,
        {
          status: 200,
          headers: {
            "content-type": "audio/webm",
            "accept-ranges": "bytes",
            "content-length": String(whole.length),
          },
          body: whole,
        },
      ]);
    }
  });

  test("HEAD answers as a GET of the whole file would, its Range ignored", async () => {
    const variants: Record<string, string>[] = [{}, { range: "bytes=2-5" }, { range: "bytes=10-" }];
    for (const headers of variants) {
      expect(await answer(ten, headers, "HEAD")).toEqual({
        status: 200,
        headers: { "content-type": "audio/webm", "accept-ranges": "bytes", "content-length": "10" },
        body: null,
      });
    }
  });
});
