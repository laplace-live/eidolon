// What Studio edits of a model before Save: its call framing, its moods and gestures, and its
// outfits. Save sends only the fields that changed, each in a shape the server's PATCH takes.
import {
  type Box,
  type Gesture,
  type MoodTag,
  resolveSetup,
  zoomBox,
} from "@laplace.live/eidolon-sdk/avatar";
import type {
  CharacterModel,
  CharacterModelPatch,
  CharacterModels,
  ModelBox,
  ModelInventory,
  ModelOutfit,
  SettingRow,
} from "@/lib/api";

export type ModelDraft = Pick<
  CharacterModel,
  "framing" | "moods" | "gestures" | "outfits" | "outfit"
>;

const FIELDS = [
  "framing",
  "moods",
  "gestures",
  "outfits",
  "outfit",
] as const satisfies readonly (keyof ModelDraft)[];

/** The server's limits, as CharacterModelPatch's doc comment gives them. */
export const MAX_OUTFITS = 32;
export const MAX_MOOD_EXPRESSIONS = 2;
export const MAX_NAME = 64;

export function draftOf(model: ModelDraft): ModelDraft {
  const { framing, moods, gestures, outfits, outfit } = model;
  return { framing, moods, gestures, outfits, outfit };
}

/** Plain JSON compared by value, whatever order an object's keys are in. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

/** The draft as the server would keep it: outfit names trimmed. */
function normalized(draft: ModelDraft): ModelDraft {
  if (draft.outfits.every((outfit) => outfit.name === outfit.name.trim())) return draft;
  return {
    ...draft,
    outfits: draft.outfits.map((outfit) => ({ ...outfit, name: outfit.name.trim() })),
  };
}

/** The fields of `draft` that differ from `saved`, as PATCH takes them. */
export function draftChanges(draft: ModelDraft, saved: ModelDraft): CharacterModelPatch {
  const sent = normalized(draft);
  const patch: Partial<Record<keyof ModelDraft, unknown>> = {};
  for (const field of FIELDS) {
    if (!sameValue(sent[field], saved[field])) patch[field] = sent[field];
  }
  return patch as CharacterModelPatch;
}

/**
 * `draft` once what it was made from went from `base` to `next`, as after a Save or a rename: a
 * field the owner left as it was takes `next`'s, and one they changed meanwhile stays theirs.
 */
export function rebaseDraft(draft: ModelDraft, base: ModelDraft, next: ModelDraft): ModelDraft {
  const out: Record<string, unknown> = {};
  for (const field of FIELDS) {
    out[field] = sameValue(draft[field], base[field]) ? next[field] : draft[field];
  }
  return out as ModelDraft;
}

/**
 * `draft` on a new file the runtime read as `inventory`: what it names that the rig lacks goes, and
 * values keep within their new ranges, as the server keeps what was saved.
 */
export function keptDraft(draft: ModelDraft, inventory: ModelInventory): ModelDraft {
  const expressions = new Set(inventory.expressions.map(({ id }) => id));
  const clips = new Set(inventory.clips.map(({ id }) => id));
  const parts = new Set(inventory.parts.map(({ id }) => id));
  const ranges = new Map(inventory.parameters.map((parameter) => [parameter.id, parameter]));
  return {
    ...draft,
    moods: Object.fromEntries(
      Object.entries(draft.moods).flatMap(([mood, ids]) => {
        const left = ids.filter((id) => expressions.has(id));
        return left.length > 0 || ids.length === 0 ? [[mood, left]] : [];
      }),
    ),
    gestures: Object.fromEntries(Object.entries(draft.gestures).filter(([, id]) => clips.has(id))),
    outfits: draft.outfits.map((outfit) => ({
      ...outfit,
      poses: outfit.poses.filter(({ group, entry }) => entry < (inventory.poseGroups[group] ?? 0)),
      parameters: outfit.parameters.flatMap(({ id, value }) => {
        const range = ranges.get(id);
        return range ? [{ id, value: Math.min(range.max, Math.max(range.min, value)) }] : [];
      }),
      hiddenParts: outfit.hiddenParts.filter((id) => parts.has(id)),
    })),
  };
}

/** The model she shows, and where that comes from. */
export interface ActiveModel {
  readonly id: string;
  /** Her own appearance.model names it; else she inherits the environment's. */
  readonly own: boolean;
  /** What she shows once her own setting is cleared: the environment's model, while she has it. */
  readonly fallback: string | null;
}

