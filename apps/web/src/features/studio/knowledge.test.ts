import { describe, expect, test } from "bun:test";
import type { FactFile } from "../../lib/api";
import { factsHint, factsState, wasIndexed } from "./knowledge";

function file(name: string, matched = true, changed = false): FactFile {
  return { name, size: 1, mtime: "2026-11-01T00:00:00.000Z", matched, changed };
}

describe("files the index still holds", () => {
  test("those the server reports removed", () => {
    const state = factsState({ files: [file("a.txt")], removed: ["old.txt"] }, []);
    expect(state).toEqual({ matched: 1, changed: 0, gone: ["old.txt"] });
    expect(factsHint(state)).toEqual({ key: "studio.facts.goneCount", vars: { count: 1 } });
  });

  test("one deleted here while indexed, which a table without a build record can't report", () => {
    const state = factsState({ files: [file("a.txt", true, true)], removed: [] }, ["b.txt"]);
    expect(state.gone).toEqual(["b.txt"]);
    expect(factsHint(state)).toEqual({ key: "studio.facts.changedCount", vars: { count: 1 } });
  });

  test("each once, sorted, and not one that is back", () => {
    const state = factsState({ files: [file("b.txt", true, true)], removed: ["c.txt", "a.txt"] }, [
      "a.txt",
      "b.txt",
    ]);
    expect(state.gone).toEqual(["a.txt", "c.txt"]);
  });

  test("when no file is left to index", () => {
    const state = factsState({ files: [], removed: [] }, ["a.txt"]);
    expect(state).toEqual({ matched: 0, changed: 0, gone: ["a.txt"] });
    expect(factsHint(state)).toEqual({ key: "studio.facts.nothingMatched" });
  });
});

test("an index that matches its files needs nothing", () => {
  const state = factsState({ files: [file("a.txt"), file("b.txt", false)], removed: [] }, []);
  expect(state).toEqual({ matched: 1, changed: 0, gone: [] });
  expect(factsHint(state)).toEqual({ key: "studio.facts.ingestHelp" });
});

test("which files the index holds, as far as the page can tell", () => {
  const recorded = { built: true, rows: 12 };
  const unrecorded = { built: true, rows: null };
  expect(wasIndexed(file("a.txt"), recorded)).toBe(true);
  // New or edited since: the server's `removed` tells whether the index had it.
  expect(wasIndexed(file("a.txt", true, true), recorded)).toBe(false);
  // Every file reads as changed beside a table without a build record.
  expect(wasIndexed(file("a.txt", true, true), unrecorded)).toBe(true);
  expect(wasIndexed(file("a.txt", false), unrecorded)).toBe(false);
  expect(wasIndexed(file("a.txt"), { built: false, rows: null })).toBe(false);
  expect(wasIndexed(file("a.txt"), undefined)).toBe(false);
});
