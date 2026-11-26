// fixtures/ingest_streams.golden.json holds what the stream ingest and the catalog build make of
// the synthetic transcripts in fixtures/ingest_streams/inputs.json (rows, logs, tables, files),
// with the embedding call stubbed by the fake below. Logs and argv write "<STREAMS>" and "<TMP>"
// for the run's folders.
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type EmbeddingModel, EmbeddingUsage } from "@eidolon/providers";
import { DEFAULT_EMBED_MODEL, openTable, type ZvecTable } from "@eidolon/retrieval";
import { expect } from "vitest";
import { expectVectorsClose } from "../../retrieval/test/helpers.ts";
import { fakeVector } from "../../retrieval/test/write_golden.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

export interface GoldenTable {
  readonly rows: Record<string, unknown>[];
  readonly vectors_f32_hex: string[];
}

export interface GoldenRun {
  readonly name: string;
  readonly argv: string[];
  readonly exit_code: number;
  readonly logs: [string, string][];
  readonly embed_calls: number[];
  readonly table?: GoldenTable | null;
  readonly text?: string | null;
}

export interface IngestStreamsGolden {
  readonly printed_by: string;
  readonly load_streams: {
    readonly skip_types: string[];
    readonly rows: Record<string, unknown>[];
    readonly logs: [string, string][];
  }[];
  readonly ingest: GoldenRun[];
  readonly catalog: GoldenRun[];
  /** Each command's usage and help, as argparse lays them out. */
  readonly help: Record<"ingest_streams" | "build_stream_catalog", [string, string]>;
}

export const GOLDEN = JSON.parse(
  await readFile(join(FIXTURES, "ingest_streams.golden.json"), "utf8"),
) as IngestStreamsGolden;

const INPUTS = JSON.parse(
  await readFile(join(FIXTURES, "ingest_streams", "inputs.json"), "utf8"),
) as Record<"streams" | "bad_date", Record<string, string>>;

/** The golden's dimension: it was printed with EMBED_DIM=4. */
export const GOLDEN_DIM = 4;
export const GOLDEN_MODEL = DEFAULT_EMBED_MODEL;

/** Writes the fixture's files into `folder`, which must not exist yet. */
export function materialize(set: "streams" | "bad_date", folder: string): string {
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(INPUTS[set])) writeFileSync(join(folder, name), text);
  return folder;
}

/** The golden's stubbed embedding model; `calls` records each batch's size. */
export function fakeModel(calls: number[]): EmbeddingModel {
  return {
    provider: "openrouter",
    model: GOLDEN_MODEL,
    async embed(texts, dimensions) {
      if (dimensions !== GOLDEN_DIM) throw new Error(`unexpected dimensions ${dimensions}`);
      calls.push(texts.length);
      const n = texts.length;
      const usage = new EmbeddingUsage({
        promptTokens: 7 * n,
        totalTokens: 7 * n,
        costUsd: 0.000001 * n,
        costSource: "openrouter",
      });
      return [texts.map(fakeVector), usage];
    },
  };
}

/** A table's rows without their vectors, in scan order, and each vector's float32 bytes in hex. */
export async function readTable(dbPath: string, name = "stream_chunks"): Promise<GoldenTable> {
  const table = (await openTable(dbPath, name)) as ZvecTable;
  const back = table.readAll({ includeVectors: true });
  const vectors_f32_hex: string[] = [];
  for (let i = 0; i < back.rows.length; i++) {
    const vector = back.vectors.subarray(i * table.vectorDim, (i + 1) * table.vectorDim);
    vectors_f32_hex.push(
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("hex"),
    );
  }
  return { rows: back.rows, vectors_f32_hex };
}

function hexToFloat32(hexRows: readonly string[]): Float32Array {
  const bytes = Buffer.concat(hexRows.map((hex) => Buffer.from(hex, "hex")));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Asserts exact scalar rows and float32 vectors within Zvec COSINE's 1-2 ULP norm round-trip. */
export function expectGoldenTable(actual: GoldenTable, expected: GoldenTable): void {
  expect(actual.rows).toEqual(expected.rows);
  expectVectorsClose(hexToFloat32(actual.vectors_f32_hex), hexToFloat32(expected.vectors_f32_hex));
}

/** Maps a golden write-side log list from `.lance` / FTS wording to Zvec's. */
export function portIngestLogs(logs: readonly [string, string][]): [string, string][] {
  return logs.map(([level, message]) => [
    level,
    message
      .replace(/\.lance$/, ".zvec")
      .replace(/^Built FTS index on 'tokens' for /, "Built HNSW and FTS indexes for "),
  ]);
}

/** Each placeholder replaced by its path. */
export function substitute(text: string, paths: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [placeholder, path] of Object.entries(paths)) out = out.replaceAll(placeholder, path);
  return out;
}

/** Each path replaced by its placeholder, in the order given: list a folder before its parent. */
export function placehold(text: string, paths: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [placeholder, path] of Object.entries(paths)) out = out.replaceAll(path, placeholder);
  return out;
}

/** `"built_at": "<BUILT_AT>"`, as the golden masks it. */
export function maskBuiltAt(text: string): string {
  return text.replace(/"built_at": "[^"]*"/, '"built_at": "<BUILT_AT>"');
}
