import { useParams } from "react-router";
import { useT } from "@/lib/i18n";

export function Component() {
  const t = useT();
  const { id, tab } = useParams();
  return (
    <div className="flex flex-col gap-1">
      <h1 className="font-heading text-2xl font-semibold">{t("studio.title")}</h1>
      <p className="text-muted-foreground">{[id, tab].filter(Boolean).join(" / ")}</p>
    </div>
  );
}
