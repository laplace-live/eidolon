// Appearance's words by code: her moods, her gestures, the kinds of model she can have, why a
// model didn't show, and why a name can't be saved.
import type { AvatarErrorCode, Gesture, MoodTag } from "@laplace.live/eidolon-sdk/avatar";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import type { CharacterModelKind } from "@/lib/api";
import { MAX_NAME, type NameProblem } from "./model-draft";

export const MOOD_LABELS: Readonly<Record<MoodTag, MessageDescriptor>> = {
  happy: msg({ message: "Happy", context: "mood" }),
  gentle: msg({ message: "Gentle", context: "mood" }),
  lazy: msg({ message: "Lazy", context: "mood" }),
  pout: msg({ message: "Pouting", context: "mood" }),
  wry: msg({ message: "Wry", context: "mood" }),
  shy: msg({ message: "Shy", context: "mood" }),
  sad: msg({ message: "Sad", context: "mood" }),
  angry: msg({ message: "Angry", context: "mood" }),
  surprised: msg({ message: "Surprised", context: "mood" }),
  thinking: msg({ message: "Thinking", context: "mood" }),
  gloom: msg({ message: "Gloomy", context: "mood" }),
};

export const GESTURE_LABELS: Readonly<Record<Gesture, MessageDescriptor>> = {
  idle: msg({ message: "Idle", context: "gesture" }),
  talk: msg({ message: "Talking", context: "gesture" }),
  nod: msg({ message: "Nod", context: "gesture" }),
  shake: msg({ message: "Head Shake", context: "gesture" }),
};

export const MODEL_KIND_LABELS: Readonly<Record<CharacterModelKind, MessageDescriptor>> = {
  psd2live: msg`2D Model · PSD2Live`,
};

/** Why the preview couldn't show her model, by the SDK's error code. */
export const STAGE_ERRORS: Readonly<Record<AvatarErrorCode, MessageDescriptor>> = {
  runtime: msg`PSD2Live's runtime didn't start in this browser.`,
  rig: msg`PSD2Live's runtime couldn't read this model's file.`,
  webgl: msg`This browser can't draw her model: it needs WebGL.`,
  lost: msg`The browser stopped drawing her model to free up its graphics.`,
  trap: msg`PSD2Live's runtime stopped while it drew her model.`,
};

/** Why the server wouldn't take a model's or an outfit's name. */
export const NAME_PROBLEMS: Readonly<Record<NameProblem, MessageDescriptor>> = {
  empty: msg`Give it a name.`,
  long: msg`A name can be up to ${ph({ max: MAX_NAME })} characters.`,
  invalid: msg`A name is one line.`,
};
