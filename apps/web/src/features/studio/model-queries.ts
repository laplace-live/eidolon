// Changes to her character models. Each answer goes into her list at once; then the list, her
// summary (which names her active model) and the status reload.
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { personasQuery, refreshSettings } from "@/components/settings-form/queries";
import {
  type CharacterModel,
  type CharacterModelPatch,
  type CharacterModels,
  call,
} from "@/lib/api";
import { characterModelsQuery } from "@/lib/character-models";
import { toastError } from "@/lib/feedback";
import { statusQuery } from "@/lib/query";

function edit(
  queryClient: QueryClient,
  persona: string,
  change: (list: CharacterModels) => CharacterModels,
): void {
  queryClient.setQueryData(characterModelsQuery(persona).queryKey, (list) =>
    list === undefined ? list : change(list),
  );
}

/** `model` in its place in her list, which the server sorts by id. */
function withModel(list: CharacterModels, model: CharacterModel): CharacterModels {
  const models = list.models.filter((each) => each.id !== model.id);
  models.push(model);
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...list, models };
}

async function refresh(queryClient: QueryClient, persona: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: characterModelsQuery(persona).queryKey,
      exact: true,
    }),
    queryClient.invalidateQueries({ queryKey: personasQuery.queryKey, exact: true }),
    queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
  ]);
}

/** Keeps a .p2lrt as a new model of hers; it never becomes her active one by itself. */
export function useImportModel(persona: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      call("POST /api/local/personas/:id/models", {
        params: { id: persona },
        query: { filename: file.name },
        body: file,
      }),
    onSuccess: async (model) => {
      edit(queryClient, persona, (list) => withModel(list, model));
      await refresh(queryClient, persona);
    },
    onError: toastError,
  });
}

/** Puts a new .p2lrt in place of a model's, keeping what of its settings the new one still has. */
export function useReplaceModelFile(persona: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ model, file }: { model: string; file: File }) =>
      call("PUT /api/local/personas/:id/models/:model/file", {
        params: { id: persona, model },
        query: { filename: file.name },
        body: file,
      }),
    onSuccess: async (model) => {
      edit(queryClient, persona, (list) => withModel(list, model));
      await refresh(queryClient, persona);
    },
    onError: toastError,
  });
}

export function useUpdateModel(persona: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ model, patch }: { model: string; patch: CharacterModelPatch }) =>
      call("PATCH /api/local/personas/:id/models/:model", {
        params: { id: persona, model },
        body: patch,
      }),
    onSuccess: async (model) => {
      edit(queryClient, persona, (list) => withModel(list, model));
      await refresh(queryClient, persona);
    },
    onError: toastError,
  });
}

/** Deletes a model; the server clears her appearance.model when it named it. */
export function useRemoveModel(persona: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (model: string) =>
      call("DELETE /api/local/personas/:id/models/:model", { params: { id: persona, model } }),
    onSuccess: async (_answer, model) => {
      edit(queryClient, persona, (list) => ({
        active: list.active === model ? null : list.active,
        models: list.models.filter((each) => each.id !== model),
      }));
      queryClient.removeQueries({ queryKey: ["personas", persona, "model-file", model] });
      await Promise.all([
        refresh(queryClient, persona),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
    onError: toastError,
  });
}

/** Makes a model the one she shows, or with null none, through her appearance.model. */
export function useActivateModel(persona: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (model: string | null) =>
      call("PUT /api/local/settings", {
        body: { scope: "persona", persona, values: { "appearance.model": model } },
      }),
    onSuccess: async (response, model) => {
      edit(queryClient, persona, (list) => ({ ...list, active: model }));
      await Promise.all([
        refreshSettings(queryClient, persona, response),
        refresh(queryClient, persona),
      ]);
    },
    onError: toastError,
  });
}
