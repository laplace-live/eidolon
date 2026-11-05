// fixtures/streams.golden.json and the sidecar text below were printed by CPython 3.13 through
// laplace_eidolon.tools._streams, for the synthetic transcripts in fixtures/streams; the
// readUploadDate outcomes by tools/pipeline.py's _read_upload_date.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PyFloat, pyStr } from "@eidolon/config";
import {
  AUDIO_EXTENSIONS,
  infoJsonPath,
  iterStreams,
  loadSidecar,
  parseStream,
  readUploadDate,
  saveSidecar,
  splitIntoChunks,
  streamId,
  transcriptPath,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

interface GoldenStream {
  md_path: string;
  stream_id: string;
  metadata: Record<string, string>;
  sidecar_path: string;
  chunks: [string, number, string, string][];
}

let work = "";
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ingest-streams-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("iterStreams", () => {
  test("parses every *.md as _streams.py does", async () => {
    const golden = (await Bun.file(join(FIXTURES, "streams.golden.json")).json()) as {
      streams: GoldenStream[];
    };
    const got = iterStreams(join(FIXTURES, "streams")).map((s) => ({
      md_path: basename(s.mdPath),
      stream_id: s.streamId,
      metadata: Object.fromEntries(Object.entries(s.metadata).map(([k, v]) => [k, pyStr(v)])),
      sidecar_path: basename(s.sidecarPath),
      chunks: s.chunks.map((c) => [c.id, c.idx, c.heading, c.text]),
    }));
    expect(got).toEqual(golden.streams);
  });

  test("chunks of a stream carry its id; paths keep the form pathlib prints", () => {
    const [stream] = iterStreams(`${FIXTURES}/streams/`).filter((s) =>
      s.mdPath.endsWith("BV1aaaaaaaaa.md"),
    );
    expect(stream?.mdPath).toBe(`${FIXTURES}/streams/2026-01-02-BV1aaaaaaaaa.md`);
    expect(stream?.sidecarPath).toBe(`${FIXTURES}/streams/2026-01-02-BV1aaaaaaaaa.refined.json`);
    expect(stream?.chunks.every((c) => c.streamId === "2026-01-02-BV1aaaaaaaaa")).toBe(true);
  });

  test("a missing folder, or one that isn't a folder, holds no streams", () => {
    expect(iterStreams(join(work, "nope"))).toEqual([]);
    writeFileSync(join(work, "file"), "");
    expect(iterStreams(join(work, "file"))).toEqual([]);
  });

  test("ids pad to three digits and grow past 999", () => {
    const body = Array.from({ length: 1001 }, (_, i) => `## ${i}\nscene ${i}\n`).join("");
    writeFileSync(join(work, "long.md"), body);
    const [stream] = iterStreams(work);
    expect(stream?.chunks.at(0)?.id).toBe("long::000");
    expect(stream?.chunks.at(-1)?.id).toBe("long::1000");
  });

  test("invalid UTF-8 fails the parse, as read_text does", () => {
    writeFileSync(join(work, "bad.md"), Buffer.from([0x23, 0x23, 0x20, 0xff, 0x0a]));
    expect(() => iterStreams(work)).toThrow();
  });

  test("frontmatter is YAML 1.2, where Python read YAML 1.1 [AD]", () => {
    // What CPython 3.13.4 with PyYAML 6.0.3 gives instead, through str(), in the comments.
    writeFileSync(
      join(work, "yaml.md"),
      "---\nstream_id: 2021-07-02T10:00:00Z\nb: yes\nc: 1:30\nd: 1.0\ne: 1e3\nf: 1_000\n" +
        "g: 017\nh: 0o17\n---\n## h\nt\n",
    );
    const stream = parseStream(join(work, "yaml.md"));
    expect(stream.chunks.map((c) => c.id)).toEqual(["2021-07-02T10:00:00Z::000"]);
    expect(
      Object.fromEntries(Object.entries(stream.metadata).map(([k, v]) => [k, pyStr(v)])),
    ).toEqual({
      stream_id: "2021-07-02T10:00:00Z", // '2021-07-02 10:00:00+00:00'
      b: "yes", // 'True'
      c: "1:30", // '90'
      d: "1", // '1.0'
      e: "1000", // '1e3'
      f: "1_000", // '1000'
      g: "17", // '15'
      h: "15", // '0o17'
    });
    writeFileSync(join(work, "key.md"), "---\n2021: x\n---\n## h\nt\n");
    // TypeError: keywords must be strings
    expect(parseStream(join(work, "key.md")).metadata).toEqual({ "2021": "x" });
  });
});

test("splitIntoChunks drops what precedes the first H2 and scenes without text", () => {
  expect(splitIntoChunks("intro\n## a\n\n## b\ntext b\n")).toEqual([
    { heading: "b", text: "text b" },
  ]);
});

describe("sidecars", () => {
  const SAVED =
    '{\n  "schema_version": 2,\n  "stream_id": "x",\n  "model": "m",\n  "stats": {\n' +
    '    "cost_usd": 24.0,\n    "duration_sec": 1e-05,\n    "chunks_refined": 3\n  },\n' +
    '  "chunks": {\n    "x::000": {\n      "heading": "标题",\n      "topics": [],\n' +
    '      "extras": {}\n    }\n  }\n}';
  const DATA = {
    schema_version: 2,
    stream_id: "x",
    model: "m",
    stats: { cost_usd: new PyFloat(24), duration_sec: new PyFloat(1e-5), chunks_refined: 3 },
    chunks: { "x::000": { heading: "标题", topics: [], extras: {} } },
  };

  function stream(name: string) {
    writeFileSync(join(work, name), "## h\nt\n");
    return parseStream(join(work, name));
  }

  test("save writes json.dumps(indent=2) through a temporary file; load reads it back", () => {
    const parsed = stream("x.md");
    saveSidecar(parsed, DATA);
    expect(readFileSync(join(work, "x.refined.json"), "utf8")).toBe(SAVED);
    expect(readdirSync(work).sort()).toEqual(["x.md", "x.refined.json"]);
    expect(loadSidecar(parsed)).toEqual(DATA);
  });

  test("a missing or corrupt sidecar loads as the empty one; NaN is JSON to Python", () => {
    const parsed = stream("y.md");
    const empty = { schema_version: 1, stream_id: "y", chunks: {} };
    expect(loadSidecar(parsed)).toEqual(empty);
    writeFileSync(parsed.sidecarPath, '{"chunks": {');
    expect(loadSidecar(parsed)).toEqual(empty);
    writeFileSync(parsed.sidecarPath, '{"a": NaN, "b": 2.0}');
    const loaded = loadSidecar(parsed) as Record<string, unknown>;
    expect(loaded.a).toEqual(new PyFloat(Number.NaN));
    expect(loaded.b).toEqual(new PyFloat(2));
  });

  test("a failed save leaves no temporary file behind", () => {
    const parsed = stream("z.md");
    expect(() => saveSidecar(parsed, { bad: () => 0 })).toThrow("is not JSON serializable");
    expect(readdirSync(work)).toEqual(["z.md"]);
  });
});

describe("audio files and their info.json", () => {
  function info(name: string, text: string): string {
    writeFileSync(join(work, `${name}.info.json`), text);
    return join(work, `${name}.m4a`);
  }

  test("naming: the info.json beside the audio, the transcript under its upload date", () => {
    expect(AUDIO_EXTENSIONS.has(".m4a")).toBe(true);
    expect(infoJsonPath("vods/BV1FbgM6QEw3_p1.m4a")).toBe("vods/BV1FbgM6QEw3_p1.info.json");
    expect(streamId("2026-08-14", "BV1FbgM6QEw3_p1")).toBe("2026-08-14-BV1FbgM6QEw3_p1");
    expect(transcriptPath("streams/", "2026-08-14", "BV1FbgM6QEw3_p1")).toBe(
      "streams/2026-08-14-BV1FbgM6QEw3_p1.md",
    );
  });

  test("readUploadDate: YYYYMMDD, else null", () => {
    expect(readUploadDate(info("a", '{"upload_date": "20260814"}'))).toBe("2026-08-14");
    expect(readUploadDate(info("b", '{"upload_date": 20260814}'))).toBe("2026-08-14");
    expect(readUploadDate(info("c", '{"upload_date": " 20260814\\n"}'))).toBe("2026-08-14");
    expect(readUploadDate(info("d", '{"upload_date": 20260814.0}'))).toBeNull();
    expect(readUploadDate(info("e", '{"upload_date": "2026-08-14"}'))).toBeNull();
    expect(readUploadDate(info("f", '{"title": "x", "upload_date": null}'))).toBeNull();
    expect(readUploadDate(info("g", '{"duration": NaN, "upload_date": "20260814"}'))).toBe(
      "2026-08-14",
    );
    expect(readUploadDate(info("h", "{not json"))).toBeNull();
    expect(readUploadDate(join(work, "missing.m4a"))).toBeNull();
    expect(() => readUploadDate(info("i", "[1]"))).toThrow("'list' object has no attribute 'get'");
  });
});
