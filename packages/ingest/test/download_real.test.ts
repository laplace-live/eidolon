// fixtures/download/download-real.golden.json is what download-real.golden.py printed through
// read_url_list and prepare_batch.py's read_ids over the real URL lists: counts and hashes, no
// URLs. Lists changed since are left out. These skip when the real data is absent, unless
// EIDOLON_REQUIRE_PARITY=1. They only read the data home.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sortedPy } from "@eidolon/config";
import { download } from "../src/index.ts";
import { DOWNLOAD_FIXTURES } from "./download_helpers.ts";

const golden = JSON.parse(
  readFileSync(join(DOWNLOAD_FIXTURES, "download-real.golden.json"), "utf8"),
) as {
  lists: Record<
    string,
    { file_sha256: string; urls: number; urls_sha256: string; ids: number; ids_sha256: string }
  >;
  known: number;
  known_sha256: string;
  pending: string[];
};
const SOURCES = join(process.env.EIDOLON_REAL_HOME ?? "", "sources/milky-green");
const LISTS = join(SOURCES, "lists");
const VODS = join(SOURCES, "vods");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const REPRINT =
  "uv run --offline --no-sync python packages/ingest/test/fixtures/download/" +
  "download-real.golden.py > packages/ingest/test/fixtures/download/download-real.golden.json";

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");
const digest = (values: readonly string[]): string => sha256(values.map((v) => `${v}\n`).join(""));

/** The golden's lists that are still there, byte for byte. */
function unchangedLists(): string[] {
  return Object.entries(golden.lists)
    .filter(([name, entry]) => {
      const path = join(LISTS, name);
      return existsSync(path) && sha256(readFileSync(path)) === entry.file_sha256;
    })
    .map(([name]) => name);
}

const unchanged = unchangedLists();
const missing = Object.keys(golden.lists).length - unchanged.length;

test.skipIf(missing > 0 && !REQUIRED)(
  "readUrlList and readIds read every real list as Python does",
  () => {
    expect(missing, `real lists the golden names are missing or changed; reprint: ${REPRINT}`).toBe(
      0,
    );
    for (const name of unchanged) {
      const entry = golden.lists[name] as (typeof golden.lists)[string];
      const urls = download.readUrlList(join(LISTS, name));
      const ids = download.readIds(join(LISTS, name));
      expect([name, urls.length, digest(urls), ids.length, digest(ids)]).toEqual([
        name,
        entry.urls,
        entry.urls_sha256,
        entry.ids,
        entry.ids_sha256,
      ]);
    }
  },
);

const otherLists = existsSync(LISTS)
  ? [...download.baselineLists(LISTS), ...download.batchLists(LISTS)]
      .map((path) => path.slice(LISTS.length + 1))
      .filter((name) => !(name in golden.lists))
  : [];

test.skipIf((missing > 0 || otherLists.length > 0) && !REQUIRED)(
  "knownIds and pendingBatches match prepare_batch.py on the real lists",
  () => {
    expect(missing, `reprint: ${REPRINT}`).toBe(0);
    expect(otherLists, `lists added since the golden; reprint: ${REPRINT}`).toEqual([]);
    const known = download.knownIds(LISTS);
    expect([known.size, digest(sortedPy(known))]).toEqual([golden.known, golden.known_sha256]);
    expect(download.pendingBatches(LISTS).map((path) => path.slice(LISTS.length + 1))).toEqual(
      golden.pending,
    );
  },
);

test.skipIf(!existsSync(VODS) && !REQUIRED)(
  "the part check finds exactly the real anthology-fallback copies of part 1",
  () => {
    expect(existsSync(VODS), `no audio at ${VODS}`).toBe(true);
    const names = readdirSync(VODS);
    const found = download.bareWithParts(names);
    // Each one is a second download of part 1 under the bare id: the same size, byte for byte.
    for (const id of found) {
      const bare = names.find((n) => n.startsWith(`${id}.`) && n !== `${id}.info.json`) as string;
      const ext = bare.slice(id.length);
      expect([id, statSync(join(VODS, bare)).size]).toEqual([
        id,
        statSync(join(VODS, `${id}_p1${ext}`)).size,
      ]);
    }
    // The two the 2026-09-18 run left behind, while they are still there.
    const documented = ["BV1FbgM6QEw3", "BV1Tp7W64EP7"].filter((id) =>
      existsSync(join(VODS, `${id}.m4a`)),
    );
    expect(found).toEqual(documented);
  },
);
