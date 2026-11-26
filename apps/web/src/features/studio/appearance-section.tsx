// Appearance: the 2D models she can look like, which one is active, and the one picked in the list,
// live on a stage to test, frame and set up. `?model=` picks it, so a link can open one.
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "wouter";
import { SectionCardSkeleton } from "@/components/section-card";
import { settingsQuery } from "@/components/settings-form/queries";
import { useCallPresence } from "@/features/call/call-context";
import { shortNameOf } from "@/features/chats/persona";
import type { CharacterModels, PersonaSummary } from "@/lib/api";
import { characterModelsQuery } from "@/lib/character-models";
import { activeModelOf } from "./model-draft";
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
  const { t } = useLingui();
  const models = useQuery(characterModelsQuery(persona.id));
  const settings = useQuery(settingsQuery(persona.id));
  const { up, target } = useCallPresence();
  const calling = up && target?.cast.some((member) => member.id === persona.id);
  const [params, setParams] = useSearchParams();
  const wanted = params.get("model");
  const shown = models.data === undefined ? null : shownModel(models.data, wanted);
  const shownId = shown?.id ?? null;

  const pick = useCallback(
    (id: string) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("model", id);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  // Named in the address once shown, so making another model active never swaps it, and its edits,
  // out from under the owner.
  useEffect(() => {
    if (shownId !== null && shownId !== wanted) pick(shownId);
  }, [shownId, wanted, pick]);

  if (models.isPending) return <SectionCardSkeleton rows={2} footer={false} />;
  if (models.isError) return <LoadError error={models.error} />;
  const list = models.data;
  const row = settings.data?.settings.find((entry) => entry.path === APPEARANCE_PATH);
  const name = shortNameOf(persona);

  return (
    <>
      {calling && (
        <p className="text-muted-foreground text-sm">
          {t`A call with ${name} is in progress: changes here show from her next call.`}
        </p>
      )}
      <ModelListCard
        persona={persona}
        list={list}
        active={activeModelOf(list, row)}
        selected={shownId}
        onImported={(model) => pick(model.id)}
      />
      {shown !== null && (
        // A new file for it keeps the card, and the owner's edits that the new rig still has.
        <ModelPreviewCard key={shown.id} persona={persona} model={shown} />
      )}
    </>
  );
}
