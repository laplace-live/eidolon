import type { QueryClient } from "@tanstack/react-query";
import { call, type PersonaSummary, type PersonasResponse, type SettingsResponse } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { createRequest, type PersonaDraft } from "./wizard";

/** What the wizard and home need of a persona to name and picture her. */
export type PersonaRef = Pick<PersonaSummary, "id" | "name" | "shortName">;

/** After a persona, her voice or the active one changed: everything that shows them reloads. */
export async function refreshPersonas(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ["personas"] }),
    queryClient.invalidateQueries({ queryKey: ["settings"] }),
  ]);
}

export function createPersona(draft: PersonaDraft, voiceId: string): Promise<PersonaSummary> {
  return call("POST /api/local/personas", { body: createRequest(draft, voiceId) });
}

/** Makes a persona the one calls use; refused (call-active) while a call is live. */
export function activatePersona(id: string): Promise<PersonasResponse> {
  return call("PUT /api/local/personas/active", { body: { id } });
}

/** Saves a persona's voice in her persona.yaml (the user's copy, made on the first write). */
export function saveVoice(persona: string, voiceId: string): Promise<SettingsResponse> {
  return call("PUT /api/local/settings", {
    body: { scope: "persona", persona, values: { "voice.voiceId": voiceId } },
  });
}
