// A persona's character models: a folder each in her models/ in the data home, never in a template,
// holding the .p2lrt and model.json, which keeps what the runtime read of the file at import and
// the owner's settings for it.
import { hash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject, personaHomeDir } from "@eidolon/config";
import {
  type ActiveCharacterModel,
  CHARACTER_MODEL_KINDS,
  type CharacterModel,
  type CharacterModelPatch,
  type ModelBox,
  type ModelInventory,
  type ModelOutfit,
} from "./api.ts";
import { personaSetting } from "./personas.ts";
import { PERSONA_ID, userFolder, writeDataFile } from "./write.ts";

export const MODELS_DIR = "models";
export const RIG_FILE = "model.p2lrt";
export const MANIFEST_FILE = "model.json";

const MAX_ID = 64;
const MAX_NAME = 64;
const MAX_OUTFITS = 32;
const MAX_MOOD_EXPRESSIONS = 2;
/** A mood's, a gesture's or an outfit's key. */
const KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type ModelFields = Omit<CharacterModel, "id">;

const unique = (values: readonly unknown[]): boolean => new Set(values).size === values.length;

/** A model id: a slug, as a persona's is, since it names a folder. */
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && PERSONA_ID.test(value);
}

function modelsDir(persona: string): string {
  return join(personaHomeDir(persona), MODELS_DIR);
}

/** Model `model`'s .p2lrt; `model` is a model id. */
export function rigPath(persona: string, model: string): string {
  return join(modelsDir(persona), model, RIG_FILE);
}

/** Every name in `folder`, sorted; none when it isn't one. */
function namesIn(folder: string): string[] {
  try {
    return readdirSync(folder).sort();
  } catch {
    return [];
  }
}

/**
 * The id a model imported from `filename` gets: its name without `.p2lrt`, NFC and lowercase, each
 * run of anything but `[a-z0-9_-]` a `-`, at most 64 characters, `model` when nothing is left,
 * then `-2`, `-3`… past the names `taken`.
 */
