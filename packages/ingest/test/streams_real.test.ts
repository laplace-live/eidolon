// fixtures/streams-real.golden.json holds what parsing the real transcripts gives: counts and
// hashes, no text. Transcripts added since are left out. It skips when the transcripts it lists
// are absent or changed, unless EIDOLON_REQUIRE_PARITY=1.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pyJsonDumps, pyStr } from "@eidolon/config";
import { iterStreams } from "../src/index.ts";

const golden = (await Bun.file(
  join(import.meta.dir, "fixtures/streams-real.golden.json"),
).json()) as {
  streams: number;
  chunks: number;
  ids_headings_sha256: string;
  ids_texts_sha256: string;
  metadata_sha256: string;
  files_sha256: string[];
};
const STREAMS = join(process.env.EIDOLON_REAL_HOME ?? "", "sources/milky-green/streams");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const REPRINT =
  "uv run python packages/ingest/test/fixtures/streams-real.golden.py > " +
  "packages/ingest/test/fixtures/streams-real.golden.json";

/** The names of the transcripts in `dir` whose name and bytes the golden hashed. */
function listedTranscripts(dir: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(dir)) return names;
  const listed = new Set(golden.files_sha256);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const digest = createHash("sha256")
      .update(name, "utf8")
      .update("\0")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
    if (listed.has(digest)) names.add(name);
  }
  return names;
}

const present = existsSync(STREAMS);
const listed = listedTranscripts(STREAMS);
const missing = golden.files_sha256.length - listed.size;

test.skipIf(missing > 0 && !REQUIRED)(
  "iterStreams reproduces Python's chunk ids, headings, texts and metadata on every transcript the golden lists",
  () => {
    expect(present, `no transcripts at ${STREAMS}`).toBe(true);
    expect(
      missing,
      `transcripts the golden lists are missing or changed; reprint it: ${REPRINT}`,
    ).toBe(0);
    const streams = iterStreams(STREAMS).filter((s) => listed.has(basename(s.mdPath)));
    const headings = createHash("sha256");
    const texts = createHash("sha256");
    const metadata = createHash("sha256");
    let chunks = 0;
    for (const stream of streams) {
      const meta = Object.fromEntries(
        Object.entries(stream.metadata).map(([k, v]) => [k, pyStr(v)]),
      );
      metadata.update(`${pyJsonDumps([stream.streamId, meta], { ensureAscii: false })}\n`);
      for (const chunk of stream.chunks) {
        chunks++;
        headings.update(`${pyJsonDumps([chunk.id, chunk.heading], { ensureAscii: false })}\n`);
        texts.update(`${pyJsonDumps([chunk.id, chunk.text], { ensureAscii: false })}\n`);
      }
    }
    expect({
      streams: streams.length,
      chunks,
      ids_headings_sha256: headings.digest("hex"),
      ids_texts_sha256: texts.digest("hex"),
      metadata_sha256: metadata.digest("hex"),
    }).toEqual({
      streams: golden.streams,
      chunks: golden.chunks,
      ids_headings_sha256: golden.ids_headings_sha256,
      ids_texts_sha256: golden.ids_texts_sha256,
      metadata_sha256: golden.metadata_sha256,
    });
  },
  120_000,
);