/** Which of `list`'s models she shows, by her appearance.model row; null for none, or while it loads. */
export function activeModelOf(
  list: CharacterModels,
  setting: Pick<SettingRow, "value" | "envValue"> | undefined,
): ActiveModel | null {
  if (list.active === null || setting === undefined) return null;
  const env = setting.envValue;
  return {
    id: list.active,
    own: typeof setting.value === "string" && setting.value !== "",
    fallback: env !== null && list.models.some(({ id }) => id === env) ? env : null,
  };
}

/** Why the server would refuse a name: none, too long, or more than one line. */
export type NameProblem = "empty" | "long" | "invalid";

export function nameProblem(name: string): NameProblem | null {
  const trimmed = name.trim();
  if (trimmed === "") return "empty";
  if ([...trimmed].length > MAX_NAME) return "long";
  return /\p{Cc}/u.test(trimmed) ? "invalid" : null;
}

/** The first outfit whose name Save would send the server can't take; null when there is none. */
export function draftProblem(
  draft: ModelDraft,
): { readonly outfit: string; readonly problem: NameProblem } | null {
  for (const outfit of draft.outfits) {
    const problem = nameProblem(outfit.name);
    if (problem !== null) return { outfit: outfit.id, problem };
  }
  return null;
}

/** The expressions `tag` shows on this model: the owner's choice, else the default it has. */
export function moodExpressions(
  inventory: ModelInventory,
  moods: ModelDraft["moods"],
  tag: MoodTag,
): readonly string[] {
  return resolveSetup(inventory, { moods }).moods[tag];
}

/**
 * `moods` with `tag` showing `ids`, or with no choice for it when they are its default: the draft,
 * like the server, holds only what the owner chose.
 */
export function withMood(
  inventory: ModelInventory,
  moods: ModelDraft["moods"],
  tag: MoodTag,
  ids: readonly string[],
): ModelDraft["moods"] {
  const known = new Set(inventory.expressions.map(({ id }) => id));
  const chosen = [...new Set(ids)].filter((id) => known.has(id)).slice(0, MAX_MOOD_EXPRESSIONS);
  const rest = withoutMood(moods, tag);
  return sameValue(chosen, moodExpressions(inventory, rest, tag))
    ? rest
    : { ...rest, [tag]: chosen };
}

export function withoutMood(moods: ModelDraft["moods"], tag: string): ModelDraft["moods"] {
  if (!Object.hasOwn(moods, tag)) return moods;
  const { [tag]: _, ...rest } = moods;
  return rest;
}

/** `ids` with `id` taken out, or put in while there is room for it; null when there is none. */
export function toggledExpression(ids: readonly string[], id: string): string[] | null {
  if (ids.includes(id)) return ids.filter((each) => each !== id);
  return ids.length < MAX_MOOD_EXPRESSIONS ? [...ids, id] : null;
}

/** The clip `gesture` plays on this model: the owner's choice, else the default it has. */
export function gestureClip(
  inventory: ModelInventory,
  gestures: ModelDraft["gestures"],
  gesture: Gesture,
): string | null {
  return resolveSetup(inventory, { gestures }).gestures[gesture];
}

/** `gestures` with `gesture` playing `clip`; set back to its default when that is the default. */
export function withGesture(
  inventory: ModelInventory,
  gestures: ModelDraft["gestures"],
  gesture: Gesture,
  clip: string,
): ModelDraft["gestures"] {
  const rest = withoutGesture(gestures, gesture);
  if (!inventory.clips.some(({ id }) => id === clip)) return rest;
  return gestureClip(inventory, rest, gesture) === clip ? rest : { ...rest, [gesture]: clip };
}

export function withoutGesture(
  gestures: ModelDraft["gestures"],
  gesture: string,
): ModelDraft["gestures"] {
  if (!Object.hasOwn(gestures, gesture)) return gestures;
  const { [gesture]: _, ...rest } = gestures;
  return rest;
}

