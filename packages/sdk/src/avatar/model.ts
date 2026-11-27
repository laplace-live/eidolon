// What the stage asks of any kind of model, and how a model's setup (mood → expressions and
// parameters, gesture → clip) resolves against what its file holds: the owner's choices first, then
// the standard names PSD2Live gives a generated rig.
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

/** A parameter held at a value, as an outfit or a mood holds it. */
export interface ParameterSetting {
  readonly id: string;
  readonly value: number;
}

/** A parameter moved from what the layers below give it toward a value, by a weight 0..1. */
export interface ParameterHold extends ParameterSetting {
  readonly weight: number;
}

/** An outfit: pose entries shown, parameters held at a value, and parts hidden. */
export interface ModelOutfit {
  readonly id: string;
  readonly name: string;
  readonly poses: readonly { readonly group: number; readonly entry: number }[];
  readonly parameters: readonly ParameterSetting[];
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
   * without it, a clip above layer 0 stops as it ends, or after one pass of a clip authored to
   * loop, so the layers below show through again.
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
  /**
   * How far her gaze turns her head, body and eyes (0 not at all, 1 as far as the runtime does),
   * and optionally how strongly breathing sways her (1 unless given).
   */
  lookStrength(strength: number, o?: { readonly sway?: number }): void;
  /** Advances her clips and idle behaviors by `seconds`, settling physics at that pose. */
  advance?(seconds: number): void;
  /** The ids of the parameters a role such as AngleX moves; none when the model gives it none. */
  roleParameters(role: string): readonly string[];
  wear(outfit: ModelOutfitLike | null): void;
  /**
   * Holds parameters over her clips, expressions and outfit: each moves from what those give it
   * toward its value by its weight, a later hold over an earlier one, and a parameter left out of
   * the next call is let go.
   */
  hold(holds: readonly ParameterHold[]): void;
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

/**
 * The owner's choices for a model: mood → expression ids and parameters it holds, gesture → clip
 * id, and how far she turns.
 */
export interface SetupOverrides {
  readonly moods?: Readonly<Record<string, readonly string[]>>;
  readonly moodParameters?: Readonly<Record<string, readonly ParameterSetting[]>>;
  readonly gestures?: Readonly<Record<string, string>>;
  /** How far her gaze turns her, 0..1; 1 unless given. */
  readonly look?: number;
}

/**
 * A model's setup against its file: the expressions each mood shows and the parameters it holds,
 * the clip each gesture plays, and how far her gaze turns her.
 */
export interface ResolvedSetup {
  readonly moods: Readonly<Record<MoodTag, readonly string[]>>;
  readonly moodParameters: Readonly<Record<MoodTag, readonly ParameterSetting[]>>;
  readonly gestures: Readonly<Record<Gesture, string | null>>;
  /** 0..1 of the runtime's turn. */
  readonly look: number;
}

const MAX_EXPRESSIONS = 2;
const MAX_MOOD_PARAMETERS = 8;

/** The clip a group, name or id names, tried in that order, whatever its case; null for none. */
export function clipFor(clips: readonly ModelClip[], wanted: string): string | null {
  const key = wanted.toLowerCase();
  const clip =
    clips.find((each) => each.group.toLowerCase() === key) ??
    clips.find((each) => each.name.toLowerCase() === key) ??
    clips.find((each) => each.id.toLowerCase() === key);
  return clip?.id ?? null;
}

/**
 * Each mood's expressions, the owner's where they made a choice, else the defaults, kept to those
 * the file has, and the parameters the owner has it hold, kept to the file's within their ranges;
 * each gesture's clip, the owner's where the file has it, else the default it has; and the owner's
 * look, kept within 0..1.
 */
export function resolveSetup(
  inventory: ModelInventory,
  overrides: SetupOverrides = {},
): ResolvedSetup {
  const expressions = new Set(inventory.expressions.map(({ id }) => id));
  const known = (ids: readonly string[]) =>
    [...new Set(ids)].filter((id) => expressions.has(id)).slice(0, MAX_EXPRESSIONS);
  const ranges = new Map(inventory.parameters.map((parameter) => [parameter.id, parameter]));
  const held = (settings: readonly ParameterSetting[]) => {
    const kept: ParameterSetting[] = [];
    for (const { id, value } of settings) {
      const range = ranges.get(id);
      if (range === undefined || !Number.isFinite(value) || kept.some((each) => each.id === id)) {
        continue;
      }
      kept.push({ id, value: Math.min(range.max, Math.max(range.min, value)) });
    }
    return kept.slice(0, MAX_MOOD_PARAMETERS);
  };
  const moods = {} as Record<MoodTag, readonly string[]>;
  const moodParameters = {} as Record<MoodTag, readonly ParameterSetting[]>;
  for (const tag of MOOD_TAGS) {
    const chosen = overrides.moods !== undefined && Object.hasOwn(overrides.moods, tag);
    moods[tag] = known(chosen ? (overrides.moods?.[tag] ?? []) : DEFAULT_MOOD_EXPRESSIONS[tag]);
    const parameters = overrides.moodParameters;
    moodParameters[tag] = held(
      parameters !== undefined && Object.hasOwn(parameters, tag) ? (parameters[tag] ?? []) : [],
    );
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
  const { look } = overrides;
  return {
    moods,
    moodParameters,
    gestures,
    look: look !== undefined && Number.isFinite(look) ? Math.min(Math.max(look, 0), 1) : 1,
  };
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

/** The parameters a set of moods holds: each one's in order, a parameter at its first mood's value. */
export function moodSettings(setup: ResolvedSetup, tags: readonly MoodTag[]): ParameterSetting[] {
  const settings: ParameterSetting[] = [];
  for (const tag of tags) {
    for (const setting of setup.moodParameters[tag]) {
      if (!settings.some(({ id }) => id === setting.id)) settings.push(setting);
    }
  }
  return settings;
}
