// Her character models as the pages read them: the list and each model's file through the cache,
// and the framing, outfit and setup a model shows when the owner chose none.
import {
  type AvatarModel,
  type Bounds,
  type Box,
  bustBox,
  companionBox,
  type ResolvedSetup,
  resolveSetup,
} from "@laplace.live/eidolon-sdk/avatar";
import { queryOptions } from "@tanstack/react-query";
import { bytes, type CharacterModel, call, type ModelInventory, type ModelOutfit } from "./api";

/** Her models, and which one her appearance.model makes active. */
export function characterModelsQuery(persona: string) {
  return queryOptions({
    queryKey: ["personas", persona, "models"],
    queryFn: ({ signal }) =>
      call("GET /api/local/personas/:id/models", { params: { id: persona }, signal }),
  });
}

/** How long a model's file stays cached once nothing shows it: the runtime keeps its own copy. */
const FILE_GC_MS = 60_000;

/**
 * A model's file by its sha256, which a key never outlives: beside the list's key rather than under
 * it, so refreshing the list never fetches megabytes again.
 */
export function characterModelFileQuery(persona: string, model: string, sha256: string) {
  return queryOptions({
    queryKey: ["personas", persona, "model-file", model, sha256],
    queryFn: ({ signal }) =>
      bytes("GET /api/local/personas/:id/models/:model/file", {
        params: { id: persona, model },
        query: { sha256 },
        signal,
      }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: FILE_GC_MS,
  });
}

/** The hit area a call frames: the first whose id or name holds "head", any case; null for none. */
export function headAreaOf(inventory: Pick<ModelInventory, "hitAreas">): string | null {
  const head = inventory.hitAreas.find(({ id, name }) => /head/i.test(id) || /head/i.test(name));
  return head?.id ?? null;
}

/**
 * What a call frames of a loaded model while the owner framed none, and what Studio's Reset Framing
 * goes back to: her bust around her head's hit area, or the top third of her without one, read at
 * the pose the model was last updated to.
 */
export function defaultCallBox(model: Pick<AvatarModel, "inventory" | "bounds">): Box {
  const character = characterOf(model);
  const head = headAreaOf(model.inventory);
  return bustBox(head === null ? null : model.bounds(head), character);
}

/** What her desktop companion frames of a loaded model while the owner framed none: all of her, at its last update's pose. */
export function defaultCompanionBox(model: Pick<AvatarModel, "inventory" | "bounds">): Box {
  return companionBox(characterOf(model));
}

/** Every mesh drawn at the last update; with none, the whole canvas stands for her. */
function characterOf(model: Pick<AvatarModel, "inventory" | "bounds">): Bounds {
  const { width, height } = model.inventory.canvas;
  return model.bounds(null) ?? { x0: 0, y0: 0, x1: width, y1: height };
}

/** The outfit `model.outfit` names; null for none, or for one it no longer lists. */
export function outfitOf(model: Pick<CharacterModel, "outfits" | "outfit">): ModelOutfit | null {
  if (model.outfit === null) return null;
  return model.outfits.find(({ id }) => id === model.outfit) ?? null;
}

/**
 * Each mood's expressions and each gesture's clip, the owner's choices, then the defaults; the
 * parameters each mood holds; and how far her gaze turns her.
 */
export function setupOf(
  model: Pick<CharacterModel, "inventory" | "moods" | "moodParameters" | "gestures" | "look">,
): ResolvedSetup {
  const { inventory, moods, moodParameters, gestures, look } = model;
  return resolveSetup(inventory, { moods, moodParameters, gestures, look });
}
