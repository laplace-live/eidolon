import { useParams } from "react-router";
import { useT } from "@/lib/i18n";

/** /jobs lists them; /jobs/:id shows one. */
export function Component() {
  const t = useT();
  const { id } = useParams();
  return (
    <div className="flex flex-col gap-1">
      <h1 className="font-heading text-2xl font-semibold">{t("jobs.title")}</h1>
      {id && <p className="font-mono text-muted-foreground text-sm">{id}</p>}
    </div>
  );
}
