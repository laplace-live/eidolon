import { expect, test } from "bun:test";
import { SETTINGS } from "@eidolon/config";
import { isSection, SHOWN_PATHS } from "./sections";

const PERSONA_ROWS = SETTINGS.filter((row) => row.scope === "persona").map((row) => row.path);

test("each persona setting appears in exactly one section, and Advanced holds the rest", () => {
  const seen = new Map<string, number>();
  for (const path of SHOWN_PATHS) seen.set(path, (seen.get(path) ?? 0) + 1);
  expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
  expect(SHOWN_PATHS.filter((path) => !PERSONA_ROWS.includes(path))).toEqual([]);
  // A new persona setting lands in Advanced until a section shows it.
  expect(PERSONA_ROWS.filter((path) => !SHOWN_PATHS.includes(path)).sort()).toEqual([
    "knowledge.index",
    "memory.agentId",
    "memory.runId",
    "prompt",
  ]);
});

test("section ids are the URL's last segment", () => {
  expect(["identity", "references", "advanced"].every(isSection)).toBe(true);
  expect([undefined, "tab", "Identity"].some(isSection)).toBe(false);
});