/** An id for a new outfit: `outfit-` and the lowest number none of `outfits` has. */
export function newOutfitId(outfits: readonly Pick<ModelOutfit, "id">[]): string {
  const taken = new Set(outfits.map(({ id }) => id));
  for (let n = 1; ; n++) {
    const id = `outfit-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The first of `named(1)`, `named(2)`… that none of `outfits` is called. */
export function newOutfitName(
  outfits: readonly Pick<ModelOutfit, "name">[],
  named: (n: number) => string,
): string {
  const taken = new Set(outfits.map(({ name }) => name.trim()));
  for (let n = 1; n <= outfits.length; n++) {
    if (!taken.has(named(n))) return named(n);
  }
  return named(outfits.length + 1);
}

/** `draft` with a new, empty outfit called `name`; unchanged once it has as many as it can. */
export function withNewOutfit(draft: ModelDraft, name: string): ModelDraft {
  if (draft.outfits.length >= MAX_OUTFITS) return draft;
  const outfit: ModelOutfit = {
    id: newOutfitId(draft.outfits),
    name,
    poses: [],
    parameters: [],
    hiddenParts: [],
  };
  return { ...draft, outfits: [...draft.outfits, outfit] };
}

export function withOutfit(draft: ModelDraft, outfit: ModelOutfit): ModelDraft {
  return {
    ...draft,
    outfits: draft.outfits.map((each) => (each.id === outfit.id ? outfit : each)),
  };
}

/** `draft` without outfit `id`; she wears none instead when she wore it. */
export function withoutOutfit(draft: ModelDraft, id: string): ModelDraft {
  return {
    ...draft,
    outfits: draft.outfits.filter((each) => each.id !== id),
    outfit: draft.outfit === id ? null : draft.outfit,
  };
}

/** `outfit` showing `entry` of pose group `group`, or with null the entry the model loads with. */
export function withPose(outfit: ModelOutfit, group: number, entry: number | null): ModelOutfit {
  const poses = outfit.poses.filter((pose) => pose.group !== group);
  if (entry !== null) poses.push({ group, entry });
  return { ...outfit, poses: poses.sort((a, b) => a.group - b.group) };
}

/** `outfit` holding parameter `id` at `value`, kept within its range; with null, letting it go. */
export function withParameter(
  inventory: ModelInventory,
  outfit: ModelOutfit,
  id: string,
  value: number | null,
): ModelOutfit {
  const range = inventory.parameters.find((parameter) => parameter.id === id);
  if (value === null || range === undefined) {
    return { ...outfit, parameters: outfit.parameters.filter((setting) => setting.id !== id) };
  }
  const held = Math.min(range.max, Math.max(range.min, value));
  const at = outfit.parameters.findIndex((setting) => setting.id === id);
  const parameters =
    at === -1
      ? [...outfit.parameters, { id, value: held }]
      : outfit.parameters.map((setting, index) => (index === at ? { id, value: held } : setting));
  return { ...outfit, parameters };
}

export function withHiddenParts(outfit: ModelOutfit, parts: readonly string[]): ModelOutfit {
  return { ...outfit, hiddenParts: [...new Set(parts)] };
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/** CSS pixels per rig pixel where `box` shows whole and centred in an element of `size`. */
export function boxScale(box: Box, size: Size): number {
  if (!(box.width > 0 && box.height > 0)) return 0;
  return Math.min(size.width / box.width, size.height / box.height);
}

/** The point of the rig's canvas under a point of the element, in CSS pixels from its top left. */
export function rigPointAt(box: Box, size: Size, at: readonly [number, number]): [number, number] {
  const scale = boxScale(box, size);
  if (!(scale > 0)) return [box.x + box.width / 2, box.y + box.height / 2];
  return [
    box.x + box.width / 2 + (at[0] - size.width / 2) / scale,
    box.y + box.height / 2 + (at[1] - size.height / 2) / scale,
  ];
}

/** Where `box` shows in an element of `size`, in CSS pixels: centred, whole, touching two sides. */
export function shownRect(
  box: Box,
  size: Size,
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  const scale = boxScale(box, size);
  const width = box.width * scale;
  const height = box.height * scale;
  return { left: (size.width - width) / 2, top: (size.height - height) / 2, width, height };
}

/** The most and least of her canvas a frame may hold, by height. */
const MAX_FRAME = 3;
const MIN_FRAME = 1 / 50;

const rounded = (value: number) => Math.round(value * 100) / 100;

/** `box` kept where she can be found: its size within limits and its centre on her canvas. */
export function clampBox(box: Box, canvas: Size): ModelBox {
  const height = Math.min(
    canvas.height * MAX_FRAME,
    Math.max(canvas.height * MIN_FRAME, box.height),
  );
  const sized = zoomBox(box, box.height / height, [box.x + box.width / 2, box.y + box.height / 2]);
  const cx = Math.min(canvas.width, Math.max(0, sized.x + sized.width / 2));
  const cy = Math.min(canvas.height, Math.max(0, sized.y + sized.height / 2));
  return {
    x: rounded(cx - sized.width / 2),
    y: rounded(cy - sized.height / 2),
    width: rounded(sized.width),
    height: rounded(sized.height),
  };
}

/** How far a button moves her, as a share of the frame. */
const NUDGE = 0.05;

/** `box` moved so she moves by (`dx`, `dy`) steps in the frame, right and down when positive. */
export function nudgedBox(box: Box, dx: number, dy: number): Box {
  return {
    ...box,
    x: box.x - dx * box.width * NUDGE,
    y: box.y - dy * box.height * NUDGE,
  };
}
