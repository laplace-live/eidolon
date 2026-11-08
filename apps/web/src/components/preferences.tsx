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
import { type Theme, useTheme } from "@/lib/theme";
import { LANG_NAMES, setLang, useLang } from "@/locales/i18n";

const THEMES = [
  { value: "light", icon: SunIcon, label: msg`Light` },
  { value: "dark", icon: MoonIcon, label: msg`Dark` },
  { value: "system", icon: MonitorIcon, label: msg`System` },
] as const satisfies readonly { value: Theme; icon: unknown; label: unknown }[];

/** Switches between the two languages; it is labelled with the one it switches to. */
export function LanguageSwitch() {
  const { t } = useLingui();
  const other = useLang() === "en" ? "zh-Hans" : "en";
  return (
    <Button variant="ghost" size="sm" aria-label={t`Language`} onClick={() => void setLang(other)}>
      <LanguagesIcon />
      {LANG_NAMES[other]}
    </Button>
  );
}

export function ThemeMenu() {
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
      <DropdownMenuContent align="end">
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
