// Her model drawn on a stage of its own: a canvas made and removed with the stage (StrictMode
// mounts twice, and a GL context outlives a canvas React keeps), a spinner while it loads, her
// picture if it fails, and the box's data-state for whatever waits on it.
import {
  AvatarStage,
  type Box,
  loadPsd2liveModel,
  type ModelOutfitLike,
  type ResolvedSetup,
} from "@laplace.live/eidolon-sdk/avatar";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PersonaAvatar, type PersonaAvatarProps } from "@/components/avatar";
import { Spinner } from "@/components/ui/spinner";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { CharacterModel, ModelBox } from "@/lib/api";
import { characterModelFileQuery, defaultCallBox } from "@/lib/character-models";
import { subscribeWindowShows, windowShows } from "@/lib/desktop";
import { cn } from "@/lib/utils";

export type StageState = "loading" | "ready" | "failed";

/** A stage showing her model, for controls that drive it. */
export interface StageReady {
  readonly stage: AvatarStage;
  /** What a call frames while the owner framed nothing, read at her rest pose. */
  readonly rest: Box;
}

export interface ModelStageProps {
  /** Whose model it is: her picture stands in if it can't show. */
  readonly persona: PersonaAvatarProps["persona"];
  readonly model: Pick<CharacterModel, "id" | "sha256">;
  /** Each mood's expressions and each gesture's clip; a new one starts over only a clip it changes. */
  readonly setup: ResolvedSetup;
  /** The part of her canvas shown; null shows what a call frames by default. */
  readonly box: ModelBox | null;
  readonly outfit: ModelOutfitLike | null;
  /** Called with the stage once her model shows, and with null when it stops showing. */
  readonly onReady?: (ready: StageReady | null) => void;
  /** Called when her model can't show, with why. */
  readonly onFailure?: (error: unknown) => void;
  readonly className?: string;
  /** Drawn over the stage. */
  readonly children?: ReactNode;
}

export function ModelStage({
  persona,
  model,
  setup,
  box,
  outfit,
  onReady,
  onFailure,
  className,
  children,
}: ModelStageProps) {
  const holder = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const file = useQuery(characterModelFileQuery(persona.id, model.id, model.sha256));
  const [ready, setReady] = useState<StageReady | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef({ setup, box, outfit, onReady, onFailure });
  // The setup the stage shows, so a new one alone shows again.
  const shown = useRef<ResolvedSetup | null>(null);
  useEffect(() => {
    latest.current = { setup, box, outfit, onReady, onFailure };
  });

  const bytes = file.data;
  useEffect(() => {
    const host = holder.current;
    if (bytes === undefined || host === null) return;
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 size-full";
    canvas.setAttribute("aria-hidden", "true");
    host.prepend(canvas);
    let live = true;
    const fail = (error: unknown) => {
      if (!live) return;
      // Its last frame would stay under her picture.
      canvas.hidden = true;
      setReady(null);
      setFailed(true);
      latest.current.onFailure?.(error);
    };
    const stage = new AvatarStage(canvas, { reducedMotion, onError: fail });
    setFailed(false);
    loadPsd2liveModel(canvas, new Uint8Array(bytes)).then((loaded) => {
      if (!live) {
        loaded.dispose();
        return;
      }
      const { setup, box, outfit } = latest.current;
      let rest: Box;
      try {
        // Bounds are read at the pose of the last update, which is none until the first.
        loaded.update(0);
        rest = defaultCallBox(loaded);
      } catch (error) {
        loaded.dispose();
        fail(error);
        return;
      }
      stage.show(loaded, setup);
      shown.current = setup;
      stage.frame(box ?? rest);
      stage.wear(outfit);
      setReady({ stage, rest });
    }, fail);
    return () => {
      live = false;
      setReady(null);
      stage.dispose();
      canvas.remove();
    };
  }, [bytes, reducedMotion]);

  useEffect(() => {
    if (file.error !== null) latest.current.onFailure?.(file.error);
  }, [file.error]);
  useEffect(() => {
    latest.current.onReady?.(ready);
  }, [ready]);
  useEffect(() => {
    const model = ready?.stage.model;
    if (ready === null || model == null || shown.current === setup) return;
    ready.stage.show(model, setup);
    shown.current = setup;
  }, [ready, setup]);
  useEffect(() => {
    ready?.stage.frame(box ?? ready.rest);
  }, [ready, box]);
  useEffect(() => {
    ready?.stage.wear(outfit);
  }, [ready, outfit]);
  // A desktop app's window hidden while it feeds the desktop companion still runs its page.
  const windowShown = useSyncExternalStore(subscribeWindowShows, windowShows);
  useEffect(() => {
    if (windowShown) ready?.stage.resume();
    else ready?.stage.pause();
  }, [ready, windowShown]);

  const state: StageState =
    failed || file.isError ? "failed" : ready !== null ? "ready" : "loading";
  return (
    <div
      ref={holder}
      data-model-stage={model.id}
      data-state={state}
      className={cn("relative overflow-hidden", className)}
    >
      {state !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center">
          {state === "loading" ? (
            <Spinner className="size-6 text-muted-foreground" />
          ) : (
            <PersonaAvatar persona={persona} size="xl" />
          )}
        </div>
      )}
      {children}
    </div>
  );
}
