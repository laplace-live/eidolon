import type { ParticipantId } from "@eidolon/chat";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { personasQuery } from "@/components/settings-form/queries";
import type { PersonaSummary } from "@/lib/api";

export type ChatPersona = Pick<PersonaSummary, "id" | "name" | "shortName" | "avatar">;

/** Looks a chat's persona up; one deleted since keeps her id, and a monogram of it. */
export function usePersonaOf(): (id: ParticipantId) => ChatPersona {
  const { data } = useQuery(personasQuery);
  return useCallback(
    (id) =>
      data?.personas.find((persona) => persona.id === id) ?? {
        id,
        name: id,
        shortName: "",
        avatar: false,
      },
    [data],
  );
}

/** What a line names her by: her short name, else her name. */
export function shortNameOf(persona: ChatPersona): string {
  return persona.shortName.trim() || persona.name;
}
