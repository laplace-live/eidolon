// The Outfits tab: her outfits on this model, each hiding parts, holding parameters at a value and
// showing pose entries, and which one she wears. The outfit being edited shows on the preview.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CheckIcon, PencilIcon, PlusIcon, ShirtIcon, Trash2Icon, XIcon } from "lucide-react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ModelInventory, ModelOutfit } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NAME_PROBLEMS } from "./appearance-labels";
import { ControlGroup } from "./model-controls";
import {
  MAX_NAME,
  MAX_OUTFITS,
  type ModelDraft,
  nameProblem,
  withHiddenParts,
  withNewOutfit,
  withOutfit,
  withoutOutfit,
  withParameter,
  withPose,
} from "./model-draft";

/** The worn outfit's Select value for none: outfit ids are slugs, which never start with ":". */
const NONE = ":none";
/** A pose group's Select value for the entry the model loads with. */
const LOADED = ":loaded";

function OutfitEditor({
  inventory,
  outfit,
  onOutfit,
}: {
  readonly inventory: ModelInventory;
  readonly outfit: ModelOutfit;
  readonly onOutfit: (outfit: ModelOutfit) => void;
}) {
  const { t } = useLingui();
  const ids = { name: useId(), parts: useId() };
  const problem = nameProblem(outfit.name);
  const held = new Set(outfit.parameters.map(({ id }) => id));
  const free = inventory.parameters.filter(({ id }) => !held.has(id));
  return (
    <div className="flex flex-col gap-5 border-t px-3 pt-3 pb-4">
      <Field data-invalid={problem !== null}>
        <FieldLabel htmlFor={ids.name}>{t`Name`}</FieldLabel>
        <Input
          id={ids.name}
          value={outfit.name}
          onChange={(event) => onOutfit({ ...outfit, name: event.target.value })}
          maxLength={MAX_NAME}
          aria-invalid={problem !== null}
          autoComplete="off"
        />
        {problem !== null && <FieldError>{t(NAME_PROBLEMS[problem])}</FieldError>}
      </Field>
      {inventory.parts.length > 0 && (
        <ControlGroup title={t`Hidden Parts`} labelId={ids.parts}>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            value={[...outfit.hiddenParts]}
            onValueChange={(parts) => onOutfit(withHiddenParts(outfit, parts))}
            aria-labelledby={ids.parts}
            className="w-full flex-wrap justify-start"
          >
            {inventory.parts.map((part) => (
              <ToggleGroupItem
                key={part.id}
                value={part.id}
                className="rounded-full px-3 data-[state=on]:border-foreground/50 data-[state=on]:bg-muted data-[state=on]:line-through"
              >
                {part.name || part.id}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </ControlGroup>
      )}
      {inventory.poseGroups.length > 0 && (
        <ControlGroup title={t`Poses`}>
          <div className="flex flex-col gap-2">
            {inventory.poseGroups.map((entries, group) => {
              const entry = outfit.poses.find((pose) => pose.group === group)?.entry ?? null;
              const label = t`Pose Group ${ph({ group: group + 1 })}`;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a pose group is known by its index.
                <div key={group} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 text-sm">{label}</span>
                  <Select
                    value={entry === null ? LOADED : String(entry)}
                    onValueChange={(value) =>
                      onOutfit(withPose(outfit, group, value === LOADED ? null : Number(value)))
                    }
                  >
                    <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={label}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={LOADED}>{t`As Exported`}</SelectItem>
                      {Array.from({ length: entries }, (_, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: entries are known by their index.
                        <SelectItem key={index} value={String(index)}>
                          {t`Entry ${ph({ entry: index + 1 })}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        </ControlGroup>
      )}
      {inventory.parameters.length > 0 && (
        <ControlGroup title={t`Parameters`} description={t`Held at a value while she wears it.`}>
          {outfit.parameters.length > 0 && (
            <ul className="flex flex-col gap-2">
              {outfit.parameters.map(({ id, value }) => {
                const range = inventory.parameters.find((parameter) => parameter.id === id);
                if (range === undefined) return null;
                const step = (range.max - range.min) / 100 || 0.01;
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
                        step={step}
                        value={value}
                        aria-label={id}
                        onChange={(event) =>
                          onOutfit(withParameter(inventory, outfit, id, Number(event.target.value)))
                        }
                        className="h-2 min-w-0 flex-1 cursor-pointer accent-primary"
                      />
                      <output className="w-12 shrink-0 text-right text-sm tabular-nums">
                        {value.toFixed(2)}
                      </output>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Remove ${ph({ name: id })}`}
                        title={t`Remove ${ph({ name: id })}`}
                        onClick={() => onOutfit(withParameter(inventory, outfit, id, null))}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {free.length > 0 && (
            <Select
              value=""
              onValueChange={(id) => {
                const range = inventory.parameters.find((parameter) => parameter.id === id);
                if (range !== undefined)
                  onOutfit(withParameter(inventory, outfit, id, range.default));
              }}
            >
              <SelectTrigger size="sm" className="w-full" aria-label={t`Add a Parameter`}>
                <SelectValue placeholder={t`Add a parameter…`} />
              </SelectTrigger>
              <SelectContent>
                {free.map((parameter) => (
                  <SelectItem key={parameter.id} value={parameter.id} className="font-mono text-xs">
                    {parameter.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </ControlGroup>
      )}
    </div>
  );
}

export function OutfitsPanel({
  inventory,
  draft,
  editing,
  onDraft,
  onEditing,
}: {
  readonly inventory: ModelInventory;
  readonly draft: ModelDraft;
  /** The outfit open for editing, which the preview wears meanwhile. */
  readonly editing: string | null;
  readonly onDraft: (change: (draft: ModelDraft) => ModelDraft) => void;
  readonly onEditing: (outfit: string | null) => void;
}) {
  const { t } = useLingui();
  const ids = { worn: useId() };
  const full = draft.outfits.length >= MAX_OUTFITS;

  function add() {
    const name = t`Outfit ${ph({ count: draft.outfits.length + 1 })}`;
    const next = withNewOutfit(draft, name);
    const added = next.outfits.at(-1);
    onDraft(() => next);
    if (added !== undefined && next !== draft) onEditing(added.id);
  }

  return (
    <div className="flex flex-col gap-6">
      <ControlGroup
        title={t`She Wears`}
        labelId={ids.worn}
        description={t`The outfit she shows this model in.`}
      >
        <Select
          value={draft.outfit ?? NONE}
          onValueChange={(value) =>
            onDraft((current) => ({ ...current, outfit: value === NONE ? null : value }))
          }
        >
          <SelectTrigger className="w-full" aria-labelledby={ids.worn}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t`As Exported`}</SelectItem>
            {draft.outfits.map((outfit) => (
              <SelectItem key={outfit.id} value={outfit.id}>
                {outfit.name.trim() || t`Unnamed`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ControlGroup>
      <ControlGroup
        title={t`Outfits`}
        description={t`An outfit hides parts of her, holds parameters at a value, or shows another pose. The one you edit shows on the preview.`}
        action={
          <Button type="button" variant="outline" size="sm" disabled={full} onClick={add}>
            <PlusIcon />
            {t`Add Outfit`}
          </Button>
        }
      >
        {draft.outfits.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
            {t`No outfits yet: she wears the model as it was exported.`}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {draft.outfits.map((outfit) => {
              const open = outfit.id === editing;
              const invalid = nameProblem(outfit.name) !== null;
              return (
                <li key={outfit.id} className={cn(open && "bg-muted/30")}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <ShirtIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm",
                        invalid && "text-destructive",
                      )}
                    >
                      {outfit.name.trim() || t`Unnamed`}
                    </span>
                    {draft.outfit === outfit.id && <Badge variant="secondary">{t`Worn`}</Badge>}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={open ? t`Done` : t`Edit`}
                      title={open ? t`Done` : t`Edit`}
                      aria-expanded={open}
                      onClick={() => onEditing(open ? null : outfit.id)}
                    >
                      {open ? <CheckIcon /> : <PencilIcon />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t`Remove`}
                      title={t`Remove`}
                      onClick={() => {
                        if (open) onEditing(null);
                        onDraft((current) => withoutOutfit(current, outfit.id));
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  {open && (
                    <OutfitEditor
                      inventory={inventory}
                      outfit={outfit}
                      onOutfit={(next) => onDraft((current) => withOutfit(current, next))}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </ControlGroup>
    </div>
  );
}
