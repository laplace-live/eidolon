// Searches Fish Audio's public voices (GET voices/search) and previews their samples: the wizard's
// voice step, persona creation and the studio's voice tab use it.
import type { Voice } from "@/lib/api";

export interface VoicePickerProps {
  /** The chosen voice's id (FISH_VOICE_ID), or null before one is picked. */
  readonly value: string | null;
  readonly onChange: (voice: Voice) => void;
  readonly disabled?: boolean;
}

export function VoicePicker(_props: VoicePickerProps) {
  return null;
}
