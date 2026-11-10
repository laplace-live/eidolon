// A recording's length from its own bytes, measured before anything bills for hearing it: the
// longest of every length its container states and of its frames counted, which a decoder plays
// whatever the stated timing says. The container must account for every byte, or a decoder that
// resyncs past junk would play what the parse never saw.
import { mp3Frames } from "./mp3.ts";
import { baseMime } from "./shared.ts";

/**
 * The length of the recording `bytes` of type `mime` in ms, or null when the bytes aren't wholly a
 * WebM or Ogg of Opus, an MP4 of AAC, or an MP3, or hold no audio.
 */
export function recordingDurationMs(bytes: Uint8Array, mime: string): number | null {
  const ms = READERS.get(baseMime(mime))?.(bytes) ?? null;
  return ms === null || !Number.isFinite(ms) || ms <= 0 ? null : Math.round(ms);
}

const READERS: ReadonlyMap<string, (bytes: Uint8Array) => number | null> = new Map([
  ["audio/webm", webmMs],
  ["audio/ogg", oggMs],
  ["audio/mp4", mp4Ms],
  ["audio/mpeg", mpegMs],
]);

/** The largest of `lengths` that is known, or 0. */
function longest(lengths: readonly number[]): number {
  return Math.max(0, ...lengths.filter(Number.isFinite));
}

/** Samples at 48 kHz that the Opus packet at `at`, `length` bytes, decodes to (RFC 6716 3.1). */
function opusSamples(bytes: Uint8Array, at: number, length: number): number {
  if (length < 1) return 0;
  const toc = bytes[at] as number;
  const config = toc >> 3;
  let frame: number;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3] as number;
  else if (config < 16) frame = [480, 960][config & 1] as number;
  else frame = [120, 240, 480, 960][config & 3] as number;
  const code = toc & 3;
  if (code === 0) return frame;
  if (code < 3) return 2 * frame;
  return length < 2 ? 0 : frame * ((bytes[at + 1] as number) & 0x3f);
}

const EBML_ID = {
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  codecId: 0x86,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
} as const;

/** A Segment's children, any of which ends a cluster of unknown size. */
const SEGMENT_CHILDREN = new Set<number>([
  0x114d9b74, // SeekHead
  EBML_ID.info,
  EBML_ID.tracks,
  EBML_ID.cluster,
  0x1c53bb6b, // Cues
  0x1043a770, // Chapters
  0x1254c367, // Tags
  0x1941a469, // Attachments
]);

interface Element {
  readonly id: number;
  readonly data: number;
  /** null for an element of unknown size, as a live recorder writes its Segment and Clusters. */
  readonly end: number | null;
}

type SizedElement = Element & { readonly end: number };

/** The EBML variable-length integer at `at`, its marker bit kept for an ID; null past `end`. */
function vint(
  bytes: Uint8Array,
  at: number,
  end: number,
  max: number,
  marker: boolean,
): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[at];
  if (at >= end || first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > max || at + length > end) return null;
  let value = marker ? first : first & (0xff >> length);
  let ones = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i] as number;
    value = value * 256 + byte;
    ones &&= byte === 0xff;
  }
  return { value, length, unknown: !marker && ones };
}

function element(bytes: Uint8Array, at: number, end: number): Element | null {
  const id = vint(bytes, at, end, 4, true);
  if (id === null) return null;
  const size = vint(bytes, at + id.length, end, 8, false);
  if (size === null) return null;
  const data = at + id.length + size.length;
  if (size.unknown) return { id: id.value, data, end: null };
  return data + size.value > end ? null : { id: id.value, data, end: data + size.value };
}

function uintOf(bytes: Uint8Array, field: SizedElement): number {
  let value = 0;
  for (let i = field.data; i < field.end; i++) value = value * 256 + (bytes[i] as number);
  return value;
}

/** Each child of `parent`, all of known size; false when one is malformed or `visit` says so. */
function eachChild(
  bytes: Uint8Array,
  parent: SizedElement,
  visit: (child: SizedElement) => boolean,
): boolean {
  for (let at = parent.data; at < parent.end; ) {
    const child = element(bytes, at, parent.end);
    if (child === null || child.end === null || !visit(child as SizedElement)) return false;
    at = child.end;
  }
  return true;
}

