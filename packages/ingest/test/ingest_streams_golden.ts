// fixtures/ingest_streams.golden.json is what fixtures/ingest_streams/golden.py printed through
// tools/ingest_streams.py and tools/build_stream_catalog.py (its printed_by names the versions),
// over the synthetic transcripts in fixtures/ingest_streams/inputs.json, with the embedding call
// stubbed by the fake below. Logs and argv write "<STREAMS>" and "<TMP>" for the run's folders.
// Reprint it with `uv run --offline --no-sync python packages/ingest/test/fixtures/ingest_streams/
// golden.py > packages/ingest/test/fixtures/ingest_streams.golden.json`, then Biome-format it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_EMBED_MODEL,
  type EmbeddingClient,
  EmbeddingUsage,
  type LanceTable,
  openTable,
} from "@eidolon/retrieval";

const FIXTURES = join(import.meta.dir, "fixtures");

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
  /** Each TS command's usage and help, as argparse lays them out. */
  readonly help: Record<"ingest_streams" | "build_stream_catalog", [string, string]>;
}

export const GOLDEN = (await Bun.file(
  join(FIXTURES, "ingest_streams.golden.json"),
).json()) as IngestStreamsGolden;

const INPUTS = (await Bun.file(join(FIXTURES, "ingest_streams", "inputs.json")).json()) as Record<
  "streams" | "bad_date",
  Record<string, string>
>;

/** The golden's dimension: it was printed with EMBED_DIM=4. */
export const GOLDEN_DIM = 4;
export const GOLDEN_MODEL = DEFAULT_EMBED_MODEL;

/** Writes the fixture's files into `folder`, which must not exist yet. */
export function materialize(set: "streams" | "bad_date", folder: string): string {
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(INPUTS[set])) writeFileSync(join(folder, name), text);
  return folder;
}

/** The generator's stub vector, with the same float64 arithmetic. */
function fakeVector(text: string): number[] {
  let sum = 0;
  for (const c of text) sum += c.codePointAt(0) as number;
  const base = sum % 97;
  // Python negates an int, which has no -0.
  return [base / 7, (0 - base) / 3, 0.1 * base, 1 / (base + 3)];
}

/** The generator's stubbed embed_texts_with_usage; `calls` records each batch's size. */
export function fakeClient(calls: number[]): Pick<EmbeddingClient, "embedWithUsage"> {
  return {
    async embedWithUsage(texts, options) {
      if (options.model !== GOLDEN_MODEL || options.dimensions !== GOLDEN_DIM) {
        throw new Error(`unexpected model ${options.model} at ${options.dimensions}`);
      }
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
  const table = (await openTable(dbPath, name)) as LanceTable;
  const data = await table.query().toArrow();
  const names = data.schema.fields.map((f) => f.name).filter((n) => n !== "vector");
  const rows: Record<string, unknown>[] = [];
  const vectors_f32_hex: string[] = [];
  for (const row of data) {
    rows.push(Object.fromEntries(names.map((n) => [n, row[n]])));
    const vector = row.vector.toArray() as Float32Array;
    vectors_f32_hex.push(
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("hex"),
    );
  }
  return { rows, vectors_f32_hex };
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
