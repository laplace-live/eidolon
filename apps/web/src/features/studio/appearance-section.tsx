// Appearance: the 2D models she can look like, which one is active, and the one picked in the list,
// live on a stage to test, frame and set up. `?model=` picks it, so a link can open one.
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { SectionCardSkeleton } from "@/components/section-card";
import { settingsQuery } from "@/components/settings-form/queries";
import { ownValue } from "@/features/setup/wizard";
import type { CharacterModels, PersonaSummary } from "@/lib/api";
import { characterModelsQuery } from "@/lib/character-models";
import { ModelListCard } from "./model-list";
import { ModelPreviewCard } from "./model-preview";
import { LoadError } from "./parts";
import { CARD_PATHS } from "./sections";

const [APPEARANCE_PATH] = CARD_PATHS.appearance;

/** The model the page shows: the one `?model=` names, else the active one, else the first. */
function shownModel(list: CharacterModels, wanted: string | null) {
  return (
    list.models.find((model) => model.id === wanted) ??
    list.models.find((model) => model.id === list.active) ??
    list.models[0] ??
    null
  );
}

export function AppearanceSection({ persona }: { readonly persona: PersonaSummary }) {
  const models = useQuery(characterModelsQuery(persona.id));
  const settings = useQuery(settingsQuery(persona.id));
  const [params, setParams] = useSearchParams();

  if (models.isPending) return <SectionCardSkeleton rows={2} footer={false} />;
  if (models.isError) return <LoadError error={models.error} />;
  const list = models.data;
  const row = settings.data?.settings.find((entry) => entry.path === APPEARANCE_PATH);
  // Her own setting names none, so the active model is the environment's default.
  const inherited = list.active !== null && row !== undefined && ownValue(row) === null;
  const shown = shownModel(list, params.get("model"));

  return (
    <>
      <ModelListCard
        persona={persona}
        list={list}
        inheritedActive={inherited}
        selected={shown?.id ?? null}
        onImported={(model) =>
          setParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.set("model", model.id);
              return next;
            },
            { replace: true },
          )
        }
      />
      {shown !== null && (
        // A new file is a new stage; edits saved to the same one keep it.
        <ModelPreviewCard key={`${shown.id}:${shown.sha256}`} persona={persona} model={shown} />
      )}
    </>
  );
}
