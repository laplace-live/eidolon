// The settings page's sections and the app rows each card shows. Advanced shows every other row a
// local install uses, so a new app setting lands there until a card names it.
import type { CardPath } from "@/components/settings-form/controls";
import type { EidolonDesktop } from "@/lib/desktop";
import { studioPath } from "@/lib/paths";

export const SECTIONS = [
  "providers",
  "general",
  "memory",
  "downloads",
  "assistant",
  "skills",
  "subspace",
  "desktop",
  "permissions",
  "advanced",
] as const;
export type SectionId = (typeof SECTIONS)[number];

/** A desktop app's bridge with Open at Login and the terminal command, which older apps lack. */
export type SystemOptions = EidolonDesktop &
  Required<
    Pick<EidolonDesktop, "loginItem" | "setLoginItem" | "terminalCommand" | "setTerminalCommand">
  >;

export function offersSystemOptions(app: EidolonDesktop | null): app is SystemOptions {
  return (
    app !== null &&
    app.loginItem !== undefined &&
    app.setLoginItem !== undefined &&
    app.terminalCommand !== undefined &&
    app.setTerminalCommand !== undefined
  );
}

/** A desktop app's bridge that offers the desktop companion. */
export type CompanionOptions = EidolonDesktop &
  Required<Pick<EidolonDesktop, "companion" | "setCompanion">>;

export function offersCompanion(app: EidolonDesktop | null): app is CompanionOptions {
  return app !== null && app.companion !== undefined && app.setCompanion !== undefined;
}

/** A desktop app's bridge that offers OS permissions status, requests, and Local Network testing. */
export type PermissionsOptions = EidolonDesktop &
  Required<
    Pick<
      EidolonDesktop,
      "permissions" | "requestPermission" | "openPermissionSettings" | "testLocalNetwork"
    >
  >;

export function offersPermissions(app: EidolonDesktop | null): app is PermissionsOptions {
  return (
    app !== null &&
    app.permissions !== undefined &&
    app.requestPermission !== undefined &&
    app.openPermissionSettings !== undefined &&
    app.testLocalNetwork !== undefined
  );
}

/**
 * The sections this page shows: Desktop only in a desktop app that offers its options or the
 * desktop companion, and Permissions only when the desktop bridge supports it.
 */
export function shownSections(app: EidolonDesktop | null): readonly SectionId[] {
  const showDesktop = offersSystemOptions(app) || offersCompanion(app);
  const showPermissions = offersPermissions(app);
  return SECTIONS.filter(
    (id) => (id !== "desktop" || showDesktop) && (id !== "permissions" || showPermissions),
  );
}

export type CardId =
  | "you"
  | "storage"
  | "embeddings"
  | "ytDlp"
  | "assistant"
  | "kinds"
  | "subspaceRelay";

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
      paths: ["memory.enabled", "memory.dir", "memory.historyDb"],
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
  assistant: [
    {
      id: "assistant",
      paths: [
        "assistant.enabled",
        ["assistant.provider", "assistant.model"],
        ["assistant.search.provider", "assistant.search.model"],
        "assistant.folders",
        "assistant.bash",
        "assistant.permissions",
        ["assistant.spendPauseUsd", "assistant.contextTokens"],
        "chats.display",
      ],
    },
    // The kinds' own accounts and models, which tasks she marks so run on.
    {
      id: "kinds",
      paths: [
        ["assistant.quick.provider", "assistant.quick.model"],
        ["assistant.coding.provider", "assistant.coding.model"],
        ["assistant.research.provider", "assistant.research.model"],
      ],
    },
  ],
  // No rows: its card is the owner's skill folders.
  skills: [],
  subspace: [{ id: "subspaceRelay", paths: ["subspace.relayUrl", "subspace.authUrl"] }],
  // No rows: its card asks the desktop app, never the server.
  desktop: [],
  // No rows: its cards ask the desktop app for OS permissions on this computer.
  permissions: [],
};

/** Every row a card names, which Advanced leaves out. */
export const NAMED: readonly string[] = Object.values(CARDS).flatMap((cards) =>
  cards.flatMap((card) => card.paths.flat()),
);

export type Resolved = { readonly section: SectionId } | { readonly redirect: string };

/**
 * What `?tab=` shows, of the `shown` sections. Links that name `app` or `persona` still lead
 * somewhere: `app` is General, and `persona` opens that persona's own settings in her studio, the
 * active one's without `&persona=`.
 */
export function resolveSection(
  params: URLSearchParams,
  active: string,
  shown: readonly SectionId[],
): Resolved {
  const tab = params.get("tab");
  if (tab === null) return { section: "providers" };
  const section = shown.find((id) => id === tab);
  if (section !== undefined) return { section };
  if (tab === "persona") {
    return { redirect: studioPath(params.get("persona") || active, "advanced") };
  }
  return { redirect: `?tab=${tab === "app" ? "general" : "providers"}` };
}
