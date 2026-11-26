// The schemas, and the tables written from the golden's rows, are compared with the golden
// (write_golden.ts). The real 3,072-dim vector cache and tables are in write_real.test.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZVecDataType } from "@zvec/zvec";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  closeAllReadTables,
  listTableNames,
  openTable,
  personaFactsSchema,
  streamChunksSchema,
  writeTable,
  type ZvecTable,
} from "../src/index.ts";
import { CURRENT_FILE, readCurrentBuildId } from "../src/tables.ts";
import { captureLogs, expectVectorsClose, messages } from "./helpers.ts";
import { describeSchema, GOLDEN_DIM, type GoldenTable, WRITE_GOLDEN } from "./write_golden.ts";

const records = captureLogs();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-write-"));
});
afterEach(() => {
  closeAllReadTables();
  rmSync(dir, { recursive: true, force: true });
});

const SCHEMAS = { persona_facts: personaFactsSchema, stream_chunks: streamChunksSchema } as const;

function vectorsOf(rows: readonly Record<string, unknown>[]): Float32Array {
  return Float32Array.from(rows.flatMap((row) => row.vector as number[]));
}

function persistedSchema(table: ZvecTable): ReturnType<typeof describeSchema> {
  const kindOf = (dt: ZVecDataType): string => {
    if (dt === ZVecDataType.STRING) return "string";
    if (dt === ZVecDataType.INT32) return "int32";
    if (dt === ZVecDataType.BOOL) return "bool";
    return String(dt);
  };
  const vec = table.collection.schema.vector("vector");
  return {
    metadata: {},
    fields: [
      ...table.collection.schema.fields().map((f) => [f.name, kindOf(f.dataType), f.nullable]),
      ["vector", `fixed_size_list<item: float>[${vec.dimension}]`, true, "item", "float", true],
    ],
  };
}

test.each(Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[])(
  "%s has the golden's columns, types and nullability",
  (name) => {
    expect(describeSchema(SCHEMAS[name](GOLDEN_DIM))).toEqual(
      WRITE_GOLDEN.schemas[name] as ReturnType<typeof describeSchema>,
    );
  },
);

