import {
  CHAT_DISPLAYS,
  type ChatDisplay,
  isChatDisplay,
  isPermissionLevel,
  isReplyMode,
  MAX_CHAIN_LIMIT,
  PERMISSION_LEVELS,
  type PermissionLevel,
  REPLY_MODES,
  type ReplyMode,
} from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
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
import {
  DISPLAY_HELP,
  DISPLAY_LABELS,
  PERMISSION_HELP,
  PERMISSION_LABELS,
  REPLY_MODE_HELP,
  REPLY_MODE_LABELS,
} from "./labels";
import { useSetChainLimit, useSetDisplay, useSetPermissions, useSetReplyMode } from "./queries";

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

/**
 * How much of her tasks this chat shows; until it is set, the app's. During a call, when the
 * composer takes no commands, this is where it changes.
 */
export function DisplayField({
  id,
  display,
  fallback,
}: {
  readonly id: string;
  readonly display: ChatDisplay | null;
  readonly fallback: ChatDisplay;
}) {
  const { t } = useLingui();
  const labelId = useId();
  const save = useSetDisplay();
  const shown = save.isPending ? save.variables.display : display;
  const following = t(DISPLAY_LABELS[fallback]);

  return (
    <Field>
      <FieldLabel id={labelId}>{t`Task Display`}</FieldLabel>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={shown ?? ""}
        onValueChange={(next) => {
          if (isChatDisplay(next) && next !== shown) save.mutate({ id, display: next });
        }}
        disabled={save.isPending}
        aria-labelledby={labelId}
      >
        {CHAT_DISPLAYS.map((mode) => (
          <ToggleGroupItem key={mode} value={mode} className="h-9 px-3">
            {t(DISPLAY_LABELS[mode])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldDescription>
        {shown === null
          ? t`Until you choose, this chat follows Settings: ${ph({ display: following })}.`
          : t(DISPLAY_HELP[shown])}
      </FieldDescription>
      <FieldDescription>{t`You can also type /focus, /normal or /verbose in the message box.`}</FieldDescription>
    </Field>
  );
}

/**
 * What her tasks here may do without your answer on their cards; until it is set, the app's. The
 * same as the picker beside the message box.
 */
function PermissionsField({
  id,
  permissions,
  fallback,
}: {
  readonly id: string;
  readonly permissions: PermissionLevel | null;
  readonly fallback: PermissionLevel;
}) {
  const { t } = useLingui();
  const labelId = useId();
  const save = useSetPermissions();
  const shown = save.isPending ? save.variables.permissions : permissions;
  const following = t(PERMISSION_LABELS[fallback]);

  return (
    <Field>
      <FieldLabel id={labelId}>{t`Task Permissions`}</FieldLabel>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={shown ?? ""}
        onValueChange={(next) => {
          if (isPermissionLevel(next) && next !== shown) save.mutate({ id, permissions: next });
        }}
        disabled={save.isPending}
        aria-labelledby={labelId}
        className="flex-wrap"
      >
        {PERMISSION_LEVELS.map((level) => (
          <ToggleGroupItem key={level} value={level} className="h-9 px-3">
            {t(PERMISSION_LABELS[level])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldDescription>
        {shown === null
          ? t`Until you choose, this chat follows Settings: ${ph({ level: following })}.`
          : t(PERMISSION_HELP[shown])}
      </FieldDescription>
    </Field>
  );
}

/**
 * This chat's own settings: how the personas answer, how far they answer each other, how much of
 * her tasks it shows, and what they may do unasked.
 */
export function ChatSettingsSheet({
  id,
  chainLimit,
  replyMode,
  display,
  defaultDisplay,
  permissions,
  defaultPermissions,
  open,
  onOpenChange,
}: {
  readonly id: string;
  readonly chainLimit: number;
  /** The chat's own; null leaves each persona's. */
  readonly replyMode: ReplyMode | null;
  /** The chat's own; null follows `defaultDisplay`, the app's. */
  readonly display: ChatDisplay | null;
  readonly defaultDisplay: ChatDisplay;
  /** The chat's own; null follows `defaultPermissions`, the app's. */
  readonly permissions: PermissionLevel | null;
  readonly defaultPermissions: PermissionLevel;
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
          <DisplayField id={id} display={display} fallback={defaultDisplay} />
          <PermissionsField id={id} permissions={permissions} fallback={defaultPermissions} />
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