interface WebmSegment {
  scale: number;
  stated: number;
  readonly opusTracks: Set<number>;
  /** In ms: the earliest block's start, and the latest block's end. */
  first: number;
  last: number;
  samples: number;
  blocks: number;
}

/** A SimpleBlock or Block in a cluster at `cluster` ticks; false unless it is one unlaced Opus frame. */
function readBlock(
  bytes: Uint8Array,
  block: SizedElement,
  cluster: number,
  durationTicks: number,
  segment: WebmSegment,
): boolean {
  const track = vint(bytes, block.data, block.end, 8, false);
  if (track === null || !segment.opusTracks.has(track.value)) return false;
  const header = block.data + track.length;
  if (header + 3 > block.end || ((bytes[header + 2] as number) & 0x06) !== 0) return false;
  const relative = (((bytes[header] as number) << 24) >> 16) | (bytes[header + 1] as number);
  const samples = opusSamples(bytes, header + 3, block.end - header - 3);
  const start = ((cluster + relative) * segment.scale) / 1e6;
  const length = Math.max(samples / 48, (durationTicks * segment.scale) / 1e6);
  segment.first = Math.min(segment.first, start);
  segment.last = Math.max(segment.last, start + length);
  segment.samples += samples;
  segment.blocks++;
  return true;
}

function readBlockGroup(
  bytes: Uint8Array,
  group: SizedElement,
  cluster: number,
  segment: WebmSegment,
): boolean {
  let block: SizedElement | null = null;
  let duration = 0;
  const ok = eachChild(bytes, group, (child) => {
    if (child.id === EBML_ID.block) block = child;
    else if (child.id === EBML_ID.blockDuration) duration = uintOf(bytes, child);
    return true;
  });
  return ok && block !== null && readBlock(bytes, block, cluster, duration, segment);
}

/** Reads the cluster `cluster`; where its segment reads on from, or null when it's malformed. */
function readCluster(
  bytes: Uint8Array,
  cluster: Element,
  segmentEnd: number,
  segment: WebmSegment,
): number | null {
  const end = cluster.end ?? segmentEnd;
  let time = 0;
  for (let at = cluster.data; at < end; ) {
    const child = element(bytes, at, end);
    if (child === null) return null;
    if (cluster.end === null && SEGMENT_CHILDREN.has(child.id)) return at;
    if (child.end === null) return null;
    const sized = child as SizedElement;
    if (child.id === EBML_ID.timecode) time = uintOf(bytes, sized);
    else if (child.id === EBML_ID.simpleBlock) {
      if (!readBlock(bytes, sized, time, 0, segment)) return null;
    } else if (child.id === EBML_ID.blockGroup) {
      if (!readBlockGroup(bytes, sized, time, segment)) return null;
    }
    at = child.end;
  }
  return end;
}

/** Notes each track; false unless every one is Opus. */
function readTracks(bytes: Uint8Array, tracks: SizedElement, segment: WebmSegment): boolean {
  return eachChild(bytes, tracks, (entry) => {
    if (entry.id !== EBML_ID.trackEntry) return true;
    let number = 0;
    let codec = "";
    const ok = eachChild(bytes, entry, (field) => {
      if (field.id === EBML_ID.trackNumber) number = uintOf(bytes, field);
      else if (field.id === EBML_ID.codecId) {
        codec = new TextDecoder().decode(bytes.subarray(field.data, field.end));
      }
      return true;
    });
    segment.opusTracks.add(number);
    return ok && codec === "A_OPUS";
  });
}

function readInfo(bytes: Uint8Array, info: SizedElement, segment: WebmSegment): boolean {
  let duration = 0;
  const ok = eachChild(bytes, info, (field) => {
    if (field.id === EBML_ID.timecodeScale) segment.scale = uintOf(bytes, field);
    else if (field.id === EBML_ID.duration) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + field.data,
        field.end - field.data,
      );
      if (view.byteLength === 4) duration = view.getFloat32(0);
      else if (view.byteLength === 8) duration = view.getFloat64(0);
      else return false;
    }
    return true;
  });
  segment.stated = Math.max(segment.stated, (duration * segment.scale) / 1e6);
  return ok;
}

