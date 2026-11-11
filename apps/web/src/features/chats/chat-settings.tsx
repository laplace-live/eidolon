import { isReplyMode, MAX_CHAIN_LIMIT, REPLY_MODES, type ReplyMode } from "@eidolon/chat";
import { useLingui } from "@lingui/react/macro";
import { useId } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { REPLY_MODE_HELP, REPLY_MODE_LABELS } from "./labels";
import { useSetChainLimit, useSetReplyMode } from "./queries";

const LIMITS = Array.from({ length: MAX_CHAIN_LIMIT + 1 }, (_, limit) => String(limit));

/** How the personas answer in this chat; until it is set, each answers as her own settings say. */
function ReplyModeField({
  id,
  replyMode,
}: {
  readonly id: string;
  readonly replyMode: ReplyMode | null;
}) {
  const { t } = useLingui();
  const labelId = useId();
  const save = useSetReplyMode();
  const shown = save.isPending ? save.variables.replyMode : replyMode;

  return (
    <Field>
      <FieldLabel id={labelId}>{t`Reply Mode`}</FieldLabel>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={shown ?? ""}
        onValueChange={(next) => {
          if (isReplyMode(next) && next !== shown) save.mutate({ id, replyMode: next });
        }}
        disabled={save.isPending}
        aria-labelledby={labelId}
      >
        {REPLY_MODES.map((mode) => (
          <ToggleGroupItem key={mode} value={mode} className="h-9 px-3">
            {t(REPLY_MODE_LABELS[mode])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldDescription>
        {shown === null
          ? t`Until you choose, each persona answers as her own settings say.`
          : t(REPLY_MODE_HELP[shown])}
      </FieldDescription>
      <FieldDescription>{t`A persona whose voice has no key answers in text.`}</FieldDescription>
    </Field>
  );
}

/** This chat's own settings: how the personas answer, and how far they answer each other. */
export function ChatSettingsSheet({
  id,
  chainLimit,
  replyMode,
  open,
  onOpenChange,
}: {
  readonly id: string;
  readonly chainLimit: number;
  /** The chat's own; null leaves each persona's. */
  readonly replyMode: ReplyMode | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const labelId = useId();
  const save = useSetChainLimit();
  const shown = save.isPending ? save.variables.chainLimit : chainLimit;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{t`Chat Settings`}</SheetTitle>
          <SheetDescription>{t`These apply to this chat alone.`}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4">
          <ReplyModeField id={id} replyMode={replyMode} />
          <Field>
            <FieldLabel id={labelId}>{t`Replies between Personas`}</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={String(shown)}
              // Clicking the chosen item again deselects it in Radix; keep the choice instead.
              onValueChange={(next) => {
                if (next !== "" && next !== String(shown)) {
                  save.mutate({ id, chainLimit: Number(next) });
                }
              }}
              disabled={save.isPending}
              aria-labelledby={labelId}
            >
              {LIMITS.map((limit) => (
                <ToggleGroupItem key={limit} value={limit} className="h-9 min-w-9 px-3">
                  {limit}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>
              {t`How many times personas may answer each other after each of your lines, once two or more are in the chat. At 0 they only answer you.`}
            </FieldDescription>
          </Field>
        </div>
      </SheetContent>
    </Sheet>
  );
}
