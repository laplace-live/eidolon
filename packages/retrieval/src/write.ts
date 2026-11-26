// The write side of the two Zvec tables: their scalar and HNSW/FTS schemas, strict column checks,
// and the atomic pointer swap (`<table.zvec>/<buildId>` + `CURRENT`) the offline ingests run.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { logger, pyPath, pyRepr } from "@eidolon/config";
import {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  type ZVecDocInput,
  type ZVecFieldSchema,
  ZVecIndexType,
  ZVecMetricType,
} from "@zvec/zvec";
import { CURRENT_FILE, closeReadTablesUnder, initZvecOnce, tableDir } from "./tables.ts";

export type ScalarKind = "string" | "int32" | "bool";
export type ScalarIndex = "invert" | "invert-range" | "fts";

export interface FieldSpec {
  readonly name: string;
  readonly kind: ScalarKind;
  readonly nullable: boolean;
  readonly index?: ScalarIndex;
}

export interface TableSchema {
  readonly fields: readonly FieldSpec[];
  readonly vectorDim: number;
}

const WRITE_BATCH = 512;
let buildSeq = 0;

const field = (name: string, kind: ScalarKind, index?: ScalarIndex): FieldSpec =>
  index === undefined ? { name, kind, nullable: true } : { name, kind, nullable: true, index };

export function personaFactsSchema(dim: number): TableSchema {
  return {
    fields: [
      field("id", "string", "invert"),
      field("source", "string", "invert"),
      field("date", "string", "invert-range"),
      field("floor", "int32"),
      field("text", "string"),
      field("tokens", "string", "fts"),
    ],
    vectorDim: dim,
  };
}

export function streamChunksSchema(dim: number): TableSchema {
  return {
    fields: [
      field("id", "string", "invert"),
      field("stream_id", "string", "invert"),
      field("stream_date", "string", "invert-range"),
      field("heading", "string"),
      field("text", "string"),
      field("summary", "string"),
      field("details", "string"),
      field("chunk_type", "string", "invert"),
      field("topics", "string"),
      field("mentions", "string"),
      field("extras_json", "string"),
      field("refined", "bool"),
      field("tokens", "string", "fts"),
      field("source_path", "string"),
    ],
    vectorDim: dim,
  };
}

function zvecField(spec: FieldSpec): ZVecFieldSchema {
  const dataType =
    spec.kind === "string"
      ? ZVecDataType.STRING
      : spec.kind === "int32"
        ? ZVecDataType.INT32
        : ZVecDataType.BOOL;
  const indexParams: ZVecFieldSchema["indexParams"] =
    spec.index === "fts"
      ? // Whitespace splitting with no filters keeps jieba's boundaries and BV-id letter case.
        { indexType: ZVecIndexType.FTS, tokenizerName: "whitespace", filters: [] }
      : spec.index === "invert-range"
        ? { indexType: ZVecIndexType.INVERT, enableRangeOptimization: true }
        : spec.index === "invert"
          ? { indexType: ZVecIndexType.INVERT, enableRangeOptimization: false }
          : undefined;
  return {
    name: spec.name,
    dataType,
    nullable: spec.nullable,
    ...(indexParams ? { indexParams } : {}),
  };
}

function buildZvecSchema(name: string, schema: TableSchema): ZVecCollectionSchema {
  return new ZVecCollectionSchema({
    name,
    fields: schema.fields.map(zvecField),
    vectors: [
      {
        name: "vector",
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: schema.vectorDim,
        indexParams: {
          indexType: ZVecIndexType.HNSW,
          metricType: ZVecMetricType.COSINE,
          m: 32,
          efConstruction: 200,
        },
      },
    ],
  });
}

const TYPE_LABEL: Record<ScalarKind, string> = {
  string: "Utf8",
  bool: "Bool",
  int32: "Int32",
};

function accepts(kind: ScalarKind, value: unknown): boolean {
  if (kind === "string") return typeof value === "string";
  if (kind === "bool") return typeof value === "boolean";
  return Number.isInteger(value) && (value as number) >= -(2 ** 31) && (value as number) < 2 ** 31;
}

