import { SETTINGS } from "@eidolon/config";
import { describe, expect, test } from "vitest";
import { cardSections, visibleRows } from "@/components/settings-form/controls";
import type { SettingRow } from "@/lib/api";
import type { EidolonDesktop } from "@/lib/desktop";
import {
  CARDS,
  NAMED,
  offersSystemOptions,
  resolveSection,
  SECTIONS,
  shownSections,
} from "./sections";

const rows: SettingRow[] = SETTINGS.map((setting) => ({
  ...setting,
  value: null,
  source: "default",
  envValue: null,
  envName: null,
  envOverride: false,
  productionOnly: setting.path.startsWith("mcp."),
  readOnly: false,
}));

const pathsOf = (sections: ReturnType<typeof cardSections>) =>
  sections.flatMap((section) => section.lines.flat().map((row) => row.path));

describe("the cards", () => {
  test("name each row once, and only app rows the local app shows", () => {
    expect(new Set(NAMED).size).toBe(NAMED.length);
    const shown = new Set(visibleRows(rows, "app").map((row) => row.path));
    expect(NAMED.filter((path) => !shown.has(path))).toEqual([]);
  });

  test("with Advanced, show every row the local app shows exactly once", () => {
    const cards = Object.values(CARDS).flatMap((section) =>
      section.map((card) => pathsOf(cardSections(rows, "app", card.paths))),
    );
    const advanced = pathsOf(cardSections(rows, "app", undefined, NAMED));
    const listed = [...cards.flat(), ...advanced];
    expect(listed.toSorted()).toEqual(
      visibleRows(rows, "app")
        .map((row) => row.path)
        .toSorted(),
    );
    expect(new Set(listed).size).toBe(listed.length);
    expect(advanced).toContain("providers.openrouter.appName");
    // Edited as an account's API base: a file's value applies, but no card shows it.
    expect(listed).not.toContain("providers.openrouter.apiBase");
  });

  test("Assistant Mode has a section of its own, with every assistant row and the task display last", () => {
    const [card, kinds, ...others] = CARDS.assistant;
    expect(others).toEqual([]);
    expect(card?.paths).toEqual([
      "assistant.enabled",
      ["assistant.provider", "assistant.model"],
      ["assistant.search.provider", "assistant.search.model"],
      "assistant.folders",
      "assistant.bash",
      "assistant.permissions",
      ["assistant.spendPauseUsd", "assistant.contextTokens"],
      "chats.display",
    ]);
    const rows = SETTINGS.filter(
      (setting) => setting.path.startsWith("assistant.") || setting.path === "chats.display",
    );
    expect(rows.map((setting) => setting.path).toSorted()).toEqual(
      [...(card?.paths ?? []), ...(kinds?.paths ?? [])].flat().toSorted(),
    );
  });

  test("Models by Kind follows the mode's card, each kind's account beside its model, and Advanced leaves them out", () => {
    const kinds = CARDS.assistant.find((card) => card.id === "kinds");
    expect(CARDS.assistant.map((card) => card.id)).toEqual(["assistant", "kinds"]);
    expect(kinds?.paths).toEqual([
      ["assistant.quick.provider", "assistant.quick.model"],
      ["assistant.coding.provider", "assistant.coding.model"],
      ["assistant.research.provider", "assistant.research.model"],
    ]);
    const advanced = pathsOf(cardSections(rows, "app", undefined, NAMED));
    expect(advanced.filter((path) => path.startsWith("assistant."))).toEqual([]);
  });

  test("Qdrant's host and port, and the embedding provider and model, sit side by side", () => {
    const lines = Object.values(CARDS).flatMap((section) =>
      section.flatMap((card) => card.paths.filter((line) => typeof line !== "string")),
    );
    expect(lines).toContainEqual(["memory.qdrant.host", "memory.qdrant.port"]);
    expect(lines).toContainEqual(["embeddings.provider", "embeddings.model"]);
  });
});