export function modelSlug(filename: string | null, taken: ReadonlySet<string>): string {
  const base =
    (filename ?? "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/\.p2lrt$/, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+/, "")
      .slice(0, MAX_ID)
      .replace(/-+$/, "") || "model";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const id = `${base.slice(0, MAX_ID - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** One line of 1 to MAX_NAME characters, trimmed; null for anything else. */
function nameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = [...name].length;
  return length > 0 && length <= MAX_NAME && !/\p{Cc}/u.test(name) ? name : null;
}

/** What a model imported from `filename` is called until the owner renames it. */
function nameFrom(filename: string | null): string {
  const stem = (filename ?? "")
    .normalize("NFC")
    .replace(/\.p2lrt$/i, "")
    .replace(/\p{Cc}/gu, "");
  return [...stem.trim()].slice(0, MAX_NAME).join("").trim();
}

/** model.json's fields besides `format` and `file`, at the top level, as this code writes them. */
function isModelFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.name === "string" &&
    (CHARACTER_MODEL_KINDS as readonly unknown[]).includes(value.kind) &&
    Number.isSafeInteger(value.size) &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    typeof value.importedAt === "string" &&
    typeof value.updatedAt === "string" &&
    isPlainObject(value.inventory) &&
    isPlainObject(value.framing) &&
    isPlainObject(value.moods) &&
    isPlainObject(value.gestures) &&
    Array.isArray(value.outfits) &&
    (value.outfit === null || typeof value.outfit === "string")
  );
}

/**
 * Her model `model`; null when the id isn't a slug, or its folder lacks either file, or holds a
 * model.json this code didn't write.
 */
export function readModel(persona: string, model: string): CharacterModel | null {
  if (!isModelId(model)) return null;
  const folder = join(modelsDir(persona), model);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(folder, MANIFEST_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { format, file, ...fields } = parsed;
  if (format !== 1 || file !== RIG_FILE || !isModelFields(fields)) return null;
  return existsSync(join(folder, RIG_FILE)) ? { id: model, ...(fields as ModelFields) } : null;
}

/** Her models, by id. */
export function listModels(persona: string): CharacterModel[] {
  return namesIn(modelsDir(persona)).flatMap((name) => readModel(persona, name) ?? []);
}

/**
 * The model `setting` names, her appearance.model as the bot reads it, while she has it; else
 * null, whatever the setting holds.
 */
export function activeModel(
  persona: string,
  setting = personaSetting(persona, "APPEARANCE_MODEL"),
): ActiveCharacterModel | null {
  const model = setting ? readModel(persona, setting) : null;
  if (model === null) return null;
  const { id, name, kind, sha256, updatedAt } = model;
  return { id, name, kind, sha256, updatedAt };
}

function save(persona: string, model: CharacterModel): void {
  const { id, name, kind, ...rest } = model;
  const manifest = { format: 1, name, kind, file: RIG_FILE, ...rest };
  writeDataFile(
    join(modelsDir(persona), id, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/**
 * Keeps `bytes`, a rig the runtime read as `inventory`, as a new model of hers under an id made
 * from `filename`, with no settings of its own.
 */
export function importModel(
  persona: string,
  filename: string | null,
  bytes: Uint8Array,
  inventory: ModelInventory,
): CharacterModel {
  const id = modelSlug(filename, new Set(namesIn(modelsDir(persona))));
  const now = new Date().toISOString();
  const model: CharacterModel = {
    id,
    name: nameFrom(filename) || id,
    kind: "psd2live",
    size: bytes.byteLength,
    sha256: hash("sha256", bytes, "hex"),
    importedAt: now,
    updatedAt: now,
    inventory,
    framing: { call: null, companion: null },
    moods: {},
    gestures: {},
    outfits: [],
    outfit: null,
  };
  const folder = join(modelsDir(persona), id);
  try {
    writeDataFile(join(folder, RIG_FILE), bytes);
    save(persona, model);
  } catch (error) {
    // A folder without both files lists nothing, and would keep its id taken for good.
    if (userFolder(folder)) rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  return model;
}

/** The settings of `model` that still name what `inventory` holds, its values in their ranges. */
function kept(
  model: CharacterModel,
  inventory: ModelInventory,
): Pick<CharacterModel, "moods" | "gestures" | "outfits"> {
  const expressions = new Set(inventory.expressions.map(({ id }) => id));
  const clips = new Set(inventory.clips.map(({ id }) => id));
  const parts = new Set(inventory.parts.map(({ id }) => id));
  const ranges = new Map(inventory.parameters.map((parameter) => [parameter.id, parameter]));
  return {
    moods: Object.fromEntries(
      Object.entries(model.moods).flatMap(([mood, ids]) => {
        const left = ids.filter((id) => expressions.has(id));
        // An override down to none would read as "no expression": the SDK's default takes over.
        return left.length > 0 || ids.length === 0 ? [[mood, left]] : [];
      }),
    ),
    gestures: Object.fromEntries(Object.entries(model.gestures).filter(([, id]) => clips.has(id))),
    outfits: model.outfits.map((outfit) => ({
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

/**
 * Puts `bytes`, a rig the runtime read as `inventory`, in place of `model`'s, which keeps its id,
 * name, framing and the settings that still name what the new rig holds.
 */
export function replaceRig(
  persona: string,
  model: CharacterModel,
  bytes: Uint8Array,
  inventory: ModelInventory,
): CharacterModel {
  const replaced: CharacterModel = {
    ...model,
    size: bytes.byteLength,
    sha256: hash("sha256", bytes, "hex"),
    updatedAt: new Date().toISOString(),
    inventory,
    ...kept(model, inventory),
  };
  writeDataFile(rigPath(persona, model.id), bytes);
  save(persona, replaced);
  return replaced;
}

/** Whether `value`'s keys are exactly `keys`. */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A box with a positive size; null for none, undefined for anything else. */
function boxOf(value: unknown): ModelBox | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value) || !hasKeys(value, ["x", "y", "width", "height"])) return undefined;
  const { x, y, width, height } = value;
  const numbers = [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n));
  return numbers && (width as number) > 0 && (height as number) > 0
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : undefined;
}

function framingOf(value: unknown): CharacterModel["framing"] | null {
  if (!isPlainObject(value) || !hasKeys(value, ["call", "companion"])) return null;
  const call = boxOf(value.call);
  const companion = boxOf(value.companion);
  return call === undefined || companion === undefined ? null : { call, companion };
}

function moodsOf(value: unknown, inventory: ModelInventory): Record<string, string[]> | null {
  if (!isPlainObject(value)) return null;
  const expressions = new Set(inventory.expressions.map(({ id }) => id));
  const isExpression = (id: unknown): id is string => typeof id === "string" && expressions.has(id);
  const moods: Record<string, string[]> = {};
  for (const [mood, ids] of Object.entries(value)) {
    if (!KEY.test(mood) || !Array.isArray(ids) || ids.length > MAX_MOOD_EXPRESSIONS) return null;
    if (!ids.every(isExpression) || !unique(ids)) return null;
    moods[mood] = ids;
  }
  return moods;
}

function gesturesOf(value: unknown, inventory: ModelInventory): Record<string, string> | null {
  if (!isPlainObject(value)) return null;
  const clips = new Set(inventory.clips.map(({ id }) => id));
  const entries = Object.entries(value);
  const valid = entries.every(
    ([gesture, clip]) => KEY.test(gesture) && typeof clip === "string" && clips.has(clip),
  );
  return valid ? (Object.fromEntries(entries) as Record<string, string>) : null;
}

type Pose = ModelOutfit["poses"][number];
type Setting = ModelOutfit["parameters"][number];

/** An outfit whose poses, parameters in range and parts are the model's, each once. */
function outfitOf(value: unknown, inventory: ModelInventory): ModelOutfit | null {
  if (!isPlainObject(value)) return null;
  if (!hasKeys(value, ["id", "name", "poses", "parameters", "hiddenParts"])) return null;
  const { id, poses, parameters, hiddenParts } = value;
  const name = nameOf(value.name);
  if (typeof id !== "string" || !KEY.test(id) || name === null) return null;
  if (!Array.isArray(poses) || !Array.isArray(parameters) || !Array.isArray(hiddenParts)) {
    return null;
  }
  const ranges = new Map(inventory.parameters.map((parameter) => [parameter.id, parameter]));
  const parts = new Set(inventory.parts.map((part) => part.id));
  const isPose = (pose: unknown): pose is Pose => {
    if (!isPlainObject(pose) || !hasKeys(pose, ["group", "entry"])) return false;
    const { group, entry } = pose;
    if (!Number.isSafeInteger(group) || !Number.isSafeInteger(entry)) return false;
    return (
      (entry as number) >= 0 && (entry as number) < (inventory.poseGroups[group as number] ?? 0)
    );
  };
  const isSetting = (setting: unknown): setting is Setting => {
    if (!isPlainObject(setting) || !hasKeys(setting, ["id", "value"])) return false;
    const range = typeof setting.id === "string" ? ranges.get(setting.id) : undefined;
    const { value } = setting;
    return (
      range !== undefined && typeof value === "number" && value >= range.min && value <= range.max
    );
  };
  const isPart = (part: unknown): part is string => typeof part === "string" && parts.has(part);
  if (!poses.every(isPose) || !unique(poses.map((pose) => pose.group))) return null;
  if (!parameters.every(isSetting) || !unique(parameters.map((setting) => setting.id))) return null;
  if (!hiddenParts.every(isPart) || !unique(hiddenParts)) return null;
  return { id, name, poses, parameters, hiddenParts };
}

function outfitsOf(value: unknown, inventory: ModelInventory): ModelOutfit[] | null {
  if (!Array.isArray(value) || value.length > MAX_OUTFITS) return null;
  const outfits: ModelOutfit[] = [];
  for (const item of value) {
    const outfit = outfitOf(item, inventory);
    if (outfit === null || outfits.some(({ id }) => id === outfit.id)) return null;
    outfits.push(outfit);
  }
  return outfits;
}

const PATCH_FIELDS: readonly string[] = [
  "name",
  "framing",
  "moods",
  "gestures",
  "outfits",
  "outfit",
] satisfies (keyof CharacterModelPatch)[];

/**
 * The fields `body` sets, each checked against `model`'s file, or why one is refused, which names
 * the field and never the value. Outfits that leave out the one she wears take it off her.
 */
export function checkPatch(model: CharacterModel, body: unknown): CharacterModelPatch | string {
  if (!isPlainObject(body) || Object.keys(body).some((key) => !PATCH_FIELDS.includes(key))) {
    return `Send any of ${PATCH_FIELDS.join(", ")}`;
  }
  const { inventory } = model;
  const has = (field: string) => Object.hasOwn(body, field);
  const name = has("name") ? nameOf(body.name) : undefined;
  if (name === null) return "name is one line of 1 to 64 characters";
  const framing = has("framing") ? framingOf(body.framing) : undefined;
  if (framing === null) return "framing is {call, companion}, each a box of positive size or null";
  const moods = has("moods") ? moodsOf(body.moods, inventory) : undefined;
  if (moods === null) return "moods map a mood to up to 2 of the model's expressions";
  const gestures = has("gestures") ? gesturesOf(body.gestures, inventory) : undefined;
  if (gestures === null) return "gestures map a gesture to one of the model's clips";
  const outfits = has("outfits") ? outfitsOf(body.outfits, inventory) : undefined;
  if (outfits === null) {
    return "outfits are up to 32, each naming the model's poses, parts and parameters in range";
  }
  const owned = outfits ?? model.outfits;
  let outfit: string | null | undefined;
  if (has("outfit")) {
    const named = body.outfit;
    if (named !== null && !owned.some(({ id }) => id === named)) {
      return "outfit names one of the model's outfits, or is null";
    }
    outfit = named as string | null;
  } else if (model.outfit !== null && !owned.some(({ id }) => id === model.outfit)) {
    outfit = null;
  }
  const patch = { name, framing, moods, gestures, outfits, outfit };
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as CharacterModelPatch;
}

/** `model` with `patch` saved over it. */
export function patchModel(
  persona: string,
  model: CharacterModel,
  patch: CharacterModelPatch,
): CharacterModel {
  const patched = { ...model, ...patch, updatedAt: new Date().toISOString() };
  save(persona, patched);
  return patched;
}

/** Deletes her model `model`'s folder; false when it doesn't lie in the data home. */
export function deleteModel(persona: string, model: string): boolean {
  const folder = join(modelsDir(persona), model);
  if (!userFolder(folder)) return false;
  rmSync(folder, { recursive: true, force: true });
  return true;
}