function validateInputs(
  rows: readonly object[],
  schema: TableSchema,
  vectors: Float32Array,
): Record<string, string | number | boolean>[] {
  const dim = schema.vectorDim;
  if (vectors.length !== rows.length * dim) {
    throw new RangeError(
      `${vectors.length} vector values for ${rows.length} rows of ${dim} dimensions`,
    );
  }
  return rows.map((raw, i) => {
    const row = raw as Record<string, unknown>;
    const fields: Record<string, string | number | boolean> = {};
    for (const spec of schema.fields) {
      const value = row[spec.name];
      if (value === undefined) throw new Error(`Row ${i} has no ${spec.name}`);
      if (value === null) {
        if (!spec.nullable) throw new TypeError(`Row ${i}'s ${spec.name} cannot be null`);
        // Zvec stores NULL on a nullable column when the key is omitted from `fields`.
        continue;
      }
      if (!accepts(spec.kind, value)) {
        throw new TypeError(
          `Row ${i}'s ${spec.name} is ${pyRepr(value)}, not ${TYPE_LABEL[spec.kind]}`,
        );
      }
      fields[spec.name] = value as string | number | boolean;
    }
    return fields;
  });
}

function writePointerAtomic(root: string, buildId: string): void {
  const target = join(root, CURRENT_FILE);
  const tmp = `${target}.${process.pid}.${++buildSeq}.tmp`;
  try {
    writeFileSync(tmp, `${buildId}\n`, "utf8");
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never written.
    }
    throw error;
  }
}

function pruneOldBuilds(root: string, keepBuildId: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (entry === CURRENT_FILE || entry === keepBuildId || entry.endsWith(".tmp")) continue;
    const oldPath = join(root, entry);
    closeReadTablesUnder(oldPath);
    try {
      rmSync(oldPath, { recursive: true, force: true });
    } catch {
      // Another process still holds a read-only mmap on this build; the next rebuild cleans it up.
    }
  }
}

/**
 * Replaces table `name` in `dbPath` with `rows`, in order, and `vectors` (row i's at
 * `[i * dim, (i + 1) * dim)`), then seals the HNSW and FTS indexes and flips `CURRENT`. Each row
 * holds the schema's columns minus `vector` by name; other keys, such as `embed_input`, are
 * ignored. Validation and collection build run in a fresh `<buildId>` directory before `CURRENT`
 * moves, so a bad row or an aborted run leaves the previous build untouched.
 */
export async function writeTable(
  dbPath: string,
  name: string,
  rows: readonly object[],
  schema: TableSchema,
  vectors: Float32Array,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const validated = validateInputs(rows, schema, vectors);
  options.signal?.throwIfAborted();

  initZvecOnce();
  const root = tableDir(dbPath, name);
  const buildId = `${Date.now()}-${process.pid}-${++buildSeq}`;
  const buildPath = join(root, buildId);
  mkdirSync(root, { recursive: true });

  const dim = schema.vectorDim;
  let col: ReturnType<typeof ZVecCreateAndOpen> | null = null;
  let closed = false;
  try {
    col = ZVecCreateAndOpen(buildPath, buildZvecSchema(name, schema), {
      readOnly: false,
      enableMMAP: true,
    });
    for (let start = 0; start < validated.length; start += WRITE_BATCH) {
      options.signal?.throwIfAborted();
      const end = Math.min(validated.length, start + WRITE_BATCH);
      const batch: ZVecDocInput[] = [];
      for (let i = start; i < end; i++) {
        batch.push({
          id: String(i),
          vectors: { vector: vectors.subarray(i * dim, (i + 1) * dim) },
          fields: validated[i] as Record<string, string | number | boolean>,
        });
      }
      const statuses = col.upsertSync(batch);
      for (const status of statuses) {
        if (!status.ok) {
          throw new Error(`Zvec upsert failed (${status.code}): ${status.message}`);
        }
      }
    }
    await col.optimize();
    options.signal?.throwIfAborted();
    col.closeSync();
    closed = true;
    writePointerAtomic(root, buildId);
  } catch (error) {
    if (col !== null && !closed) {
      try {
        col.closeSync();
      } catch {
        // Best-effort close before removing the partial build.
      }
    }
    rmSync(buildPath, { recursive: true, force: true });
    throw error;
  }

  pruneOldBuilds(root, buildId);
  logger.info(`Wrote ${rows.length} rows to ${pyPath(dbPath)}/${name}.zvec`);
  logger.info(`Built HNSW and FTS indexes for ${name}`);
}
