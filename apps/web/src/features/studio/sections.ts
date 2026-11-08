// The studio's sections, and which of her settings each card shows. Advanced shows every persona
// row the others leave out, so each one appears exactly once.
import type { CardPath } from "@/components/settings-form/controls";

export const SECTIONS = [
  "identity",
  "prompt",
  "voice",
  "models",
  "knowledge",
  "videos",
  "glossary",
  "references",
  "advanced",
] as const;

export type SectionId = (typeof SECTIONS)[number];

export function isSection(value: string | undefined): value is SectionId {
  return (SECTIONS as readonly (string | undefined)[]).includes(value);
}

/** Each card's rows in order; an inner array puts its rows side by side. */
export const CARD_PATHS = {
  timezone: ["identity.timezone"],
  // Fish's voice card's picker, or another provider's voice field.
  voice: ["voice.voiceId"],
  voiceProvider: [["voice.provider", "voice.model"]],
  realtime: ["realtime.provider"],
  realtimeModel: [["realtime.model", "realtime.voice"]],
  models: [
    ["hearing.provider", "hearing.model"],
    "hearing.language",
    ["mind.provider", "mind.model"],
  ],
  memory: [
    ["memory.provider", "memory.model"],
    ["memory.searchLimit", "memory.searchThreshold"],
  ],
  indexing: ["knowledge.facts.files", "knowledge.facts.subject", "knowledge.archive.skipTypes"],
  search: [
    ["knowledge.factsCandidates", "knowledge.archiveCandidates"],
    "knowledge.rerank.enabled",
    ["knowledge.rerank.provider", "knowledge.rerank.model"],
    "knowledge.gate.enabled",
    ["knowledge.gate.provider", "knowledge.gate.model"],
  ],
  transcription: [
    ["transcription.provider", "transcription.model"],
    "transcription.language",
    ["refine.provider", "refine.model"],
    "refine.concurrency",
  ],
  selfie: [
    ["selfie.provider", "selfie.model"],
    ["selfie.quality", "selfie.aspectRatio"],
    ["selfie.timeoutSeconds", "selfie.ttlSeconds"],
    "selfie.references",
  ],
} as const satisfies Readonly<Record<string, readonly CardPath[]>>;

/** Every persona row a section other than Advanced shows. */
export const SHOWN_PATHS: readonly string[] = Object.values(CARD_PATHS).flatMap(
  (paths: readonly CardPath[]) => paths.flat(),
);
