import { useMemo } from "react";
import { PipecatClient } from "@pipecat-ai/client-js";
import {
  PipecatClientAudio,
  PipecatClientProvider,
} from "@pipecat-ai/client-react";
import { SmallWebRTCTransport, WavMediaManager } from "@pipecat-ai/small-webrtc-transport";
import { VoiceBot } from "./VoiceBot";

// Where the Pipecat bot's `/api/offer` endpoint lives.
//   - In `pnpm dev`, leave this empty and rely on the Vite proxy
//     (configured in vite.config.ts) to forward to localhost:7860.
//   - In production, set VITE_PIPECAT_BOT_URL to the bot's public origin
//     (e.g. https://bot.example.com). For build-time substitution.
const BOT_BASE_URL = import.meta.env.VITE_PIPECAT_BOT_URL ?? "";
const OFFER_URL = `${BOT_BASE_URL}/api/offer`;

export function App() {
  // The PipecatClient is intentionally constructed once and held for the
  // app's lifetime — recreating it would tear down any in-flight
  // WebRTC connection and mic permissions. StrictMode's double-render
  // is fine because useMemo with [] only runs once per mount.
  const client = useMemo(
    () =>
      new PipecatClient({
        transport: new SmallWebRTCTransport({
          // STUN only — fine for users on the same LAN or with cone NAT.
          // For symmetric-NAT users you'll need your own TURN server
          // and should populate `iceServers` with TURN URLs + creds.
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          // https://github.com/pipecat-ai/pipecat/issues/4065
          mediaManager: new WavMediaManager()
        }),
        enableMic: true,
        enableCam: false,
      }),
    [],
  );

  return (
    <PipecatClientProvider client={client}>
      <VoiceBot offerUrl={OFFER_URL} />
      {/* Renders the bot's audio track. Without this you won't hear anything. */}
      <PipecatClientAudio />
    </PipecatClientProvider>
  );
}
