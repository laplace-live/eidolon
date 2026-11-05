import { useT } from "@/lib/i18n";

export function Component() {
  const t = useT();
  return <h1 className="font-heading text-2xl font-semibold">{t("call.title")}</h1>;
}