/** A Segment's length in ms, or null when it's malformed or holds anything but Opus. */
function segmentMs(bytes: Uint8Array, segment: Element): number | null {
  const end = segment.end ?? bytes.length;
  const read: WebmSegment = {
    scale: 1_000_000,
    stated: 0,
    opusTracks: new Set(),
    first: Number.POSITIVE_INFINITY,
    last: Number.NEGATIVE_INFINITY,
    samples: 0,
    blocks: 0,
  };
  for (let at = segment.data; at < end; ) {
    const child = element(bytes, at, end);
    if (child === null) return null;
    if (child.id === EBML_ID.cluster) {
      const next = readCluster(bytes, child, end, read);
      if (next === null) return null;
      at = next;
      continue;
    }
    if (child.end === null) return null;
    const sized = child as SizedElement;
    if (child.id === EBML_ID.info && !readInfo(bytes, sized, read)) return null;
    if (child.id === EBML_ID.tracks && !readTracks(bytes, sized, read)) return null;
    at = child.end;
  }
  if (read.blocks === 0) return 0;
  return longest([read.stated, read.last - read.first, read.samples / 48]);
}

function webmMs(bytes: Uint8Array): number | null {
  let total = 0;
  for (let at = 0; at < bytes.length; ) {
    const top = element(bytes, at, bytes.length);
    if (top === null) return null;
    if (top.id === EBML_ID.segment) {
      const ms = segmentMs(bytes, top);
      if (ms === null) return null;
      total += ms;
    } else if (top.end === null) {
      return null;
    }
    at = top.end ?? bytes.length;
  }
  return total;
}

interface OggStream {
  preSkip: number;
  granule: number;
  samples: number;
  packets: number;
}

const OGG_S = 0x4f676753;
const OPUS_HEAD = new TextEncoder().encode("OpusHead");

function oggMs(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streams = new Map<number, OggStream>();
  for (let at = 0; at < bytes.length; ) {
    if (at + 27 > bytes.length || view.getUint32(at) !== OGG_S || bytes[at + 4] !== 0) return null;
    const flags = bytes[at + 5] as number;
    const granule = view.getBigInt64(at + 6, true);
    const serial = view.getUint32(at + 14, true);
    const segments = bytes[at + 26] as number;
    const body = at + 27 + segments;
    if (body > bytes.length) return null;
    let size = 0;
    for (let i = 0; i < segments; i++) size += bytes[at + 27 + i] as number;
    if (body + size > bytes.length) return null;
    let stream = streams.get(serial);
    if ((flags & 0x02) !== 0) {
      if (stream !== undefined) return null;
      stream = { preSkip: 0, granule: 0, samples: 0, packets: 0 };
      streams.set(serial, stream);
    }
    if (stream === undefined) return null;
    let offset = body;
    let starts = (flags & 0x01) === 0;
    for (let i = 0; i < segments; i++) {
      const lace = bytes[at + 27 + i] as number;
      if (starts) {
        if (stream.packets === 0) {
          if (lace < 19 || OPUS_HEAD.some((byte, j) => bytes[offset + j] !== byte)) return null;
          stream.preSkip = view.getUint16(offset + 10, true);
        } else if (stream.packets >= 2) {
          // The first two packets are OpusHead and OpusTags.
          stream.samples += opusSamples(bytes, offset, lace);
        }
        stream.packets++;
      }
      starts = lace < 255;
      offset += lace;
    }
    if (granule >= 0n) stream.granule = Math.max(stream.granule, Number(granule));
    at = body + size;
  }
  let total = 0;
  for (const stream of streams.values()) {
    if (stream.packets <= 2) continue;
    total += longest([(stream.granule - stream.preSkip) / 48, stream.samples / 48]);
  }
  return total;
}

interface Box {
  readonly type: string;
  readonly data: number;
  readonly end: number;
}

/** Each box from `start` to `end`; false when one doesn't fit, or `visit` says so. */
function eachBox(
  view: DataView,
  start: number,
  end: number,
  visit: (box: Box) => boolean,
): boolean {
  for (let at = start; at < end; ) {
    if (at + 8 > end) return false;
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return false;
      size = u64(view, at + 8);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (!(size >= header && at + size <= end)) return false;
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    );
    if (!visit({ type, data: at + header, end: at + size })) return false;
    at += size;
  }
  return true;
}

