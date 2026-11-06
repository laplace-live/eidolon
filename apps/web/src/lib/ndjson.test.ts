import { describe, expect, test } from "bun:test";
import { LineSplitter, readNdjson } from "./ndjson";

const encoder = new TextEncoder();

const EVENTS = [
  { type: "item", item: "2026-01-02 直播回放 🎤.m4a", status: "done" },
  { type: "stage", stage: "transcribe", status: "start" },
  { type: "summary", ok: true, counts: { 成功: 2 } },
];
const PAYLOAD = encoder.encode(EVENTS.map((event) => `${JSON.stringify(event)}\n`).join(""));

function streamOf(
  chunks: readonly Uint8Array[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel: onCancel,
  });
}

function lineEnds(payload: Uint8Array): number[] {
  return [...payload.entries()].filter(([, byte]) => byte === 0x0a).map(([at]) => at + 1);
}

describe("LineSplitter", () => {
  test("cuts at every chunk boundary, including inside a multi-byte character", () => {
    for (let cut = 0; cut <= PAYLOAD.length; cut += 1) {
      for (let second = cut; second <= PAYLOAD.length; second += 7) {
        const splitter = new LineSplitter();
        const lines = [
          ...splitter.push(PAYLOAD.subarray(0, cut)),
          ...splitter.push(PAYLOAD.subarray(cut, second)),
          ...splitter.push(PAYLOAD.subarray(second)),
        ];
        expect(lines.map((line) => JSON.parse(line.text))).toEqual(EVENTS);
        expect(lines.map((line) => line.offset)).toEqual(lineEnds(PAYLOAD));
      }
    }
  });

  test("byte by byte", () => {
    const splitter = new LineSplitter();
    const lines = [...PAYLOAD].flatMap((byte) => splitter.push(Uint8Array.of(byte)));
    expect(lines.map((line) => JSON.parse(line.text))).toEqual(EVENTS);
  });

  test("holds a line until its newline arrives", () => {
    const splitter = new LineSplitter();
    expect(splitter.push(encoder.encode('{"a":1}\n{"b":'))).toEqual([
      { text: '{"a":1}', offset: 8 },
    ]);
    expect(splitter.push(encoder.encode("2}"))).toEqual([]);
    expect(splitter.push(encoder.encode("\n"))).toEqual([{ text: '{"b":2}', offset: 16 }]);
  });

  test("counts from the offset the stream was resumed at", () => {
    expect(new LineSplitter(100).push(encoder.encode("{}\n[]\n"))).toEqual([
      { text: "{}", offset: 103 },
      { text: "[]", offset: 106 },
    ]);
  });

  test("drops a CR before the newline, and skips blank lines while counting their bytes", () => {
    expect(new LineSplitter().push(encoder.encode('{"a":1}\r\n\n  \n{"b":2}\n'))).toEqual([
      { text: '{"a":1}', offset: 9 },
      { text: '{"b":2}', offset: 21 },
    ]);
  });

  test("a chunk the caller reuses doesn't change a held line", () => {
    const splitter = new LineSplitter();
    const chunk = encoder.encode('{"a":');
    splitter.push(chunk);
    chunk.fill(0x20);
    expect(splitter.push(encoder.encode("1}\n"))).toEqual([{ text: '{"a":1}', offset: 8 }]);
  });
});

describe("readNdjson", () => {
  test("yields each value with the offset past it", async () => {
    const records = [];
    for await (const record of readNdjson(
      streamOf([PAYLOAD.subarray(0, 50), PAYLOAD.subarray(50)]),
    )) {
      records.push(record);
    }
    expect(records.map((record) => record.value)).toEqual(EVENTS);
    expect(records.map((record) => record.offset)).toEqual(lineEnds(PAYLOAD));
  });

  test("never yields a last line without its newline", async () => {
    const values = [];
    for await (const { value } of readNdjson(streamOf([encoder.encode('{"a":1}\n{"b":2}')]))) {
      values.push(value);
    }
    expect(values).toEqual([{ a: 1 }]);
  });

  test("offsets start at the resumed position", async () => {
    const offsets = [];
    for await (const { offset } of readNdjson(streamOf([encoder.encode("1\n2\n")]), 40)) {
      offsets.push(offset);
    }
    expect(offsets).toEqual([42, 44]);
  });

  test("returning early cancels the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("{}\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _ of readNdjson(body)) break;
    expect(cancelled).toBe(true);
  });

  test("a line that isn't JSON fails the read", async () => {
    const read = async () => {
      for await (const _ of readNdjson(streamOf([encoder.encode("{}\nnot json\n")]))) {
        // drain
      }
    };
    await expect(read()).rejects.toThrow(SyntaxError);
  });
});
