// The chat's permission level for her tasks, in its message box: what they may do without your
// answer on their cards, from their next question on. Until the chat picks one, it follows Settings.
import { PERMISSION_LEVELS, type PermissionLevel } from "@eidolon/chat";
import { useLingui } from "@lingui/react/macro";
import {
  ChevronDownIcon,
  HandIcon,
  type LucideIcon,
  ShieldCheckIcon,
  ShieldExclamationPointIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { PERMISSION_HELP, PERMISSION_LABELS } from "./labels";
import { useSetPermissions } from "./queries";

const ICONS: Readonly<Record<PermissionLevel, LucideIcon>> = {
  ask: HandIcon,
  auto: ShieldCheckIcon,
  full: ShieldExclamationPointIcon,
};

export function PermissionsPicker({
  id,
  own,
  fallback,
}: {
  readonly id: string;
  /** The chat's own; null follows `fallback`, the app's. */
  readonly own: PermissionLevel | null;
  readonly fallback: PermissionLevel;
}) {
  const { t } = useLingui();
  const save = useSetPermissions();
  const shown = save.isPending ? save.variables.permissions : (own ?? fallback);
  const Icon = ICONS[shown];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          data-permissions={shown}
          className={cn(
            "rounded-full text-muted-foreground",
            shown === "full" && "text-warning hover:text-warning aria-expanded:text-warning",
          )}
        >
          <Icon />
          {t(PERMISSION_LABELS[shown])}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{t`How much should her tasks here ask you?`}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={shown}>
          {PERMISSION_LEVELS.map((level) => {
            const ItemIcon = ICONS[level];
            const warn = level === "full";
            return (
              <DropdownMenuRadioItem
                key={level}
                value={level}
                disabled={save.isPending}
                // Picking the level the chat follows from Settings makes it the chat's own.
                onSelect={() => {
                  if (level !== own) save.mutate({ id, permissions: level });
                }}
                className="items-start py-1.5"
              >
                <ItemIcon className={cn("mt-0.5", warn && "text-warning")} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className={cn(warn && "text-warning")}>{t(PERMISSION_LABELS[level])}</span>
                  <span className="text-muted-foreground text-xs">{t(PERMISSION_HELP[level])}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {own === null && (
          <p className="px-1.5 py-1 text-muted-foreground text-xs">
            {t`Until you choose, this chat follows Settings.`}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
