// A model of hers on a live stage, with one draft of what Studio edits of it: tried in Test, framed
// for calls in Framing, and set up in Moods and Outfits, all saved together.
import {
  AvatarError,
  type Box,
  panBox,
  resolveSetup,
  zoomBox,
} from "@laplace.live/eidolon-sdk/avatar";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CircleAlertIcon, RotateCcwIcon } from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ModelStage, type StageReady } from "@/components/model-stage";
import { SectionCard } from "@/components/section-card";
import { SaveActions } from "@/components/settings-form/settings-card";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { ApiError, type CharacterModel, type PersonaSummary } from "@/lib/api";
import { errorMessage } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { STAGE_ERRORS } from "./appearance-labels";
import { FramingPanel, type PreviewShape, TestPanel } from "./model-controls";
import {
  boxScale,
  clampBox,
  draftChanges,
  draftOf,
  draftProblem,
  keptDraft,
  type ModelDraft,
  nudgedBox,
  rebaseDraft,
  rigPointAt,
  shownRect,
} from "./model-draft";
import { MoodsPanel } from "./model-moods";
import { OutfitsPanel } from "./model-outfits";
import { useUpdateModel } from "./model-queries";
import { UnsavedGuard } from "./text-editor";

const TABS = ["test", "framing", "moods", "outfits"] as const;
type PreviewTab = (typeof TABS)[number];

const isTab = (value: string): value is PreviewTab => (TABS as readonly string[]).includes(value);

interface Size {
  readonly width: number;
  readonly height: number;
}

/** An element's size in CSS pixels, following it as it changes. */
function useSize(element: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const node = element.current;
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** A wheel's scroll in CSS pixels, whatever unit the device reports it in. */
function wheelPixels(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * 400;
  return event.deltaY;
}

/** How much a pixel of wheel zooms, and the most one event may. */
const WHEEL_ZOOM = 0.0015;
const MAX_WHEEL_STEP = 1.5;

/**
 * Drag to pan and wheel or pinch to zoom the frame, on `surface`, while `on`. Attached by hand, as
 * React's wheel listener is passive and the page would scroll instead.
 */
function useFramingGestures(
  surface: RefObject<HTMLElement | null>,
  on: boolean,
  edit: (change: (box: Box) => Box) => void,
) {
  const latest = useRef(edit);
  useEffect(() => {
    latest.current = edit;
  });
  useEffect(() => {
    const node = surface.current;
    if (!on || node === null) return;
    const pointers = new Map<number, readonly [number, number]>();
    const local = (x: number, y: number): [number, number] => {
      const rect = node.getBoundingClientRect();
      return [x - rect.left, y - rect.top];
    };
    const sizeOf = (): Size => ({ width: node.clientWidth, height: node.clientHeight });

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      node.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, [event.clientX, event.clientY]);
    };
    const onMove = (event: PointerEvent) => {
      const last = pointers.get(event.pointerId);
      if (last === undefined) return;
      const next = [event.clientX, event.clientY] as const;
      const others = [...pointers].filter(([id]) => id !== event.pointerId);
      pointers.set(event.pointerId, next);
      const size = sizeOf();
      const [other] = others;
      if (other === undefined) {
        const [dx, dy] = [next[0] - last[0], next[1] - last[1]];
        latest.current((box) => panBox(box, dx, dy, boxScale(box, size)));
        return;
      }
      const [, fixed] = other;
      const before = Math.hypot(last[0] - fixed[0], last[1] - fixed[1]);
      const after = Math.hypot(next[0] - fixed[0], next[1] - fixed[1]);
      if (!(before > 0 && after > 0)) return;
      const middle = local((next[0] + fixed[0]) / 2, (next[1] + fixed[1]) / 2);
      latest.current((box) => zoomBox(box, after / before, rigPointAt(box, size, middle)));
    };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-wheelPixels(event) * WHEEL_ZOOM);
      const step = Math.min(MAX_WHEEL_STEP, Math.max(1 / MAX_WHEEL_STEP, factor));
      const at = local(event.clientX, event.clientY);
      const size = sizeOf();
      latest.current((box) => zoomBox(box, step, rigPointAt(box, size, at)));
    };
    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
      node.removeEventListener("wheel", onWheel);
    };
  }, [surface, on]);
}

