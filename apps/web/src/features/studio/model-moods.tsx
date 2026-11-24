// The Moods tab: the expressions each mood of hers shows on this model, and the clip each gesture
// plays, the owner's choice or the SDK's default, tried on the preview as they are edited.
import {
  type AvatarStage,
  GESTURES,
  type Gesture,
  MOOD_TAGS,
  type MoodTag,
} from "@laplace.live/eidolon-sdk/avatar";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { PlayIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ModelInventory } from "@/lib/api";
import { GESTURE_LABELS, MOOD_LABELS } from "./appearance-labels";
import { ControlGroup, NEUTRAL, usePlayClip } from "./model-controls";
import {
  gestureClip,
  MAX_MOOD_EXPRESSIONS,
  type ModelDraft,
  moodExpressions,
  withGesture,
  withMood,
  withoutGesture,
  withoutMood,
} from "./model-draft";

function ResetButton({ name, onReset }: { readonly name: string; readonly onReset: () => void }) {
  const { t } = useLingui();
  const label = t`Reset ${ph({ name })} to Default`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={onReset}
    >
      <RotateCcwIcon />
    </Button>
  );
}

function MoodRow({
  tag,
  inventory,
  moods,
  trying,
  disabled,
  onMoods,
  onTry,
}: {
  readonly tag: MoodTag;
  readonly inventory: ModelInventory;
  readonly moods: ModelDraft["moods"];
  readonly trying: boolean;
  readonly disabled: boolean;
  readonly onMoods: (moods: ModelDraft["moods"]) => void;
  readonly onTry: (on: boolean) => void;
}) {
  const { t } = useLingui();
  const labelId = useId();
  const label = t(MOOD_LABELS[tag]);
  const shown = moodExpressions(inventory, moods, tag);
  const chosen = Object.hasOwn(moods, tag);
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1">
          <span id={labelId} className="font-medium text-sm">
            {label}
          </span>
          {!chosen && <span className="ml-2 text-muted-foreground text-xs">{t`Default`}</span>}
        </span>
        {chosen && <ResetButton name={label} onReset={() => onMoods(withoutMood(moods, tag))} />}
        <Toggle
          variant="outline"
          size="sm"
          pressed={trying}
          onPressedChange={onTry}
          disabled={disabled}
          aria-label={t`Try ${ph({ name: label })}`}
        >
          {t`Try`}
        </Toggle>
      </div>
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        value={[...shown]}
        onValueChange={(ids) => onMoods(withMood(inventory, moods, tag, ids))}
        aria-labelledby={labelId}
        className="w-full flex-wrap justify-start"
      >
        {inventory.expressions.map((expression) => (
          <ToggleGroupItem
            key={expression.id}
            value={expression.id}
            disabled={!shown.includes(expression.id) && shown.length >= MAX_MOOD_EXPRESSIONS}
            className="rounded-full px-3 data-[state=on]:border-foreground/50 data-[state=on]:bg-muted"
          >
            {expression.name || expression.id}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </li>
  );
}

function GestureRow({
  gesture,
  inventory,
  gestures,
  disabled,
  onGestures,
  onPlay,
}: {
  readonly gesture: Gesture;
  readonly inventory: ModelInventory;
  readonly gestures: ModelDraft["gestures"];
  readonly disabled: boolean;
  readonly onGestures: (gestures: ModelDraft["gestures"]) => void;
  readonly onPlay: (clip: string) => void;
}) {
  const { t } = useLingui();
  const label = t(GESTURE_LABELS[gesture]);
  const play = t`Play ${ph({ name: label })}`;
  const clip = gestureClip(inventory, gestures, gesture);
  const chosen = Object.hasOwn(gestures, gesture);
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex min-h-7 items-center gap-1.5">
        <span className="min-w-0 flex-1 font-medium text-sm">
          {label}
          {!chosen && (
            <span className="ml-2 font-normal text-muted-foreground text-xs">{t`Default`}</span>
          )}
        </span>
        {chosen && (
          <ResetButton name={label} onReset={() => onGestures(withoutGesture(gestures, gesture))} />
        )}
      </div>
      <div className="flex items-center gap-2">
        <Select
          value={clip ?? ""}
          onValueChange={(id) => onGestures(withGesture(inventory, gestures, gesture, id))}
        >
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={label}>
            <SelectValue placeholder={t`None`} />
          </SelectTrigger>
          <SelectContent>
            {inventory.clips.map((each) => (
              <SelectItem key={each.id} value={each.id}>
                {each.name || each.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={play}
          title={play}
          disabled={disabled || clip === null}
          onClick={() => clip !== null && onPlay(clip)}
        >
          <PlayIcon />
        </Button>
      </div>
    </li>
  );
}

export function MoodsPanel({
  stage,
  inventory,
  moods,
  gestures,
  onMoods,
  onGestures,
}: {
  /** Null until her model shows. */
  readonly stage: AvatarStage | null;
  readonly inventory: ModelInventory;
  readonly moods: ModelDraft["moods"];
  readonly gestures: ModelDraft["gestures"];
  readonly onMoods: (moods: ModelDraft["moods"]) => void;
  readonly onGestures: (gestures: ModelDraft["gestures"]) => void;
}) {
  const { t } = useLingui();
  const [trying, setTrying] = useState<MoodTag | null>(null);
  const playClip = usePlayClip(stage);

  // The mood tried shows as a reply's would, through her setup as edited so far.
  useEffect(() => {
    stage?.direct(trying === null ? NEUTRAL : { ...NEUTRAL, mood: [trying] });
  }, [stage, trying]);
  useEffect(() => {
    if (stage === null) return;
    return () => stage.direct(NEUTRAL);
  }, [stage]);

  return (
    <div className="flex flex-col gap-6">
      <ControlGroup
        title={t`Moods`}
        description={t`Her replies' cues give her a mood, which shows as up to two of these expressions.`}
      >
        <ul className="divide-y rounded-lg border">
          {MOOD_TAGS.map((tag) => (
            <MoodRow
              key={tag}
              tag={tag}
              inventory={inventory}
              moods={moods}
              trying={trying === tag}
              disabled={stage === null}
              onMoods={onMoods}
              onTry={(on) => setTrying(on ? tag : null)}
            />
          ))}
        </ul>
      </ControlGroup>
      <ControlGroup
        title={t`Gestures`}
        description={t`The clip each plays: idle all the time, talking while she speaks, and a nod or a head shake now and then.`}
      >
        <ul className="divide-y rounded-lg border">
          {GESTURES.map((gesture) => (
            <GestureRow
              key={gesture}
              gesture={gesture}
              inventory={inventory}
              gestures={gestures}
              disabled={stage === null}
              onGestures={onGestures}
              onPlay={(id) => {
                const clip = inventory.clips.find((each) => each.id === id);
                if (clip !== undefined) playClip(clip);
              }}
            />
          ))}
        </ul>
      </ControlGroup>
    </div>
  );
}
