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
  type ModelParameterSetting,
} from "./api.ts";
import { PERSONA_ID, userFolder, writeDataFile } from "./write.ts";

export const MODELS_DIR = "models";
export const RIG_FILE = "model.p2lrt";
export const MANIFEST_FILE = "model.json";

const MAX_ID = 64;
const MAX_NAME = 64;
const MAX_OUTFITS = 32;
const MAX_MOOD_EXPRESSIONS = 2;
const MAX_MOOD_PARAMETERS = 8;
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

/** `name`, or past the names `taken`, `name 2`, `name 3`…, cut to fit MAX_NAME characters. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  const chars = [...name];
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const stem = chars
      .slice(0, MAX_NAME - suffix.length)
      .join("")
      .trimEnd();
    const named = `${stem}${suffix}`;
    if (!taken.has(named)) return named;
  }
}

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string";
const isNumber: Check = (value) => typeof value === "number";
const isBoolean: Check = (value) => typeof value === "boolean";

function orNull(check: Check): Check {
  return (value) => value === null || check(value);
}

function listOf(check: Check): Check {
  return (value) => Array.isArray(value) && value.every(check);
}

function recordOf(check: Check): Check {
  return (value) => isPlainObject(value) && Object.values(value).every(check);
}

/** A field model.json may lack, written before it existed. */
function orAbsent(check: Check): Check {
  return (value) => value === undefined || check(value);
}

