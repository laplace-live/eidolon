// The microphone, recorded into one voice message at a time with MediaRecorder.
import { MAX_VOICE_MS } from "@eidolon/chat";
import { useCallback, useEffect, useRef, useState } from "react";
import { type MicProblem, micProblemOf } from "@/features/call/media";
import type { VoiceClip } from "./stream";
import { MIN_RECORDING_MS, MicRequests, recordingType } from "./voice";

export type RecorderPhase = "idle" | "starting" | "recording";

/** Why a recording didn't become a message: the microphone's problem, or it was too short. */
export type RecorderProblem = MicProblem | "short";

interface Take {
  readonly stream: MediaStream;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly startedAt: number;
}

/** Whether this browser can record a voice message here at all. */
export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    navigator.mediaDevices !== undefined &&
    recordingType((type) => MediaRecorder.isTypeSupported(type)) !== null
  );
}

function release(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export interface Recorder {
  readonly phase: RecorderPhase;
  /** How long the take has run, in whole seconds' ms. */
  readonly elapsed: number;
  start(): void;
  /** Ends the take: `send` hands it to `onClip`, else it is thrown away. */
  stop(send: boolean): void;
}

/**
 * One take at a time. It stops on its own at MAX_VOICE_MS and sends what it has; the
 * microphone is let go as soon as a take ends, and when the component unmounts.
 */
export function useRecorder({
  onClip,
  onProblem,
}: {
  readonly onClip: (clip: VoiceClip) => void;
  readonly onProblem: (problem: RecorderProblem) => void;
}): Recorder {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const take = useRef<Take | null>(null);
  // Stop cancels a start under way, so a microphone granted after it is let go at once.
  const requests = useRef(new MicRequests());
  const handlers = useRef({ onClip, onProblem });
  useEffect(() => {
    handlers.current = { onClip, onProblem };
  });

  const stop = useCallback((send: boolean) => {
    requests.current.cancel();
    const current = take.current;
    take.current = null;
    setPhase("idle");
    setElapsed(0);
    if (current === null) return;
    const durationMs = Math.min(performance.now() - current.startedAt, MAX_VOICE_MS);
    const { recorder } = current;
    // The last chunk arrives just before "stop".
    const finish = () => {
      release(current.stream);
      if (!send) return;
      if (durationMs < MIN_RECORDING_MS) {
        handlers.current.onProblem("short");
        return;
      }
      const type = recorder.mimeType || current.chunks[0]?.type || "audio/webm";
      handlers.current.onClip({ audio: new Blob(current.chunks, { type }), durationMs });
    };
    if (recorder.state === "inactive") {
      finish();
    } else {
      recorder.onstop = finish;
      recorder.stop();
    }
  }, []);

  const start = useCallback(() => {
    if (take.current !== null) return;
    const request = requests.current.begin();
    if (request === null) return;
    setPhase("starting");
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        if (!requests.current.settle(request)) {
          release(stream);
          return;
        }
        const type = recordingType((candidate) => MediaRecorder.isTypeSupported(candidate));
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, type === null ? undefined : { mimeType: type });
          recorder.start();
        } catch {
          release(stream);
          setPhase("idle");
          handlers.current.onProblem("unknown");
          return;
        }
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => {
          stop(false);
          handlers.current.onProblem("unknown");
        };
        take.current = { stream, recorder, chunks, startedAt: performance.now() };
        setElapsed(0);
        setPhase("recording");
      },
      (error: unknown) => {
        if (!requests.current.settle(request)) return;
        setPhase("idle");
        handlers.current.onProblem(micProblemOf(error));
      },
    );
  }, [stop]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      const current = take.current;
      if (current === null) return;
      const ran = performance.now() - current.startedAt;
      if (ran >= MAX_VOICE_MS) stop(true);
      // The bar shows whole seconds: an unchanged value skips the Composer's render.
      else setElapsed(Math.floor(ran / 1000) * 1000);
    }, 200);
    return () => clearInterval(timer);
  }, [phase, stop]);

  useEffect(() => () => stop(false), [stop]);

  return { phase, elapsed, start, stop };
}
