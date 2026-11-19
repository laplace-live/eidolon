import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { LanguagesIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Theme, useTheme } from "@/lib/theme";
import { LANG_NAMES, setLang, useLang } from "@/locales/i18n";

const THEMES = [
  { value: "light", icon: SunIcon, label: msg`Light` },
  { value: "dark", icon: MoonIcon, label: msg`Dark` },
  { value: "system", icon: MonitorIcon, label: msg`System` },
] as const satisfies readonly { value: Theme; icon: unknown; label: unknown }[];

/**
 * Switches between the two languages; it is labelled with the one it switches to, in a tooltip
 * when `compact`.
 */
export function LanguageSwitch({ compact = false }: { readonly compact?: boolean }) {
  const { t } = useLingui();
  const other = useLang() === "en" ? "zh-Hans" : "en";
  const button = (
    <Button
      variant="ghost"
      size={compact ? "icon-sm" : "sm"}
      aria-label={t`Language`}
      onClick={() => void setLang(other)}
    >
      <LanguagesIcon />
      {!compact && LANG_NAMES[other]}
    </Button>
  );
  if (!compact) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{LANG_NAMES[other]}</TooltipContent>
    </Tooltip>
  );
}

export function ThemeMenu({ side = "bottom" }: { readonly side?: "bottom" | "right" }) {
  const { t } = useLingui();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const Icon = resolvedTheme === "dark" ? MoonIcon : SunIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t`Theme`}>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          {THEMES.map(({ value, icon: ItemIcon, label }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <ItemIcon />
              {t(label)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
