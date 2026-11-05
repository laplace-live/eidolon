// The schemas and the written tables are compared with what Python's build_arrow_schema and
// write_table made of the same rows (write_golden.ts). The real tables are in write_real.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LanceTable,
  openTable,
  personaFactsSchema,
  streamChunksSchema,
  writeTable,
} from "../src/index.ts";
import { captureLogs, messages } from "./helpers.ts";
import {
  describeSchema,
  GOLDEN_DIM,
  type GoldenTable,
  rowsHex,
  WRITE_GOLDEN,
} from "./write_golden.ts";

const records = captureLogs();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-write-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SCHEMAS = { persona_facts: personaFactsSchema, stream_chunks: streamChunksSchema } as const;

function vectorsOf(rows: readonly Record<string, unknown>[]): Float32Array {
  return Float32Array.from(rows.flatMap((row) => row.vector as number[]));
}

async function readBack(table: LanceTable) {
  const data = await table.query().toArrow();
  const names = data.schema.fields.map((f) => f.name).filter((n) => n !== "vector");
  const rows = data.toArray().map((row) => Object.fromEntries(names.map((n) => [n, row[n]])));
  const vectors = new Float32Array(data.numRows * GOLDEN_DIM);
  data.toArray().forEach((row, i) => {
    vectors.set(row.vector.toArray() as Float32Array, i * GOLDEN_DIM);
  });
  return { schema: data.schema, rows, vectors };
}

test.each(Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[])(
  "%s has Python's columns, types and nullability",
  (name) => {
    expect(describeSchema(SCHEMAS[name](GOLDEN_DIM))).toEqual(
      WRITE_GOLDEN.schemas[name] as ReturnType<typeof describeSchema>,
    );
  },
);

describe.each(Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[])("writing %s", (name) => {
  const golden = WRITE_GOLDEN.tables[name] as GoldenTable;

  test("gives Python's rows, vectors, FTS index, versions and manifest names", async () => {
    await writeTable(dir, name, golden.rows, SCHEMAS[name](GOLDEN_DIM), vectorsOf(golden.rows));
    const table = (await openTable(dir, name)) as LanceTable;
    const back = await readBack(table);
    expect(describeSchema(back.schema)).toEqual(describeSchema(SCHEMAS[name](GOLDEN_DIM)));
    expect(back.rows).toEqual(golden.read_back);
    expect(rowsHex(back.vectors, GOLDEN_DIM)).toEqual(golden.vectors_f32_hex);
    const indices = (await table.listIndices()).map((i) => [
      i.name,
      i.indexType,
      i.columns,
      i.indexDetails,
    ]);
    expect(indices).toEqual(golden.indices);
    expect((await table.listVersions()).map((v) => v.version)).toEqual(golden.versions);
    expect(readdirSync(join(dir, `${name}.lance`, "_versions")).sort()).toEqual(golden.manifests);
    expect(messages(records, "INFO")).toEqual([
      `Wrote ${golden.rows.length} rows to ${dir}/${name}.lance`,
      `Built FTS index on 'tokens' for ${name}`,
    ]);
  });

  test("a rewrite drops the old table, so it starts again at version 1", async () => {
    const schema = SCHEMAS[name](GOLDEN_DIM);
    await writeTable(dir, name, golden.rows, schema, vectorsOf(golden.rows));
    const first = golden.rows.slice(0, 1);
    await writeTable(dir, name, first, schema, vectorsOf(first));
    const table = (await openTable(dir, name)) as LanceTable;
    expect(await table.countRows()).toBe(1);
    expect((await table.listVersions()).map((v) => v.version)).toEqual(golden.versions);
    expect(readdirSync(join(dir, `${name}.lance`, "_versions")).sort()).toEqual(golden.manifests);
  });
});