/** Why the stage can't show her model, as the preview says it. */
function StageFailure({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useLingui();
  const reason =
    error instanceof AvatarError
      ? t(STAGE_ERRORS[error.code])
      : error instanceof ApiError
        ? t(errorMessage(error))
        : t(STAGE_ERRORS.trap);
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{t`Her model can't show here`}</AlertTitle>
      <AlertDescription>{reason}</AlertDescription>
      <AlertAction>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCcwIcon />
          {t`Try Again`}
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function ModelPreviewCard({
  persona,
  model,
}: {
  readonly persona: PersonaSummary;
  readonly model: CharacterModel;
}) {
  const { t } = useLingui();
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState(() => ({ saved: model, draft: draftOf(model) }));
  let current = state;
  // Saved elsewhere, such as a rename or a new file: the fields left alone here take what was
  // saved, and a new file's rig keeps what it has of the rest.
  if (state.saved !== model) {
    const rebased = rebaseDraft(state.draft, draftOf(state.saved), draftOf(model));
    current = {
      saved: model,
      draft: model.sha256 === state.saved.sha256 ? rebased : keptDraft(rebased, model.inventory),
    };
    setState(current);
  }
  const { draft } = current;
  const setDraft = useCallback((change: (draft: ModelDraft) => ModelDraft) => {
    setState((previous) => ({ ...previous, draft: change(previous.draft) }));
  }, []);
  const changes = useMemo(() => draftChanges(draft, model), [draft, model]);
  const dirty = Object.keys(changes).length > 0;
  const problem = draftProblem(draft);
  const save = useUpdateModel(persona.id);

  const [tab, setTab] = useState<PreviewTab>("test");
  const [shape, setShape] = useState<PreviewShape>("wide");
  const [editing, setEditing] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [ready, setReady] = useState<StageReady | null>(null);
  const [failure, setFailure] = useState<{ readonly error: unknown } | null>(null);
  // A new stage for Try Again.
  const [attempt, setAttempt] = useState(0);
  const surface = useRef<HTMLDivElement>(null);
  const size = useSize(surface);

  const { inventory } = model;
  const setup = useMemo(
    () => resolveSetup(inventory, { moods: draft.moods, gestures: draft.gestures }),
    [inventory, draft.moods, draft.gestures],
  );
  const worn = draft.outfits.find((outfit) => outfit.id === draft.outfit) ?? null;
  const shownOutfit =
    tab === "outfits" && editing !== null
      ? (draft.outfits.find((outfit) => outfit.id === editing) ?? worn)
      : worn;

  const rest = ready?.rest ?? null;
  const box = draft.framing.call ?? rest;
  const framing = tab === "framing";
  const editBox = useCallback(
    (change: (box: Box) => Box) => {
      if (rest === null) return;
      const canvas = inventory.canvas;
      setDraft((previous) => {
        const from = previous.framing.call ?? rest;
        const to = clampBox(change(from), canvas);
        return { ...previous, framing: { ...previous.framing, call: to } };
      });
    },
    [rest, inventory.canvas, setDraft],
  );
  useFramingGestures(surface, framing && ready !== null, editBox);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || problem !== null || save.isPending) return;
    const sent = draft;
    save.mutate(
      { model: model.id, patch: changes },
      {
        onSuccess: (saved) => {
          setState((previous) => ({
            saved,
            draft: rebaseDraft(previous.draft, sent, draftOf(saved)),
          }));
          toast.success(t`${ph({ name: saved.name })} saved.`);
        },
      },
    );
  }

  const outline = framing && box !== null && size.width > 0 ? shownRect(box, size) : null;
  const name = persona.shortName || persona.name;

  return (
    <form onSubmit={submit} noValidate>
      <SectionCard
        // Not hidden: the stage sticks beside long tabs, which a clipping ancestor would stop.
        className="overflow-clip"
        title={model.name}
        description={t`Try her out, frame her for calls, and choose how she shows each mood and what she wears, then save.`}
        note={
          problem !== null ? (
            <span className="text-destructive">{t`Name every outfit first.`}</span>
          ) : (
            t`Saved for ${ph({ name })}`
          )
        }
        actions={
          <SaveActions
            dirty={dirty}
            pending={save.isPending}
            blocked={problem !== null}
            onDiscard={() => {
              setState({ saved: model, draft: draftOf(model) });
              setEditing(null);
            }}
          />
        }
      >
        <div className="@container">
          <div className="grid gap-6 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,19rem)] @2xl:items-start">
            <div className="flex min-w-0 flex-col gap-3 @2xl:sticky @2xl:top-4">
              <div
                ref={surface}
                className={cn(
                  "relative overflow-hidden rounded-lg border bg-muted/40",
                  shape === "wide"
                    ? "aspect-[4/3] w-full"
                    : "mx-auto aspect-[9/16] h-[min(36rem,70svh)] max-w-full",
                  framing && ready !== null && "cursor-grab touch-none active:cursor-grabbing",
                )}
              >
                <ModelStage
                  key={attempt}
                  className="absolute inset-0"
                  persona={persona}
                  model={model}
                  setup={setup}
                  box={draft.framing.call}
                  outfit={shownOutfit}
                  onReady={(next) => {
                    setReady(next);
                    if (next !== null) setFailure(null);
                  }}
                  onFailure={(error) => setFailure({ error })}
                >
                  {outline !== null && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute rounded-sm border border-foreground/40 border-dashed"
                      style={outline}
                    />
                  )}
                </ModelStage>
              </div>
              {failure !== null && (
                <StageFailure
                  error={failure.error}
                  onRetry={() => {
                    setFailure(null);
                    setAttempt((count) => count + 1);
                  }}
                />
              )}
            </div>
            <Tabs
              value={tab}
              onValueChange={(next) => {
                if (isTab(next)) setTab(next);
              }}
              className="min-w-0 gap-4"
            >
              <TabsList className="w-full">
                <TabsTrigger value="test">{t({ message: "Test", context: "model" })}</TabsTrigger>
                <TabsTrigger value="framing">{t`Framing`}</TabsTrigger>
                <TabsTrigger value="moods">{t`Moods`}</TabsTrigger>
                <TabsTrigger value="outfits">{t`Outfits`}</TabsTrigger>
              </TabsList>
              <TabsContent value="test">
                <TestPanel
                  stage={ready?.stage ?? null}
                  setup={setup}
                  inventory={inventory}
                  reducedMotion={reducedMotion}
                  text={line}
                  onText={setLine}
                />
              </TabsContent>
              <TabsContent value="framing">
                <FramingPanel
                  shape={shape}
                  framed={draft.framing.call !== null}
                  disabled={ready === null}
                  onShape={setShape}
                  onZoom={(factor) =>
                    editBox((from) =>
                      zoomBox(from, factor, [from.x + from.width / 2, from.y + from.height / 2]),
                    )
                  }
                  onNudge={(dx, dy) => editBox((from) => nudgedBox(from, dx, dy))}
                  onReset={() =>
                    setDraft((previous) => ({
                      ...previous,
                      framing: { ...previous.framing, call: null },
                    }))
                  }
                />
              </TabsContent>
              <TabsContent value="moods">
                <MoodsPanel
                  stage={ready?.stage ?? null}
                  inventory={inventory}
                  moods={draft.moods}
                  gestures={draft.gestures}
                  onMoods={(moods) => setDraft((previous) => ({ ...previous, moods }))}
                  onGestures={(gestures) => setDraft((previous) => ({ ...previous, gestures }))}
                />
              </TabsContent>
              <TabsContent value="outfits">
                <OutfitsPanel
                  inventory={inventory}
                  draft={draft}
                  editing={editing}
                  onDraft={setDraft}
                  onEditing={setEditing}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </SectionCard>
      <UnsavedGuard dirty={dirty} />
    </form>
  );
}
