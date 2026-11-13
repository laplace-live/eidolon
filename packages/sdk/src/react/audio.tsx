import { useEffect, useRef } from "react";
import { useEidolonMediaTrack } from "./hooks.ts";

/** Plays the remote bot audio track from the enclosing `EidolonClientProvider`. */
export function EidolonClientAudio() {
  const track = useEidolonMediaTrack("audio", "bot");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!track) {
      if (el.srcObject instanceof MediaStream) el.srcObject = null;
      return;
    }
    const current = el.srcObject instanceof MediaStream ? el.srcObject.getAudioTracks()[0] : null;
    if (current?.id !== track.id) {
      el.srcObject = new MediaStream([track]);
      void el.play().catch(() => {});
    }
    return () => {
      if (el.srcObject instanceof MediaStream) el.srcObject = null;
    };
  }, [track]);

  // biome-ignore lint/a11y/useMediaCaption: live WebRTC voice stream; live transcript renders separately.
  return <audio ref={audioRef} autoPlay />;
}
