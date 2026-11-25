// The Moods tab: the expressions each mood of hers shows on this model and the parameters it holds,
// and the clip each gesture plays, the owner's choice or the SDK's default, tried on the preview as
// they are edited.
import {
  type AvatarStage,
  GESTURES,
  type Gesture,
  MOOD_TAGS,
  type MoodTag,
} from "@laplace.live/eidolon-sdk/avatar";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { PlayIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ModelInventory, ModelParameter } from "@/lib/api";
import { GESTURE_LABELS, MOOD_LABELS } from "./appearance-labels";
import { ControlGroup, NEUTRAL, ResetButton } from "./model-controls";
import {
  gestureClip,
  MAX_MOOD_EXPRESSIONS,
  MAX_MOOD_PARAMETERS,
  type ModelDraft,
  moodExpressions,
  withGesture,
  withMood,
  withMoodParameter,
  withoutGesture,
  withoutMood,
} from "./model-draft";

/** A searchable list of the parameters a mood doesn't hold yet, for one to add to it. */
function ParameterPicker({
  name,
  parameters,
  disabled,
  onPick,
}: {
  /** The mood's name, for the button's label. */
  readonly name: string;
  readonly parameters: readonly ModelParameter[];
  readonly disabled: boolean;
  readonly onPick: (parameter: ModelParameter) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          aria-label={t`Add Parameter to ${ph({ name })}`}
          className="self-start text-muted-foreground"
        >
          <PlusIcon />
          {t`Add Parameter`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0" align="start">
        <Command>
          <CommandInput placeholder={t`Search parameters`} />
          <CommandList>
            <CommandEmpty>{t`No parameter by that name.`}</CommandEmpty>
            <CommandGroup>
              {parameters.map((parameter) => (
                <CommandItem
                  key={parameter.id}
                  value={parameter.id}
                  onSelect={() => {
                    onPick(parameter);
                    setOpen(false);
                  }}
                >
                  <span className="truncate font-mono text-xs">{parameter.id}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function MoodRow({
  tag,
  inventory,
  moods,
  moodParameters,
  trying,
  disabled,
  onMoods,
  onMoodParameters,
  onTry,
}: {
  readonly tag: MoodTag;
  readonly inventory: ModelInventory;
  readonly moods: ModelDraft["moods"];
  readonly moodParameters: ModelDraft["moodParameters"];
  readonly trying: boolean;
  readonly disabled: boolean;
  readonly onMoods: (moods: ModelDraft["moods"]) => void;
  readonly onMoodParameters: (moodParameters: ModelDraft["moodParameters"]) => void;
  readonly onTry: (on: boolean) => void;
}) {
  const { t } = useLingui();
  const labelId = useId();
  const label = t(MOOD_LABELS[tag]);
  const shown = moodExpressions(inventory, moods, tag);
  const settings = moodParameters[tag] ?? [];
  const chosen = Object.hasOwn(moods, tag) || settings.length > 0;
  const held = new Set(settings.map(({ id }) => id));
  // A parameter edited shows on the preview at once, as she would show the mood.
  const hold = (id: string, value: number | null) => {
    onMoodParameters(withMoodParameter(inventory, moodParameters, tag, id, value));
    if (value !== null) onTry(true);
  };
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1">
          <span id={labelId} className="font-medium text-sm">
            {label}
          </span>
          {!chosen && <span className="ml-2 text-muted-foreground text-xs">{t`Default`}</span>}
        </span>
        {chosen && (
          <ResetButton
            name={label}
            onReset={() => {
              onMoods(withoutMood(moods, tag));
              onMoodParameters(withoutMood(moodParameters, tag));
            }}
          />
        )}
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
      {inventory.expressions.length > 0 && (
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
      )}
      {settings.length > 0 && (
        <ul className="flex flex-col gap-2">
          {settings.map(({ id, value }) => {
            const range = inventory.parameters.find((parameter) => parameter.id === id);
            if (range === undefined) return null;
            const remove = t`Remove ${ph({ name: id })}`;
            return (
              <li key={id} className="flex flex-col gap-1">
                <span className="truncate font-mono text-xs" title={id}>
                  {id}
                </span>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={range.min}
                    max={range.max}
                    step={(range.max - range.min) / 100 || 0.01}
                    value={value}
                    aria-label={id}
                    onChange={(event) => hold(id, Number(event.target.value))}
                    className="h-2 min-w-0 flex-1 cursor-pointer accent-primary"
                  />
                  <output className="w-12 shrink-0 text-right text-sm tabular-nums">
                    {value.toFixed(2)}
                  </output>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={remove}
                    title={remove}
                    onClick={() => hold(id, null)}
                  >
                    <XIcon />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {inventory.parameters.length > 0 && (
        <ParameterPicker
          name={label}
          parameters={inventory.parameters.filter(({ id }) => !held.has(id))}
          disabled={settings.length >= MAX_MOOD_PARAMETERS}
          onPick={(parameter) => hold(parameter.id, parameter.default)}
        />
      )}
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
  readonly onPlay: () => void;
}) {
  const { t } = useLingui();
  const label = t(GESTURE_LABELS[gesture]);
  const play = t`Play ${ph({ name: label })}`;
  const clip = gestureClip(inventory, gestures, gesture);
  const chosen = Object.hasOwn(gestures, gesture);
  // The stage nods and shakes her head by itself where the model has no clip for it.
  const playable = clip !== null || gesture === "nod" || gesture === "shake";
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
          disabled={disabled || !playable}
          onClick={onPlay}
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
  moodParameters,
  gestures,
  onMoods,
  onMoodParameters,
  onGestures,
}: {
  /** Null until her model shows. */
  readonly stage: AvatarStage | null;
  readonly inventory: ModelInventory;
  readonly moods: ModelDraft["moods"];
  readonly moodParameters: ModelDraft["moodParameters"];
  readonly gestures: ModelDraft["gestures"];
  readonly onMoods: (moods: ModelDraft["moods"]) => void;
  readonly onMoodParameters: (moodParameters: ModelDraft["moodParameters"]) => void;
  readonly onGestures: (gestures: ModelDraft["gestures"]) => void;
}) {
  const { t } = useLingui();
  const [trying, setTrying] = useState<MoodTag | null>(null);

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
        description={
          inventory.expressions.length > 0
            ? t`Her replies' cues give her a mood, which shows as up to two of these expressions and the parameters you add to it.`
            : t`Her replies' cues give her a mood. This model has no expressions, so build each mood from its parameters.`
        }
      >
        <ul className="divide-y rounded-lg border">
          {MOOD_TAGS.map((tag) => (
            <MoodRow
              key={tag}
              tag={tag}
              inventory={inventory}
              moods={moods}
              moodParameters={moodParameters}
              trying={trying === tag}
              disabled={stage === null}
              onMoods={onMoods}
              onMoodParameters={onMoodParameters}
              onTry={(on) => setTrying(on ? tag : null)}
            />
          ))}
        </ul>
      </ControlGroup>
      <ControlGroup
        title={t`Gestures`}
        description={t`The clip each plays: idle all the time, talking while she speaks, and a nod or a head shake now and then. Without a clip, she still nods and shakes her head.`}
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
              onPlay={() => stage?.gesture(gesture)}
            />
          ))}
        </ul>
      </ControlGroup>
    </div>
  );
}
