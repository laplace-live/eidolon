import { buildCatalogs } from "@/lib/i18n";

/** Every locale file; a feature adds strings by adding `<lang>/<feature>.json` in both languages. */
export const catalogs = buildCatalogs(
  import.meta.glob<Record<string, string>>("./*/*.json", { eager: true, import: "default" }),
);
