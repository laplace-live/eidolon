import { useEffect, useRef } from "react";
import { useOptionalEidolonClient } from "./provider.tsx";

/** Plays the remote bot audio track from the enclosing `EidolonClientProvider`. */
export function EidolonClientAudio() {
  const client = useOptionalEidolonClient();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (client === null) return;

    const attach = (track: MediaStreamTrack | undefined) => {
      const el = audioRef.current;
      if (!el || !track || track.kind !== "audio") return;
      const current = el.srcObject instanceof MediaStream ? el.srcObject.getAudioTracks()[0] : null;
      if (current?.id === track.id) return;
      el.srcObject = new MediaStream([track]);
      void el.play().catch(() => {});
    };

    const detach = (track?: MediaStreamTrack) => {
      const el = audioRef.current;
      if (!el || !(el.srcObject instanceof MediaStream)) return;
      if (track && el.srcObject.getAudioTracks()[0]?.id !== track.id) return;
      el.srcObject = null;
    };

    attach(client.tracks().bot?.audio);

    const offStarted = client.on("trackStarted", (track, participant) => {
      if (participant?.local !== true && track.kind === "audio") attach(track);
    });
    const offStopped = client.on("trackStopped", (track, participant) => {
      if (participant?.local !== true && track.kind === "audio") detach(track);
    });
    const offDisconnected = client.on("disconnected", () => detach());

    return () => {
      offStarted();
      offStopped();
      offDisconnected();
      detach();
    };
  }, [client]);

  // biome-ignore lint/a11y/useMediaCaption: live WebRTC voice stream; live transcript renders separately.
  return <audio ref={audioRef} autoPlay />;
}