describe.each(Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[])("writing %s", (name) => {
  const golden = WRITE_GOLDEN.tables[name] as GoldenTable;

  test("preserves rows, float32 vectors, HNSW + FTS indexes, and the CURRENT build pointer", async () => {
    await writeTable(dir, name, golden.rows, SCHEMAS[name](GOLDEN_DIM), vectorsOf(golden.rows));
    const table = (await openTable(dir, name)) as ZvecTable;
    const back = table.readAll({ includeVectors: true });
    expect(persistedSchema(table)).toEqual(describeSchema(SCHEMAS[name](GOLDEN_DIM)));
    expect(back.rows).toEqual(golden.read_back);
    expectVectorsClose(back.vectors, vectorsOf(golden.rows));

    const buildId = readCurrentBuildId(dir, name) as string;
    expect(buildId).toBeTruthy();
    expect(readdirSync(join(dir, `${name}.zvec`)).sort()).toEqual([CURRENT_FILE, buildId].sort());
    expect(messages(records, "INFO")).toEqual([
      `Wrote ${golden.rows.length} rows to ${dir}/${name}.zvec`,
      `Built HNSW and FTS indexes for ${name}`,
    ]);
  });

  test("a rewrite swaps CURRENT to a new buildId and prunes the old build directory", async () => {
    const schema = SCHEMAS[name](GOLDEN_DIM);
    await writeTable(dir, name, golden.rows, schema, vectorsOf(golden.rows));
    const firstBuild = readCurrentBuildId(dir, name) as string;
    const first = golden.rows.slice(0, 1);
    await writeTable(dir, name, first, schema, vectorsOf(first));
    const secondBuild = readCurrentBuildId(dir, name) as string;
    expect(secondBuild).not.toBe(firstBuild);
    const table = (await openTable(dir, name)) as ZvecTable;
    expect(await table.countRows()).toBe(1);
    expect(readdirSync(join(dir, `${name}.zvec`)).sort()).toEqual(
      [CURRENT_FILE, secondBuild].sort(),
    );
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
      const beforeBuild = readCurrentBuildId(dir, "persona_facts");
      await expect(writeTable(dir, "persona_facts", rows, schema, vectors)).rejects.toThrow(error);
      const table = (await openTable(dir, "persona_facts")) as ZvecTable;
      expect(await table.countRows()).toBe(good.length);
      expect(readCurrentBuildId(dir, "persona_facts")).toBe(beforeBuild);
    });
  }

  test("an aborted signal", async () => {
    await writeTable(dir, "persona_facts", good, schema, vectorsOf(good));
    const beforeBuild = readCurrentBuildId(dir, "persona_facts");
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const write = writeTable(dir, "persona_facts", one({}), schema, vectorsOf(one({})), {
      signal: controller.signal,
    });
    await expect(write).rejects.toThrow("stop");
    const table = (await openTable(dir, "persona_facts")) as ZvecTable;
    expect(await table.countRows()).toBe(good.length);
    expect(readCurrentBuildId(dir, "persona_facts")).toBe(beforeBuild);
  });

  test("a signal aborted during Zvec optimize cleans up the partial build and keeps CURRENT", async () => {
    await writeTable(dir, "persona_facts", good, schema, vectorsOf(good));
    const beforeBuild = readCurrentBuildId(dir, "persona_facts") as string;
    const controller = new AbortController();
    const pending = writeTable(dir, "persona_facts", one({}), schema, vectorsOf(one({})), {
      signal: controller.signal,
    });
    // `writeTable` runs synchronously into `await col.optimize()`, so aborting now cancels post-open.
    controller.abort(new DOMException("stop-after-open", "AbortError"));
    await expect(pending).rejects.toThrow("stop-after-open");
    const table = (await openTable(dir, "persona_facts")) as ZvecTable;
    expect(await table.countRows()).toBe(good.length);
    expect(readCurrentBuildId(dir, "persona_facts")).toBe(beforeBuild);
    expect(readdirSync(join(dir, "persona_facts.zvec")).sort()).toEqual(
      [CURRENT_FILE, beforeBuild].sort(),
    );
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

test("null is written and read back as null, distinct from an empty string", async () => {
  const rows = [
    { ...WRITE_GOLDEN.tables.persona_facts.rows[0], date: null, floor: null },
    { ...WRITE_GOLDEN.tables.persona_facts.rows[1], date: "", floor: 0 },
  ];
  await writeTable(dir, "persona_facts", rows, personaFactsSchema(GOLDEN_DIM), vectorsOf(rows));
  const table = (await openTable(dir, "persona_facts")) as ZvecTable;
  const back = table.readAll();
  expect([back.rows[0]?.date, back.rows[0]?.floor]).toEqual([null, null]);
  expect([back.rows[1]?.date, back.rows[1]?.floor]).toEqual(["", 0]);
});

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
  expect(messages(records, "INFO")[0]).toBe(`Wrote ${rows.length} rows to ${db}/facts.zvec`);
});

test("the FTS index finds rows by their jieba tokens, case kept", async () => {
  const rows = WRITE_GOLDEN.tables.persona_facts.rows;
  await writeTable(dir, "persona_facts", rows, personaFactsSchema(GOLDEN_DIM), vectorsOf(rows));
  const table = (await openTable(dir, "persona_facts")) as ZvecTable;
  const ids = async (q: string) => {
    const docs = await table.collection.query({
      fieldName: "tokens",
      fts: { matchString: q },
      topk: 10,
      outputFields: ["id"],
    });
    return docs.map((d) => String(d.fields.id)).sort();
  };
  expect(await ids("坚果")).toEqual(["f0", "f1"]);
  expect(await ids("BV1x")).toEqual(["f2"]);
  expect(await ids("bv1x")).toEqual([]);
});

test("leaves legacy .lance tables and __manifest untouched alongside .zvec", async () => {
  const legacyFiles = [
    ["persona_facts.lance", "data.lance", "legacy-facts-bytes"],
    ["stream_chunks.lance", "data.lance", "legacy-streams-bytes"],
    ["__manifest", "1.manifest", "legacy-manifest-bytes"],
  ] as const;
  for (const [folder, file, content] of legacyFiles) {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, file), content, "utf8");
  }

  const rows = WRITE_GOLDEN.tables.persona_facts.rows;
  const schema = personaFactsSchema(GOLDEN_DIM);
  await writeTable(dir, "persona_facts", rows, schema, vectorsOf(rows));
  await writeTable(dir, "persona_facts", rows.slice(0, 1), schema, vectorsOf(rows.slice(0, 1)));

  expect(await listTableNames(dir)).toEqual(["persona_facts"]);
  expect(await (await openTable(dir, "persona_facts"))?.countRows()).toBe(1);
  for (const [folder, file, content] of legacyFiles) {
    const full = join(dir, folder, file);
    expect(existsSync(full)).toBe(true);
    expect(readFileSync(full, "utf8")).toBe(content);
  }
});
