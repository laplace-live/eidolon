import { defaultEngineDeps, runTurn } from "@eidolon/engine";
import { openRealtime } from "@eidolon/providers/realtime";
import { openSpeech } from "@eidolon/providers/speech-stream";
import { openStt } from "@eidolon/providers/stt";
import type { CallDeps } from "@eidolon/voice";
import { voiceModels } from "../audio.ts";
import { BOT_ABOUT } from "../rtvi.ts";

/** What a native call runs on in production and the local app: the real engine and clients. */
export const productionCallDeps: CallDeps = {
  engine: defaultEngineDeps({
    // A call's tools act through its effects, so the engine never stores a file for one.
    saveAttachment: () => Promise.reject(new Error("A call keeps no files")),
  }),
  runTurn,
  openStt,
  openSpeech,
  openRealtime,
  models: voiceModels(),
  about: BOT_ABOUT,
  clock: {
    now: () => performance.now(),
    setTimer(ms, fire) {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    },
  },
};
