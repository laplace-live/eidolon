// The settings page's sections and the app rows each card shows. Advanced shows every other row a
// local install uses, so a new app setting lands there until a card names it.
import type { CardPath } from "@/components/settings-form/controls";
import { studioPath } from "@/lib/paths";

export const SECTIONS = ["providers", "general", "memory", "downloads", "advanced"] as const;
export type SectionId = (typeof SECTIONS)[number];

export type CardId = "you" | "storage" | "embeddings" | "ytDlp";

export interface CardSpec {
  /** Picks its title and description. */
  readonly id: CardId;
  readonly paths: readonly CardPath[];
}

/** The sections whose cards name their rows; Advanced takes the rest. */
type Named = Exclude<SectionId, "advanced">;

/** The SettingsCards of each section, in order. */
export const CARDS: Readonly<Record<Named, readonly CardSpec[]>> = {
  general: [{ id: "you", paths: ["local.viewerName"] }],
  memory: [
    {
      id: "storage",
      paths: [
        ["memory.qdrant.host", "memory.qdrant.port"],
        "memory.qdrant.collection",
        "memory.historyDb",
      ],
    },
  ],
  // Beneath the accounts: the embedding model every persona's index shares.
  providers: [
    {
      id: "embeddings",
      paths: [["embeddings.provider", "embeddings.model"], "embeddings.dim"],
    },
  ],
  downloads: [
    {
      id: "ytDlp",
      paths: [["sources.cookiesFromBrowser", "sources.cookiesFile"], "sources.ytDlp"],
    },
  ],
};

/** Every row a card names, which Advanced leaves out. */
export const NAMED: readonly string[] = Object.values(CARDS).flatMap((cards) =>
  cards.flatMap((card) => card.paths.flat()),
);

export type Resolved = { readonly section: SectionId } | { readonly redirect: string };

function isSection(tab: string): tab is SectionId {
  return (SECTIONS as readonly string[]).includes(tab);
}

/**
 * What `?tab=` shows. Links that name `app` or `persona` still lead somewhere: `app` is General,
 * and `persona` opens that persona's own settings in her studio, the active one's without
 * `&persona=`.
 */
export function resolveSection(params: URLSearchParams, active: string): Resolved {
  const tab = params.get("tab");
  if (tab === null) return { section: "providers" };
  if (isSection(tab)) return { section: tab };
  if (tab === "persona") {
    return { redirect: studioPath(params.get("persona") || active, "advanced") };
  }
  return { redirect: `?tab=${tab === "app" ? "general" : "providers"}` };
}
