// What the stage asks of any kind of model, and how a model's setup (mood → expressions, gesture →
// clip) resolves against what its file holds: the owner's choices first, then the standard names
// PSD2Live gives a generated rig.
import type { Bounds, View } from "./framing.ts";
import { DEFAULT_MOOD_EXPRESSIONS, MOOD_TAGS, type MoodTag } from "./moods.ts";

/** What a model does on its own clips: idles, talks while she speaks, and nods or shakes her head. */
export const GESTURES = ["idle", "talk", "nod", "shake"] as const;

export type Gesture = (typeof GESTURES)[number];

/** The clip a gesture plays unless the owner picks one: matched by group, then name, then id. */
const GESTURE_CLIPS: Readonly<Record<Gesture, string>> = {
  idle: "Idle",
  talk: "Talk",
  nod: "Nod",
  shake: "Shake",
};

export interface ModelClip {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  /** Seconds. */
  readonly duration: number;
  readonly looping: boolean;
}

export interface ModelNamed {
  readonly id: string;
  readonly name: string;
}

export interface ModelParameter {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** What the runtime read from a model's file. */
export interface ModelInventory {
  /** The version of the runtime that read it. */
  readonly runtime: string;
  /** What made the file, e.g. "psd2live 3.8.4"; null when it doesn't say. */
  readonly generator: string | null;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly clips: readonly ModelClip[];
  readonly expressions: readonly ModelNamed[];
  readonly hitAreas: readonly ModelNamed[];
  readonly parameters: readonly ModelParameter[];
  readonly parts: readonly ModelNamed[];
  /** How many parts each pose group switches between. */
  readonly poseGroups: readonly number[];
  /** Whether a parameter has the LipSync role, which her mouth moves. */
  readonly lipSync: boolean;
  readonly textures: number;
}

/** An outfit: pose entries shown, parameters held at a value, and parts hidden. */
export interface ModelOutfit {
  readonly id: string;
  readonly name: string;
  readonly poses: readonly { readonly group: number; readonly entry: number }[];
  readonly parameters: readonly { readonly id: string; readonly value: number }[];
  readonly hiddenParts: readonly string[];
}

export type ModelOutfitLike = Pick<ModelOutfit, "poses" | "parameters" | "hiddenParts">;

/** A model the stage draws. Every method may throw an AvatarError, after which it is unusable. */
export interface AvatarModel {
  readonly kind: "psd2live";
  readonly inventory: ModelInventory;
  /** Shows exactly these expressions; an id the model lacks is ignored, and a list of only those changes nothing. */
  setExpressions(ids: readonly string[]): void;
  /**
   * Plays a clip on a layer over those below it, null stopping the layer; an id the model lacks
   * changes nothing. `loop` replays a clip that ends by itself until the layer plays another;
   * without it, a clip above layer 0 stops as it ends, so the layers below show through again.
   */
  play(
    clip: string | null,
    layer: 0 | 1 | 2,
    o?: { readonly loop?: boolean; readonly priority?: number },
  ): void;
  /** How far her mouth is open, 0..1. */
  mouth(level: number): void;
  /** Where she looks, each axis -1..1 (x right, y up). */
  lookAt(x: number, y: number): void;
  wear(outfit: ModelOutfitLike | null): void;
  /** A hit area's bounds, or with none every mesh drawn, at the last update; null for nothing. */
  bounds(area?: string | null): Bounds | null;
  update(dt: number): void;
  draw(pixelRatio: number, view: View): void;
  hitTest(clientX: number, clientY: number): string | null;
  /** The drawn alpha, 0..1, at a point of the page, read right after a draw. */
  alphaAt(clientX: number, clientY: number): number;
  dispose(): void;
}

export type AvatarErrorCode = "runtime" | "rig" | "webgl" | "lost" | "trap";

/**
 * Why a model can't be shown: the runtime didn't load (`runtime`), the file isn't a rig it reads
 * (`rig`), WebGL can't draw it (`webgl`), the browser took the GPU context back (`lost`), or the
 * runtime failed while it ran (`trap`).
 */
export class AvatarError extends Error {
  override name = "AvatarError";
  readonly code: AvatarErrorCode;

  constructor(code: AvatarErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** `error` as an AvatarError: as it is when it is one, else under `code`. */
export function avatarErrorOf(error: unknown, code: AvatarErrorCode): AvatarError {
  if (error instanceof AvatarError) return error;
  return new AvatarError(code, error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

/** The owner's choices for a model: mood → expression ids, gesture → clip id. */
export interface SetupOverrides {
  readonly moods?: Readonly<Record<string, readonly string[]>>;
  readonly gestures?: Readonly<Record<string, string>>;
}

/** A model's setup against its file: the expressions each mood shows and the clip each gesture plays. */
export interface ResolvedSetup {
  readonly moods: Readonly<Record<MoodTag, readonly string[]>>;
  readonly gestures: Readonly<Record<Gesture, string | null>>;
}

const MAX_EXPRESSIONS = 2;

/** The clip a group, name or id names, tried in that order, whatever its case; null for none. */
export function clipFor(clips: readonly ModelClip[], wanted: string): string | null {
  const key = wanted.toLowerCase();
  const clip =
    clips.find((each) => each.group.toLowerCase() === key) ??
    clips.find((each) => each.name.toLowerCase() === key) ??
    clips.find((each) => each.id.toLowerCase() === key);
  return clip?.id ?? null;
}

/** Each mood's expressions and each gesture's clip: the owner's where they name what the file has, else the defaults it has. */
export function resolveSetup(
  inventory: ModelInventory,
  overrides: SetupOverrides = {},
): ResolvedSetup {
  const expressions = new Set(inventory.expressions.map(({ id }) => id));
  const known = (ids: readonly string[]) =>
    [...new Set(ids)].filter((id) => expressions.has(id)).slice(0, MAX_EXPRESSIONS);
  const moods = {} as Record<MoodTag, readonly string[]>;
  for (const tag of MOOD_TAGS) {
    const chosen = overrides.moods !== undefined && Object.hasOwn(overrides.moods, tag);
    moods[tag] = known(chosen ? (overrides.moods?.[tag] ?? []) : DEFAULT_MOOD_EXPRESSIONS[tag]);
  }
  const clips = new Set(inventory.clips.map(({ id }) => id));
  const gestures = {} as Record<Gesture, string | null>;
  for (const gesture of GESTURES) {
    const chosen =
      overrides.gestures !== undefined && Object.hasOwn(overrides.gestures, gesture)
        ? overrides.gestures[gesture]
        : undefined;
    gestures[gesture] =
      chosen !== undefined && clips.has(chosen)
        ? chosen
        : clipFor(inventory.clips, GESTURE_CLIPS[gesture]);
  }
  return { moods, gestures };
}

/** The expressions a set of moods shows: each one's in order, without repeats, at most two. */
export function moodExpressions(setup: ResolvedSetup, tags: readonly MoodTag[]): string[] {
  const ids: string[] = [];
  for (const tag of tags) {
    for (const id of setup.moods[tag]) {
      if (ids.length < MAX_EXPRESSIONS && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
