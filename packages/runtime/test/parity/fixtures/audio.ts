// The audio both engines hear, built on the spot: the repository keeps no recordings (.gitignore).
import { concat, noise, syntheticSpeech, toPcm } from "../../../../voice/test/input/speech.ts";

const ROOM_TONE = 60;

function overRoomTone(speech: Float64Array, seed: number): Float64Array {
  const tone = noise(speech.length / 16000, ROOM_TONE, seed);
  return speech.map((v, i) => v + (tone[i] as number));
}

/**
 * A caller's 39 s at 16 kHz: a quiet start long enough for Silero's resets and Smart Turn's
 * pre-speech trim, a question with a short pause in it, a fragment Smart Turn judges unfinished
 * followed by more than its 3 s stop, then a quieter answer longer than its 8 s window. Built
 * once and shared, so never written to.
 */
export function callAudio(): Int16Array {
  call ??= toPcm(
    concat(
      noise(12.5, ROOM_TONE, 11),
      overRoomTone(syntheticSpeech(2.5, 21), 12),
      noise(0.5, ROOM_TONE, 13),
      overRoomTone(syntheticSpeech(3, 22), 14),
      noise(1.5, ROOM_TONE, 15),
      overRoomTone(syntheticSpeech(1.2, 56), 16),
      noise(4, ROOM_TONE, 17),
      overRoomTone(
        syntheticSpeech(9.5, 23).map((v) => v * 0.3),
        18,
      ),
      noise(1.5, ROOM_TONE, 19),
      fadeIn(syntheticSpeech(4, 24), 0.005, 0.1),
      noise(1, ROOM_TONE / 10, 20),
    ),
  );
  return call;
}
let call: Int16Array | undefined;

/** `speech` rising from `from` to `to` of its level: it crosses the VAD's volume gate on the way. */
function fadeIn(speech: Float64Array, from: number, to: number): Float64Array {
  return speech.map((v, i) => v * (from + ((to - from) * i) / speech.length));
}

/** Segments for Smart Turn alone: shorter than its 8 s window, longer, silent and noisy. Shared. */
export function turnSegments(): Readonly<Record<string, Float32Array>> {
  const float = (audio: Float64Array) => Float32Array.from(toPcm(audio), (v) => v / 32768);
  segments ??= {
    "2 s of speech": float(syntheticSpeech(2, 31)),
    "10 s of speech": float(syntheticSpeech(10, 32)),
    "speech then a pause": float(concat(syntheticSpeech(3, 33), noise(1, ROOM_TONE, 34))),
    "1 s of silence": new Float32Array(16000),
    "3 s of noise": float(noise(3, 3000, 35)),
  };
  return segments;
}
let segments: Record<string, Float32Array> | undefined;