describe("a write that can't complete leaves the old table in place", () => {
  const golden = WRITE_GOLDEN.tables.persona_facts;
  const schema = personaFactsSchema(GOLDEN_DIM);
  const good = golden.rows;
  const one = (patch: Record<string, unknown>) => [{ ...good[0], ...patch }];

  const cases: [string, Record<string, unknown>[], Float32Array, RegExp][] = [
    ["a missing column", [{ ...good[0], text: undefined }], vectorsOf(one({})), /has no text/],
    [
      "a number in a string column",
      one({ source: 7 }),
      vectorsOf(one({})),
      /source is 7, not Utf8/,
    ],
    ["a string in int32", one({ floor: "3" }), vectorsOf(one({})), /floor is '3', not Int32/],
    ["int32 overflow", one({ floor: 2 ** 31 }), vectorsOf(one({})), /floor is 2147483648/],
    ["too few vector values", one({}), new Float32Array(3), /3 vector values for 1 rows of 4/],
  ];
  for (const [label, rows, vectors, error] of cases) {
    test(label, async () => {
      await writeTable(dir, "persona_facts", good, schema, vectorsOf(good));
      await expect(writeTable(dir, "persona_facts", rows, schema, vectors)).rejects.toThrow(error);
      const table = (await openTable(dir, "persona_facts")) as LanceTable;
      expect(await table.countRows()).toBe(good.length);
      expect((await table.listVersions()).map((v) => v.version)).toEqual([1, 2]);
    });
  }

  test("an aborted signal", async () => {
    await writeTable(dir, "persona_facts", good, schema, vectorsOf(good));
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const write = writeTable(dir, "persona_facts", one({}), schema, vectorsOf(one({})), {
      signal: controller.signal,
    });
    await expect(write).rejects.toThrow("stop");
    const table = (await openTable(dir, "persona_facts")) as LanceTable;
    expect(await table.countRows()).toBe(good.length);
  });

  test("a bool column refuses a number", async () => {
    const chunks = WRITE_GOLDEN.tables.stream_chunks.rows;
    const rows = [{ ...chunks[0], refined: 1 }];
    const write = writeTable(
      dir,
      "stream_chunks",
      rows,
      streamChunksSchema(GOLDEN_DIM),
      vectorsOf(rows),
    );
    await expect(write).rejects.toThrow(/refined is 1, not Bool/);
    expect(await openTable(dir, "stream_chunks")).toBeNull();
  });
});

test("null is written as null, as pyarrow writes None", async () => {
  const rows = [{ ...WRITE_GOLDEN.tables.persona_facts.rows[0], date: null, floor: null }];
  await writeTable(dir, "persona_facts", rows, personaFactsSchema(GOLDEN_DIM), vectorsOf(rows));
  const back = await readBack((await openTable(dir, "persona_facts")) as LanceTable);
  expect([back.rows[0]?.date, back.rows[0]?.floor]).toEqual([null, null]);
});

// An interface has no index signature, so it is not a Record<string, unknown>; rows may be one.
interface FactRow {
  readonly id: string;
  readonly source: string;
  readonly date: string;
  readonly floor: number;
  readonly text: string;
  readonly tokens: string;
  readonly vector: number[];
}

test("the folder is created, and the log names it as pathlib would", async () => {
  const db = join(dir, "personas", "x", "index");
  const rows = WRITE_GOLDEN.tables.persona_facts.rows as unknown as FactRow[];
  const vectors = Float32Array.from(rows.flatMap((row) => row.vector));
  await writeTable(`${db}/`, "facts", rows, personaFactsSchema(GOLDEN_DIM), vectors);
  expect(await (await openTable(db, "facts"))?.countRows()).toBe(rows.length);
  expect(messages(records, "INFO")[0]).toBe(`Wrote ${rows.length} rows to ${db}/facts.lance`);
});

test("the FTS index finds rows by their jieba tokens, case kept", async () => {
  const rows = WRITE_GOLDEN.tables.persona_facts.rows;
  await writeTable(dir, "persona_facts", rows, personaFactsSchema(GOLDEN_DIM), vectorsOf(rows));
  const table = (await openTable(dir, "persona_facts")) as LanceTable;
  const ids = async (q: string) =>
    (await table.search(q, "fts", "tokens").toArray()).map((r) => r.id);
  expect(await ids("坚果")).toEqual(expect.arrayContaining(["f0", "f1"]));
  expect(await ids("BV1x")).toEqual(["f2"]);
  expect(await ids("bv1x")).toEqual([]);
});
