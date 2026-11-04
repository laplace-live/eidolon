// Selfies: OpenRouter image generation, the selfie prompt and references, and the TTL store that
// serves the results. Shared by the take_selfie tool, apps/bot's /api/selfie route and the
// generate-image CLI, so what the CLI probes is what a viewer gets.
export { ImageGenError } from "./errors.ts";
export {
  ASPECT_RATIOS,
  DEFAULT_IMAGE_MODEL,
  type GeneratedImage,
  type GenerateOptions,
  type Generation,
  generate,
  IMAGE_REQUEST_IDLE_TIMEOUT_MS,
  MAX_IMAGES,
  MAX_REFERENCES,
  OPENROUTER_IMAGES_URL,
  QUALITIES,
} from "./generate.ts";
export { imageMediaType, imageSuffix } from "./mime.ts";
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
export { pyPath, pyPathName, pyPathStem, pyPathSuffix, pyPathWithName } from "./pypath.ts";
export {
  FRIENDS,
  friendSources,
  imagesIn,
  isReferenceUrl,
  isSelfieConfigured,
  loadReference,
  loadReferences,
  OUTFITS,
  type ReferenceImage,
  type ReferenceOptions,
  referenceRoots,
  referenceSources,
  selectOutfit,
} from "./references.ts";
export { type RenderSelfieOptions, renderSelfie, type SelfieRender } from "./render.ts";
export { SELFIE_ID_BYTES, SELFIE_PATH, SelfieStore, selfieResponse, selfieStore } from "./store.ts";
