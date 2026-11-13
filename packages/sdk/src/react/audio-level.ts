import { useEffect, useRef } from "react";
import { useEidolonMediaTrack } from "./hooks.ts";

const SMOOTHING = 0.3;
const RMS_GAIN = 4;

export interface EidolonAudioLevelOptions {
  readonly enabled: boolean;
  readonly participant?: "local" | "bot";
  readonly onLevel: (level: number) => void;
}

/** Drives `onLevel` once per animation frame with the smoothed 0..1 RMS loudness of a call track. */
export function useEidolonAudioLevel({
  enabled,
  participant = "bot",
  onLevel,
}: EidolonAudioLevelOptions): void {
  const track = useEidolonMediaTrack("audio", participant);
  const onLevelRef = useRef(onLevel);
  useEffect(() => {
    onLevelRef.current = onLevel;
  }, [onLevel]);

  useEffect(() => {
    if (!enabled || !track || typeof window === "undefined") return;

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.fftSize);
    let smoothed = 0;
    let frame = 0;

    const tick = () => {
      analyser.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i++) {
        const sample = ((buffer[i] ?? 128) - 128) / 128;
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / buffer.length);
      const raw = Math.min(1, rms * RMS_GAIN);
      smoothed += (raw - smoothed) * SMOOTHING;
      onLevelRef.current(smoothed);
      frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      void audioContext.close();
    };
  }, [enabled, track]);
}
