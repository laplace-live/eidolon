import { LanguagesIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLang, useLang, useT } from "@/lib/i18n";
import { type Theme, useTheme } from "@/lib/theme";

const THEMES = [
  { value: "light", icon: SunIcon },
  { value: "dark", icon: MoonIcon },
  { value: "system", icon: MonitorIcon },
] as const satisfies readonly { value: Theme; icon: unknown }[];

/** Switches between the two languages; it is labelled with the one it switches to. */
export function LanguageSwitch() {
  const t = useT();
  const other = useLang() === "en" ? "zh-CN" : "en";
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t("common.language.label")}
      onClick={() => setLang(other)}
    >
      <LanguagesIcon />
      {t(`common.language.${other}`)}
    </Button>
  );
}

export function ThemeMenu() {
  const t = useT();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const Icon = resolvedTheme === "dark" ? MoonIcon : SunIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("common.theme.label")}>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          {THEMES.map(({ value, icon: ItemIcon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <ItemIcon />
              {t(`common.theme.${value}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
