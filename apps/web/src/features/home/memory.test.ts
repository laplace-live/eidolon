import { describe, expect, test } from "bun:test";
import { ApiError, type Memory } from "../../lib/api";
import { memoryView, shownMemories } from "./memory";

describe("what the memory panel shows", () => {
  const pending = { status: "pending", error: null } as const;
  const listed = { status: "success", error: null } as const;
  const failed = (status: number, code: "unavailable" | "upstream-failed") =>
    ({ status: "error", error: new ApiError(status, code, "") }) as const;

  test("off without a Qdrant host, whatever else holds", () => {
    expect(memoryView({ configured: false, reachable: null }, pending)).toBe("off");
    expect(memoryView({ configured: false, reachable: true }, listed)).toBe("off");
  });

  test("down when Qdrant doesn't answer the list, or the last probe said so", () => {
    expect(memoryView({ configured: true, reachable: true }, failed(503, "unavailable"))).toBe(
      "down",
    );
    expect(memoryView({ configured: true, reachable: false }, pending)).toBe("down");
  });

  test("the list once it answers, even when the last probe failed", () => {
    expect(memoryView({ configured: true, reachable: false }, listed)).toBe("list");
    expect(memoryView({ configured: true, reachable: null }, pending)).toBe("loading");
    expect(memoryView({ configured: true, reachable: true }, failed(502, "upstream-failed"))).toBe(
      "failed",
    );
  });
});

test("memories show newest first, and empty ones not at all", () => {
  const memory = (
    id: string,
    text: string | null,
    updated: string | null,
    created: string | null,
  ) => ({ id, memory: text, updated_at: updated, created_at: created, categories: null }) as Memory;
  const shown = shownMemories([
    memory("old", "likes tea", null, "2026-10-01T00:00:00Z"),
    memory("blank", "  ", null, "2026-11-04T00:00:00Z"),
    memory("none", null, null, null),
    memory("undated", "has a cat", null, null),
    memory("new", "lives in Shanghai", "2026-11-03T00:00:00Z", "2026-09-01T00:00:00Z"),
  ]);
  expect(shown.map((entry) => entry.id)).toEqual(["new", "old", "undated"]);
});