function isLook(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

/** An object with at least `fields`, each passing its check. */
function shaped(fields: Record<string, Check>): Check {
  return (value) =>
    isPlainObject(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
}

const NAMED = { id: isString, name: isString };
const SETTING = { id: isString, value: isNumber };

/** model.json's fields besides `format` and `file`, in the shapes this code writes them. */
const isModelFields = shaped({
  name: isString,
  kind: (kind) => (CHARACTER_MODEL_KINDS as readonly unknown[]).includes(kind),
  size: Number.isSafeInteger,
  sha256: (sha256) => typeof sha256 === "string" && SHA256.test(sha256),
  importedAt: isString,
  updatedAt: isString,
  inventory: shaped({
    runtime: isString,
    generator: orNull(isString),
    canvas: shaped({ width: isNumber, height: isNumber }),
    clips: listOf(shaped({ ...NAMED, group: isString, duration: isNumber, looping: isBoolean })),
    expressions: listOf(shaped(NAMED)),
    hitAreas: listOf(shaped(NAMED)),
    parameters: listOf(shaped({ id: isString, min: isNumber, max: isNumber, default: isNumber })),
    parts: listOf(shaped(NAMED)),
    poseGroups: listOf(Number.isSafeInteger),
    lipSync: isBoolean,
    textures: Number.isSafeInteger,
  }),
  framing: (framing) => framingOf(framing) !== null,
  look: orAbsent(isLook),
  moods: recordOf(listOf(isString)),
  moodParameters: orAbsent(recordOf(listOf(shaped(SETTING)))),
  gestures: recordOf(isString),
  outfits: listOf(
    shaped({
      ...NAMED,
      poses: listOf(shaped({ group: Number.isSafeInteger, entry: Number.isSafeInteger })),
      parameters: listOf(shaped(SETTING)),
      hiddenParts: listOf(isString),
    }),
  ),
  outfit: orNull(isString),
});

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
  if (!existsSync(join(folder, RIG_FILE))) return null;
  // Picked, never spread: an id written into the file would stand for another folder.
  const { name, kind, size, sha256, importedAt, updatedAt } = fields as ModelFields;
  const { inventory, framing, moods, gestures, outfits, outfit } = fields as ModelFields;
  const { look = 1, moodParameters = {} } = fields as Partial<ModelFields>;
  return {
    id: model,
    name,
    kind,
    size,
    sha256,
    importedAt,
    updatedAt,
    inventory,
    framing,
    look,
    moods,
    moodParameters,
    gestures,
    outfits,
    outfit,
  };
}

/** Her models, by id. */
export function listModels(persona: string): CharacterModel[] {
  return namesIn(modelsDir(persona)).flatMap((name) => readModel(persona, name) ?? []);
}

/**
 * The model `setting` names, her appearance.model as the caller reads it, while she has that
 * model; else null, whatever the setting holds.
 */
export function activeModel(
  persona: string,
  setting: string | undefined,
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
 * Keeps `bytes`, a rig the runtime read as `inventory`, as a new model of hers with no settings of
 * its own, under an id and a name made from `filename`, the name numbered past her other models'.
 */
export function importModel(
  persona: string,
  filename: string | null,
  bytes: Uint8Array,
  inventory: ModelInventory,
): CharacterModel {
  const id = modelSlug(filename, new Set(namesIn(modelsDir(persona))));
  const names = new Set(listModels(persona).map(({ name }) => name));
  const now = new Date().toISOString();
  const model: CharacterModel = {
    id,
    name: freeName(nameFrom(filename) || id, names),
    kind: "psd2live",
    size: bytes.byteLength,
    sha256: hash("sha256", bytes, "hex"),
    importedAt: now,
    updatedAt: now,
    inventory,
    framing: { call: null, companion: null },
    look: 1,
    moods: {},
    moodParameters: {},
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
): Pick<CharacterModel, "moods" | "moodParameters" | "gestures" | "outfits"> {
  const expressions = new Set(inventory.expressions.map(({ id }) => id));
  const clips = new Set(inventory.clips.map(({ id }) => id));
  const parts = new Set(inventory.parts.map(({ id }) => id));
  const ranges = new Map(inventory.parameters.map((parameter) => [parameter.id, parameter]));
  const inRange = (settings: readonly ModelParameterSetting[]) =>
    settings.flatMap(({ id, value }) => {
      const range = ranges.get(id);
      return range ? [{ id, value: Math.min(range.max, Math.max(range.min, value)) }] : [];
    });
  return {
    moods: Object.fromEntries(
      Object.entries(model.moods).flatMap(([mood, ids]) => {
        const left = ids.filter((id) => expressions.has(id));
        // An override down to none would read as "no expression": the SDK's default takes over.
        return left.length > 0 || ids.length === 0 ? [[mood, left]] : [];
      }),
    ),
    moodParameters: Object.fromEntries(
      Object.entries(model.moodParameters).flatMap(([mood, settings]) => {
        const left = inRange(settings);
        return left.length > 0 ? [[mood, left]] : [];
      }),
    ),
    gestures: Object.fromEntries(Object.entries(model.gestures).filter(([, id]) => clips.has(id))),
    outfits: model.outfits.map((outfit) => ({
      ...outfit,
      poses: outfit.poses.filter(({ group, entry }) => entry < (inventory.poseGroups[group] ?? 0)),
      parameters: inRange(outfit.parameters),
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
  const rig = rigPath(persona, model.id);
  const before = readFileSync(rig);
  writeDataFile(rig, bytes);
  try {
    save(persona, replaced);
  } catch (error) {
    // model.json still names the old file, whose URL would serve the new one for good.
    writeDataFile(rig, before);
    throw error;
  }
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

/** A check for {id, value}: one of the model's parameters, at a value within its range. */
function settingCheck(inventory: ModelInventory) {
  const ranges = new Map(inventory.parameters.map((parameter) => [parameter.id, parameter]));
  return (setting: unknown): setting is ModelParameterSetting => {
    if (!isPlainObject(setting) || !hasKeys(setting, ["id", "value"])) return false;
    const range = typeof setting.id === "string" ? ranges.get(setting.id) : undefined;
    const { value } = setting;
    return (
      range !== undefined && typeof value === "number" && value >= range.min && value <= range.max
    );
  };
}

function moodParametersOf(
  value: unknown,
  inventory: ModelInventory,
): Record<string, ModelParameterSetting[]> | null {
  if (!isPlainObject(value)) return null;
  const isSetting = settingCheck(inventory);
  const moods: Record<string, ModelParameterSetting[]> = {};
  for (const [mood, settings] of Object.entries(value)) {
    if (!KEY.test(mood) || !Array.isArray(settings) || settings.length > MAX_MOOD_PARAMETERS) {
      return null;
    }
    if (!settings.every(isSetting) || !unique(settings.map(({ id }) => id))) return null;
    moods[mood] = settings;
  }
  return moods;
}

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
  const parts = new Set(inventory.parts.map((part) => part.id));
  const isPose = (pose: unknown): pose is Pose => {
    if (!isPlainObject(pose) || !hasKeys(pose, ["group", "entry"])) return false;
    const { group, entry } = pose;
    if (!Number.isSafeInteger(group) || !Number.isSafeInteger(entry)) return false;
    return (
      (entry as number) >= 0 && (entry as number) < (inventory.poseGroups[group as number] ?? 0)
    );
  };
  const isSetting = settingCheck(inventory);
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
  "look",
  "moods",
  "moodParameters",
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
  const look = has("look") ? (isLook(body.look) ? body.look : null) : undefined;
  if (look === null) return "look is a number from 0 to 1";
  const moods = has("moods") ? moodsOf(body.moods, inventory) : undefined;
  if (moods === null) return "moods map a mood to up to 2 of the model's expressions";
  const moodParameters = has("moodParameters")
    ? moodParametersOf(body.moodParameters, inventory)
    : undefined;
  if (moodParameters === null) {
    return "moodParameters map a mood to up to 8 of the model's parameters, each once and in range";
  }
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
  const patch = { name, framing, look, moods, moodParameters, gestures, outfits, outfit };
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
