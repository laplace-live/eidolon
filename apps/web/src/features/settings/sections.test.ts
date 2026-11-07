import { describe, expect, test } from "bun:test";
import { SETTINGS } from "@eidolon/config";
import { cardSections, visibleRows } from "@/components/settings-form/controls";
import type { SettingRow } from "@/lib/api";
import { CARDS, NAMED, resolveSection } from "./sections";

const rows: SettingRow[] = SETTINGS.map((setting) => ({
  ...setting,
  value: null,
  source: "default",
  envValue: null,
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
    expect(advanced).toContain("providers.openrouter.apiBase");
  });

  test("Qdrant's host and port, and the embedding model and dimension, sit side by side", () => {
    const lines = Object.values(CARDS).flatMap((section) =>
      section.flatMap((card) => card.paths.filter((line) => typeof line !== "string")),
    );
    expect(lines).toContainEqual(["memory.qdrant.host", "memory.qdrant.port"]);
    expect(lines).toContainEqual(["embeddings.model", "embeddings.dim"]);
  });
});

describe("?tab=", () => {
  const resolve = (query: string) => resolveSection(new URLSearchParams(query), "milky-green");

  test("names a section, and Keys without one", () => {
    expect(resolve("")).toEqual({ section: "keys" });
    expect(resolve("tab=keys")).toEqual({ section: "keys" });
    expect(resolve("tab=memory")).toEqual({ section: "memory" });
    expect(resolve("tab=advanced")).toEqual({ section: "advanced" });
  });

  test("the old General id and an unknown one lead to a section", () => {
    expect(resolve("tab=app")).toEqual({ redirect: "?tab=general" });
    expect(resolve("tab=app&persona=ada")).toEqual({ redirect: "?tab=general" });
    expect(resolve("tab=nope")).toEqual({ redirect: "?tab=keys" });
    expect(resolve("tab=")).toEqual({ redirect: "?tab=keys" });
  });

  test("the old persona tab opens her own settings in the studio, the active one's by default", () => {
    expect(resolve("tab=persona&persona=ada")).toEqual({ redirect: "/personas/ada/advanced" });
    expect(resolve("tab=persona")).toEqual({ redirect: "/personas/milky-green/advanced" });
    expect(resolve("tab=persona&persona=")).toEqual({ redirect: "/personas/milky-green/advanced" });
    expect(resolve("tab=persona&persona=a%20b")).toEqual({ redirect: "/personas/a%20b/advanced" });
  });
});
