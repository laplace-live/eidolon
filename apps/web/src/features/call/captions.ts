// What a video call's screen shows of what is said: the last line, hers or the viewer's, as a
// caption, and her newest photo.
import { type CallSpeaker, stripCues } from "@laplace.live/eidolon-sdk";
import { type SelfieEntry, type Transcript, userText } from "./transcript";

export type Caption =
  | {
      readonly kind: "her";
      /** Who said it on a group call; null on a call with her alone. */
      readonly speaker: CallSpeaker | null;
      /** Her latest sentence, cues and directions taken out. */
      readonly text: string;
      /** She is saying it now. */
      readonly live: boolean;
    }
  | {
      readonly kind: "you";
      readonly said: string;
      /** The part still being heard, with its leading space (userText). */
      readonly hearing: string;
      /** Still being heard. */
      readonly live: boolean;
    };

/**
 * The last thing said on the call, hers or the viewer's; null before anything is. Her sentence
 * shows whole from its announcement and stays until the next line, so nothing flickers between two.
 */
export function captionOf(transcript: Transcript, botSpeaking: boolean): Caption | null {
  const last = transcript.entries.findLast((entry) => entry.kind !== "selfie");
  if (last === undefined) return null;
  if (last.kind === "user") {
    const { said, hearing } = userText(last);
    if (said.trim() === "" && hearing.trim() === "") return null;
    return { kind: "you", said, hearing, live: transcript.openUser === last.id };
  }
  for (const segment of last.segments.toReversed()) {
    const text = segment.voiced ? stripCues(segment.text) : "";
    if (text !== "") return { kind: "her", speaker: last.speaker, text, live: botSpeaking };
  }
  return null;
}

/** The call's newest photo. */
export function latestSelfie(transcript: Transcript): SelfieEntry | null {
  return transcript.entries.findLast((entry) => entry.kind === "selfie") ?? null;
}