/** A 64-bit field as a number; NaN for all ones, a length nobody knew. */
function u64(view: DataView, at: number): number {
  const high = view.getUint32(at);
  const low = view.getUint32(at + 4);
  return high === 0xffffffff && low === 0xffffffff ? Number.NaN : high * 2 ** 32 + low;
}

/** A full box's version: 1 widens its times to 64 bits. */
function wide(view: DataView, box: Box): boolean {
  return view.getUint8(box.data) === 1;
}

/** A time field, 64 bits when `wide`, else 32; NaN for all ones. */
function timeAt(view: DataView, at: number, wide: boolean): number {
  if (wide) return u64(view, at);
  const value = view.getUint32(at);
  return value === 0xffffffff ? Number.NaN : value;
}

/** Whether `box` holds `bytes` bytes, the first being its version when it is a full box. */
function holds(box: Box, bytes: number): boolean {
  return box.data + bytes <= box.end;
}

/** MPEG-4 Audio's sampling frequencies by index. */
const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
/** The audio object types whose frames are 1024 samples at the config's first rate, SBR's core. */
const AAC_TYPES = new Set([1, 2, 3, 4, 5, 29]);
/** The `esds` object types that are AAC: MPEG-4 Audio, and MPEG-2's Main, LC and SSR. */
const AAC_OBJECTS = new Set([0x40, 0x66, 0x67, 0x68]);

