import { MAX_CHAIN_LIMIT } from "@eidolon/chat";
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
import { useSetChainLimit } from "./queries";

const LIMITS = Array.from({ length: MAX_CHAIN_LIMIT + 1 }, (_, limit) => String(limit));

/** This chat's own settings: how far personas answer each other. Each change saves at once. */
export function ChatSettingsSheet({
  id,
  chainLimit,
  open,
  onOpenChange,
}: {
  readonly id: string;
  readonly chainLimit: number;
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
        <div className="px-4">
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
