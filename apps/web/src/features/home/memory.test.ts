import { describe, expect, test } from "vitest";
import { ApiError, type Memory } from "../../lib/api";
import { memoryView, shownMemories } from "./memory";

describe("what the memory panel shows", () => {
  const pending = { status: "pending", error: null } as const;
  const listed = { status: "success", error: null } as const;
  const failed = (status: number, code: "unavailable" | "upstream-failed") =>
    ({ status: "error", error: new ApiError(status, code, "") }) as const;

  test("off while memory is disabled, whatever else holds", () => {
    expect(memoryView({ configured: false, ready: false, problem: null }, pending)).toBe("off");
    expect(memoryView({ configured: false, ready: true, problem: null }, listed)).toBe("off");
  });

  test("not-ready when enabled without required keys", () => {
    expect(memoryView({ configured: true, ready: false, problem: "missing key" }, pending)).toBe(
      "not-ready",
    );
  });

  test("loading, list, unavailable on 503, and failed on 502 once ready", () => {
    const ready = { configured: true, ready: true, problem: null } as const;
    expect(memoryView(ready, pending)).toBe("loading");
    expect(memoryView(ready, listed)).toBe("list");
    expect(memoryView(ready, failed(503, "unavailable"))).toBe("unavailable");
    expect(memoryView(ready, failed(502, "upstream-failed"))).toBe("failed");
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
