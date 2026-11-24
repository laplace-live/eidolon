// Her voice message's mouth, worked out from its file: decoded offline, so no audio graph touches the
// bubble that plays it in the main window, and nothing needs a click.
import { bytes } from "@/lib/api";
import { voiceOpenings } from "./mouths";

const KEPT = 8;
const kept = new Map<string, Promise<Float32Array | null>>();

async function decoded(chat: string, file: string): Promise<Float32Array | null> {
  try {
    const buffer = await bytes("GET /api/local/chats/:id/files/:name", {
      params: { id: chat, name: file },
    });
    const audio = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(buffer);
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const samples = audio.getChannelData(channel);
      for (let i = 0; i < mono.length; i++) {
        mono[i] = (mono[i] ?? 0) + (samples[i] ?? 0) / audio.numberOfChannels;
      }
    }
    return voiceOpenings(mono, audio.sampleRate);
  } catch {
    return null;
  }
}

/** Her voice message's openings, read from its file in its chat and decoded here; null when it can't be. Eight are kept. */
export function voiceOpeningsOf(chat: string, file: string): Promise<Float32Array | null> {
  const key = `${chat}/${file}`;
  const hit = kept.get(key);
  if (hit !== undefined) {
    kept.delete(key);
    kept.set(key, hit);
    return hit;
  }
  const openings = decoded(chat, file);
  kept.set(key, openings);
  for (const old of kept.keys()) {
    if (kept.size <= KEPT) break;
    kept.delete(old);
  }
  return openings;
}
