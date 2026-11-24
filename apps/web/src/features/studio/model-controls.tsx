// The preview's controls that play her model without changing what is saved: the Test tab (her
// expressions and clips, a line of hers, her mouth on the microphone, her eyes on the pointer) and
// the Framing tab's buttons. Moods and Outfits, which edit the draft, have modules of their own.

import { cueEmoji } from "@laplace.live/eidolon-sdk";
import {
  type AvatarModel,
  type AvatarStage,
  type Direction,
  direct,
  directionOf,
  directionState,
  type ModelClip,
  MouthMeter,
  type MouthSource,
  type ResolvedSetup,
} from "@laplace.live/eidolon-sdk/avatar";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  EyeIcon,
  MicIcon,
  PlayIcon,
  RectangleHorizontalIcon,
  RectangleVerticalIcon,
  RotateCcwIcon,
  SquareIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { QuietBadge } from "@/components/quiet-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type MicProblem, micProblemOf } from "@/features/call/media";
import { RECORDER_PROBLEMS } from "@/features/chats/labels";
import { MicRequests } from "@/features/chats/voice";
import type { ModelInventory } from "@/lib/api";
import { listOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { MOOD_LABELS } from "./appearance-labels";
import { type LinePlan, lineEvents, planLine, syllableLevel } from "./model-line";
import { Hint } from "./parts";

/** The layer the stage plays gestures on, above her idle and her talking. */
const GESTURE_LAYER = 2;
const GESTURE_PRIORITY = 2;
/** How often a line's cues are checked for, as a call's tick does. */
const TICK_MS = 100;
/** How long her face keeps a line's mood once she has said it. */
const HOLD_MS = 1500;

/** No mood, nothing said, eyes wandering: how she is between tries. */
export const NEUTRAL: Direction = directionOf(directionState());

/** A titled group of controls in a tab; `labelId` names the heading for a control it labels. */
export function ControlGroup({
  title,
  labelId,
  description,
  action,
  className,
  children,
}: {
  readonly title: string;
  readonly labelId?: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const own = useId();
  const id = labelId ?? own;
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="font-medium text-sm">
          {title}
        </h3>
        {action}
      </div>
      {description !== undefined && (
        <div className="text-muted-foreground text-xs">{description}</div>
      )}
      {children}
    </section>
  );
}

/**
 * Plays a clip once over her idle, as a gesture plays, under reduced motion too since it was asked
 * for. A clip that loops never ends by itself, so it is stopped after one pass.
 */
export function usePlayClip(stage: AvatarStage | null): (clip: ModelClip) => void {
  const looping = useRef<{ readonly model: AvatarModel; readonly timer: number } | null>(null);
  const stopLoop = useCallback(() => {
    const current = looping.current;
    looping.current = null;
    if (current === null) return;
    window.clearTimeout(current.timer);
    if (stage?.model === current.model) current.model.play(null, GESTURE_LAYER);
  }, [stage]);
  useEffect(() => stopLoop, [stopLoop]);
  return useCallback(
    (clip: ModelClip) => {
      const model = stage?.model;
      if (model == null) return;
      stopLoop();
      model.play(clip.id, GESTURE_LAYER, { priority: GESTURE_PRIORITY });
      if (!clip.looping) return;
      const timer = window.setTimeout(() => {
        looping.current = null;
        if (stage?.model === model) model.play(null, GESTURE_LAYER);
      }, clip.duration * 1000);
      looping.current = { model, timer };
    },
    [stage, stopLoop],
  );
}

function release(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

type MicPhase = "off" | "starting" | "on";

/** Her mouth on the microphone through the SDK's meter: audio only, let go on stop and unmount. */
function useMicrophoneMouth(stage: AvatarStage | null, onProblem: (problem: MicProblem) => void) {
  const [phase, setPhase] = useState<MicPhase>("off");
  const held = useRef<{
    readonly stream: MediaStream;
    readonly context: AudioContext;
    readonly meter: MouthMeter;
  } | null>(null);
  const requests = useRef(new MicRequests());
  const problems = useRef(onProblem);
  useEffect(() => {
    problems.current = onProblem;
  });

  const stop = useCallback(() => {
    requests.current.cancel();
    const current = held.current;
    held.current = null;
    setPhase("off");
    if (current === null) return;
    stage?.mouth(null);
    current.meter.close();
    void current.context.close().catch(() => {});
    release(current.stream);
  }, [stage]);

  const start = useCallback(() => {
    if (stage === null || held.current !== null) return;
    const media = navigator.mediaDevices as MediaDevices | undefined;
    // Browsers leave it undefined outside a secure context.
    if (media === undefined) {
      problems.current("insecure");
      return;
    }
    const request = requests.current.begin();
    if (request === null) return;
    // Made in the click, where the browser lets it start.
    const context = new AudioContext();
    setPhase("starting");
    media.getUserMedia({ audio: true }).then(
      (stream) => {
        if (!requests.current.settle(request)) {
          release(stream);
          void context.close().catch(() => {});
          return;
        }
        let meter: MouthMeter;
        try {
          meter = new MouthMeter(stream, { context });
        } catch {
          release(stream);
          void context.close().catch(() => {});
          setPhase("off");
          problems.current("unknown");
          return;
        }
        held.current = { stream, context, meter };
        stage.mouth(meter);
        setPhase("on");
      },
      (error: unknown) => {
        void context.close().catch(() => {});
        if (!requests.current.settle(request)) return;
        setPhase("off");
        problems.current(micProblemOf(error));
      },
    );
  }, [stage]);

  useEffect(() => stop, [stop]);
  const mouth = useCallback((): MouthSource | null => held.current?.meter ?? null, []);
  return { phase, start, stop, mouth };
}

/** A line's made-up mouth: a syllable at her voice's pace, read by the stage each frame. */
class LineMouth implements MouthSource {
  readonly #seconds: number;
  #elapsed = 0;

  constructor(seconds: number) {
    this.#seconds = seconds;
  }

  read(dt: number): number {
    this.#elapsed += dt;
    return syllableLevel(this.#elapsed, this.#seconds);
  }
}

/**
 * Plays a line of hers on the stage as a call would, then lets her face settle back; `playing`
 * holds until it has, since until then her direction sets her expressions.
 */
function useTryLine(stage: AvatarStage | null, restoreMouth: () => MouthSource | null) {
  const [playing, setPlaying] = useState(false);
  const timers = useRef<number[]>([]);
  const clear = useCallback(() => {
    for (const timer of timers.current.splice(0)) window.clearTimeout(timer);
  }, []);

  const stop = useCallback(() => {
    clear();
    setPlaying(false);
    stage?.direct(NEUTRAL);
    stage?.mouth(restoreMouth());
  }, [stage, restoreMouth, clear]);

  const play = useCallback(
    (plan: LinePlan) => {
      if (stage === null) return;
      clear();
      setPlaying(true);
      const at = performance.now();
      const { start, end } = lineEvents(plan, at);
      let state = start.reduce(direct, directionState());
      stage.direct(directionOf(state));
      stage.mouth(new LineMouth(plan.seconds));
      const tick = window.setInterval(() => {
        state = direct(state, { type: "tick", at: performance.now() });
        stage.direct(directionOf(state));
      }, TICK_MS);
      const done = window.setTimeout(() => {
        window.clearInterval(tick);
        state = end.reduce(direct, state);
        stage.direct(directionOf(state));
        stage.mouth(restoreMouth());
        const settle = window.setTimeout(() => {
          stage.direct(NEUTRAL);
          setPlaying(false);
        }, HOLD_MS);
        timers.current.push(settle);
      }, plan.seconds * 1000);
      // clearTimeout and clearInterval share one pool of ids.
      timers.current.push(tick, done);
    },
    [stage, restoreMouth, clear],
  );

  useEffect(
    () => () => {
      clear();
      stage?.direct(NEUTRAL);
      stage?.mouth(restoreMouth());
    },
    [stage, restoreMouth, clear],
  );
  return { playing, play, stop };
}

/** What a line was read as: its mood, and the cues that move her face. */
function LineReading({ plan }: { readonly plan: LinePlan }) {
  const { t } = useLingui();
  const moods = listOf(plan.moods.map((tag) => t(MOOD_LABELS[tag])));
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
      <span>
        {plan.moods.length > 0
          ? t`Mood: ${ph({ moods })}`
          : plan.cues.length > 0
            ? t`No mood found, so only her cues change her face.`
            : t`No mood found, so her face stays neutral.`}
      </span>
      {plan.cues.map((cue, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a cue can come twice, in order.
        <QuietBadge key={`${cue}-${index}`}>
          {cueEmoji(cue)} {cue}
        </QuietBadge>
      ))}
    </div>
  );
}

export function TestPanel({
  stage,
  setup,
  inventory,
  reducedMotion,
  text,
  onText,
}: {
  /** Null until her model shows. */
  readonly stage: AvatarStage | null;
  /** What the stage shows her with; it starts her face afresh when this changes. */
  readonly setup: ResolvedSetup;
  readonly inventory: ModelInventory;
  readonly reducedMotion: boolean;
  /** The line to try, kept while other tabs are open. */
  readonly text: string;
  readonly onText: (text: string) => void;
}) {
  const { t } = useLingui();
  const ids = { expressions: useId(), line: useId() };
  const [held, setHeld] = useState<string[]>([]);
  const [reading, setReading] = useState<LinePlan | null>(null);
  const [following, setFollowing] = useState(false);
  const playClip = usePlayClip(stage);
  const mic = useMicrophoneMouth(stage, (problem) =>
    toast.error(t(RECORDER_PROBLEMS[problem].title), {
      description: t(RECORDER_PROBLEMS[problem].body),
    }),
  );
  const line = useTryLine(stage, mic.mouth);
  const off = stage === null;

  // Leaving the tab, a stage made anew, or a new setup, which a Save or Discard can bring, takes off
  // what it held on her.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setup only triggers it.
  useEffect(() => {
    if (stage === null) return;
    return () => {
      stage.model?.setExpressions([]);
      setHeld([]);
    };
  }, [stage, setup]);
  useEffect(() => {
    if (stage === null) return;
    stage.gaze(following ? "pointer" : "direction");
    return () => stage.gaze("direction");
  }, [stage, following]);

  // Straight onto the model, which the stage leaves alone until her direction asks for other
  // expressions: a line with no mood never does, so a line takes these off before it plays.
  function hold(ids: string[]) {
    setHeld(ids);
    stage?.model?.setExpressions(ids);
  }

  function tryLine() {
    const plan = planLine(text.trim());
    setReading(plan);
    hold([]);
    line.play(plan);
  }

  return (
    <div className="flex flex-col gap-6">
      {reducedMotion && (
        <Hint>{t`Your system asks for less motion, so she doesn't talk or gesture with her body by herself. A clip you play still plays.`}</Hint>
      )}
      <ControlGroup
        title={t`Expressions`}
        labelId={ids.expressions}
        description={t`Held on her until you take them off.`}
      >
        {inventory.expressions.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t`This model has no expressions.`}</p>
        ) : (
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            value={held}
            onValueChange={hold}
            disabled={off || line.playing}
            aria-labelledby={ids.expressions}
            className="w-full flex-wrap justify-start"
          >
            {inventory.expressions.map((expression) => (
              <ToggleGroupItem
                key={expression.id}
                value={expression.id}
                className="rounded-full px-3 data-[state=on]:border-foreground/50 data-[state=on]:bg-muted"
              >
                {expression.name || expression.id}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </ControlGroup>
      <ControlGroup title={t`Clips`} description={t`Each plays once over her idle.`}>
        {inventory.clips.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t`This model has no clips.`}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {inventory.clips.map((clip) => (
              <Button
                key={clip.id}
                type="button"
                variant="outline"
                size="sm"
                disabled={off}
                onClick={() => playClip(clip)}
              >
                <PlayIcon />
                {clip.name || clip.id}
              </Button>
            ))}
          </div>
        )}
      </ControlGroup>
      <ControlGroup
        title={t`Try a Line`}
        labelId={ids.line}
        description={t`Paste a reply of hers, with its cues: she plays it as she would on a call, with no voice and nothing billed.`}
      >
        <Textarea
          aria-labelledby={ids.line}
          rows={2}
          value={text}
          onChange={(event) => onText(event.target.value)}
          placeholder={t`[sleepy, teasing] Oh, you're back. [chuckling]`}
          className="min-h-16 resize-none"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {line.playing ? (
            <Button type="button" variant="outline" size="sm" onClick={line.stop}>
              <SquareIcon />
              {t`Stop`}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={off || text.trim() === ""}
              onClick={tryLine}
            >
              <PlayIcon />
              {t`Play`}
            </Button>
          )}
          {reading !== null && <LineReading plan={reading} />}
        </div>
      </ControlGroup>
      <ControlGroup title={t`Microphone and Pointer`}>
        <div className="flex flex-wrap gap-2">
          <Toggle
            variant="outline"
            size="sm"
            pressed={mic.phase !== "off"}
            onPressedChange={(on) => (on ? mic.start() : mic.stop())}
            disabled={off}
          >
            {mic.phase === "starting" ? <Spinner /> : <MicIcon />}
            {t`Use Microphone`}
          </Toggle>
          <Toggle
            variant="outline"
            size="sm"
            pressed={following}
            onPressedChange={setFollowing}
            disabled={off}
          >
            <EyeIcon />
            {t`Follow Pointer`}
          </Toggle>
        </div>
        <p className="text-muted-foreground text-xs">
          {t`Her mouth follows your voice, and her eyes follow your pointer. Nothing is recorded.`}
        </p>
      </ControlGroup>
    </div>
  );
}

export type PreviewShape = "wide" | "tall";

export function FramingPanel({
  shape,
  framed,
  disabled,
  onShape,
  onZoom,
  onNudge,
  onReset,
}: {
  readonly shape: PreviewShape;
  /** The owner framed her; else she shows as calls frame her by default. */
  readonly framed: boolean;
  readonly disabled: boolean;
  readonly onShape: (shape: PreviewShape) => void;
  /** Zooms in by `factor`, out below 1. */
  readonly onZoom: (factor: number) => void;
  /** Moves her by steps: right and down for positive ones. */
  readonly onNudge: (dx: number, dy: number) => void;
  readonly onReset: () => void;
}) {
  const { t } = useLingui();
  const ids = { shape: useId() };
  const step = (label: string, icon: ReactNode, run: () => void) => (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={run}
    >
      {icon}
    </Button>
  );
  return (
    <div className="flex flex-col gap-6">
      <ControlGroup
        title={t`Screen`}
        labelId={ids.shape}
        description={t`A call fills the screen it's on: try her on a wide one and on a phone's.`}
      >
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={shape}
          onValueChange={(next) => {
            if (next === "wide" || next === "tall") onShape(next);
          }}
          aria-labelledby={ids.shape}
        >
          <ToggleGroupItem value="wide" className="h-8 px-3">
            <RectangleHorizontalIcon />
            {t`Wide`}
          </ToggleGroupItem>
          <ToggleGroupItem value="tall" className="h-8 px-3">
            <RectangleVerticalIcon />
            {t`Tall`}
          </ToggleGroupItem>
        </ToggleGroup>
      </ControlGroup>
      <ControlGroup
        title={t`Position`}
        description={t`Drag her on the preview to move her, and scroll or pinch to zoom.`}
      >
        <div className="flex flex-wrap items-center gap-2">
          {step(t`Zoom Out`, <ZoomOutIcon />, () => onZoom(1 / 1.15))}
          {step(t`Zoom In`, <ZoomInIcon />, () => onZoom(1.15))}
          <span aria-hidden className="mx-1 h-5 w-px bg-border" />
          {step(t`Move Left`, <ArrowLeftIcon />, () => onNudge(-1, 0))}
          {step(t`Move Up`, <ArrowUpIcon />, () => onNudge(0, -1))}
          {step(t`Move Down`, <ArrowDownIcon />, () => onNudge(0, 1))}
          {step(t`Move Right`, <ArrowRightIcon />, () => onNudge(1, 0))}
        </div>
      </ControlGroup>
      <div className="flex flex-col items-start gap-2">
        <p className="text-muted-foreground text-xs">
          {framed
            ? t`The dashed outline is what any call shows of her; a wider or taller screen shows more around it.`
            : t`Calls frame her head and shoulders until you frame her yourself.`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !framed}
          onClick={onReset}
        >
          <RotateCcwIcon />
          {t`Reset Framing`}
        </Button>
      </div>
    </div>
  );
}
