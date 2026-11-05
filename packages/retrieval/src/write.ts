// The write side of the two LanceDB tables: their Arrow schemas, and the drop-and-rebuild the
// offline ingests run, which reproduces the tables and FTS index Python's ingests built.
import { mkdirSync } from "node:fs";
import { logger, pyPath, pyRepr } from "@eidolon/config";
import * as lancedb from "@lancedb/lancedb";
import {
  Table as ArrowTable,
  Bool,
  type Data,
  DataType,
  Field,
  FixedSizeList,
  Float32,
  Int32,
  makeData,
  RecordBatch,
  Schema,
  Struct,
  Utf8,
  vectorFromArray,
} from "apache-arrow";
import { listTableNames } from "./tables.ts";

// pyarrow's fields are nullable unless told otherwise, apache-arrow's are not.
function utf8(name: string): Field {
  return new Field(name, new Utf8(), true);
}

function vectorField(dim: number): Field {
  return new Field("vector", new FixedSizeList(dim, new Field("item", new Float32(), true)), true);
}

/** The `persona_facts` columns, in Python's order. */
export function personaFactsSchema(dim: number): Schema {
  return new Schema([
    utf8("id"),
    utf8("source"),
    utf8("date"),
    new Field("floor", new Int32(), true),
    utf8("text"),
    utf8("tokens"),
    vectorField(dim),
  ]);
}

/** The `stream_chunks` columns, in Python's order. */
export function streamChunksSchema(dim: number): Schema {
  return new Schema([
    utf8("id"),
    utf8("stream_id"),
    utf8("stream_date"),
    utf8("heading"),
    utf8("text"),
    utf8("summary"),
    utf8("details"),
    utf8("chunk_type"),
    utf8("topics"),
    utf8("mentions"),
    utf8("extras_json"),
    new Field("refined", new Bool(), true),
    utf8("tokens"),
    utf8("source_path"),
    vectorField(dim),
  ]);
}

// Whitespace splitting and no stemming keep jieba's boundaries; no lowercasing keeps BV ids and
// names case-distinct. Python set only those five; the rest are lance's defaults its index was
// built with, pinned.
const FTS_OPTIONS = {
  baseTokenizer: "whitespace",
  stem: false,
  removeStopWords: false,
  lowercase: false,
  withPosition: false,
  language: "English",
  maxTokenLength: 40,
  asciiFolding: true,
  ngramMinLength: 3,
  ngramMaxLength: 3,
  prefixOnly: false,
  blockSize: 128,
} as const;

/** `build_fts_index`: the index hybrid search runs against `field`, named `<field>_idx`. */
export async function buildFtsIndex(table: lancedb.Table, field = "tokens"): Promise<void> {
  await table.createIndex(field, { replace: true, config: lancedb.Index.fts(FTS_OPTIONS) });
}

// pyarrow refuses these where apache-arrow would coerce: a number to a string, 2**31 to -2**31.
function accepts(type: DataType, value: unknown): boolean {
  if (DataType.isUtf8(type)) return typeof value === "string";
  if (DataType.isBool(type)) return typeof value === "boolean";
  if (DataType.isInt(type) && type.isSigned && type.bitWidth === 32) {
    return (
      Number.isInteger(value) && (value as number) >= -(2 ** 31) && (value as number) < 2 ** 31
    );
  }
  return false;
}

function column(rows: readonly object[], field: Field): Data {
  const values = rows.map((row, i) => {
    const value = (row as Record<string, unknown>)[field.name];
    if (value === undefined) throw new Error(`Row ${i} has no ${field.name}`);
    if (value !== null && !accepts(field.type, value)) {
      throw new TypeError(`Row ${i}'s ${field.name} is ${pyRepr(value)}, not ${field.type}`);
    }
    return value;
  });
  return vectorFromArray(values as never[], field.type).data[0] as Data;
}

function arrowTable(rows: readonly object[], schema: Schema, vectors: Float32Array): ArrowTable {
  const children = schema.fields.map((field) => {
    if (field.name !== "vector") return column(rows, field);
    const dim = (field.type as FixedSizeList).listSize;
    if (vectors.length !== rows.length * dim) {
      throw new RangeError(
        `${vectors.length} vector values for ${rows.length} rows of ${dim} dimensions`,
      );
    }
    const values = { type: new Float32(), length: vectors.length, nullCount: 0, data: vectors };
    const child = makeData(values);
    return makeData({
      type: field.type as FixedSizeList,
      length: rows.length,
      nullCount: 0,
      child,
    });
  });
  const struct = new Struct(schema.fields);
  const data = makeData({ type: struct, length: rows.length, nullCount: 0, children });
  return new ArrowTable([new RecordBatch(schema, data)]);
}

/**
 * Replaces table `name` in `dbPath` with `rows`, in order, and `vectors` (row i's at
 * `[i * dim, (i + 1) * dim)`), then builds the FTS index. Each row holds the schema's columns but
 * `vector` by name; other keys, such as `embed_input`, are ignored. The old table is dropped,
 * never overwritten: a running bot's handle then fails with "Not found" and reopens, where an
 * overwrite's old files would keep serving stale rows. The new table is built and checked first,
 * so a bad row or an aborted run leaves the old one in place.
 */
export async function writeTable(
  dbPath: string,
  name: string,
  rows: readonly object[],
  schema: Schema,
  vectors: Float32Array,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const data = arrowTable(rows, schema, vectors);
  mkdirSync(dbPath, { recursive: true });
  const db = await lancedb.connect(dbPath);
  const exists = (await listTableNames(dbPath)).includes(name);
  // Once the old table is gone, finishing beats leaving none.
  options.signal?.throwIfAborted();
  if (exists) await db.dropTable(name);
  const table = await db.createTable(name, data);
  logger.info(`Wrote ${rows.length} rows to ${pyPath(dbPath)}/${name}.lance`);
  await buildFtsIndex(table);
  logger.info(`Built FTS index on 'tokens' for ${name}`);
}
