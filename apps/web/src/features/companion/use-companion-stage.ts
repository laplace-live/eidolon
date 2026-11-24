// The desktop companion's stage, for her page's life: her model loaded onto a canvas made and removed
// with it (StrictMode mounts twice, and a GL context outlives a canvas React keeps), framed, set up
// and dressed; her picture instead whenever it can't be, quietly.
import {
  AvatarStage,
  type Bounds,
  type Box,
  type FrameClock,
  loadPsd2liveModel,
  type MouthSource,
  type ResolvedSetup,
} from "@laplace.live/eidolon-sdk/avatar";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { CharacterModel } from "@/lib/api";
import { defaultCompanionBox, headAreaOf, outfitOf, setupOf } from "@/lib/character-models";

export type CompanionView = "loading" | "model" | "picture";

export interface CompanionStage {
  readonly view: CompanionView;
  readonly stage: AvatarStage | null;
  /** The box she is framed by; null but for her model. */
  readonly box: Box | null;
  /** Her head hit area's bounds at her rest pose; null without one. */
  readonly head: Bounds | null;
  /** Frames her stage's loop has run. */
  readonly frames: () => number;
}

/** Her stage once her model shows on it: what she is framed by when the owner framed nothing, and her head. */
interface Shown {
  readonly stage: AvatarStage;
  readonly rest: Box;
  readonly head: Bounds | null;
}

export function useCompanionStage(
  host: RefObject<HTMLDivElement | null>,
  input: {
    readonly model: CharacterModel | null;
    readonly bytes: ArrayBuffer | undefined;
    /** Her model's file won't come: no model is active, or the list's or the file's read failed. */
    readonly none: boolean;
    readonly reducedMotion: boolean;
    readonly mouth: MouthSource;
    /** Called in the effect before a load starts: she has nothing to hit until she draws. */
    readonly loading: () => void;
  },
): CompanionStage {
  const { model, bytes, none, reducedMotion, mouth, loading } = input;
  const [shown, setShown] = useState<Shown | null>(null);
  const [failed, setFailed] = useState(false);
  const frames = useRef(0);
  const setup = useMemo(() => (model === null ? null : setupOf(model)), [model]);
  const outfit = useMemo(() => (model === null ? null : outfitOf(model)), [model]);
  const latest = useRef({ model, setup, outfit, mouth, loading });
  // The setup the stage shows, so a new one alone shows again.
  const showing = useRef<ResolvedSetup | null>(null);
  useEffect(() => {
    latest.current = { model, setup, outfit, mouth, loading };
  });

  useEffect(() => {
    const target = host.current;
    if (bytes === undefined || target === null) return;
    // Before the load holds the page's thread, so her window passes clicks while it does.
    latest.current.loading();
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 size-full";
    canvas.setAttribute("aria-hidden", "true");
    target.prepend(canvas);
    let live = true;
    const fail = () => {
      if (!live) return;
      // Its last frame would stay under her picture.
      canvas.hidden = true;
      setShown(null);
      setFailed(true);
    };
    const clock: FrameClock = {
      request: (frame) =>
        requestAnimationFrame((now) => {
          frames.current += 1;
          frame(now);
        }),
      cancel: (handle) => cancelAnimationFrame(handle as number),
    };
    const stage = new AvatarStage(canvas, { fps: 30, reducedMotion, onError: fail, clock });
    setFailed(false);
    loadPsd2liveModel(canvas, new Uint8Array(bytes)).then((loaded) => {
      const { model, setup, outfit, mouth } = latest.current;
      if (!live || model === null || setup === null) {
        loaded.dispose();
        return;
      }
      let rest: Box;
      let head: Bounds | null;
      try {
        // Bounds are read at the pose of the last update, which is none until the first.
        loaded.update(0);
        rest = defaultCompanionBox(loaded);
        const area = headAreaOf(loaded.inventory);
        head = area === null ? null : loaded.bounds(area);
      } catch {
        loaded.dispose();
        fail();
        return;
      }
      stage.show(loaded, setup);
      showing.current = setup;
      stage.frame(model.framing.companion ?? rest);
      stage.wear(outfit);
      stage.mouth(mouth);
      setShown({ stage, rest, head });
    }, fail);
    return () => {
      live = false;
      setShown(null);
      stage.dispose();
      canvas.remove();
    };
  }, [host, bytes, reducedMotion]);

  // A new setup or outfit for the same file shows in place.
  useEffect(() => {
    const loaded = shown?.stage.model;
    if (shown === null || loaded == null || setup === null || showing.current === setup) return;
    shown.stage.show(loaded, setup);
    showing.current = setup;
  }, [shown, setup]);
  useEffect(() => {
    shown?.stage.wear(outfit);
  }, [shown, outfit]);
  const box = shown === null || model === null ? null : (model.framing.companion ?? shown.rest);
  useEffect(() => {
    if (shown !== null && box !== null) shown.stage.frame(box);
  }, [shown, box]);

  const view: CompanionView = none || failed ? "picture" : shown !== null ? "model" : "loading";
  return {
    view,
    stage: view === "model" ? (shown?.stage ?? null) : null,
    box: view === "model" ? box : null,
    head: view === "model" ? (shown?.head ?? null) : null,
    frames: () => frames.current,
  };
}
