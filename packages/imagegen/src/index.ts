// Selfies: the selfie prompt and references, the render through the selfie role's image model, and
// the TTL store that serves the results. Shared by the take_selfie tool, apps/bot's /api/selfie
// route and the generate-image CLI, so what the CLI probes is what a viewer gets.
export {
  type GeneratedImage,
  type Generation,
  ImageGenError,
  type ReferenceImage,
} from "@eidolon/providers";
export {
  ASPECT_RATIOS,
  DEFAULT_IMAGE_MODEL,
  type GenerateOptions,
  generate,
  MAX_IMAGES,
  MAX_REFERENCES,
  QUALITIES,
} from "./generate.ts";
export { imageMediaType, imageSuffix, REFERENCE_EXTENSIONS } from "./mime.ts";
export {
  AFTER_DARK,
  AMBIENCE,
  type AmbienceRow,
  ambience,
  buildSelfiePrompt,
  fillTime,
  INDOORS,
  OUTDOORS,
  type PersonaClock,
  personaClock,
  SELFIE_PROMPT,
} from "./prompt.ts";
export {
  FRIENDS,
  friendSources,
  imagesIn,
  isReferenceUrl,
  isSelfieConfigured,
  loadReference,
  loadReferences,
  OUTFITS,
  type ReferenceOptions,
  referenceCandidates,
  referenceRoots,
  referenceSources,
  selectOutfit,
} from "./references.ts";
export { type RenderSelfieOptions, renderSelfie, type SelfieRender } from "./render.ts";
export { SELFIE_ID_BYTES, SELFIE_PATH, SelfieStore, selfieResponse, selfieStore } from "./store.ts";