describe("?tab=", () => {
  const resolve = (query: string) =>
    resolveSection(new URLSearchParams(query), "milky-green", shownSections(null));

  test("names a section, and Providers without one", () => {
    expect(resolve("")).toEqual({ section: "providers" });
    expect(resolve("tab=providers")).toEqual({ section: "providers" });
    expect(resolve("tab=memory")).toEqual({ section: "memory" });
    expect(resolve("tab=assistant")).toEqual({ section: "assistant" });
    expect(resolve("tab=advanced")).toEqual({ section: "advanced" });
  });

  test("the old General and Keys ids, and an unknown one, lead to a section", () => {
    expect(resolve("tab=app")).toEqual({ redirect: "?tab=general" });
    expect(resolve("tab=app&persona=ada")).toEqual({ redirect: "?tab=general" });
    expect(resolve("tab=keys")).toEqual({ redirect: "?tab=providers" });
    expect(resolve("tab=nope")).toEqual({ redirect: "?tab=providers" });
    expect(resolve("tab=")).toEqual({ redirect: "?tab=providers" });
  });

  test("the old persona tab opens her own settings in the studio, the active one's by default", () => {
    expect(resolve("tab=persona&persona=ada")).toEqual({ redirect: "/personas/ada/advanced" });
    expect(resolve("tab=persona")).toEqual({ redirect: "/personas/milky-green/advanced" });
    expect(resolve("tab=persona&persona=")).toEqual({ redirect: "/personas/milky-green/advanced" });
    expect(resolve("tab=persona&persona=a%20b")).toEqual({ redirect: "/personas/a%20b/advanced" });
  });
});

describe("the Desktop section", () => {
  const ignore = () => {};
  const bridge: EidolonDesktop = {
    platform: "darwin",
    version: "0.2.0",
    serverVersion: "0.14.0",
    setTheme: ignore,
    setLanguage: ignore,
    onCommand: ignore,
  };
  const off = { state: "off" } as const;
  const absent = { state: "absent", path: "/usr/local/bin/eidolon" } as const;
  const options = {
    loginItem: async () => off,
    setLoginItem: async () => off,
    terminalCommand: async () => absent,
    setTerminalCommand: async () => ({ command: absent }),
  };
  const desktopApp: EidolonDesktop = { ...bridge, ...options };

  test("shows in a desktop app that offers Open at Login and the terminal command, last before Advanced", () => {
    expect(offersSystemOptions(desktopApp)).toBe(true);
    expect(shownSections(desktopApp)).toEqual([
      "providers",
      "general",
      "memory",
      "downloads",
      "assistant",
      "skills",
      "desktop",
      "advanced",
    ]);
  });

  test("a browser, or an app whose bridge predates the options, shows every other section", () => {
    const others = SECTIONS.filter((id) => id !== "desktop");
    expect(shownSections(null)).toEqual(others);
    expect(shownSections(bridge)).toEqual(others);
    expect(shownSections({ ...bridge, chooseFolder: async () => null })).toEqual(others);
    const { setTerminalCommand: _, ...withoutOne } = options;
    expect(offersSystemOptions({ ...bridge, ...withoutOne })).toBe(false);
  });

  test("?tab=desktop opens it where it shows, and the default section anywhere else", () => {
    const params = new URLSearchParams("tab=desktop");
    expect(resolveSection(params, "milky-green", shownSections(desktopApp))).toEqual({
      section: "desktop",
    });
    expect(resolveSection(params, "milky-green", shownSections(null))).toEqual({
      redirect: "?tab=providers",
    });
    expect(resolveSection(params, "milky-green", shownSections(bridge))).toEqual({
      redirect: "?tab=providers",
    });
  });

  test("has no rows of its own, so Advanced still shows every app row no card names", () => {
    expect(CARDS.desktop).toEqual([]);
  });
});
