// Recordings for the tests of recordingDurationMs and the voice routes: the second-long tones in
// fixtures/, and a WebM of Opus built frame by frame, as long as a test needs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A 440 Hz tone in fixtures/: `chrome.webm` as Chrome's MediaRecorder wrote it with a timeslice
 * (no sizes, no Duration), the rest by ffmpeg, `fragmented.m4a` fragmented as a recorder writes MP4.
 */
export function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));
}

/** What ffmpeg decodes each fixture to, in ms, and its type. */
export const FIXTURES: readonly (readonly [name: string, mime: string, decodedMs: number])[] = [
  ["chrome.webm", "audio/webm;codecs=opus", 1320],
  ["ffmpeg.webm", "audio/webm", 1500],
  ["ffmpeg.ogg", "audio/ogg;codecs=opus", 1500],
  ["ffmpeg.m4a", "audio/mp4", 1500],
  ["fragmented.m4a", "audio/mp4", 1600],
  ["ffmpeg.mp3", "audio/mpeg", 1500],
];

function idBytes(id: number): number[] {
  const bytes: number[] = [];
  for (let rest = id; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return bytes;
}

/** An EBML element, its size in 8 bytes; null for a body of unknown size, whose children follow. */
function element(id: number, body: readonly number[] | null): number[] {
  if (body === null) return [...idBytes(id), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const n = body.length;
  return [
    ...idBytes(id),
    0x01,
    0,
    0,
    0,
    n >>> 24,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
    ...body,
  ];
}

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

export interface WebmOptions {
  /** Ms between frames' timecodes; 0 stamps them all at once. Default 60, their length. */
  readonly spacing?: number;
  /** Default `A_OPUS`. */
  readonly codec?: string;
  /** Each SimpleBlock's flags; default 0x80, a keyframe without lacing. */
  readonly flags?: number;
}

/**
 * A WebM of `frames` Opus packets, each its TOC byte alone (SILK, one 60 ms frame), as a live
 * recorder writes it: no sizes for the Segment or its Clusters, and no Duration.
 */
export function webmOpus(frames: number, options: WebmOptions = {}): Uint8Array<ArrayBuffer> {
  const { spacing = 60, codec = "A_OPUS", flags = 0x80 } = options;
  const out = [
    ...element(0x1a45dfa3, element(0x4282, ascii("webm"))),
    ...element(0x18538067, null),
    ...element(0x1654ae6b, element(0xae, [...element(0xd7, [1]), ...element(0x86, ascii(codec))])),
  ];
  for (let i = 0; i < frames; i++) {
    // A block's timecode is 16 bits past its cluster's.
    if (i % 500 === 0) {
      const time = i * spacing;
      out.push(...element(0x1f43b675, null));
      out.push(
        ...element(0xe7, [time >>> 24, (time >>> 16) & 0xff, (time >>> 8) & 0xff, time & 0xff]),
      );
    }
    const relative = (i % 500) * spacing;
    out.push(...element(0xa3, [0x81, relative >> 8, relative & 0xff, flags, 0x18]));
  }
  return new Uint8Array(out);
}
