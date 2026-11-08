import { ph, t } from "@lingui/core/macro";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { personasQuery } from "@/components/settings-form/queries";
import { accountsQuery } from "@/lib/accounts";
import { call, type PersonaSummary, type PersonasResponse, type SettingsResponse } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { statusQuery } from "@/lib/query";
import { createRequest, type PersonaDraft } from "./wizard";

/** What the wizard and home need of a persona to name and picture her. */
export type PersonaRef = Pick<PersonaSummary, "id" | "name" | "shortName">;

/**
 * After a persona, her voice or the active one changed: everything that shows them reloads, but not
 * her own files under ["personas", id, …], which none of these change. `list` is the persona list
 * the change answered with.
 */
export async function refreshPersonas(
  queryClient: QueryClient,
  list?: PersonasResponse,
): Promise<void> {
  if (list) queryClient.setQueryData(personasQuery.queryKey, list);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ["settings"] }),
    // Another active persona needs other accounts for her calls.
    queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey, exact: true }),
    list
      ? undefined
      : queryClient.invalidateQueries({ queryKey: personasQuery.queryKey, exact: true }),
  ]);
}

export function createPersona(draft: PersonaDraft, voiceId: string): Promise<PersonaSummary> {
  return call("POST /api/local/personas", { body: createRequest(draft, voiceId) });
}

/** Makes a persona the one calls use; refused (call-active) while a call is live. */
export function activatePersona(id: string): Promise<PersonasResponse> {
  return call("PUT /api/local/personas/active", { body: { id } });
}

/** Activates the persona it is given, says so, and refreshes what shows the active one. */
export function useActivatePersona(onActivated?: (id: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: activatePersona,
    onSuccess: async (response, id) => {
      const chosen = response.personas.find((persona) => persona.id === id);
      toast.success(t`${ph({ name: chosen?.name ?? id })} is now the active persona.`);
      onActivated?.(id);
      await refreshPersonas(queryClient, response);
    },
    onError: toastError,
  });
}

/**
 * Saves a persona's voice in her persona.yaml (the user's copy, made on the first write), or with
 * null removes it.
 */
export function saveVoice(persona: string, voiceId: string | null): Promise<SettingsResponse> {
  return call("PUT /api/local/settings", {
    body: { scope: "persona", persona, values: { "voice.voiceId": voiceId } },
  });
}
