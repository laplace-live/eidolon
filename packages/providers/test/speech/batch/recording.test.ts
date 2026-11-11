import { describe, expect, test } from "bun:test";
import { mp3DurationMs, recordingDurationMs } from "../../../src/speech/batch/index.ts";
import { mp3Frames } from "./fake.ts";
import { FIXTURES, fixture, webmOpus } from "./recordings.ts";

const MIMES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"];

/** Where the box of type `type` starts its body, the first of that type in `bytes`. */
function boxBody(bytes: Uint8Array, type: string): number {
  const at = Buffer.from(bytes).indexOf(type);
  if (at === -1) throw new Error(`no ${type} box`);
  return at + 4;
}

describe("recordingDurationMs", () => {
  test("measures each recording at what a decoder plays, or a little over", () => {
    for (const [name, mime, decoded] of FIXTURES) {
      const ms = recordingDurationMs(fixture(name), mime) ?? 0;
      expect([name, ms >= decoded && ms <= decoded + 250]).toEqual([name, true]);
    }
  });

  test("reads the codecs' frames whatever the container's timing says", () => {
    expect(recordingDurationMs(webmOpus(25), "audio/webm")).toBe(1500);
    expect(recordingDurationMs(webmOpus(25, { spacing: 0 }), "audio/webm")).toBe(1500);
    expect(recordingDurationMs(webmOpus(2500, { spacing: 0 }), "audio/webm")).toBe(150_000);

    const ogg = fixture("ffmpeg.ogg");
    for (let at = Buffer.from(ogg).indexOf("OggS"); at !== -1; ) {
      ogg.fill(0, at + 6, at + 14);
      at = Buffer.from(ogg).indexOf("OggS", at + 4);
    }
    expect(recordingDurationMs(ogg, "audio/ogg")).toBeGreaterThanOrEqual(1500);

    // Every stated length 1 tick: the box durations, the edit list and each sample's delta.
    const m4a = fixture("ffmpeg.m4a");
    const view = new DataView(m4a.buffer);
    for (const [type, offset] of [
      ["mvhd", 16],
      ["tkhd", 20],
      ["mdhd", 16],
      ["elst", 8],
    ] as const) {
      view.setUint32(boxBody(m4a, type) + offset, 1);
    }
    const stts = boxBody(m4a, "stts");
    for (let i = 0; i < view.getUint32(stts + 4); i++) view.setUint32(stts + 12 + i * 8, 1);
    expect(recordingDurationMs(m4a, "audio/mp4")).toBeGreaterThanOrEqual(1500);

    const mp3 = new Uint8Array([...mp3Frames(3), ...mp3Frames(5000)]);
    expect(recordingDurationMs(mp3, "audio/mpeg")).toBe(mp3DurationMs(mp3));
    expect(mp3DurationMs(mp3)).toBeGreaterThan(130_000);
  });

  test("a clip that isn't wholly its container is not measured, wherever it is cut", () => {
    for (const [name, mime] of FIXTURES) {
      const bytes = fixture(name);
      const full = recordingDurationMs(bytes, mime) as number;
      // Junk after the end, where a decoder that resyncs would read on.
      expect([name, recordingDurationMs(new Uint8Array([...bytes, 0]), mime)]).toEqual([
        name,
        null,
      ]);
      for (let length = 0; length < bytes.length; length++) {
        const cut = recordingDurationMs(bytes.subarray(0, length), mime);
        if (cut !== null) expect([name, length, cut <= full]).toEqual([name, length, true]);
      }
    }
    const hidden = new Uint8Array([...mp3Frames(3), 0, ...mp3Frames(5000)]);
    expect(mp3DurationMs(hidden)).toBe(78);
    expect(recordingDurationMs(hidden, "audio/mpeg")).toBeNull();
  });

  test("another container than the type names, or a codec whose frames it can't count, is not measured", () => {
    for (const [name, mime] of FIXTURES) {
      const own = mime.split(";")[0];
      for (const other of [...MIMES.filter((m) => m !== own), "audio/wav", "", "__proto__"]) {
        expect([name, other, recordingDurationMs(fixture(name), other)]).toEqual([
          name,
          other,
          null,
        ]);
      }
    }
    expect(recordingDurationMs(webmOpus(25, { codec: "A_VORBIS" }), "audio/webm")).toBeNull();
    // Laced: several frames in a block, sized in a header this doesn't read.
    expect(recordingDurationMs(webmOpus(25, { flags: 0x82 }), "audio/webm")).toBeNull();
    const vorbis = fixture("ffmpeg.ogg");
    vorbis.set(new TextEncoder().encode("\x01vorbis\0"), Buffer.from(vorbis).indexOf("OpusHead"));
    expect(recordingDurationMs(vorbis, "audio/ogg")).toBeNull();
    // MP3 in MP4.
    const m4a = fixture("ffmpeg.m4a");
    const esds = boxBody(m4a, "esds");
    m4a[m4a.indexOf(0x40, esds + 8)] = 0x6b;
    expect(recordingDurationMs(m4a, "audio/mp4")).toBeNull();
  });

  test("a container with no audio in it is not measured", () => {
    expect(recordingDurationMs(webmOpus(0), "audio/webm")).toBeNull();
    expect(recordingDurationMs(new Uint8Array(), "audio/mpeg")).toBeNull();
    const ogg = fixture("ffmpeg.ogg");
    // OpusHead's page and OpusTags', which end at the third page.
    const third = Buffer.from(ogg).indexOf("OggS", Buffer.from(ogg).indexOf("OggS", 4) + 4);
    expect(recordingDurationMs(ogg.subarray(0, third), "audio/ogg")).toBeNull();
  });
});
