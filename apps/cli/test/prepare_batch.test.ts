// laplace-prepare-batch against prepare_batch.py's main(), from the goldens in
// packages/ingest/test/fixtures/download.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pyJsonDumps, sourceFolder } from "@eidolon/config";
import {
  downloadGolden as golden,
  type PrepareGolden,
} from "../../../packages/ingest/test/download_helpers.ts";
import { prepareBatchMain } from "../src/index.ts";
import { captureIo, setEnv } from "./helpers.ts";

const NOW = new Date("2026-09-08T17:02:09Z");
const ARCHIVE_URL = "https://space.bilibili.com/2132180406/lists/2484684?type=series";

let work = "";
let restore: () => void = () => {};
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "cli-prepare-batch-")));
  restore = setEnv({ TZ: "America/Los_Angeles" });
});
afterEach(() => {
  restore();
  rmSync(work, { recursive: true, force: true });
  rmSync(sourceFolder("milky-green", "lists"), { recursive: true, force: true });
});

/** Python's prepared repository, laid out as the persona's lists. */
function prepareLists(lists: string): void {
  for (const [name, content] of Object.entries(golden.prepare_files)) {
    if (typeof content !== "string" || !name.startsWith("data/")) continue;
    const path = name.startsWith("data/auto-embed/")
      ? join(lists, "batches", name.slice(16))
      : join(lists, name.slice(5));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  writeFileSync(join(work, "capture.txt"), golden.prepare_files["capture.txt"] as string);
}

test("argparse errors are prepare_batch.py's", async () => {
  for (const c of golden.prepare_main) {
    const io = captureIo();
    expect([c.argv, await prepareBatchMain(c.argv, io.io)]).toEqual([c.argv, c.code]);
    expect(io.stderr()).toStartWith("usage: laplace-prepare-batch [-h] --expected-count");
    expect(io.stderr().trimEnd().split("\n").at(-1)).toBe(
      c.error.replace("prepare_batch.py: ", "laplace-prepare-batch: "),
    );
  }
});

test("prints prepare_batch.py's JSON and writes its batch", async () => {
  const c = golden.prepare.find((p) => p.name === "write") as PrepareGolden;
  const lists = join(work, "lists");
  prepareLists(lists);
  const io = captureIo();
  const argv = [join(work, "capture.txt"), "--expected-count", "6", "--lists-dir", lists];
  const code = await prepareBatchMain([...argv, "--source", ARCHIVE_URL], {
    ...io.io,
    now: () => NOW,
  });
  expect(code).toBe(0);
  const relocated = JSON.parse(
    JSON.stringify(c.result)
      .replaceAll("<WORK>/data/auto-embed/", `${lists}/batches/`)
      .replaceAll("<WORK>/data/", `${lists}/`),
  );
  expect(io.stdout()).toBe(`${pyJsonDumps(relocated, { ensureAscii: false, indent: 2 })}\n`);
  expect(readFileSync(relocated.created_batch, "utf8")).toBe(c.created_text as string);

  // Run again, the new batch is a list like the others: nothing is new.
  const again = captureIo();
  expect(await prepareBatchMain(argv, { ...again.io, now: () => NOW })).toBe(0);
  expect(JSON.parse(again.stdout())).toMatchObject({ new_count: 0, created_batch: null });
});

test("a batch already named for this second is never overwritten", async () => {
  const lists = join(work, "lists");
  prepareLists(lists);
  const taken = join(lists, "batches", "videos-2026-09-08-100209.txt");
  writeFileSync(taken, "BV1aaaaaaaa1\n");
  const io = captureIo();
  const argv = [join(work, "capture.txt"), "--expected-count", "6", "--lists-dir", lists];
  expect(await prepareBatchMain(argv, { ...io.io, now: () => NOW })).toBe(1);
  expect(io.stderr()).toBe(`[Errno 17] File exists: '${taken}'\n`);
  expect(readFileSync(taken, "utf8")).toBe("BV1aaaaaaaa1\n");
});

test("the persona's lists are the default, resolved as Path.resolve() would", async () => {
  const lists = sourceFolder("milky-green", "lists");
  prepareLists(lists);
  const io = captureIo();
  const code = await prepareBatchMain(
    [join(work, "capture.txt"), "--expected-count", "6", "--dry-run"],
    io.io,
  );
  expect(code).toBe(0);
  const result = JSON.parse(io.stdout());
  expect(result.pending_batches).toEqual([
    join(realpathSync(lists), "batches", "videos-2026-02-01-000000.txt"),
  ]);
  expect(result.created_batch).toBeNull();
});

test("a ValueError or OSError prints its message and exits 1", async () => {
  const lists = join(work, "lists");
  prepareLists(lists);
  const mismatch = captureIo();
  expect(
    await prepareBatchMain(
      [join(work, "capture.txt"), "--expected-count", "7", "--lists-dir", lists],
      mismatch.io,
    ),
  ).toBe(1);
  expect(mismatch.stderr()).toBe(
    "Archive coverage mismatch: captured 6 unique IDs, expected 7; no batch written\n",
  );
  const missing = captureIo();
  expect(
    await prepareBatchMain(
      [join(work, "nope.txt"), "--expected-count", "1", "--lists-dir", lists],
      missing.io,
    ),
  ).toBe(1);
  expect(missing.stderr()).toBe(
    `[Errno 2] No such file or directory: '${join(work, "nope.txt")}'\n`,
  );
});