/** An MPEG-4 descriptor at `at`: its tag as `type`, and its body. */
function descriptor(view: DataView, at: number, end: number): Box | null {
  if (at >= end) return null;
  const tag = view.getUint8(at);
  let size = 0;
  let p = at + 1;
  for (let i = 0; i < 4; i++) {
    if (p >= end) return null;
    const byte = view.getUint8(p++);
    size = size * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return p + size > end ? null : { type: String(tag), data: p, end: p + size };
}

/** The core sampling rate of the AAC an `esds` box describes, or null when it isn't AAC. */
function aacRate(view: DataView, esds: Box): number | null {
  const es = descriptor(view, esds.data + 4, esds.end);
  if (es?.type !== "3" || !holds(es, 3)) return null;
  let at = es.data + 2;
  const flags = view.getUint8(at++);
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += at < es.end ? 1 + view.getUint8(at) : 1;
  if (flags & 0x20) at += 2;
  const config = descriptor(view, at, es.end);
  if (config?.type !== "4" || !holds(config, 13)) return null;
  if (!AAC_OBJECTS.has(view.getUint8(config.data))) return null;
  const info = descriptor(view, config.data + 13, config.end);
  if (info?.type !== "5") return null;
  let bit = info.data * 8;
  const read = (n: number): number => {
    let value = 0;
    for (let i = 0; i < n; i++, bit++) {
      if (bit >= info.end * 8) return Number.NaN;
      value = value * 2 + ((view.getUint8(bit >> 3) >> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  let type = read(5);
  if (type === 31) type = 32 + read(6);
  if (!AAC_TYPES.has(type)) return null;
  const index = read(4);
  const rate = index === 15 ? read(24) : AAC_RATES[index];
  return rate !== undefined && rate > 0 ? rate : null;
}

/** The AAC rate of an `stsd`'s sample entries, or null unless every one is AAC at that rate. */
function sampleEntriesRate(view: DataView, stsd: Box): number | null {
  if (!holds(stsd, 8)) return null;
  let rate: number | null = null;
  const ok = eachBox(view, stsd.data + 8, stsd.end, (entry) => {
    if (entry.type !== "mp4a" || !holds(entry, 28)) return false;
    // QuickTime's sound descriptions 1 and 2 run 16 and 36 bytes longer.
    const version = view.getUint16(entry.data + 8);
    const children = entry.data + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
    let found: number | null = null;
    const read = eachBox(view, children, entry.end, (child) => {
      if (child.type === "esds") found = aacRate(view, child);
      return child.type !== "esds" || found !== null;
    });
    if (!read || found === null || (rate !== null && rate !== found)) return false;
    rate = found;
    return true;
  });
  return ok ? rate : null;
}

interface Mp4Track {
  timescale: number;
  rate: number | null;
  /** In the track's timescale. */
  readonly lengths: number[];
  /** In the movie's timescale. */
  readonly movieLengths: number[];
  samples: number;
  fragmentTicks: number;
  fragmentStart: number;
  fragmentEnd: number;
}

function readStbl(view: DataView, stbl: Box, track: Mp4Track): boolean {
  return eachBox(view, stbl.data, stbl.end, (table) => {
    switch (table.type) {
      case "stsd":
        track.rate = sampleEntriesRate(view, table);
        return track.rate !== null;
      case "stts": {
        if (!holds(table, 8)) return false;
        const count = view.getUint32(table.data + 4);
        if (!holds(table, 8 + count * 8)) return false;
        let ticks = 0;
        for (let i = 0; i < count; i++) {
          const at = table.data + 8 + i * 8;
          ticks += view.getUint32(at) * view.getUint32(at + 4);
        }
        track.lengths.push(ticks);
        return true;
      }
      case "stsz":
      case "stz2":
        if (!holds(table, 12)) return false;
        track.samples += view.getUint32(table.data + 8);
        return true;
      default:
        return true;
    }
  });
}

function readMdia(view: DataView, mdia: Box, track: Mp4Track): boolean {
  return eachBox(view, mdia.data, mdia.end, (box) => {
    if (box.type === "mdhd") {
      if (!holds(box, 1)) return false;
      const v1 = wide(view, box);
      if (!holds(box, v1 ? 32 : 20)) return false;
      track.timescale = view.getUint32(box.data + (v1 ? 20 : 12));
      track.lengths.push(timeAt(view, box.data + (v1 ? 24 : 16), v1));
      return true;
    }
    if (box.type !== "minf") return true;
    return eachBox(view, box.data, box.end, (minf) =>
      minf.type === "stbl" ? readStbl(view, minf, track) : true,
    );
  });
}

function readElst(view: DataView, elst: Box, track: Mp4Track): boolean {
  if (!holds(elst, 8)) return false;
  const v1 = wide(view, elst);
  const count = view.getUint32(elst.data + 4);
  const entry = v1 ? 20 : 12;
  if (!holds(elst, 8 + count * entry)) return false;
  let ticks = 0;
  for (let i = 0; i < count; i++) ticks += timeAt(view, elst.data + 8 + i * entry, v1);
  track.movieLengths.push(ticks);
  return true;
}

/** Reads a `trak` into `tracks` by its ID; false unless it is AAC, once. */
function readTrak(view: DataView, trak: Box, tracks: Map<number, Mp4Track>): boolean {
  const track: Mp4Track = {
    timescale: 0,
    rate: null,
    lengths: [],
    movieLengths: [],
    samples: 0,
    fragmentTicks: 0,
    fragmentStart: Number.POSITIVE_INFINITY,
    fragmentEnd: 0,
  };
  let id: number | null = null;
  const ok = eachBox(view, trak.data, trak.end, (box) => {
    switch (box.type) {
      case "tkhd": {
        if (!holds(box, 1)) return false;
        const v1 = wide(view, box);
        if (!holds(box, v1 ? 36 : 24)) return false;
        id = view.getUint32(box.data + (v1 ? 20 : 12));
        track.movieLengths.push(timeAt(view, box.data + (v1 ? 28 : 20), v1));
        return true;
      }
      case "edts":
        return eachBox(view, box.data, box.end, (elst) =>
          elst.type === "elst" ? readElst(view, elst, track) : true,
        );
      case "mdia":
        return readMdia(view, box, track);
      default:
        return true;
    }
  });
  if (!ok || id === null || tracks.has(id) || track.timescale === 0 || track.rate === null) {
    return false;
  }
  tracks.set(id, track);
  return true;
}

/** Reads a `moof`'s fragments into their tracks; false when one is malformed or unknown. */
function readMoof(
  view: DataView,
  moof: Box,
  tracks: ReadonlyMap<number, Mp4Track>,
  defaults: ReadonlyMap<number, number>,
): boolean {
  return eachBox(view, moof.data, moof.end, (traf) => {
    if (traf.type !== "traf") return true;
    let track: Mp4Track | undefined;
    let duration = 0;
    let base = Number.NaN;
    let ticks = 0;
    const ok = eachBox(view, traf.data, traf.end, (box) => {
      if (box.type !== "tfhd" && box.type !== "tfdt" && box.type !== "trun") return true;
      if (!holds(box, 8)) return false;
      const flags = view.getUint32(box.data) & 0xffffff;
      if (box.type === "tfhd") {
        const id = view.getUint32(box.data + 4);
        track = tracks.get(id);
        const at = box.data + 8 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0);
        if (track === undefined || ((flags & 0x08) !== 0 && at + 4 > box.end)) return false;
        duration = flags & 0x08 ? view.getUint32(at) : (defaults.get(id) ?? 0);
        return true;
      }
      if (box.type === "tfdt") {
        const v1 = wide(view, box);
        if (!holds(box, v1 ? 12 : 8)) return false;
        base = timeAt(view, box.data + 4, v1);
        return true;
      }
      if (track === undefined) return false;
      const count = view.getUint32(box.data + 4);
      let at = box.data + 8 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
      const each = [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length * 4;
      if (at + count * each > box.end) return false;
      if (flags & 0x100) {
        for (let i = 0; i < count; i++, at += each) ticks += view.getUint32(at);
      } else {
        ticks += count * duration;
      }
      track.samples += count;
      return true;
    });
    const fragmented = track as Mp4Track | undefined;
    if (!ok || fragmented === undefined) return false;
    fragmented.fragmentTicks += ticks;
    if (Number.isFinite(base)) {
      fragmented.fragmentStart = Math.min(fragmented.fragmentStart, base);
      fragmented.fragmentEnd = Math.max(fragmented.fragmentEnd, base + ticks);
    }
    return true;
  });
}

function mp4Ms(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tracks = new Map<number, Mp4Track>();
  const defaults = new Map<number, number>();
  const movieLengths: number[] = [];
  let timescale = 0;
  let moov = false;
  const readMoov = (moovBox: Box): boolean =>
    eachBox(view, moovBox.data, moovBox.end, (box) => {
      switch (box.type) {
        case "mvhd": {
          if (!holds(box, 1)) return false;
          const v1 = wide(view, box);
          if (!holds(box, v1 ? 32 : 20)) return false;
          timescale = view.getUint32(box.data + (v1 ? 20 : 12));
          movieLengths.push(timeAt(view, box.data + (v1 ? 24 : 16), v1));
          return true;
        }
        case "trak":
          return readTrak(view, box, tracks);
        case "mvex":
          return eachBox(view, box.data, box.end, (child) => {
            if (child.type === "mehd") {
              if (!holds(child, 1)) return false;
              const v1 = wide(view, child);
              if (!holds(child, v1 ? 12 : 8)) return false;
              movieLengths.push(timeAt(view, child.data + 4, v1));
            } else if (child.type === "trex") {
              if (!holds(child, 16)) return false;
              defaults.set(view.getUint32(child.data + 4), view.getUint32(child.data + 12));
            }
            return true;
          });
        default:
          return true;
      }
    });
  const ok = eachBox(view, 0, bytes.length, (top) => {
    if (top.type === "moov") {
      if (moov) return false;
      moov = true;
      return readMoov(top);
    }
    return top.type === "moof" ? moov && readMoof(view, top, tracks, defaults) : true;
  });
  if (!ok || timescale === 0 || tracks.size === 0) return null;
  const lengths = movieLengths.map((ticks) => (ticks * 1000) / timescale);
  let frames = 0;
  for (const track of tracks.values()) {
    const ms = (ticks: number) => (ticks * 1000) / track.timescale;
    lengths.push(
      ...track.lengths.map(ms),
      ...track.movieLengths.map((ticks) => (ticks * 1000) / timescale),
      ms(track.fragmentTicks),
      ms(track.fragmentEnd - Math.min(track.fragmentStart, track.fragmentEnd)),
    );
    frames += (track.samples * 1024 * 1000) / (track.rate as number);
  }
  return frames === 0 ? 0 : longest([...lengths, frames]);
}

/** An MP3's frames, which must run to its end, or to an ID3v1 tag there. */
function mpegMs(bytes: Uint8Array): number | null {
  const { ms, frames, end } = mp3Frames(bytes);
  if (frames === 0) return null;
  const rest = bytes.length - end;
  const tagged =
    rest === 128 && bytes[end] === 0x54 && bytes[end + 1] === 0x41 && bytes[end + 2] === 0x47;
  return rest <= 0 || tagged ? ms : null;
}
