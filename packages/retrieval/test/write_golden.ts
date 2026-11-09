// fixtures/write_side.golden.json pins the write side: the embedding cache's keys, blobs and file,
// the batch-embedding scenarios and totals, and each table's schema, rows, FTS index and versions.
import { join } from "node:path";
import type { DataType, Field } from "apache-arrow";
import type { ArrowSchema, CostSource } from "../src/index.ts";

export interface GoldenScenario {
  name: string;
  noun: string;
  texts: string[];
  batch_size: number;
  seeded: number[];
  use_cache: boolean;
  usages: [number, number, number, CostSource][];
  messages: string[];
  calls: { texts: string[]; model: string; dimensions: number }[];
  vectors_f32_hex: string[];
  total: [number, number, number, CostSource];
  cache_count: number | null;
  cache_blobs: Record<string, string | null>;
}

export interface GoldenTable {
  rows: Record<string, unknown>[];
  indices: [string, string, string[], Record<string, unknown>][];
  versions: number[];
  manifests: string[];
  read_back: Record<string, unknown>[];
  vectors_f32_hex: string[];
}

export interface WriteGolden {
  printed_by: string;
  keys: [string, number, string, string][];
  blobs: [number[], string][];
  cache_file: { sql: string; journal_mode: string };
  tables: { persona_facts: GoldenTable; stream_chunks: GoldenTable };
  scenarios: GoldenScenario[];
  totals: Record<string, string>;
  schemas: Record<string, { metadata: Record<string, string>; fields: unknown[][] }>;
}

export const WRITE_GOLDEN = (await Bun.file(
  join(import.meta.dir, "fixtures", "write_side.golden.json"),
).json()) as WriteGolden;

/** The golden's dimension: it was printed with EMBED_DIM=4. */
export const GOLDEN_DIM = 4;

/** The golden's stub embedding, with the same float64 arithmetic. */
export function fakeVector(text: string): number[] {
  let sum = 0;
  for (const c of text) sum += c.codePointAt(0) as number;
  const base = sum % 97;
  // `0 - base`, never `-base`: the golden holds 0 where `-base` would give -0.
  return [base / 7, (0 - base) / 3, 0.1 * base, 1 / (base + 3)];
}

/** pyarrow's `str()` of a type, for the types the two schemas use. */
function pyType(type: DataType): string {
  const name = String(type);
  if (name === "Utf8") return "string";
  if (name === "Bool") return "bool";
  if (name === "Int32") return "int32";
  if (name === "Float32") return "float";
  const item = type.children[0] as Field;
  const size = (type as unknown as { listSize: number }).listSize;
  return `fixed_size_list<${item.name}: ${pyType(item.type)}>[${size}]`;
}

/** A schema as the golden describes pyarrow's: name, type, nullability, and the list's item. */
export function describeSchema(schema: ArrowSchema): {
  metadata: Record<string, string>;
  fields: unknown[][];
} {
  return {
    metadata: Object.fromEntries(schema.metadata),
    fields: schema.fields.map((f) => {
      const item = f.type.children?.[0] as Field | undefined;
      const entry: unknown[] = [f.name, pyType(f.type), f.nullable];
      return item === undefined ? entry : [...entry, item.name, pyType(item.type), item.nullable];
    }),
  };
}

/** Each `dim`-wide row of `vectors` as the hex of its float32 bytes. */
export function rowsHex(vectors: Float32Array, dim: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < vectors.length; i += dim) {
    const row = vectors.subarray(i, i + dim);
    rows.push(Buffer.from(row.buffer, row.byteOffset, row.byteLength).toString("hex"));
  }
  return rows;
}
