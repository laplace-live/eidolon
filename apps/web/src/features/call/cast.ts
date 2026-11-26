// The model each member of a call shows, read fresh as the call is placed.
import type { AvatarModel, Box, ResolvedSetup } from "@laplace.live/eidolon-sdk/avatar";
import type { QueryClient } from "@tanstack/react-query";
import type { ModelOutfit } from "@/lib/api";
import {
  characterModelFileQuery,
  characterModelsQuery,
  defaultCallBox,
  outfitOf,
  setupOf,
} from "@/lib/character-models";
import type { CastMember } from "./target";

export interface LoadedModel {
  readonly model: AvatarModel;
  readonly setup: ResolvedSetup;
  readonly box: Box;
  readonly outfit: ModelOutfit | null;
}

/**
 * The model `member` has active now, ready for her stage. Read as the call is placed, it is the
 * call's snapshot: Studio's changes during the call show from the next one.
 */
export async function loadCastModel(
  queryClient: QueryClient,
  member: CastMember,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
): Promise<LoadedModel | null> {
  const list = await queryClient.query({ ...characterModelsQuery(member.id), staleTime: 0 });
  signal.throwIfAborted();
  const model = list.models.find(({ id }) => id === list.active);
  if (model === undefined) return null;
  const bytes = await queryClient.query(characterModelFileQuery(member.id, model.id, model.sha256));
  signal.throwIfAborted();
  const { loadPsd2liveModel } = await import("./avatar-loader");
  const loaded = await loadPsd2liveModel(canvas, new Uint8Array(bytes));
  try {
    signal.throwIfAborted();
    // Bounds are read at the pose of the last update, which is none until the first.
    loaded.update(0);
    const box = model.framing.call ?? defaultCallBox(loaded);
    return { model: loaded, setup: setupOf(model), box, outfit: outfitOf(model) };
  } catch (error) {
    loaded.dispose();
    throw error;
  }
}
