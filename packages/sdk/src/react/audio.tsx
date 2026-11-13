import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { useEidolonMediaTrack } from "./hooks.ts";

export interface EidolonClientAudioHandle {
  readonly element: HTMLAudioElement | null;
  /** Retries audio playback, such as from a user click after browser autoplay was blocked. */
  play(): Promise<void>;
}

export interface EidolonClientAudioProps {
  /** Called when browser playback is blocked (`true`) or resumes/clears (`false`). */
  readonly onBlockedChange?: (blocked: boolean, error?: Error) => void;
}

/** Plays the remote bot audio track from the enclosing `EidolonClientProvider`. */
export const EidolonClientAudio = forwardRef<EidolonClientAudioHandle, EidolonClientAudioProps>(
  function EidolonClientAudio({ onBlockedChange }, ref) {
    const track = useEidolonMediaTrack("audio", "bot");
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const blockedRef = useRef(false);
    const onBlockedChangeRef = useRef(onBlockedChange);
    useEffect(() => {
      onBlockedChangeRef.current = onBlockedChange;
    }, [onBlockedChange]);

    const reportBlocked = useCallback((blocked: boolean, error?: Error) => {
      if (blockedRef.current === blocked && error === undefined) return;
      blockedRef.current = blocked;
      onBlockedChangeRef.current?.(blocked, error);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        get element() {
          return audioRef.current;
        },
        async play() {
          const el = audioRef.current;
          const source = el?.srcObject;
          if (!el || !(source instanceof MediaStream)) return;
          try {
            await el.play();
            if (audioRef.current === el && el.srcObject === source) {
              reportBlocked(false);
            }
          } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            if (audioRef.current === el && el.srcObject === source) {
              reportBlocked(true, normalized);
              throw normalized;
            }
          }
        },
      }),
      [reportBlocked],
    );

    useEffect(() => {
      const el = audioRef.current;
      if (!el) return;
      if (!track) {
        if (el.srcObject instanceof MediaStream) el.srcObject = null;
        reportBlocked(false);
        return;
      }
      const current = el.srcObject instanceof MediaStream ? el.srcObject.getAudioTracks()[0] : null;
      if (current?.id !== track.id) {
        const stream = new MediaStream([track]);
        el.srcObject = stream;
        el.play()
          .then(() => {
            if (el.srcObject === stream) reportBlocked(false);
          })
          .catch((error: unknown) => {
            if (el.srcObject !== stream) return;
            reportBlocked(true, error instanceof Error ? error : new Error(String(error)));
          });
      }
      return () => {
        if (el.srcObject instanceof MediaStream) el.srcObject = null;
      };
    }, [reportBlocked, track]);

    return (
      // biome-ignore lint/a11y/useMediaCaption: live WebRTC voice stream; live transcript renders separately.
      <audio
        ref={audioRef}
        autoPlay
        onPlaying={() => {
          reportBlocked(false);
        }}
      />
    );
  },
);
