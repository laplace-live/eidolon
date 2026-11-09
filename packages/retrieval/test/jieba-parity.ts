// On demand: `bun packages/retrieval/test/jieba-parity.ts [dbPath]` re-tokenizes every row of both
// tables and compares with the stored `tokens` column. Exits 1 on any mismatch.
import { openTable, resolveDbPath, tokenizeZh, warmTokenizer } from "../src/index.ts";
import { chunkFtsText, FTS_COLUMNS, factFtsText } from "./fts_text.ts";

const dbPath = process.argv[2] ?? resolveDbPath();
const started = performance.now();
warmTokenizer();
console.log(`prefix dict built in ${(performance.now() - started).toFixed(0)} ms`);

let failed = false;
for (const [name, ftsText] of [
  ["persona_facts", factFtsText],
  ["stream_chunks", chunkFtsText],
] as const) {
  const table = await openTable(dbPath, name);
  if (table === null) {
    console.log(`${name}: no table at ${dbPath}`);
    failed = true;
    continue;
  }
  const rows = await table
    .query()
    .select([...FTS_COLUMNS[name]])
    .toArray();
  const t0 = performance.now();
  const mismatches = rows.filter((row) => tokenizeZh(ftsText(row)) !== row.tokens);
  const seconds = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(
    `${name}: ${rows.length - mismatches.length}/${rows.length} identical (${seconds} s)`,
  );
  for (const row of mismatches.slice(0, 5)) console.log(`  mismatch: ${row.id}`);
  if (mismatches.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
