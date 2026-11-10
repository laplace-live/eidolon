import { expect, test } from "bun:test";
import { mp3DurationMs } from "../../../src/speech/batch/index.ts";
import { mp3Frames } from "./fake.ts";

test("sums each frame's samples over its rate", () => {
  expect(mp3DurationMs(mp3Frames(1))).toBe(26);
  expect(mp3DurationMs(mp3Frames(100))).toBe(2612);
});

test("skips an ID3v2 tag, whose size is four 7-bit bytes", () => {
  const tag = new Uint8Array(10 + 200);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 1, 0x48]);
  const file = new Uint8Array([...tag, ...mp3Frames(10)]);
  expect(mp3DurationMs(file)).toBe(261);
});

test("reads MPEG-2's half-length frames, and stops at a trailing ID3v1 tag", () => {
  // MPEG-2 Layer III, 64 kbps at 24 kHz: 576 samples in 192 bytes.
  const frame = new Uint8Array(192);
  frame.set([0xff, 0xf3, 0x84, 0x00]);
  const file = new Uint8Array([...frame, ...frame, ...new TextEncoder().encode("TAG")]);
  expect(mp3DurationMs(file)).toBe(48);
});

test("null for bytes that hold no Layer III frame", () => {
  expect(mp3DurationMs(new Uint8Array())).toBeNull();
  expect(mp3DurationMs(new TextEncoder().encode("RIFF....WAVEfmt "))).toBeNull();
  // A Layer II header.
  expect(mp3DurationMs(new Uint8Array([0xff, 0xfd, 0x90, 0x00]))).toBeNull();
});
