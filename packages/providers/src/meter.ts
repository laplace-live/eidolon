// A call's audio seconds and spoken characters, batched so a long call writes a handful of usage
// records rather than one per frame or sentence.
import type { Units } from "./pricing.ts";
import type { Selection } from "./resolve.ts";
import { reportUsage } from "./usage.ts";

/** Report once this much audio, or text, has piled up, and at the end of the call. */
const AUDIO_BATCH_SECONDS = 300;
const TEXT_BATCH_CHARACTERS = 2000;

export class Meter {
  #units: { audioSeconds: number; characters: number; bytes: number } = {
    audioSeconds: 0,
    characters: 0,
    bytes: 0,
  };
  readonly #selection: Selection;

  constructor(selection: Selection) {
    this.#selection = selection;
  }

  add(units: Pick<Units, "audioSeconds" | "characters" | "bytes">): void {
    this.#units.audioSeconds += units.audioSeconds ?? 0;
    this.#units.characters += units.characters ?? 0;
    this.#units.bytes += units.bytes ?? 0;
    if (
      this.#units.audioSeconds >= AUDIO_BATCH_SECONDS ||
      this.#units.characters >= TEXT_BATCH_CHARACTERS
    ) {
      this.flush();
    }
  }

  flush(): void {
    const { audioSeconds, characters, bytes } = this.#units;
    if (audioSeconds === 0 && characters === 0) return;
    this.#units = { audioSeconds: 0, characters: 0, bytes: 0 };
    const { role, provider, model } = this.#selection;
    reportUsage({
      role: role.id,
      provider: provider.id,
      model,
      units: audioSeconds > 0 ? { audioSeconds } : { characters, bytes },
    });
  }
}
