import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { useT } from "@/lib/i18n";

export function Component() {
  const t = useT();
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-6">
      <div className="flex justify-end gap-1">
        <LanguageSwitch />
        <ThemeMenu />
      </div>
      <h1 className="font-heading text-2xl font-semibold">{t("setup.title")}</h1>
    </div>
  );
}
