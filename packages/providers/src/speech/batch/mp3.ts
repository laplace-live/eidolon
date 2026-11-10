// An MP3's length from its frame headers, since only MiniMax says how long the audio it sends is.

// Layer III bitrates in kbps, by bitrate index: MPEG-1's, then MPEG-2's and 2.5's.
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
// Sample rates by version bits (2.5, reserved, 2, 1), then by rate index.
const SAMPLE_RATES: readonly (readonly number[] | null)[] = [
  [11025, 12000, 8000],
  null,
  [22050, 24000, 16000],
  [44100, 48000, 32000],
];

/** Where the audio starts: past an ID3v2 tag, whose size is four 7-bit bytes. */
function audioStart(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size =
    ((bytes[6] as number) << 21) |
    ((bytes[7] as number) << 14) |
    ((bytes[8] as number) << 7) |
    (bytes[9] as number);
  const footer = ((bytes[5] as number) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** The length of an MPEG Layer III stream in ms, or null when `bytes` hold no frame of one. */
export function mp3DurationMs(bytes: Uint8Array): number | null {
  const { ms, frames } = mp3Frames(bytes);
  return frames === 0 ? null : ms;
}

/** The Layer III frames at the start of `bytes`: their length in ms, and where the run of them ends. */
export function mp3Frames(bytes: Uint8Array): { ms: number; frames: number; end: number } {
  let at = audioStart(bytes);
  let seconds = 0;
  let frames = 0;
  while (at + 4 <= bytes.length) {
    const b1 = bytes[at + 1] as number;
    const b2 = bytes[at + 2] as number;
    if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0) break;
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const rates = SAMPLE_RATES[version];
    const rate = rates?.[(b2 >> 2) & 3];
    const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[(b2 >> 4) & 0xf];
    if (layer !== 1 || rate === undefined || !kbps) break;
    const samples = version === 3 ? 1152 : 576;
    const length = Math.floor(((samples / 8) * kbps * 1000) / rate) + ((b2 >> 1) & 1);
    seconds += samples / rate;
    frames++;
    at += length;
  }
  return { ms: Math.round(seconds * 1000), frames, end: at };
}
